/**
 * R2-D3 corrections — shared team editor (personal-port fixture).
 *
 * R2-D3-1: content reconciliation after 409 / uncertain outcomes.
 *   - The fixture enforces real CAS: a PUT with a stale
 *     expected_revision gets a genuine 409. A "second client" write is a
 *     real fetch through the same intercepted route — it commits and
 *     bumps the revision before the editor's PUT.
 *   - Lost-ACK mode applies the commit in the handler first and only
 *     then aborts delivery to the browser: the server holds the sent
 *     snapshot, the client only knows the response never arrived.
 *   - Reconciliation outcomes: server==sent → already-persisted (ZERO
 *     extra PUT); disjoint changes → merge (server-only fields adopted,
 *     user fields kept, resend on fresh revision); same-field divergence
 *     → explicit conflict decision (Mantener / Cargar) — never a blind
 *     overwrite. No autosave/flush PUT bypasses the reconcile.
 *
 * R2-D3-2: leave/commit ownership.
 *   - `_routeFlushOp`/`_closingEditOp` are per-operation tokens, not
 *     global booleans: a hung request from a retired editor never blocks
 *     the successor's Volver or route flush, and its late release cannot
 *     free the successor's operation.
 *   - requestLeave(grant)/commitLeave(grant): the grant binds commit to
 *     the concrete admission — a stale commit never retires an editor
 *     reopened on the same element, and edits typed after admission are
 *     flushed before retiring, never discarded.
 *
 * Run: `npm run build:lib && node --test tests/r2-editor-corrections.test.mjs`
 * Requires: chromium (npx playwright install chromium).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(APP_ROOT, '..');
const DIST_EMBED = join(REPO_ROOT, 'dist', 'embed', 'biq-onboard.js');
const PORT = 9156;

if (!existsSync(DIST_EMBED)) {
  throw new Error('Build output not found. Run `npm run build:lib` first.');
}

const bundle = readFileSync(DIST_EMBED, 'utf-8');
let server;

const HARNESS = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>r2 editor corrections</title></head>
<body>
  <biq-onboard-app id="app"></biq-onboard-app>
  <script type="module" src="/embed/biq-onboard.js"></script>
</body>
</html>`;

async function startServer() {
  server = createServer((req, res) => {
    if (req.url === '/embed/biq-onboard.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end(bundle);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HARNESS);
  });
  await new Promise((r) => server.listen(PORT, r));
}

async function stopServer() {
  await new Promise((r) => server.close(r));
}

const BASE_TEAMS = [
  {
    team_id: 'pt-1', name: 'Paquetillos 1', category_key: 'infantil',
    category_label: 'Infantil', gender: 'M', age_band: '',
    section_applicability: 'all', timezone: 'Europe/Madrid',
    season: '2026-27', team_revision: 1, archived: false,
  },
  {
    team_id: 'pt-2', name: 'Paquetillos 2', category_key: 'infantil',
    category_label: 'Infantil', gender: 'M', age_band: '',
    section_applicability: 'all', timezone: 'Europe/Madrid',
    season: '2026-27', team_revision: 3, archived: false,
  },
];

const BASE_CONTEXT = {
  context_id: 'ctx-personal-1',
  context_epoch: 3,
  owner_scope: { kind: 'personal', workspace_id: 'ws-1', account_id: 'acc-1' },
  team_ids: ['pt-1', 'pt-2'],
  working_team_ids: ['pt-1', 'pt-2'],
  active_team_id: 'pt-1',
};

const ROSTERS = {};
function resetRosters() {
  ROSTERS['pt-1'] = {
    name: 'Paquetillos 1',
    competitive_level: 'regional',
    players: [
      { name: 'Ana Sol', number: 7 },
      { name: 'Bea Luna', number: 12 },
    ],
    team_revision: 1,
  };
  ROSTERS['pt-2'] = {
    name: 'Paquetillos 2',
    competitive_level: 'autonomico',
    players: [{ name: 'Cora Mar', number: 4 }],
    team_revision: 3,
  };
}
resetRosters();

const rosterPayload = (teamId, ctx) => ({
  schema_version: '1.0',
  context_id: ctx.context_id,
  context_epoch: ctx.context_epoch,
  owner_scope: ctx.owner_scope,
  team: { id: teamId, ...ROSTERS[teamId] },
});

/**
 * Personal-context mount with a REAL CAS stub:
 *  - PUT roster validates `expected_revision` against the live store —
 *    a stale CAS gets a genuine 409.
 *  - `lostAckNth: n` — the Nth PUT commits in the store and bumps the
 *    revision BEFORE the delivery to the browser is cut (lost ACK).
 *  - `holdPuts: { [n]: promise }` parks the Nth PUT in flight.
 */
async function newPersonalPage(browser, {
  routeQuery = null,
  context = BASE_CONTEXT,
  teams = BASE_TEAMS,
  lostAckNth = 0,
  holdPuts = {},
} = {}) {
  const page = await browser.newPage();
  const log = [];
  let putCount = 0;
  const live = { ctx: context };

  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const entry = { url: req.url(), method: req.method(), postData: req.postData() };
    log.push(entry);
    const json = (data, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    try {
      const u = req.url();
      if (u.includes('/api/context/v1/bootstrap')) {
        return json({
          schema_version: '1', state: 'context_active', account_id: 'acc-1',
          identity_verified: true, contexts: [], active: live.ctx, entry_actions: {},
        });
      }
      const rosterMatch = u.match(/personal-teams\/([^/]+)\/roster/);
      if (rosterMatch) {
        const teamId = decodeURIComponent(rosterMatch[1]);
        if (req.method() === 'PUT') {
          putCount += 1;
          const n = putCount;
          if (holdPuts[n]) await holdPuts[n];
          const body = JSON.parse(req.postData() || '{}');
          // REAL CAS: stale expected_revision → genuine 409.
          if (body.expected_revision !== ROSTERS[teamId].team_revision) {
            return json({ detail: 'stale team revision' }, 409);
          }
          // The commit lands in the store BEFORE any delivery decision.
          ROSTERS[teamId] = {
            name: body.name,
            competitive_level: body.competitive_level,
            players: body.players,
            team_revision: ROSTERS[teamId].team_revision + 1,
          };
          if (lostAckNth === n) {
            entry.lostAck = true;
            return route.abort('connectionreset'); // commit applied; ACK never arrived
          }
          return json(rosterPayload(teamId, live.ctx));
        }
        return json(rosterPayload(teamId, live.ctx));
      }
      if (u.includes('/api/context/v1/personal-teams')) {
        return json({ teams });
      }
      return json({ ok: true });
    } catch {
      // aborted delivery
    }
  });

  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('biq-onboard-app', { state: 'attached', timeout: 10000 });
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el && el.shadowRoot);
  }, { timeout: 10000 });
  await page.evaluate(({ rq, ctx }) => {
    const el = document.getElementById('app');
    if (rq) el.route = rq;
    el.context = ctx;
    el.org = { club: null, email: 'e2e@basketiq.io', display_name: 'E2E', memberships: [] };
    el.user = 'e2e-user';
  }, { rq: routeQuery, ctx: context });
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el.shadowRoot && el.shadowRoot.childElementCount > 0);
  }, { timeout: 10000 });

  // Second authorized client writing through the SAME intercepted route —
  // its PUT runs the real CAS check and commits in the shared store.
  const otherClientPut = (teamId, payload) => page.evaluate(
    async ({ teamId: t, payload: p }) => {
      const res = await fetch(
        `/api/context/v1/personal-teams/${encodeURIComponent(t)}/roster`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(p),
        },
      );
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    { teamId, payload },
  );

  return { page, log, live, otherClientPut };
}

async function waitModal(page, present = true) {
  await page.waitForFunction(
    (want) =>
      !!document.getElementById('app').shadowRoot
        .querySelector('[data-edit-modal]') === want,
    present, { timeout: 10000 },
  );
}
function rosterPuts(log) {
  return log.filter((e) => e.method === 'PUT' && e.url.includes('/roster'));
}
function rosterGets(log) {
  return log.filter((e) => e.method === 'GET' && e.url.includes('/roster'));
}
async function waitForPuts(log, n, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (rosterPuts(log).length >= n) return rosterPuts(log);
    await new Promise((r) => setTimeout(r, 60));
  }
  return rosterPuts(log);
}
const chipState = () => {
  const m = document.getElementById('app').shadowRoot
    .querySelector('[data-edit-modal]');
  if (!m) return null;
  const chip = m.querySelector('[data-edit-save-status]');
  const detail = m.querySelector('[data-edit-save-detail]');
  const vis = (sel) => {
    const b = m.querySelector(sel);
    return !!b && !b.hidden;
  };
  return {
    status: chip?.className.replace('onboard-save-chip', '').trim() || '',
    chip: chip?.textContent.trim() || '',
    detail: detail?.textContent.trim() || '',
    retryVisible: vis('[data-edit-retry]'),
    keepMineVisible: vis('[data-edit-keep-mine]'),
    loadServerVisible: vis('[data-edit-load-server]'),
  };
};
const editTeamName = (page, value) => page.evaluate((v) => {
  const n = document.getElementById('app').shadowRoot
    .querySelector('[data-edit-team-name]');
  n.value = v;
  n.dispatchEvent(new Event('input', { bubbles: true }));
}, value);
const editRosterNumber = (page, idx, value) => page.evaluate(({ i, v }) => {
  const row = document.getElementById('app').shadowRoot
    .querySelectorAll('[data-roster-row]')[i];
  const num = row.querySelector('[data-player-number]');
  num.value = v;
  num.dispatchEvent(new Event('input', { bubbles: true }));
}, { i: idx, v: value });
const addRosterRow = (page, name, number) => page.evaluate(
  async ({ n, d }) => {
    document.getElementById('app').shadowRoot
      .querySelector('[data-add-player]').click();
    await new Promise((r) => setTimeout(r, 30));
    const rows = document.getElementById('app').shadowRoot
      .querySelectorAll('[data-roster-row]');
    const last = rows[rows.length - 1];
    const nameIn = last.querySelector('[data-player-name]');
    const numIn = last.querySelector('[data-player-number]');
    nameIn.value = n;
    nameIn.dispatchEvent(new Event('input', { bubbles: true }));
    numIn.value = d;
    numIn.dispatchEvent(new Event('input', { bubbles: true }));
  },
  { n: name, d: number },
);
const waitChip = (page, cls, timeout = 10000) => page.waitForFunction(
  (c) => {
    const chip = document.getElementById('app').shadowRoot
      .querySelector('[data-edit-save-status]');
    return chip && chip.classList.contains(c);
  }, cls, { timeout },
);

test.before(async () => { await startServer(); });
test.after(async () => { await stopServer(); });
test.beforeEach(() => resetRosters());

// ─── R2-D3-1: reconciliación real de contenido ─────────────────────────

test('R2-1: real 409 — disjoint change merges: server field adopted, user field resent on fresh CAS', async () => {
  const browser = await chromium.launch();
  try {
    const { page, log, otherClientPut } = await newPersonalPage(browser, {
      routeQuery: 'teams?edit=pt-1',
    });
    await waitModal(page);
    // Another authorized client commits r1 → r2 changing ONLY the name.
    const w = await otherClientPut('pt-1', {
      expected_revision: 1,
      name: 'Paquetillos Élite',
      competitive_level: 'regional',
      players: [
        { name: 'Ana Sol', number: 7 },
        { name: 'Bea Luna', number: 12 },
      ],
    });
    assert.equal(w.status, 200, 'second client commits r1→r2');
    // The user edits the ROSTER (disjoint from the server's name change).
    await addRosterRow(page, 'Duna Río', '9');
    // Autosave PUT rides expected_revision:1 → real 409.
    const puts = await waitForPuts(log, 2); // client's + editor's stale PUT
    assert.equal(rosterPuts(log).length, 2);
    await waitChip(page, 'is-conflict');
    // Reintentar = informed reconcile: read first, compare content,
    // merge disjoint fields, resend on the fresh revision — never blind.
    await page.evaluate(() =>
      document.getElementById('app').shadowRoot
        .querySelector('[data-edit-retry]').click());
    await waitChip(page, 'is-saved');
    const all = rosterPuts(log);
    assert.equal(all.length, 3, '409 → read → exactly one resend on fresh CAS');
    const resent = JSON.parse(all[2].postData);
    assert.equal(resent.expected_revision, 2, 'resend rides the reconciled revision');
    assert.equal(resent.name, 'Paquetillos Élite', 'server-only change merged into the resend');
    assert.equal(resent.players.length, 3, 'user roster preserved through the merge');
    assert.equal(resent.players[2].name, 'Duna Río');
    const st = await page.evaluate(chipState);
    assert.equal(st.keepMineVisible, false, 'disjoint merge never demands a decision');
    // The DOM reflects the adopted field.
    const shown = await page.evaluate(() =>
      document.getElementById('app').shadowRoot
        .querySelector('[data-edit-team-name]').value);
    assert.equal(shown, 'Paquetillos Élite');
    const gets = rosterGets(log);
    assert.ok(gets.length >= 2, 'reconciliation read ran');
    const i409 = log.indexOf(all[1]);
    const iGet = log.indexOf(gets[gets.length - 1]);
    const iPut3 = log.indexOf(all[2]);
    assert.ok(i409 < iGet && iGet < iPut3, 'GET reconciles between the 409 and the resend');
  } finally {
    await browser.close();
  }
});

test('R2-2: real 409 — same-field divergence → informed conflict → Mantener mis cambios wins on fresh CAS', async () => {
  const browser = await chromium.launch();
  try {
    const { page, log, otherClientPut } = await newPersonalPage(browser, {
      routeQuery: 'teams?edit=pt-1',
    });
    await waitModal(page);
    // Second client adds a player (roster diverges on the same field).
    const w = await otherClientPut('pt-1', {
      expected_revision: 1,
      name: 'Paquetillos 1',
      competitive_level: 'regional',
      players: [
        { name: 'Ana Sol', number: 7 },
        { name: 'Bea Luna', number: 12 },
        { name: 'Concurrente Pérez', number: 33 },
      ],
    });
    assert.equal(w.status, 200);
    // The user also edits the roster — same field, different content.
    await addRosterRow(page, 'Duna Río', '9');
    await waitForPuts(log, 2);
    await waitChip(page, 'is-conflict');
    // Reintentar triggers the reconciliation read — the same-field
    // divergence is detected and the informed decision surfaces.
    await page.evaluate(() =>
      document.getElementById('app').shadowRoot
        .querySelector('[data-edit-retry]').click());
    await page.waitForFunction(() => {
      const m = document.getElementById('app').shadowRoot
        .querySelector('[data-edit-modal]');
      const b = m && m.querySelector('[data-edit-keep-mine]');
      return !!b && !b.hidden;
    }, { timeout: 10000 });
    const st = await page.evaluate(chipState);
    assert.equal(st.status, 'is-conflict');
    assert.equal(st.keepMineVisible, true, 'explicit decision offered');
    assert.equal(st.loadServerVisible, true);
    assert.match(st.detail, /plantilla/i, 'conflict names the divergent field');
    assert.match(st.detail, /Concurrente Pérez/, 'server roster disclosed — informed decision');
    assert.equal(rosterPuts(log).length, 2, 'no blind overwrite after the 409');
    // While undecided, further edits never bypass reconciliation.
    await editTeamName(page, 'Nombre durante conflicto');
    await page.waitForTimeout(1200);
    assert.equal(rosterPuts(log).length, 2, 'autosave never bypasses the undecided conflict');
    // Explicit local-wins: resend the user's draft on the fresh revision.
    await page.evaluate(() =>
      document.getElementById('app').shadowRoot
        .querySelector('[data-edit-keep-mine]').click());
    await waitChip(page, 'is-saved');
    const all = rosterPuts(log);
    assert.equal(all.length, 3, 'exactly one resend after the decision');
    const resent = JSON.parse(all[2].postData);
    assert.equal(resent.expected_revision, 2);
    assert.equal(resent.name, 'Nombre durante conflicto', 'live draft — incl. post-conflict edits');
    assert.equal(resent.players.length, 3);
    assert.equal(resent.players[2].name, 'Duna Río');
    // The concurrent player's slot is gone by explicit user decision.
    assert.ok(!resent.players.some((p) => p.name === 'Concurrente Pérez'));
  } finally {
    await browser.close();
  }
});

test('R2-3: real 409 — Cargar versión actual adopts the server state, zero further PUTs', async () => {
  const browser = await chromium.launch();
  try {
    const { page, log, otherClientPut } = await newPersonalPage(browser, {
      routeQuery: 'teams?edit=pt-1',
    });
    await waitModal(page);
    await otherClientPut('pt-1', {
      expected_revision: 1,
      name: 'Paquetillos Servidor',
      competitive_level: 'nacional',
      players: [{ name: 'Única Vera', number: 5 }],
    });
    await editTeamName(page, 'Mi nombre local');
    await waitForPuts(log, 2);
    await waitChip(page, 'is-conflict');
    await page.evaluate(() =>
      document.getElementById('app').shadowRoot
        .querySelector('[data-edit-retry]').click());
    await page.waitForFunction(() => {
      const m = document.getElementById('app').shadowRoot
        .querySelector('[data-edit-modal]');
      const b = m && m.querySelector('[data-edit-keep-mine]');
      return !!b && !b.hidden;
    }, { timeout: 10000 });
    const st = await page.evaluate(chipState);
    assert.match(st.detail, /nombre/i);
    await page.evaluate(() =>
      document.getElementById('app').shadowRoot
        .querySelector('[data-edit-load-server]').click());
    await waitChip(page, 'is-saved');
    const dom = await page.evaluate(() => ({
      name: document.getElementById('app').shadowRoot
        .querySelector('[data-edit-team-name]').value,
      rows: document.getElementById('app').shadowRoot
        .querySelectorAll('[data-roster-row]').length,
    }));
    assert.equal(dom.name, 'Paquetillos Servidor', 'DOM adopts the server version');
    assert.equal(dom.rows, 1, 'server roster rendered');
    assert.equal(rosterPuts(log).length, 2, 'zero PUTs after accepting the server version');
    await page.waitForTimeout(1200);
    assert.equal(rosterPuts(log).length, 2, 'no deferred write fires either');
  } finally {
    await browser.close();
  }
});

test('R2-4: lost ACK — the commit landed, delivery was cut → reconcile recognizes it: ZERO extra PUTs', async () => {
  const browser = await chromium.launch();
  try {
    const { page, log } = await newPersonalPage(browser, {
      routeQuery: 'teams?edit=pt-1', lostAckNth: 1,
    });
    await waitModal(page);
    await editTeamName(page, 'Nombre que sí llegó');
    await waitForPuts(log, 1);
    // The store committed the write; the browser saw a transport error.
    assert.equal(ROSTERS['pt-1'].name, 'Nombre que sí llegó',
      'the write is applied despite the lost ACK');
    assert.equal(ROSTERS['pt-1'].team_revision, 2);
    await waitChip(page, 'is-error');
    const st = await page.evaluate(chipState);
    assert.equal(st.retryVisible, true);
    // Post-loss edits queue separately — reconcile must not eat them.
    await editTeamName(page, 'Nombre posterior');
    // Retry (or any later flush/autosave) reconciles FIRST.
    await page.evaluate(() =>
      document.getElementById('app').shadowRoot
        .querySelector('[data-edit-retry]').click());
    await waitChip(page, 'is-saved');
    const puts = rosterPuts(log);
    const gets = rosterGets(log);
    // PUT1 = lost (committed name 'Nombre que sí llegó'), GET reconcile
    // sees server == sent → no resend of that snapshot; PUT2 carries only
    // the post-edit on the adopted revision.
    assert.equal(puts.length, 2, 'the lost snapshot is never resent');
    const resent = JSON.parse(puts[1].postData);
    assert.equal(resent.name, 'Nombre posterior', 'post-edits send on the fresh revision');
    assert.equal(resent.expected_revision, 2, 'adopted CAS from the reconciliation read');
    const iAbort = log.indexOf(puts[0]);
    const iGet = log.indexOf(gets[gets.length - 1]);
    const iPut2 = log.indexOf(puts[1]);
    assert.ok(iAbort < iGet && iGet < iPut2, 'GET precedes the only resend');
    assert.match(puts[0].postData, /Nombre que sí llegó/);
  } finally {
    await browser.close();
  }
});

// ─── R2-D3-2: ownership de salidas ─────────────────────────────────────

test('R2-5: hung save of retired editor A never blocks B — route flush and Volver proceed; late release harmless', async () => {
  const browser = await chromium.launch();
  try {
    let releaseA;
    const hangA = new Promise((r) => { releaseA = r; });
    const ctxB = {
      context_id: 'ctx-personal-2', context_epoch: 4,
      owner_scope: { kind: 'personal', workspace_id: 'ws-1', account_id: 'acc-1' },
      team_ids: ['pt-1', 'pt-2'], working_team_ids: ['pt-1', 'pt-2'],
      active_team_id: 'pt-2',
    };
    const { page, log, live } = await newPersonalPage(browser, {
      routeQuery: 'teams?edit=pt-1',
      holdPuts: { 1: hangA }, // A's save never resolves while parked
    });
    await waitModal(page);
    await editTeamName(page, 'A colgado');
    await waitForPuts(log, 1); // A's PUT parked in flight
    // Forced transition retires A and opens B under a new scope.
    live.ctx = ctxB;
    await page.evaluate((c) => {
      document.getElementById('app').context = c;
      document.getElementById('app').route = 'teams?edit=pt-2';
    }, ctxB);
    await page.waitForFunction(() => {
      const m = document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]');
      const n = m && m.querySelector('[data-edit-team-name]');
      return n && n.value === 'Paquetillos 2';
    }, { timeout: 10000 });
    // B is dirty → Volver must flush B and close WITHOUT waiting on A.
    await editTeamName(page, 'B cambio');
    await waitForPuts(log, 2); // B's PUT resolves (only #1 hangs)
    const t0 = Date.now();
    await page.evaluate(() =>
      document.getElementById('app').shadowRoot
        .querySelector('[data-cancel-edit]').click());
    await page.waitForFunction(() =>
      !document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]'),
    { timeout: 10000 });
    assert.ok(Date.now() - t0 < 9000, 'B closes without waiting on the hung A request');
    // Reopen B: a route transition with dirty B also proceeds on its own op.
    await page.evaluate((c) => {
      const el = document.getElementById('app');
      el.route = 'teams?edit=pt-2';
    }, ctxB);
    await waitModal(page);
    await editTeamName(page, 'B otra vez');
    await waitForPuts(log, 3);
    await page.evaluate(() => { document.getElementById('app').route = ''; });
    await page.waitForFunction(() =>
      !document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]'),
    { timeout: 10000 });
    // Late release of A: nothing changes for the already-closed B.
    releaseA();
    await page.waitForTimeout(400);
    const closed = await page.evaluate(() =>
      !document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]'));
    assert.equal(closed, true);
    assert.equal(rosterPuts(log).length, 3, 'no stray PUT from the late release');
  } finally {
    await browser.close();
  }
});

test('R2-6: commitLeave(grant) binds to the admission — stale grant never retires B; post-admission edits flush before retiring', async () => {
  const browser = await chromium.launch();
  try {
    const { page, log } = await newPersonalPage(browser, {
      routeQuery: 'teams?edit=pt-1',
    });
    await waitModal(page);
    // Admit A with grant g1 (clean editor admits instantly).
    const g1ok = await page.evaluate(async () => {
      const el = document.getElementById('app');
      window.__grants = { g1: { id: 'g1' }, g2: { id: 'g2' }, g3: { id: 'g3' } };
      return el.requestLeave(window.__grants.g1);
    });
    assert.equal(g1ok, true);
    // Reopen editor B on the SAME element before the commit lands.
    await page.evaluate(() => { document.getElementById('app').route = 'teams?edit=pt-2'; });
    await page.waitForFunction(() => {
      const n = document.getElementById('app').shadowRoot
        .querySelector('[data-edit-modal] [data-edit-team-name]');
      return n && n.value === 'Paquetillos 2';
    }, { timeout: 10000 });
    // A's stale commit must not close B.
    const stillOpen = await page.evaluate(() => {
      const el = document.getElementById('app');
      el.commitLeave(window.__grants.g1);
      return !!el.shadowRoot.querySelector('[data-edit-modal]');
    });
    assert.equal(stillOpen, true, 'commit of the old admission leaves B open');
    // Admit B (g2) → commit closes only with its own grant.
    const g2ok = await page.evaluate(async () =>
      document.getElementById('app').requestLeave(window.__grants.g2));
    assert.equal(g2ok, true);
    await page.evaluate(() => document.getElementById('app').commitLeave(window.__grants.g1));
    const stillOpen2 = await page.evaluate(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]'));
    assert.equal(stillOpen2, true, 'a grant from the previous admission does not match');
    await page.evaluate(() => document.getElementById('app').commitLeave(window.__grants.g2));
    await waitModal(page, false);

    // Post-admission edits: typed AFTER requestLeave admitted — commit
    // flushes them before retiring, never discards.
    await page.evaluate(() => { document.getElementById('app').route = 'teams?edit=pt-1'; });
    await waitModal(page);
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-edit-team-name]'),
    { timeout: 10000 });
    const admitted = await page.evaluate(async () => {
      const el = document.getElementById('app');
      const ok = await el.requestLeave(window.__grants.g3);
      // Type AFTER the admission resolved — before commit.
      const n = el.shadowRoot.querySelector('[data-edit-team-name]');
      n.value = 'Tecleado tras la admisión';
      n.dispatchEvent(new Event('input', { bubbles: true }));
      el.commitLeave(window.__grants.g3);
      return ok;
    });
    assert.equal(admitted, true);
    // The commit waits for the post-admission edit to flush.
    await page.waitForFunction(() =>
      !document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]'),
    { timeout: 15000 });
    const puts = rosterPuts(log);
    assert.equal(puts.length, 1, 'the post-admission edit reached the server');
    assert.match(puts[0].postData, /Tecleado tras la admisión/);
  } finally {
    await browser.close();
  }
});

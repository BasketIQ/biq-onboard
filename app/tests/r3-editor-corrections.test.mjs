/**
 * R3-D3 corrections — shared team editor (personal-port fixture).
 *
 * R3-D3-1: reconcile base with an INVALID draft. A 409 while the user has
 *   a divergent draft, followed by an invalid input BEFORE the informed
 *   read, must NOT adopt the server model as the new base — after fixing
 *   the field the next pass still runs the three-way merge and the
 *   concurrent writer's data is preserved (disjoint → merged; overlapping
 *   → explicit decision). No PUT ever rides a fresh revision obtained
 *   without comparing against the original base.
 *
 * R3-D3-2 (module side): commitLeave is awaitable — resolves true only
 *   when the editor actually retired; post-admission edits trigger a
 *   final flush whose hung/error/invalid outcome resolves false and
 *   RETAINS the editor with its feedback (the caller never unmounts over
 *   an unconfirmed commit).
 *
 * R3-D3-3: Volver with an undecided conflict retains the editor AND keeps
 *   both decisions visible/operable — 'saving' during the close flush
 *   never hides them permanently; zero PUT until an explicit choice.
 *
 * Run: `npm run build:lib && node --test tests/r3-editor-corrections.test.mjs`
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
const PORT = 9157; // free — r1=9153, r2=9156, others 91xx

if (!existsSync(DIST_EMBED)) {
  throw new Error('Build output not found. Run `npm run build:lib` first.');
}

const bundle = readFileSync(DIST_EMBED, 'utf-8');
let server;

const HARNESS = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>r3 editor corrections</title></head>
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

/** Same real-CAS stub as the R2 spec — plus `failPutsNth` to force a
 *  transport-level failure on a chosen PUT (lost delivery, no commit). */
async function newPersonalPage(browser, {
  routeQuery = null,
  context = BASE_CONTEXT,
  teams = BASE_TEAMS,
  lostAckNth = 0,
  failPutsNth = 0,
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
          if (failPutsNth === n) {
            entry.failed = true;
            return route.abort('connectionreset'); // transport dies, no commit
          }
          const body = JSON.parse(req.postData() || '{}');
          if (body.expected_revision !== ROSTERS[teamId].team_revision) {
            return json({ detail: 'stale team revision' }, 409);
          }
          ROSTERS[teamId] = {
            name: body.name,
            competitive_level: body.competitive_level,
            players: body.players,
            team_revision: ROSTERS[teamId].team_revision + 1,
          };
          if (lostAckNth === n) {
            entry.lostAck = true;
            return route.abort('connectionreset');
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
const editRosterName = (page, idx, value) => page.evaluate(({ i, v }) => {
  const row = document.getElementById('app').shadowRoot
    .querySelectorAll('[data-roster-row]')[i];
  const inp = row.querySelector('[data-player-name]');
  inp.value = v;
  inp.dispatchEvent(new Event('input', { bubbles: true }));
}, { i: idx, v: value });
const waitChip = (page, cls, timeout = 10000) => page.waitForFunction(
  (c) => {
    const chip = document.getElementById('app').shadowRoot
      .querySelector('[data-edit-save-status]');
    return chip && chip.classList.contains(c);
  }, cls, { timeout },
);
const clickBtn = (page, sel) => page.evaluate((s) =>
  document.getElementById('app').shadowRoot.querySelector(s).click(), sel);

test.before(async () => { await startServer(); });
test.after(async () => { await stopServer(); });
test.beforeEach(() => resetRosters());

// ─── R3-D3-1: reconciliación con borrador inválido conserva la base ────

test('R3-1: 409 → invalid draft at reconcile keeps the confirmed base — fixed field still merges, concurrent data preserved', async () => {
  const browser = await chromium.launch();
  try {
    const { page, log, otherClientPut } = await newPersonalPage(browser, {
      routeQuery: 'teams?edit=pt-1',
    });
    await waitModal(page);
    // Second writer commits r1→r2: adds a player (roster change).
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
    assert.equal(w.status, 200, 'concurrent writer commits');
    // The user also edits the roster (rename Ana) — same field diverged.
    await editRosterName(page, 0, 'Ana Renombrada');
    const puts = await waitForPuts(log, 2); // client PUT + stale PUT → 409
    assert.equal(rosterPuts(log).length, 2);
    await waitChip(page, 'is-conflict');
    // BEFORE the informed read the user leaves an invalid input: blank a
    // persisted player's name. The reconcile GET lands on !draft.ok.
    await editRosterName(page, 1, '');
    const getsBefore = rosterGets(log).length;
    await clickBtn(page, '[data-edit-retry]');
    // The reconcile runs (real GET) but the draft is invalid: status is
    // pending, NOT resolved — and crucially the base must NOT become the
    // server model (that would turn the user's divergent draft into a
    // one-sided change and silently drop 'Concurrente Pérez'). The chip
    // already showed pending from the invalid input, so the observable
    // signal is the reconcile GET landing in the request log.
    const t0 = Date.now();
    while (rosterGets(log).length <= getsBefore && Date.now() - t0 < 8000) {
      await new Promise((r) => setTimeout(r, 60));
    }
    assert.ok(rosterGets(log).length > getsBefore,
      'reconcile read ran (open + post-409)');
    const pend = await page.evaluate(chipState);
    assert.equal(pend.status, 'is-pending',
      'invalid draft stays pending — the fresh revision is NOT adopted silently');
    assert.equal(rosterPuts(log).length, 2, 'no PUT while the draft is invalid');
    // Repair the field — the next pass MUST reconcile again against the
    // ORIGINAL base: players diverged on both sides → explicit conflict.
    await editRosterName(page, 1, 'Bea Luna');
    await page.waitForFunction(() => {
      const m = document.getElementById('app').shadowRoot
        .querySelector('[data-edit-modal]');
      const b = m && m.querySelector('[data-edit-keep-mine]');
      return !!b && !b.hidden;
    }, { timeout: 10000 });
    const st = await page.evaluate(chipState);
    assert.equal(st.status, 'is-conflict', 'same-field divergence → explicit decision, not silent overwrite');
    assert.equal(st.keepMineVisible, true);
    assert.equal(st.loadServerVisible, true);
    assert.match(st.detail, /plantilla/i);
    // No overwrite happened: the server still holds the concurrent player.
    assert.ok(ROSTERS['pt-1'].players.some((p) => p.name === 'Concurrente Pérez'),
      'concurrent data intact — zero blind writes');
    assert.equal(rosterPuts(log).length, 2, 'still zero PUTs before the decision');
    // Explicit choice: keep mine — the resend rides the reconciled
    // revision and carries the user's roster (deliberate, not blind).
    await clickBtn(page, '[data-edit-keep-mine]');
    await waitChip(page, 'is-saved');
    const all = rosterPuts(log);
    assert.equal(all.length, 3, 'exactly one resend after the decision');
    const resent = JSON.parse(all[2].postData);
    assert.equal(resent.expected_revision, 2, 'resend on the reconciled revision');
    assert.ok(resent.players.some((p) => p.name === 'Ana Renombrada'));
  } finally {
    await browser.close();
  }
});

test('R3-1b: invalid draft at reconcile → fixed → disjoint merge adopts the concurrent player without a decision', async () => {
  const browser = await chromium.launch();
  try {
    const { page, log, otherClientPut } = await newPersonalPage(browser, {
      routeQuery: 'teams?edit=pt-1',
    });
    await waitModal(page);
    // Second writer changes ONLY the roster (adds Concurrente).
    await otherClientPut('pt-1', {
      expected_revision: 1,
      name: 'Paquetillos 1',
      competitive_level: 'regional',
      players: [
        { name: 'Ana Sol', number: 7 },
        { name: 'Bea Luna', number: 12 },
        { name: 'Concurrente Pérez', number: 33 },
      ],
    });
    // The user edits ONLY the name — disjoint from the server change.
    await editTeamName(page, 'Nombre del usuario');
    await waitForPuts(log, 2);
    await waitChip(page, 'is-conflict');
    // Invalid input before the informed read.
    await editRosterName(page, 0, '');
    const getsBefore = rosterGets(log).length;
    await clickBtn(page, '[data-edit-retry]');
    const t0 = Date.now();
    while (rosterGets(log).length <= getsBefore && Date.now() - t0 < 8000) {
      await new Promise((r) => setTimeout(r, 60));
    }
    assert.ok(rosterGets(log).length > getsBefore, 'reconcile read ran');
    const pend = await page.evaluate(chipState);
    assert.equal(pend.status, 'is-pending', 'invalid draft stays pending — base preserved');
    assert.equal(rosterPuts(log).length, 2, 'no PUT while the draft is invalid');
    // Fix → reconcile → disjoint merge: the server roster (with the
    // concurrent player) is adopted into the DOM; the resend carries the
    // user's name AND the merged roster — Concurrente is preserved.
    await editRosterName(page, 0, 'Ana Sol');
    await waitChip(page, 'is-saved');
    const all = rosterPuts(log);
    assert.ok(all.length >= 3, 'resend after the reconcile');
    // Every post-reconcile PUT carries the merged roster — no write ever
    // drops the concurrent player (the revision may advance if a queued
    // pass re-sends identical content on the newer handle).
    for (const p of all.slice(2)) {
      const body = JSON.parse(p.postData);
      assert.ok(body.players.some((pl) => pl.name === 'Concurrente Pérez'),
        'concurrent player preserved in every post-reconcile write');
      assert.ok(body.expected_revision >= 2, 'post-reconcile writes ride a fresh CAS handle');
    }
    const resent = JSON.parse(all[all.length - 1].postData);
    assert.ok(resent.expected_revision >= 2);
    assert.equal(resent.name, 'Nombre del usuario');
    assert.ok(resent.players.some((p) => p.name === 'Concurrente Pérez'),
      'disjoint merge preserved the concurrent player');
    const rows = await page.evaluate(() =>
      document.getElementById('app').shadowRoot
        .querySelectorAll('[data-roster-row]').length);
    assert.equal(rows, 3, 'DOM shows the adopted concurrent roster');
  } finally {
    await browser.close();
  }
});

// ─── R3-D3-3: Volver mantiene la decisión de conflicto operable ────────

test('R3-3: informed conflict → Volver → retained with BOTH decisions visible → resolvable', async () => {
  const browser = await chromium.launch();
  try {
    const { page, log, otherClientPut } = await newPersonalPage(browser, {
      routeQuery: 'teams?edit=pt-1',
    });
    await waitModal(page);
    await otherClientPut('pt-1', {
      expected_revision: 1,
      name: 'Paquetillos 1',
      competitive_level: 'regional',
      players: [
        { name: 'Ana Sol', number: 7 },
        { name: 'Bea Luna', number: 12 },
        { name: 'Concurrente Pérez', number: 33 },
      ],
    });
    await editRosterName(page, 0, 'Ana Renombrada');
    await waitForPuts(log, 2);
    await waitChip(page, 'is-conflict');
    await clickBtn(page, '[data-edit-retry]');
    // Informed conflict: both decisions visible.
    await page.waitForFunction(() => {
      const m = document.getElementById('app').shadowRoot
        .querySelector('[data-edit-modal]');
      const k = m && m.querySelector('[data-edit-keep-mine]');
      const l = m && m.querySelector('[data-edit-load-server]');
      return !!(k && !k.hidden && l && !l.hidden);
    }, { timeout: 10000 });
    // Volver — the close flush hits the undecided conflict and retains;
    // the decisions must be visible and operable again (not stuck in
    // Guardando with hidden buttons).
    await clickBtn(page, '[data-cancel-edit]');
    await page.waitForFunction(() => {
      const m = document.getElementById('app').shadowRoot
        .querySelector('[data-edit-modal]');
      if (!m) return false;
      const chip = m.querySelector('[data-edit-save-status]');
      const k = m.querySelector('[data-edit-keep-mine]');
      const l = m.querySelector('[data-edit-load-server]');
      return !!(chip && chip.classList.contains('is-conflict') &&
        k && !k.hidden && l && !l.hidden);
    }, { timeout: 10000 });
    assert.equal(rosterPuts(log).length, 2, 'zero PUTs — retention, not silent write');
    // Decide after the retained Volver — the choice must still work.
    await clickBtn(page, '[data-edit-keep-mine]');
    await waitChip(page, 'is-saved');
    const all = rosterPuts(log);
    assert.equal(all.length, 3, 'one resend after the explicit decision');
    const resent = JSON.parse(all[2].postData);
    assert.equal(resent.expected_revision, 2);
    assert.ok(resent.players.some((p) => p.name === 'Ana Renombrada'));
  } finally {
    await browser.close();
  }
});

// ─── R3-D3-2: commitLeave awaitable — retención real en la fase final ──

test('R3-2a: commitLeave resolves true on clean retire; post-admission edit flushes then retires', async () => {
  const browser = await chromium.launch();
  try {
    const { page, log } = await newPersonalPage(browser, {
      routeQuery: 'teams?edit=pt-1',
    });
    await waitModal(page);
    // Clean commit: admitted with no drift → true immediately.
    const clean = await page.evaluate(async () => {
      const g = { id: 'clean' };
      const ok = await document.getElementById('app').requestLeave(g);
      if (!ok) return { ok };
      const committed = await document.getElementById('app').commitLeave(g);
      return { ok, committed };
    });
    assert.deepEqual(clean, { ok: true, committed: true });
    await waitModal(page, false);

    // Post-admission drift + healthy final flush → still true (flushed).
    await page.evaluate(() => { document.getElementById('app').route = 'teams?edit=pt-1'; });
    await waitModal(page);
    const drift = await page.evaluate(async () => {
      const el = document.getElementById('app');
      const g = { id: 'drift' };
      const ok = await el.requestLeave(g);
      if (!ok) return { ok };
      const n = el.shadowRoot.querySelector('[data-edit-team-name]');
      n.value = 'Edición tras admisión';
      n.dispatchEvent(new Event('input', { bubbles: true }));
      const committed = await el.commitLeave(g); // awaits the final flush
      return { ok, committed, open: !!el.shadowRoot.querySelector('[data-edit-modal]') };
    });
    assert.deepEqual(drift, { ok: true, committed: true, open: false });
    const puts = rosterPuts(log);
    assert.equal(puts.length, 1, 'the post-admission edit was persisted before retiring');
    assert.match(puts[0].postData, /Edición tras admisión/);
  } finally {
    await browser.close();
  }
});

test('R3-2b: post-admission edit + failing final flush → commitLeave false, editor retained, zero data loss', async () => {
  const browser = await chromium.launch();
  try {
    const { page, log } = await newPersonalPage(browser, {
      routeQuery: 'teams?edit=pt-1', failPutsNth: 1,
    });
    await waitModal(page);
    const res = await page.evaluate(async () => {
      const el = document.getElementById('app');
      const g = { id: 'failing' };
      const ok = await el.requestLeave(g); // clean editor admits fast
      if (!ok) return { ok };
      const n = el.shadowRoot.querySelector('[data-edit-team-name]');
      n.value = 'Se perdería sin retención';
      n.dispatchEvent(new Event('input', { bubbles: true }));
      const committed = await el.commitLeave(g); // final flush → transport dies
      return {
        ok, committed,
        open: !!el.shadowRoot.querySelector('[data-edit-modal]'),
        chip: el.shadowRoot.querySelector('[data-edit-save-status]')?.className || '',
      };
    });
    assert.equal(res.ok, true);
    assert.equal(res.committed, false, 'failed final flush retains — the caller must NOT unmount');
    assert.equal(res.open, true, 'editor stays with the unsaved draft');
    assert.match(res.chip, /is-error/);
    // Server state untouched: the late edit never committed.
    assert.equal(ROSTERS['pt-1'].name, 'Paquetillos 1');
    assert.equal(rosterPuts(log).length, 1);
  } finally {
    await browser.close();
  }
});

test('R3-2c: post-admission INVALID edit → commitLeave false (no PUT possible), then a fresh admit+commit retires', async () => {
  const browser = await chromium.launch();
  try {
    const { page, log } = await newPersonalPage(browser, {
      routeQuery: 'teams?edit=pt-1',
    });
    await waitModal(page);
    const res = await page.evaluate(async () => {
      const el = document.getElementById('app');
      const g = { id: 'invalid' };
      const ok = await el.requestLeave(g);
      if (!ok) return { ok };
      const row = el.shadowRoot.querySelectorAll('[data-roster-row]')[0];
      const inp = row.querySelector('[data-player-name]');
      inp.value = '';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      const committed = await el.commitLeave(g); // invalid → cannot send
      return {
        ok, committed,
        open: !!el.shadowRoot.querySelector('[data-edit-modal]'),
        chip: el.shadowRoot.querySelector('[data-edit-save-status]')?.className || '',
      };
    });
    assert.equal(res.ok, true);
    assert.equal(res.committed, false, 'invalid draft retains — no PUT possible');
    assert.equal(res.open, true);
    assert.match(res.chip, /is-pending/);
    assert.equal(rosterPuts(log).length, 0, 'zero writes');
    // Fix the field and run a NEW admission+commit — retires cleanly.
    const res2 = await page.evaluate(async () => {
      const el = document.getElementById('app');
      const row = el.shadowRoot.querySelectorAll('[data-roster-row]')[0];
      const inp = row.querySelector('[data-player-name]');
      inp.value = 'Ana Sol';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      const g2 = { id: 'second' };
      const ok = await el.requestLeave(g2); // flush sends the repaired draft
      if (!ok) return { ok };
      const committed = await el.commitLeave(g2);
      return { ok, committed, open: !!el.shadowRoot.querySelector('[data-edit-modal]') };
    });
    assert.deepEqual(res2, { ok: true, committed: true, open: false });
    assert.equal(rosterPuts(log).length, 1);
  } finally {
    await browser.close();
  }
});

test('R3-2d: hung final flush — commitLeave stays pending (never resolves early), resolves true when it lands', async () => {
  const browser = await chromium.launch();
  try {
    let release;
    const hang = new Promise((r) => { release = r; });
    const { page, log } = await newPersonalPage(browser, {
      routeQuery: 'teams?edit=pt-1', holdPuts: { 1: hang },
    });
    await waitModal(page);
    const pending = await page.evaluate(async () => {
      const el = document.getElementById('app');
      const g = { id: 'hung' };
      const ok = await el.requestLeave(g);
      if (!ok) return { ok };
      const n = el.shadowRoot.querySelector('[data-edit-team-name]');
      n.value = 'Flush colgado';
      n.dispatchEvent(new Event('input', { bubbles: true }));
      window.__commitResult = undefined;
      el.commitLeave(g).then((v) => { window.__commitResult = v; });
      return { ok };
    });
    assert.equal(pending.ok, true);
    // Give the flush time to reach the parked PUT; commit stays pending.
    await waitForPuts(log, 1);
    await page.waitForTimeout(800);
    const mid = await page.evaluate(() => ({
      result: window.__commitResult,
      open: !!document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]'),
    }));
    assert.equal(mid.result, undefined, 'commit still awaiting the hung flush');
    assert.equal(mid.open, true, 'editor retained while the commit is in flight');
    release();
    await page.waitForFunction(() => window.__commitResult === true, { timeout: 10000 });
    await waitModal(page, false);
    const puts = rosterPuts(log);
    assert.equal(puts.length, 1);
    assert.match(puts[0].postData, /Flush colgado/, 'the late PUT carried the post-admission edit');
  } finally {
    await browser.close();
  }
});

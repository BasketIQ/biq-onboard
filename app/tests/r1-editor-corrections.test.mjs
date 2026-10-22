/**
 * R1-D3 corrections — shared team editor (personal-port fixture).
 *
 * R1-D3-1: roster rows are never dropped implicitly — a cleared name on a
 *   persisted player or an incomplete new row blocks the save as
 *   pending/invalid; the only delete path is the explicit remove control.
 * R1-D3-2: queued/in-flight save work is fenced to the editor owner
 *   (teamId+generation+context fence); retirement and a context move bury
 *   stale work — a late response never mutates a successor editor.
 * R1-D3-3 (module side): requestLeave admits without destroying state —
 *   commitLeave retires only once the transition is applied.
 * R1-D3-4: conflict and uncertain transport outcomes never resend blind —
 *   Reintentar reconciles with a read first and resends the live draft
 *   over the fresh CAS revision.
 *
 * Run: `npm run build:lib && node --test tests/r1-editor-corrections.test.mjs`
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
const PORT = 9153;

if (!existsSync(DIST_EMBED)) {
  throw new Error('Build output not found. Run `npm run build:lib` first.');
}

const bundle = readFileSync(DIST_EMBED, 'utf-8');
let server;

const HARNESS = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>r1 editor corrections</title></head>
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
    team_id: 'pt-1',
    name: 'Paquetillos 1',
    category_key: 'infantil',
    category_label: 'Infantil',
    gender: 'M',
    age_band: '',
    section_applicability: 'all',
    timezone: 'Europe/Madrid',
    season: '2026-27',
    team_revision: 1,
    archived: false,
  },
];

const BASE_CONTEXT = {
  context_id: 'ctx-personal-1',
  context_epoch: 3,
  owner_scope: { kind: 'personal', workspace_id: 'ws-1', account_id: 'acc-1' },
  team_ids: ['pt-1'],
  working_team_ids: ['pt-1'],
  active_team_id: 'pt-1',
};

// Per-team live roster store — the PUT mutates it and the revision bumps,
// mirroring the real CAS endpoint.
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
 * Mounts the app under a personal context.
 * `routeQuery` presets el.route; `teams`/`context` extend the fixture;
 * `putHold` parks every PUT (promise or per-request fn); `putAbort`
 * faults the Nth PUT at transport level (uncertain outcome); `put409`
 * answers the Nth PUT with a conflict; `rosterHold` parks GETs.
 */
async function newPersonalPage(browser, {
  routeQuery = null,
  teams = BASE_TEAMS,
  context = null,
  putHold = null,
  putAbort = 0,
  put409 = 0,
  rosterHold = null,
} = {}) {
  const page = await browser.newPage();
  const log = [];
  let putCount = 0;
  // Echo validation binds each roster envelope to the live context — tests
  // that swap el.context mid-flight update `live.ctx` alongside.
  const live = { ctx: context || BASE_CONTEXT };

  await page.route('**/api/**', async (route) => {
    const req = route.request();
    // Log BEFORE any await — a parked request is observable in-flight.
    const entry = { url: req.url(), method: req.method(), postData: req.postData() };
    log.push(entry);
    const json = (data, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    try {
      const u = req.url();
      if (u.includes('/api/context/v1/bootstrap')) {
        return json({
          schema_version: '1',
          state: 'context_active',
          account_id: 'acc-1',
          identity_verified: true,
          contexts: [],
          active: context || BASE_CONTEXT,
          entry_actions: {},
        });
      }
      const rosterMatch = u.match(/personal-teams\/([^/]+)\/roster/);
      if (rosterMatch) {
        const teamId = decodeURIComponent(rosterMatch[1]);
        if (req.method() === 'PUT') {
          putCount += 1;
          const n = putCount;
          if (putAbort === n) {
            entry.aborted = true;
            return route.abort('connectionreset');
          }
          if (putHold) await (typeof putHold === 'function' ? putHold(n) : putHold);
          if (put409 === n) {
            return json({ detail: 'stale team revision' }, 409);
          }
          const body = JSON.parse(req.postData() || '{}');
          ROSTERS[teamId] = {
            name: body.name,
            competitive_level: body.competitive_level,
            players: body.players,
            team_revision: ROSTERS[teamId].team_revision + 1,
          };
          return json(rosterPayload(teamId, live.ctx));
        }
        if (rosterHold) await rosterHold;
        return json(rosterPayload(teamId, live.ctx));
      }
      if (u.includes('/api/context/v1/personal-teams')) {
        return json({ teams });
      }
      return json({ ok: true });
    } catch {
      // aborted
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
  }, { rq: routeQuery, ctx: context || BASE_CONTEXT });
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el.shadowRoot && el.shadowRoot.childElementCount > 0);
  }, { timeout: 10000 });

  return { page, log, live };
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
  return {
    status: chip?.className.replace('onboard-save-chip', '').trim() || '',
    chip: chip?.textContent.trim() || '',
    detail: detail?.textContent.trim() || '',
    retryVisible: !!m.querySelector('[data-edit-retry]') && !m.querySelector('[data-edit-retry]').hidden,
  };
};

test.before(async () => { await startServer(); });
test.after(async () => { await stopServer(); });
test.beforeEach(() => resetRosters());

// ─── R1-D3-1: ninguna fila se descarta implícitamente ───────────────────

test('D3-1: clearing a persisted player name blocks the save — no implicit drop, no Guardado', async () => {
  const browser = await chromium.launch();
  try {
    const { page, log } = await newPersonalPage(browser, { routeQuery: 'teams?edit=pt-1' });
    await waitModal(page);
    await page.waitForFunction(() =>
      document.getElementById('app').shadowRoot
        .querySelectorAll('[data-roster-row]').length === 2,
    { timeout: 10000 });
    // Clear Ana Sol's name — a draft input, not a deletion.
    await page.evaluate(() => {
      const row = document.getElementById('app').shadowRoot
        .querySelectorAll('[data-roster-row]')[0];
      const input = row.querySelector('[data-player-name]');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(1200); // debounce window + slack
    assert.equal(rosterPuts(log).length, 0, 'incomplete row never produces a PUT');
    const st = await page.evaluate(chipState);
    assert.match(st.chip, /pendiente/i, 'chip stays pending, never Guardado');
    assert.match(st.detail, /nombre/i, 'validation names the missing-name cause');
    // The row and the rest of the draft are still there.
    const rows = await page.evaluate(() =>
      document.getElementById('app').shadowRoot
        .querySelectorAll('[data-roster-row]').length);
    assert.equal(rows, 2, 'the cleared row is retained, not dropped');
    // Restore the name — the save now carries BOTH players (no implicit drop).
    await page.evaluate(() => {
      const row = document.getElementById('app').shadowRoot
        .querySelectorAll('[data-roster-row]')[0];
      const input = row.querySelector('[data-player-name]');
      input.value = 'Ana Solana';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const puts = await waitForPuts(log, 1);
    assert.equal(puts.length, 1);
    const sent = JSON.parse(puts[0].postData);
    assert.equal(sent.players.length, 2, 'persisted player survives the cleared-name episode');
    assert.deepEqual(
      sent.players.map((p) => p.name).sort(),
      ['Ana Solana', 'Bea Luna'],
    );
  } finally {
    await browser.close();
  }
});

test('D3-1: a new row with a dorsal but no name stays invalid — never filtered out', async () => {
  const browser = await chromium.launch();
  try {
    const { page, log } = await newPersonalPage(browser, { routeQuery: 'teams?edit=pt-1' });
    await waitModal(page);
    await page.waitForFunction(() =>
      document.getElementById('app').shadowRoot
        .querySelector('[data-add-player]'),
    { timeout: 10000 });
    await page.evaluate(() =>
      document.getElementById('app').shadowRoot.querySelector('[data-add-player]').click());
    await page.waitForFunction(() =>
      document.getElementById('app').shadowRoot
        .querySelectorAll('[data-roster-row]').length === 3,
    { timeout: 10000 });
    // Dorsal only on the new row — incomplete, never a clean payload.
    await page.evaluate(() => {
      const rows = document.getElementById('app').shadowRoot
        .querySelectorAll('[data-roster-row]');
      const input = rows[2].querySelector('[data-player-number]');
      input.value = '9';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(1200);
    assert.equal(rosterPuts(log).length, 0, 'incomplete new row produces no write');
    const st = await page.evaluate(chipState);
    assert.match(st.chip, /pendiente/i);
    assert.match(st.detail, /nombre|fila/i);
    // Completing the row unblocks the save with all three players.
    await page.evaluate(() => {
      const rows = document.getElementById('app').shadowRoot
        .querySelectorAll('[data-roster-row]');
      const input = rows[2].querySelector('[data-player-name]');
      input.value = 'Duna Río';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const puts = await waitForPuts(log, 1);
    const sent = JSON.parse(puts[0].postData);
    assert.equal(sent.players.length, 3);
    assert.deepEqual(sent.players[2], { name: 'Duna Río', number: 9 });
  } finally {
    await browser.close();
  }
});

test('D3-1: the explicit remove control is the only delete path — it persists the deletion', async () => {
  const browser = await chromium.launch();
  try {
    const { page, log } = await newPersonalPage(browser, { routeQuery: 'teams?edit=pt-1' });
    await waitModal(page);
    await page.waitForFunction(() =>
      document.getElementById('app').shadowRoot
        .querySelectorAll('[data-remove-player]').length === 2,
    { timeout: 10000 });
    await page.evaluate(() =>
      document.getElementById('app').shadowRoot
        .querySelector('[data-remove-player]').click());
    const puts = await waitForPuts(log, 1);
    assert.equal(puts.length, 1, 'explicit removal persists immediately');
    const sent = JSON.parse(puts[0].postData);
    assert.equal(sent.players.length, 1, 'the removed player is gone from the payload');
    assert.deepEqual(sent.players[0], { name: 'Bea Luna', number: 12 });
  } finally {
    await browser.close();
  }
});

// ─── R1-D3-2: trabajos encolados/en vuelo vallados al dueño ─────────────

test('D3-2: a queued save under a retired owner never fires and never mutates', async () => {
  const browser = await chromium.launch();
  try {
    const { page, log } = await newPersonalPage(browser, { routeQuery: 'teams?edit=pt-1' });
    await waitModal(page);
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-edit-team-name]'),
    { timeout: 10000 });
    // Edit → debounce armed (save not yet fired) → context move retires.
    await page.evaluate(() => {
      const m = document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]');
      const n = m.querySelector('[data-edit-team-name]');
      n.value = 'Cambio que no debe salir';
      n.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.evaluate(() => {
      document.getElementById('app').context = {
        context_id: 'ctx-personal-2',
        context_epoch: 9,
        owner_scope: { kind: 'personal', workspace_id: 'ws-2', account_id: 'acc-2' },
        team_ids: [], working_team_ids: [],
      };
    });
    await page.waitForTimeout(1200); // debounce window fully elapsed
    assert.equal(rosterPuts(log).length, 0, 'retired owner never writes');
    const closed = await page.evaluate(() =>
      !document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]'));
    assert.equal(closed, true);
  } finally {
    await browser.close();
  }
});

test('D3-2: an in-flight save retired mid-flight cannot mutate the successor editor', async () => {
  const browser = await chromium.launch();
  try {
    let release;
    const hold = new Promise((r) => { release = r; });
    const ctx = {
      ...BASE_CONTEXT,
      team_ids: ['pt-1', 'pt-2'],
      working_team_ids: ['pt-1', 'pt-2'],
    };
    const teams = [
      ...BASE_TEAMS,
      { ...BASE_TEAMS[0], team_id: 'pt-2', name: 'Paquetillos 2', team_revision: 3 },
    ];
    const { page, log, live } = await newPersonalPage(browser, {
      routeQuery: 'teams?edit=pt-1', context: ctx, teams, putHold: hold,
    });
    await waitModal(page);
    // Edit pt-1 → PUT parked in flight (generation A).
    await page.evaluate(() => {
      const n = document.getElementById('app').shadowRoot
        .querySelector('[data-edit-team-name]');
      n.value = 'Nombre A';
      n.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await waitForPuts(log, 1);
    // Scope bump retires A; open B (pt-2) under the new scope.
    const ctxB = {
      context_id: 'ctx-personal-2',
      context_epoch: 4,
      owner_scope: { kind: 'personal', workspace_id: 'ws-1', account_id: 'acc-1' },
      team_ids: ['pt-1', 'pt-2'],
      working_team_ids: ['pt-1', 'pt-2'],
      active_team_id: 'pt-2',
    };
    live.ctx = ctxB; // roster envelopes must echo the scope they serve
    await page.evaluate((c) => {
      document.getElementById('app').context = c;
      document.getElementById('app').route = 'teams?edit=pt-2';
    }, ctxB);
    await page.waitForFunction(() => {
      const m = document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]');
      const n = m && m.querySelector('[data-edit-team-name]');
      return n && n.value === 'Paquetillos 2';
    }, { timeout: 10000 });
    // The parked PUT resolves — its 'saved' response belongs to owner A.
    release();
    await page.waitForTimeout(500);
    const st = await page.evaluate(chipState);
    assert.equal(st.status, 'is-idle', 'editor B untouched by the stale A response');
    const name = await page.evaluate(() =>
      document.getElementById('app').shadowRoot
        .querySelector('[data-edit-team-name]').value);
    assert.equal(name, 'Paquetillos 2', 'B draft never overwritten by A');
    assert.equal(rosterPuts(log).length, 1, 'no successor save spawned by the stale job');
  } finally {
    await browser.close();
  }
});

test('D3-2/D3-3: requestLeave admits without destroying; commitLeave retires; deny retains', async () => {
  const browser = await chromium.launch();
  try {
    const { page, log } = await newPersonalPage(browser, { routeQuery: 'teams?edit=pt-1' });
    await waitModal(page);
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-edit-team-name]'),
    { timeout: 10000 });
    // Clean state: admit is instant and NON-destructive.
    const clean = await page.evaluate(async () => {
      const el = document.getElementById('app');
      const r1 = el.requestLeave();
      const r2 = el.requestLeave(); // coalesced — same flush
      const results = await Promise.all([r1, r2]);
      return { results, modalOpen: !!el.shadowRoot.querySelector('[data-edit-modal]') };
    });
    assert.deepEqual(clean.results, [true, true], 'shared flush admits both callers');
    assert.equal(clean.modalOpen, true, 'admit never retires the editor');
    // Commit retires.
    await page.evaluate(() => document.getElementById('app').commitLeave());
    await page.waitForFunction(() =>
      !document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]'),
    { timeout: 10000 });
    // Reopen, make it invalid → deny retains with feedback.
    await page.evaluate(() => { document.getElementById('app').route = 'teams?edit=pt-1'; });
    await waitModal(page);
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-edit-team-name]'),
    { timeout: 10000 });
    await page.evaluate(() => {
      const row = document.getElementById('app').shadowRoot
        .querySelectorAll('[data-roster-row]')[0];
      const num = row.querySelector('[data-player-number]');
      num.value = 'ab';
      num.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(1200);
    const denied = await page.evaluate(async () => {
      const el = document.getElementById('app');
      const ok = await el.requestLeave();
      const m = el.shadowRoot.querySelector('[data-edit-modal]');
      return {
        ok,
        modalOpen: !!m,
        chip: m?.querySelector('[data-edit-save-status]')?.textContent.trim() || '',
      };
    });
    assert.equal(denied.ok, false, 'invalid draft denies the leave');
    assert.equal(denied.modalOpen, true, 'denied leave keeps the editor');
    assert.match(denied.chip, /pendiente/i);
    // Fix the draft → flush succeeds → admit; commit closes.
    await page.evaluate(() => {
      const row = document.getElementById('app').shadowRoot
        .querySelectorAll('[data-roster-row]')[0];
      const num = row.querySelector('[data-player-number]');
      num.value = '7';
      num.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await waitForPuts(log, 1);
    const ok = await page.evaluate(async () =>
      document.getElementById('app').requestLeave());
    assert.equal(ok, true, 'flushed editor admits');
    await page.evaluate(() => document.getElementById('app').commitLeave());
    await page.waitForFunction(() =>
      !document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]'),
    { timeout: 10000 });
  } finally {
    await browser.close();
  }
});

// ─── R1-D3-4: nunca un reenvío a ciegas — reconciliación primero ────────

test('D3-4: uncertain transport outcome — Reintentar reconciles with a read before resending', async () => {
  const browser = await chromium.launch();
  try {
    const { page, log } = await newPersonalPage(browser, {
      routeQuery: 'teams?edit=pt-1', putAbort: 1,
    });
    await waitModal(page);
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-edit-team-name]'),
    { timeout: 10000 });
    await page.evaluate(() => {
      const n = document.getElementById('app').shadowRoot
        .querySelector('[data-edit-team-name]');
      n.value = 'Nombre incierto';
      n.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(() => {
      const chip = document.getElementById('app').shadowRoot
        .querySelector('[data-edit-save-status]');
      return chip && chip.classList.contains('is-error');
    }, { timeout: 10000 });
    const st = await page.evaluate(chipState);
    assert.match(st.detail, /estado actual/i, 'uncertainty explained before resend');
    assert.equal(st.retryVisible, true);
    // The write may have committed elsewhere — simulate the server moving
    // to revision 7 before the user retries.
    ROSTERS['pt-1'].team_revision = 7;
    const putsBefore = rosterPuts(log).length;
    await page.evaluate(() =>
      document.getElementById('app').shadowRoot.querySelector('[data-edit-retry]').click());
    await page.waitForFunction(() => {
      const chip = document.getElementById('app').shadowRoot
        .querySelector('[data-edit-save-status]');
      return chip && chip.classList.contains('is-saved');
    }, { timeout: 10000 });
    const putsAfter = rosterPuts(log);
    const gets = rosterGets(log);
    assert.equal(putsAfter.length, putsBefore + 1, 'exactly one resend — never blind duplicates');
    const lastPut = putsAfter[putsAfter.length - 1];
    const lastGet = gets[gets.length - 1];
    assert.ok(lastGet, 'a reconciliation GET ran');
    const putIdx = log.indexOf(lastPut);
    assert.ok(log.indexOf(lastGet) < putIdx, 'reconciliation read precedes the resend');
    const body = JSON.parse(lastPut.postData);
    assert.equal(body.expected_revision, 7, 'resend carries the reconciled CAS revision');
    assert.equal(body.name, 'Nombre incierto', 'the live draft is what resends');
  } finally {
    await browser.close();
  }
});

test('D3-4: a 409 explains the conflict and retries over the reconciled revision only', async () => {
  const browser = await chromium.launch();
  try {
    const { page, log } = await newPersonalPage(browser, {
      routeQuery: 'teams?edit=pt-1', put409: 1,
    });
    await waitModal(page);
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-edit-team-name]'),
    { timeout: 10000 });
    await page.evaluate(() => {
      const n = document.getElementById('app').shadowRoot
        .querySelector('[data-edit-team-name]');
      n.value = 'Nombre en conflicto';
      n.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(() => {
      const chip = document.getElementById('app').shadowRoot
        .querySelector('[data-edit-save-status]');
      return chip && chip.classList.contains('is-conflict');
    }, { timeout: 10000 });
    const st = await page.evaluate(chipState);
    assert.match(st.detail, /cambi[oó]|reintent/i, 'conflict explained to the user');
    assert.equal(rosterPuts(log).length, 1, 'no automatic resend after 409');
    ROSTERS['pt-1'].team_revision = 4; // the competing write committed
    await page.evaluate(() =>
      document.getElementById('app').shadowRoot.querySelector('[data-edit-retry]').click());
    await page.waitForFunction(() => {
      const chip = document.getElementById('app').shadowRoot
        .querySelector('[data-edit-save-status]');
      return chip && chip.classList.contains('is-saved');
    }, { timeout: 10000 });
    const puts = rosterPuts(log);
    assert.equal(puts.length, 2, 'one informed resend');
    const getIdx = log.indexOf(rosterGets(log).at(-1));
    assert.ok(getIdx > log.indexOf(puts[0]) && getIdx < log.indexOf(puts[1]),
      'GET reconciliation between the conflicting PUT and the resend');
    assert.equal(JSON.parse(puts[1].postData).expected_revision, 4,
      'resend rides the reconciled revision');
    // Draft preserved: user edit is what was resent.
    assert.equal(JSON.parse(puts[1].postData).name, 'Nombre en conflicto');
  } finally {
    await browser.close();
  }
});

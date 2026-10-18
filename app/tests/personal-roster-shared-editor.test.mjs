/**
 * SF1 — the personal roster shares the club team editor.
 *
 * Under an active personal context, `#/onboard/teams?edit=<id>` (and the
 * legacy `#/onboard/spaces?edit=<id>` alias) opens the SAME editor
 * renderer/handlers as the club surface, backed by the own-workspace
 * roster API:
 *   GET/PUT /api/context/v1/personal-teams/{team_id}/roster
 * with the team_revision CAS in `expected_revision`.
 *
 * Run: `npm run build:lib && node --test tests/personal-roster-shared-editor.test.mjs`
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
const PORT = 9147;

if (!existsSync(DIST_EMBED)) {
  throw new Error('Build output not found. Run `npm run build:lib` first.');
}

const bundle = readFileSync(DIST_EMBED, 'utf-8');
let server;

const HARNESS = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>personal roster editor</title></head>
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

const PERSONAL_TEAMS = [
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

const PERSONAL_CONTEXT = {
  context_id: 'ctx-personal-1',
  context_epoch: 3,
  owner_scope: { kind: 'personal', workspace_id: 'ws-1', account_id: 'acc-1' },
  team_ids: ['pt-1'],
  working_team_ids: ['pt-1'],
  active_team_id: 'pt-1',
};

let ROSTER = {
  name: 'Paquetillos 1',
  competitive_level: 'regional',
  players: [{ name: 'Ana Sol', number: 7 }],
  team_revision: 1,
};

const rosterPayload = () => ({
  schema_version: '1.0',
  context_id: 'ctx-personal-1',
  context_epoch: 3,
  owner_scope: PERSONAL_CONTEXT.owner_scope,
  team: { id: 'pt-1', ...ROSTER },
});

/**
 * Mounts the app under a personal context. `routeQuery` presets el.route;
 * `rosterStatus` fails the roster endpoint; `rosterHold`/`putHold` park
 * the GET/PUT until released (stale-response + late-save fencing) —
 * `putHold` may be a promise applied to every PUT or a function called
 * per request so distinct saves get distinct gates;
 * `rosterBody` replaces the served payload (echo-mismatch coverage);
 * `context` replaces the injected descriptor (working-set coverage).
 */
async function newPersonalPage(browser, { routeQuery = null, rosterStatus = 200, rosterHold = null, putHold = null, rosterBody = null, context = null } = {}) {
  const page = await browser.newPage();
  const log = [];

  await page.route('**/api/**', async (route) => {
    const req = route.request();
    log.push({ url: req.url(), method: req.method(), postData: req.postData() });
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
          active: PERSONAL_CONTEXT,
          entry_actions: {},
        });
      }
      if (u.match(/personal-teams\/[^/]+\/roster/)) {
        if (rosterStatus !== 200) return json({ detail: 'denied' }, rosterStatus);
        if (req.method() === 'PUT') {
          if (putHold) await (typeof putHold === 'function' ? putHold() : putHold);
          const body = JSON.parse(req.postData() || '{}');
          ROSTER = {
            name: body.name,
            competitive_level: body.competitive_level,
            players: body.players,
            team_revision: ROSTER.team_revision + 1,
          };
          return json(rosterBody ? rosterBody(req) : rosterPayload());
        }
        if (rosterHold) await rosterHold;
        return json(rosterBody ? rosterBody(req) : rosterPayload());
      }
      if (u.includes('/api/context/v1/personal-teams')) {
        return json({ teams: PERSONAL_TEAMS });
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
  }, { rq: routeQuery, ctx: context || PERSONAL_CONTEXT });
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el.shadowRoot && el.shadowRoot.childElementCount > 0);
  }, { timeout: 10000 });

  return { page, log };
}

const sr = () => document.getElementById('app').shadowRoot;

// Autosave helpers (UX v2): edición real = value + input event; el debounce
// (~600ms) encola el PUT. `saveSettles` espera a que la petición aterrice.
const typeIn = (el, value) => {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
async function waitForPuts(log, n, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const puts = log.filter((e) => e.method === 'PUT' && e.url.includes('/roster'));
    if (puts.length >= n) return puts;
    await new Promise((r) => setTimeout(r, 60));
  }
  return log.filter((e) => e.method === 'PUT' && e.url.includes('/roster'));
}

test.before(async () => { await startServer(); });
test.after(async () => { await stopServer(); });

test('personal teams?edit opens the SHARED editor via the roster API', async () => {
  const browser = await chromium.launch();
  try {
    const { page, log } = await newPersonalPage(browser, { routeQuery: 'teams?edit=pt-1' });
    await page.waitForFunction(() => {
      const m = document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]');
      return m && m.querySelector('[data-player-name="0"]');
    }, { timeout: 10000 });

    const view = await page.evaluate(() => {
      const m = document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]');
      return {
        name: m.querySelector('[data-edit-team-name]').value,
        level: m.querySelector('[data-edit-team-level]').value,
        player: m.querySelector('[data-player-name="0"]').value,
        number: m.querySelector('[data-player-number="0"]').value,
      };
    });
    assert.equal(view.name, 'Paquetillos 1');
    assert.equal(view.level, 'regional');
    assert.equal(view.player, 'Ana Sol');
    assert.equal(view.number, '7');
    const getCalls = log.filter((e) => e.url.includes('/roster') && e.method === 'GET');
    assert.equal(getCalls.length, 1, 'roster load went through the personal port');
  } finally {
    await browser.close();
  }
});

test('autosave sends expected_revision + full replace roster to the roster API', async () => {
  const browser = await chromium.launch();
  try {
    const { page, log } = await newPersonalPage(browser, { routeQuery: 'teams?edit=pt-1' });
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-player-name="0"]'),
    { timeout: 10000 });
    // No Guardar/Cancelar — autosave chip present instead.
    const controls = await page.evaluate(() => {
      const m = document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]');
      return {
        save: !!m.querySelector('[data-save-team]'),
        chip: !!m.querySelector('[data-edit-save-status]'),
        back: m.querySelector('[data-cancel-edit]')?.textContent.trim(),
      };
    });
    assert.equal(controls.save, false, 'no Guardar control under autosave');
    assert.equal(controls.chip, true, 'discrete save-state chip present');
    assert.equal(controls.back, 'Volver');
    // Draft survives add-row re-render (shared draft capture path).
    await page.evaluate(() => {
      const m = document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]');
      const p = m.querySelector('[data-player-name="0"]');
      p.value = 'Ana Sol Editada';
      p.dispatchEvent(new Event('input', { bubbles: true }));
      m.querySelector('[data-add-player]').click();
    });
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-player-name="1"]'),
    { timeout: 10000 });
    // A queued debounce may already be in flight from the first edit —
    // the second edit coalesces into the serial chain, never duplicates.
    await page.evaluate(() => {
      const m = document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]');
      const n = m.querySelector('[data-player-name="1"]');
      const d = m.querySelector('[data-player-number="1"]');
      n.value = 'Bert Luz';
      n.dispatchEvent(new Event('input', { bubbles: true }));
      d.value = '12';
      d.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // The serial queue converges: the LAST PUT carries the complete draft.
    const t0 = Date.now();
    let puts = [];
    let body = null;
    while (Date.now() - t0 < 10000) {
      puts = log.filter((e) => e.method === 'PUT' && e.url.includes('/roster'));
      body = puts.length ? JSON.parse(puts[puts.length - 1].postData) : null;
      if (
        body && body.players?.length === 2 &&
        body.players[0].name === 'Ana Sol Editada' &&
        body.players[1].name === 'Bert Luz'
      ) break;
      await page.waitForTimeout(80);
    }
    assert.ok(body, 'autosave PUT landed');
    // CAS progression is serial: every PUT carries revision+1 over the last.
    const revs = puts.map((p) => JSON.parse(p.postData).expected_revision);
    assert.deepEqual(revs, revs.map((_, i) => revs[0] + i),
      'CAS handle travels as expected_revision and advances serially');
    assert.equal(body.competitive_level, 'regional');
    assert.deepEqual(body.players, [
      { name: 'Ana Sol Editada', number: 7 },
      { name: 'Bert Luz', number: 12 },
    ]);
    // The chip settles on Guardado — the editor stays open (autosave).
    await page.waitForFunction(() =>
      document.getElementById('app').shadowRoot
        .querySelector('[data-edit-save-status]')?.classList.contains('is-saved'),
    { timeout: 10000 });
    // Volver vacía la cola y cierra — host = personal panel after.
    await page.evaluate(() =>
      document.getElementById('app').shadowRoot.querySelector('[data-cancel-edit]')?.click());
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('.entry-teams'),
    { timeout: 10000 });
  } finally {
    await browser.close();
  }
});

test('legacy spaces?edit forwards to the canonical shared editor route', async () => {
  const browser = await chromium.launch();
  try {
    const { page } = await newPersonalPage(browser, { routeQuery: 'spaces?edit=pt-1' });
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]'),
    { timeout: 10000 });
    const hash = await page.evaluate(() => window.location.hash);
    assert.match(hash, /#\/onboard\/teams\?.*edit=pt-1/,
      'legacy alias canonicalizes to the shared teams edit route');
  } finally {
    await browser.close();
  }
});

test('reopen reads the freshly saved roster — no cached players', async () => {
  const browser = await chromium.launch();
  try {
    const { page, log } = await newPersonalPage(browser, { routeQuery: 'teams?edit=pt-1' });
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]'),
    { timeout: 10000 });
    // Edit → autosave persists; Volver closes only after the queue drains.
    await page.evaluate(() => {
      const m = document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]');
      const p = m.querySelector('[data-player-name="0"]');
      p.value = 'Ana Sol Editada';
      p.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await waitForPuts(log, 1);
    await page.waitForFunction(() =>
      document.getElementById('app').shadowRoot
        .querySelector('[data-edit-save-status]')?.classList.contains('is-saved'),
    { timeout: 10000 });
    await page.evaluate(() =>
      document.getElementById('app').shadowRoot.querySelector('[data-cancel-edit]')?.click());
    await page.waitForFunction(() =>
      !document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]'),
    { timeout: 10000 });
    // Reopen through the panel's Plantilla affordance — roster is re-fetched.
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-personal-team-roster-open]'),
    { timeout: 10000 });
    await page.evaluate(() => {
      document.getElementById('app').shadowRoot
        .querySelector('[data-personal-team-roster-open]').click();
    });
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]'),
    { timeout: 10000 });
    const view = await page.evaluate(() => ({
      name: document.getElementById('app').shadowRoot
        .querySelector('[data-edit-team-name]').value,
      player: document.getElementById('app').shadowRoot
        .querySelector('[data-player-name="0"]')?.value,
    }));
    assert.equal(view.name, 'Paquetillos 1');
    assert.equal(view.player, 'Ana Sol Editada', 'reopen serves the autosaved roster');
  } finally {
    await browser.close();
  }
});

test('a stale roster load never paints after the context scope moved', async () => {
  const browser = await chromium.launch();
  try {
    let release;
    const hold = new Promise((r) => { release = r; });
    const { page } = await newPersonalPage(browser, { routeQuery: 'teams?edit=pt-1', rosterHold: hold });
    await page.waitForTimeout(300); // load in flight
    await page.evaluate(() => {
      // Scope change — the in-flight GET for the old fence must not paint.
      document.getElementById('app').context = {
        context_id: 'ctx-personal-2',
        context_epoch: 4,
        owner_scope: { kind: 'personal', workspace_id: 'ws-2', account_id: 'acc-2' },
        team_ids: [], working_team_ids: [],
      };
    });
    release();
    await page.waitForTimeout(400);
    const modal = await page.evaluate(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]'));
    assert.equal(modal, false, 'stale roster response must not paint');
  } finally {
    await browser.close();
  }
});

test('a denied roster load fails closed — no empty draft opens', async () => {
  const browser = await chromium.launch();
  try {
    const { page } = await newPersonalPage(browser, { routeQuery: 'teams?edit=pt-1', rosterStatus: 403 });
    // Wait a beat for the denied load to settle.
    await page.waitForTimeout(600);
    const view = await page.evaluate(() => {
      const s = document.getElementById('app').shadowRoot;
      return {
        modal: !!s.querySelector('[data-edit-modal]'),
        error: s.querySelector('.entry-error')?.textContent?.trim() || '',
      };
    });
    assert.equal(view.modal, false, 'denied read never opens a draft');
    assert.match(view.error, /permiso|editar/i);
  } finally {
    await browser.close();
  }
});

test('a 409 keeps the draft, shows the conflict chip, and Reintentar recovers', async () => {
  const browser = await chromium.launch();
  try {
    const { page } = await newPersonalPage(browser, { routeQuery: 'teams?edit=pt-1' });
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]'),
    { timeout: 10000 });
    // Server says the revision moved — the first save conflicts; reloads
    // serve revision 2 and later PUTs commit it.
    let puts = 0;
    await page.route('**/api/context/v1/personal-teams/*/roster', async (route) => {
      if (route.request().method() === 'PUT') {
        puts += 1;
        if (puts === 1) {
          await route.fulfill({ status: 409, contentType: 'application/json', body: '{"detail":"stale team revision"}' });
          return;
        }
        const body = JSON.parse(route.request().postData() || '{}');
        ROSTER = {
          name: body.name, competitive_level: body.competitive_level,
          players: body.players, team_revision: ROSTER.team_revision + 1,
        };
      }
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify(rosterPayload()),
      });
    });
    await page.evaluate(() => {
      const m = document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]');
      const n = m.querySelector('[data-edit-team-name]');
      n.value = 'Nombre Nuevo';
      n.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // Conflict state: chip + Reintentar visible, draft preserved, no retry.
    await page.waitForFunction(() => {
      const m = document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]');
      return m && m.querySelector('[data-edit-save-status]')?.classList.contains('is-conflict');
    }, { timeout: 10000 });
    const state = await page.evaluate(() => {
      const m = document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]');
      return {
        chip: m.querySelector('[data-edit-save-status]').textContent.trim(),
        detail: m.querySelector('[data-edit-save-detail]').textContent.trim(),
        retry: !m.querySelector('[data-edit-retry]').hidden,
        draft: m.querySelector('[data-edit-team-name]').value,
      };
    });
    assert.match(state.chip, /cambi[oó]/i);
    assert.match(state.detail, /reintent|cargar/i);
    assert.equal(state.retry, true, 'Reintentar visible on conflict');
    assert.equal(state.draft, 'Nombre Nuevo', 'draft survives the conflict');
    assert.equal(puts, 1, 'no silent retry or rebase — exactly one PUT');
    // Reintentar recarga la revisión y reenvía el borrador — PUT con CAS 2.
    await page.evaluate(() =>
      document.getElementById('app').shadowRoot.querySelector('[data-edit-retry]')?.click());
    await page.waitForFunction(() =>
      document.getElementById('app').shadowRoot
        .querySelector('[data-edit-save-status]')?.classList.contains('is-saved'),
    { timeout: 10000 });
    assert.equal(puts, 2, 'retry re-sends over the reloaded revision');
  } finally {
    await browser.close();
  }
});

test('a stale save completion never touches a retired editor generation', async () => {
  const browser = await chromium.launch();
  try {
    let release;
    const hold = new Promise((r) => { release = r; });
    const { page, log } = await newPersonalPage(browser, { routeQuery: 'teams?edit=pt-1', putHold: hold });
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]'),
    { timeout: 10000 });
    // Edit → autosave PUT parks in flight (generation A).
    await page.evaluate(() => {
      const m = document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]');
      const n = m.querySelector('[data-edit-team-name]');
      n.value = 'Nombre A';
      n.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await waitForPuts(log, 1);
    // A forced context/scope change retires the editor mid-flight —
    // unlike Volver (which flushes), scope changes invalidate the fence.
    await page.evaluate(() => {
      document.getElementById('app').context = {
        context_id: 'ctx-personal-2',
        context_epoch: 4,
        owner_scope: { kind: 'personal', workspace_id: 'ws-2', account_id: 'acc-2' },
        team_ids: [], working_team_ids: [],
      };
    });
    await page.waitForFunction(() =>
      !document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]'),
    { timeout: 10000 });
    release();
    await page.waitForTimeout(400);
    // The late response is dropped: nothing repaints, no successor saves.
    const puts = log.filter((e) => e.method === 'PUT' && e.url.includes('/roster'));
    assert.equal(puts.length, 1, 'retired generation spawns no successor PUTs');
    const closed = await page.evaluate(() =>
      !document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]'));
    assert.equal(closed, true, 'late save A cannot resurrect the retired editor');
  } finally {
    await browser.close();
  }
});

test('rapid edits coalesce into one PUT; later edits serialize behind it', async () => {
  const browser = await chromium.launch();
  try {
    const { page, log } = await newPersonalPage(browser, { routeQuery: 'teams?edit=pt-1' });
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]'),
    { timeout: 10000 });
    // Burst of edits inside the debounce window → a single autosave PUT.
    await page.evaluate(() => {
      const m = document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]');
      const n = m.querySelector('[data-edit-team-name]');
      for (const v of ['Nombre 1', 'Nombre 12', 'Nombre 123']) {
        n.value = v;
        n.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    const puts1 = await waitForPuts(log, 1);
    assert.equal(puts1.length, 1, 'debounce coalesces the burst into one PUT');
    await page.waitForTimeout(900); // let any extra debounce windows expire
    const putsAfter = log.filter((e) => e.method === 'PUT' && e.url.includes('/roster'));
    assert.equal(putsAfter.length, 1, 'no duplicate saves for the same draft');
    // A later edit starts a second save — serial, CAS advances to rev 2.
    await page.evaluate(() => {
      const n = document.getElementById('app').shadowRoot
        .querySelector('[data-edit-team-name]');
      n.value = 'Nombre Final';
      n.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const puts2 = await waitForPuts(log, 2);
    assert.equal(puts2.length, 2, 'second edit serializes a second PUT');
    assert.equal(
      JSON.parse(puts2[1].postData).expected_revision,
      JSON.parse(puts2[0].postData).expected_revision + 1,
      'second save sends the post-save revision');
    assert.equal(JSON.parse(puts2[1].postData).name, 'Nombre Final');
  } finally {
    await browser.close();
  }
});

test('a same-epoch working-set switch retires the open editor', async () => {
  const browser = await chromium.launch();
  try {
    const { page } = await newPersonalPage(browser, { routeQuery: 'teams?edit=pt-1' });
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]'),
    { timeout: 10000 });
    // Same context_id + epoch — only the working set moved. The editor
    // was authorized under the old set; the new fingerprint retires it.
    await page.evaluate(() => {
      document.getElementById('app').context = {
        context_id: 'ctx-personal-1',
        context_epoch: 3,
        owner_scope: { kind: 'personal', workspace_id: 'ws-1', account_id: 'acc-1' },
        team_ids: ['pt-1'], working_team_ids: [],
      };
    });
    await page.waitForFunction(() =>
      !document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]'),
    { timeout: 10000 });
  } finally {
    await browser.close();
  }
});

test('a readable own team outside the working set opens read-only', async () => {
  const browser = await chromium.launch();
  try {
    // GET succeeds (own workspace read) but the team is not in the
    // working set — truthful read-only, never a writable draft.
    const { page } = await newPersonalPage(browser, {
      routeQuery: 'teams?edit=pt-1',
      context: { ...PERSONAL_CONTEXT, working_team_ids: [] },
    });
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]'),
    { timeout: 10000 });
    const view = await page.evaluate(() => {
      const m = document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]');
      return {
        note: !!m.querySelector('[data-edit-readonly-note]'),
        save: !!m.querySelector('[data-save-team]'),
        saveState: !!m.querySelector('.onboard-save-state'),
        add: !!m.querySelector('[data-add-player]'),
        nameDisabled: m.querySelector('[data-edit-team-name]').disabled,
      };
    });
    assert.equal(view.note, true, 'read-only note is rendered');
    assert.equal(view.save, false, 'no save affordance');
    assert.equal(view.saveState, false, 'no autosave state in read-only mode');
    assert.equal(view.add, false, 'no add-player affordance');
    assert.equal(view.nameDisabled, true, 'inputs are disabled');
  } finally {
    await browser.close();
  }
});

test('a roster response echoing the wrong binding fails closed', async () => {
  const browser = await chromium.launch();
  try {
    const variants = {
      'wrong team id': () => ({ ...rosterPayload(), team: { ...rosterPayload().team, id: 'pt-other' } }),
      'wrong owner': () => ({ ...rosterPayload(), owner_scope: { kind: 'personal', workspace_id: 'ws-1', account_id: 'acc-2' } }),
      'wrong context': () => ({ ...rosterPayload(), context_id: 'ctx-other' }),
      'wrong epoch': () => ({ ...rosterPayload(), context_epoch: 99 }),
      'wrong schema': () => ({ ...rosterPayload(), schema_version: '9.9' }),
      'zero revision': () => ({ ...rosterPayload(), team: { ...rosterPayload().team, team_revision: 0 } }),
    };
    for (const [label, make] of Object.entries(variants)) {
      const { page } = await newPersonalPage(browser, {
        routeQuery: 'teams?edit=pt-1',
        rosterBody: make,
      });
      await page.waitForTimeout(600); // let the rejected load settle
      const view = await page.evaluate(() => {
        const s = document.getElementById('app').shadowRoot;
        return {
          modal: !!s.querySelector('[data-edit-modal] [data-player-name="0"]'),
          error: s.querySelector('.entry-error')?.textContent?.trim() || '',
        };
      });
      assert.equal(view.modal, false, `${label}: mismatched echo never paints a draft`);
      assert.match(view.error, /inválida|plantilla|error|cargar/i, `${label}: truthful failure surfaced`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test('G2: edits during an in-flight save queue serially — order and CAS preserved', async () => {
  const browser = await chromium.launch();
  try {
    // Per-request gates: save A and save B park on distinct holds.
    const gates = [];
    const holdFor = () => new Promise((r) => gates.push(r));
    const { page, log } = await newPersonalPage(browser, {
      routeQuery: 'teams?edit=pt-1',
      putHold: () => holdFor(),
    });
    await page.waitForFunction(
      (m) => !!document.getElementById('app').shadowRoot.querySelector(m),
      '[data-edit-modal]', { timeout: 10000 });
    // Edit A → autosave PUT parks in flight.
    await page.evaluate(() => {
      const m = document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]');
      const n = m.querySelector('[data-edit-team-name]');
      n.value = 'Nombre A';
      n.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await waitForPuts(log, 1);
    // Edit B while A is parked — the serial queue must NOT issue a
    // parallel PUT; it waits for A to complete then sends B with the
    // advanced revision.
    await page.evaluate(() => {
      const m = document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]');
      const n = m.querySelector('[data-edit-team-name]');
      n.value = 'Nombre B';
      n.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(900); // debounce expires; queue holds for A
    let puts = log.filter((e) => e.method === 'PUT' && e.url.includes('/roster'));
    assert.equal(puts.length, 1, 'no parallel PUT while save A is in flight');
    const midState = await page.evaluate(() => {
      const m = document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]');
      return {
        chip: m?.querySelector('[data-edit-save-status]')?.className || '',
        draft: m?.querySelector('[data-edit-team-name]')?.value,
        nameEnabled: m?.querySelector('[data-edit-team-name]')?.disabled === false,
      };
    });
    assert.match(midState.chip, /is-(saving|pending)/, 'chip stays busy/pending while A flies');
    assert.equal(midState.draft, 'Nombre B', 'latest draft kept in the input');
    assert.equal(midState.nameEnabled, true, 'inputs stay usable while saving');
    // Release A — the queued B save must run automatically (no retype).
    gates[0]();
    const puts2 = await waitForPuts(log, 2);
    assert.equal(puts2.length, 2, 'queued save fires after A completes');
    const bodyB = JSON.parse(puts2[1].postData);
    assert.equal(bodyB.name, 'Nombre B', 'queued save carries the latest draft');
    assert.equal(bodyB.expected_revision,
      JSON.parse(puts2[0].postData).expected_revision + 1,
      'queued save uses the post-A revision');
    // Releasing B settles the chain — chip returns to saved.
    gates[1]();
    await page.waitForFunction(() =>
      document.getElementById('app').shadowRoot
        .querySelector('[data-edit-save-status]')?.classList.contains('is-saved'),
    { timeout: 10000 });
    puts = log.filter((e) => e.method === 'PUT' && e.url.includes('/roster'));
    assert.equal(puts.length, 2, 'exactly one PUT each for A and B — no duplicates');
  } finally {
    await browser.close();
  }
});

test('Volver flushes a parked save before closing — never drops the draft', async () => {
  const browser = await chromium.launch();
  try {
    let release;
    const hold = new Promise((r) => { release = r; });
    const { page, log } = await newPersonalPage(browser, { routeQuery: 'teams?edit=pt-1', putHold: hold });
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]'),
    { timeout: 10000 });
    await page.evaluate(() => {
      const m = document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]');
      const n = m.querySelector('[data-edit-team-name]');
      n.value = 'Nombre Hold';
      n.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await waitForPuts(log, 1);
    // Volver while the PUT is parked → the editor stays open until it lands.
    await page.evaluate(() =>
      document.getElementById('app').shadowRoot.querySelector('[data-cancel-edit]')?.click());
    await page.waitForTimeout(400);
    const stillOpen = await page.evaluate(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]'));
    assert.equal(stillOpen, true, 'Volver waits on the in-flight save — no draft loss');
    release();
    await page.waitForFunction(() =>
      !document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]'),
    { timeout: 10000 });
  } finally {
    await browser.close();
  }
});

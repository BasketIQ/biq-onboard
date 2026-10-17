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

test('save sends expected_revision + full replace roster to the roster API', async () => {
  const browser = await chromium.launch();
  try {
    const { page, log } = await newPersonalPage(browser, { routeQuery: 'teams?edit=pt-1' });
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-player-name="0"]'),
    { timeout: 10000 });
    // Draft survives add-row re-render (shared draft capture path).
    await page.evaluate(() => {
      const m = document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]');
      m.querySelector('[data-player-name="0"]').value = 'Ana Sol Editada';
      m.querySelector('[data-add-player]').click();
    });
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-player-name="1"]'),
    { timeout: 10000 });
    await page.evaluate(() => {
      const m = document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]');
      // Row added BEFORE its input renders — draft kept the edited name.
      m.querySelector('[data-player-name="1"]').value = 'Bert Luz';
      m.querySelector('[data-player-number="1"]').value = '12';
      m.querySelector('[data-save-team]').click();
    });
    await page.waitForFunction(() =>
      !document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]'),
    { timeout: 10000 });
    const puts = log.filter((e) => e.method === 'PUT' && e.url.includes('/roster'));
    assert.equal(puts.length, 1, 'exactly one roster PUT');
    const body = JSON.parse(puts[0].postData);
    assert.equal(body.expected_revision, 1, 'CAS handle travels as expected_revision');
    assert.equal(body.competitive_level, 'regional');
    assert.deepEqual(body.players, [
      { name: 'Ana Sol Editada', number: 7 },
      { name: 'Bert Luz', number: 12 },
    ]);
    // After save the host is the personal panel — not a settings form.
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
    const { page } = await newPersonalPage(browser, { routeQuery: 'teams?edit=pt-1' });
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]'),
    { timeout: 10000 });
    await page.evaluate(() => {
      const m = document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]');
      m.querySelector('[data-save-team]').click();
    });
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
    const rev = await page.evaluate(() =>
      document.getElementById('app').shadowRoot
        .querySelector('[data-edit-team-name]').value,
    );
    assert.equal(rev, 'Paquetillos 1');
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

test('a 409 keeps the draft and shows the conflict inside the modal', async () => {
  const browser = await chromium.launch();
  try {
    const { page, log } = await newPersonalPage(browser, { routeQuery: 'teams?edit=pt-1' });
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]'),
    { timeout: 10000 });
    // Server says the revision moved — next save conflicts. Count PUTs
    // locally: this override consumes them (they never reach `log`).
    let puts = 0;
    await page.route('**/api/context/v1/personal-teams/*/roster', async (route) => {
      if (route.request().method() === 'PUT') {
        puts += 1;
        await route.fulfill({ status: 409, contentType: 'application/json', body: '{"detail":"stale team revision"}' });
        return;
      }
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          schema_version: '1.0', context_id: 'ctx-personal-1', context_epoch: 3,
          owner_scope: PERSONAL_CONTEXT.owner_scope,
          team: { id: 'pt-1', name: 'Paquetillos 1', competitive_level: 'regional', players: [], team_revision: 2 },
        }),
      });
    });
    await page.evaluate(() => {
      const m = document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]');
      m.querySelector('[data-edit-team-name]').value = 'Nombre Nuevo';
      m.querySelector('[data-save-team]').click();
    });
    await page.waitForFunction(() => {
      const m = document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]');
      return m && m.querySelector('.onboard-modal-error');
    }, { timeout: 10000 });
    const state = await page.evaluate(() => {
      const m = document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]');
      return {
        error: m.querySelector('.onboard-modal-error').textContent,
        draft: m.querySelector('[data-edit-team-name]').value,
      };
    });
    assert.match(state.error, /cambi[oó]|revisi[oó]n|conflict/i);
    assert.equal(state.draft, 'Nombre Nuevo', 'draft survives the conflict');
    // No silent retry or rebase — exactly one PUT.
    assert.equal(puts, 1);
  } finally {
    await browser.close();
  }
});

test('a late save completion never closes a reopened same-team editor', async () => {
  const browser = await chromium.launch();
  try {
    let release;
    const hold = new Promise((r) => { release = r; });
    const { page } = await newPersonalPage(browser, { routeQuery: 'teams?edit=pt-1', putHold: hold });
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]'),
    { timeout: 10000 });
    // Save A — parked in flight.
    await page.evaluate(() => {
      const m = document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]');
      m.querySelector('[data-edit-team-name]').value = 'Nombre A';
      m.querySelector('[data-save-team]').click();
    });
    await page.waitForTimeout(300);
    // Close and reopen the SAME team — a new generation. Draft B must not
    // be closed or overwritten when A's response finally lands.
    await page.evaluate(() =>
      document.getElementById('app').shadowRoot.querySelector('[data-cancel-edit]')?.click());
    await page.evaluate(() => { document.getElementById('app').route = 'teams?edit=pt-1'; });
    await page.waitForFunction(() => {
      const m = document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]');
      return m && m.querySelector('[data-edit-team-name]');
    }, { timeout: 10000 });
    await page.evaluate(() => {
      document.getElementById('app').shadowRoot
        .querySelector('[data-edit-team-name]').value = 'Nombre B';
    });
    release();
    await page.waitForTimeout(500);
    const state = await page.evaluate(() => {
      const m = document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]');
      return {
        open: !!m,
        name: m?.querySelector('[data-edit-team-name]')?.value ?? null,
        error: m?.querySelector('.onboard-modal-error')?.textContent ?? null,
      };
    });
    assert.equal(state.open, true, 'late save A must not close editor B');
    assert.equal(state.name, 'Nombre B', 'late save A must not overwrite B');
    assert.equal(state.error, null, 'late save A must not paint into B');
  } finally {
    await browser.close();
  }
});

test('double save serializes — exactly one roster PUT', async () => {
  const browser = await chromium.launch();
  try {
    const { page, log } = await newPersonalPage(browser, { routeQuery: 'teams?edit=pt-1' });
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]'),
    { timeout: 10000 });
    await page.evaluate(() => {
      const m = document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]');
      const save = () => m.querySelector('[data-save-team]').click();
      save(); save(); save();
    });
    await page.waitForFunction(() =>
      !document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]'),
    { timeout: 10000 });
    const puts = log.filter((e) => e.method === 'PUT' && e.url.includes('/roster'));
    assert.equal(puts.length, 1, 'serialized saves — one PUT for many clicks');
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
        add: !!m.querySelector('[data-add-player]'),
        nameDisabled: m.querySelector('[data-edit-team-name]').disabled,
      };
    });
    assert.equal(view.note, true, 'read-only note is rendered');
    assert.equal(view.save, false, 'no save affordance');
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

test('G2: a stale save completion never releases another save\'s busy state', async () => {
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
    // Save A — parked in flight.
    await page.evaluate(() => {
      const m = document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]');
      m.querySelector('[data-edit-team-name]').value = 'Nombre A';
      m.querySelector('[data-save-team]').click();
    });
    await page.waitForTimeout(300);
    // Close + reopen the SAME team → new generation; B starts its own save.
    await page.evaluate(() =>
      document.getElementById('app').shadowRoot.querySelector('[data-cancel-edit]')?.click());
    await page.evaluate(() => { document.getElementById('app').route = 'teams?edit=pt-1'; });
    await page.waitForFunction(() => {
      const m = document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]');
      return m && m.querySelector('[data-edit-team-name]');
    }, { timeout: 10000 });
    await page.evaluate(() => {
      const m = document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]');
      m.querySelector('[data-edit-team-name]').value = 'Nombre B';
      m.querySelector('[data-save-team]').click();
    });
    await page.waitForTimeout(300);
    // A's completion lands — stale. B must keep its busy state.
    gates[0]();
    await page.waitForTimeout(400);
    // Force a rerender under the still-pending B (same fingerprint → no
    // retirement, just a paint) — the regression showed enabled controls
    // right here.
    await page.evaluate(() => {
      const el = document.getElementById('app');
      el.context = { ...el.context };
    });
    await page.waitForTimeout(200);
    const mid = await page.evaluate(() => {
      const m = document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]');
      return {
        open: !!m,
        name: m?.querySelector('[data-edit-team-name]')?.value ?? null,
        saveDisabled: m?.querySelector('[data-save-team]')?.disabled ?? null,
        nameDisabled: m?.querySelector('[data-edit-team-name]')?.disabled ?? null,
      };
    });
    assert.equal(mid.open, true, 'late A must not close editor B');
    assert.equal(mid.name, 'Nombre B', 'late A must not repaint B');
    assert.equal(mid.saveDisabled, true, 'B save stays busy through rerender');
    assert.equal(mid.nameDisabled, true, 'B inputs stay disabled while B saves');
    // Releasing B's own completion is the only thing allowed to close it.
    gates[1]();
    await page.waitForFunction(() =>
      !document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]'),
    { timeout: 10000 });
    const puts = log.filter((e) => e.method === 'PUT' && e.url.includes('/roster'));
    assert.equal(puts.length, 2, 'one PUT each for A and B — no duplicate B PUT');
  } finally {
    await browser.close();
  }
});

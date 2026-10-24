/**
 * S6/S10a — club team editor: stable roster identity + Categoría/Género.
 *
 * F-CL-3 / PD-2 (biq-core 0.25.0): club roster rows carry `player_id`
 * (`pl_<16 hex>`). The editor draft keeps it through edit/remove/add;
 * new rows travel without one and adopt the id the PUT response echoes
 * back, so the next autosave re-sends it.
 *
 * Categoría/Género selects join the same autosave chain as name/level
 * (debounce → serial queue → chip), keep unknown stored values as an
 * extra selected option, and are fenced by the same seq/fence machinery.
 *
 * Personal rosters (biq-app own-workspace API) preserve player_id: a row
 * id the read served is echoed back on write — never stripped (M4-F03).
 * Rows without one send no `player_id` key at all (the server assigns /
 * backfills; the client never mints ids).
 *
 * Run: `npm run build:lib && node --test tests/scouting-team-editor.test.mjs`
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
const PORT = 9161;

if (!existsSync(DIST_EMBED)) {
  throw new Error('Build output not found. Run `npm run build:lib` first.');
}

const bundle = readFileSync(DIST_EMBED, 'utf-8');
let server;

const HARNESS = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>scouting team editor</title></head>
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

// ─── Club fixture ───────────────────────────────────────────────────────

let idCounter = 0;
const nextId = () => `pl_${String(++idCounter).padStart(16, '0')}`;

const MY_CATALOG = [
  {
    id: 'team_club1_cadete_m', club_id: 'club1', name: 'Cadete Masculino',
    category: 'cadete', gender: 'M', label: '2011', archived: false,
  },
];

let CLUB_TEAM;
function resetClubTeam() {
  idCounter = 0;
  CLUB_TEAM = {
    id: 'team_club1_cadete_m',
    club_id: 'club1',
    name: 'Cadete Masculino',
    category: 'cadete',
    gender: 'M',
    label: '2011',
    timezone: 'Europe/Madrid',
    staff_user_ids: ['u_dir'],
    archived: false,
    competitive_level: 'regional',
    players: [
      { name: 'Ana García', number: 7, player_id: 'pl_aaaaaaaaaaaaaaaa' },
      { name: 'Luis Pérez', number: 9, player_id: 'pl_bbbbbbbbbbbbbbbb' },
    ],
  };
}
resetClubTeam();

const CLUB_CONTEXT = {
  context_id: 'ctx-club-1',
  context_epoch: 1,
  owner_scope: { kind: 'club', club_id: 'club1' },
  team_ids: ['team_club1_cadete_m'],
  working_team_ids: ['team_club1_cadete_m'],
  active_team_id: 'team_club1_cadete_m',
};

/**
 * Mounts the app under a club context. `teamOverrides` patches the served
 * team row (unknown category/gender coverage); `putHold` parks every PUT
 * until released (stale-save fencing); `capture` collects PUT bodies.
 */
async function newClubPage(browser, { routeQuery = null, teamOverrides = {}, putHold = null } = {}) {
  const page = await browser.newPage();
  const log = [];

  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const u = req.url();
    const method = req.method();
    log.push({ url: u, method, postData: req.postData() });
    const json = (data, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    try {
      if (u.includes('/api/context/v1/bootstrap')) {
        return json({
          schema_version: '1',
          state: 'context_active',
          account_id: 'acc-1',
          identity_verified: true,
          contexts: [],
          active: CLUB_CONTEXT,
          entry_actions: {},
        });
      }
      if (u.includes('/api/org/my-teams') && method === 'GET') {
        return json({ ok: true, selected: [CLUB_TEAM.id], catalog: MY_CATALOG });
      }
      if (u.includes('/team-seeding') && method === 'GET') {
        return json({ ok: true, team_seeding_job: { status: 'done' } });
      }
      const m = u.match(/\/api\/clubs\/[^/]+\/teams\/([^/]+)$/);
      if (m && method === 'PUT') {
        if (putHold) await putHold;
        const body = JSON.parse(req.postData() || '{}');
        // Server semantics: full roster replace; rows without player_id get
        // one assigned, rows with one keep it.
        CLUB_TEAM = {
          ...CLUB_TEAM,
          name: body.name ?? CLUB_TEAM.name,
          category: body.category !== undefined ? (body.category || null) : CLUB_TEAM.category,
          gender: body.gender !== undefined ? (body.gender || null) : CLUB_TEAM.gender,
          competitive_level: body.competitive_level ?? CLUB_TEAM.competitive_level,
          players: (body.players || []).map((p) => ({
            name: p.name,
            number: p.number ?? null,
            player_id: p.player_id || nextId(),
          })),
        };
        return json({ ok: true, team: CLUB_TEAM });
      }
      if (u.match(/\/api\/clubs\/[^/]+\/teams$/) && method === 'GET') {
        return json({ teams: [{ ...CLUB_TEAM, ...teamOverrides }], total: 1 });
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
    el.org = { club: { id: 'club1', name: 'Club Test' }, role: 'administrator' };
    el.user = 'admin';
  }, { rq: routeQuery, ctx: CLUB_CONTEXT });
  return { page, log };
}

// ─── Personal fixture (player_id strip coverage) ────────────────────────

const PERSONAL_CONTEXT = {
  context_id: 'ctx-personal-1',
  context_epoch: 3,
  owner_scope: { kind: 'personal', workspace_id: 'ws-1', account_id: 'acc-1' },
  team_ids: ['pt-1'],
  working_team_ids: ['pt-1'],
  active_team_id: 'pt-1',
};

const PERSONAL_TEAMS = [
  {
    team_id: 'pt-1', name: 'Paquetillos 1', category_key: 'infantil',
    category_label: 'Infantil', gender: 'M', age_band: '',
    section_applicability: 'all', timezone: 'Europe/Madrid',
    season: '2026-27', team_revision: 1, archived: false,
  },
];

// biq-app does not serve player_id today; a tolerant future payload that
// DID carry one is what the strip contract defends against.
let PERSONAL_ROSTER;
function resetPersonalRoster(extraRows = []) {
  PERSONAL_ROSTER = {
    name: 'Paquetillos 1',
    competitive_level: 'regional',
    players: [{ name: 'Ana Sol', number: 7 }, ...extraRows],
    team_revision: 1,
  };
}
resetPersonalRoster();

const personalRosterPayload = () => ({
  schema_version: '1.0',
  context_id: 'ctx-personal-1',
  context_epoch: 3,
  owner_scope: PERSONAL_CONTEXT.owner_scope,
  team: { id: 'pt-1', ...PERSONAL_ROSTER },
});

async function newPersonalPage(browser, { rosterPlayers = null } = {}) {
  const page = await browser.newPage();
  const log = [];
  resetPersonalRoster(rosterPlayers || []);

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
        if (req.method() === 'PUT') {
          const body = JSON.parse(req.postData() || '{}');
          PERSONAL_ROSTER = {
            name: body.name,
            competitive_level: body.competitive_level,
            players: body.players,
            team_revision: PERSONAL_ROSTER.team_revision + 1,
          };
          return json(personalRosterPayload());
        }
        return json(personalRosterPayload());
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
  await page.evaluate((ctx) => {
    const el = document.getElementById('app');
    el.route = 'teams?edit=pt-1';
    el.context = ctx;
    el.org = { club: null, email: 'e2e@basketiq.io', display_name: 'E2E', memberships: [] };
    el.user = 'e2e-user';
  }, PERSONAL_CONTEXT);
  await page.waitForFunction(() =>
    !!document.getElementById('app').shadowRoot?.querySelector('[data-edit-modal]'),
  { timeout: 10000 });
  return { page, log };
}

// ─── Helpers ────────────────────────────────────────────────────────────

const modal = () => document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]');
const typeIn = (el, value) => {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const selectIn = (el, value) => {
  el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
};
async function waitForPuts(log, n, urlPart, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const puts = log.filter((e) => e.method === 'PUT' && e.url.includes(urlPart));
    if (puts.length >= n) return puts;
    await new Promise((r) => setTimeout(r, 60));
  }
  return log.filter((e) => e.method === 'PUT' && e.url.includes(urlPart));
}
async function waitForSavedChip(page, timeout = 10000) {
  await page.waitForFunction(() =>
    document.getElementById('app').shadowRoot
      .querySelector('[data-edit-save-status]')?.classList.contains('is-saved'),
  { timeout });
}
async function openClubEditor(page) {
  await page.waitForFunction(() => {
    const m = document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]');
    return m && m.querySelector('[data-player-name="0"]');
  }, { timeout: 10000 });
}

test.before(async () => { await startServer(); });
test.after(async () => { await stopServer(); });
test.beforeEach(() => { resetClubTeam(); resetPersonalRoster(); });

// ─── player_id identity ─────────────────────────────────────────────────

test('club editor round-trips player_id through edit, remove and add', async () => {
  const browser = await chromium.launch();
  try {
    const { page, log } = await newClubPage(browser, { routeQuery: 'teams?edit=team_club1_cadete_m' });
    await openClubEditor(page);

    // Edit row 0 name (id kept), remove row 1 (id dropped), add a new row
    // (no id — the server assigns it).
    await page.evaluate(() => {
      const m = document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]');
      const p0 = m.querySelector('[data-player-name="0"]');
      p0.value = 'Ana García Editada';
      p0.dispatchEvent(new Event('input', { bubbles: true }));
      m.querySelector('[data-remove-player="1"]').click();
      m.querySelector('[data-add-player]').click();
    });
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-player-name="1"]'),
    { timeout: 10000 });
    await page.evaluate(() => {
      const m = document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]');
      const n = m.querySelector('[data-player-name="1"]');
      const d = m.querySelector('[data-player-number="1"]');
      n.value = 'Nueva Jugadora';
      n.dispatchEvent(new Event('input', { bubbles: true }));
      d.value = '4';
      d.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const t0 = Date.now();
    let body = null;
    while (Date.now() - t0 < 10000) {
      const puts = log.filter((e) => e.method === 'PUT' && e.url.includes('/teams/team_club1_cadete_m'));
      body = puts.length ? JSON.parse(puts[puts.length - 1].postData) : null;
      if (body?.players?.length === 2 && body.players[1].name === 'Nueva Jugadora') break;
      await page.waitForTimeout(80);
    }
    assert.ok(body, 'autosave PUT landed');
    assert.deepEqual(body.players, [
      { name: 'Ana García Editada', number: 7, player_id: 'pl_aaaaaaaaaaaaaaaa' },
      { name: 'Nueva Jugadora', number: 4, player_id: null },
    ], 'edited row keeps its id, removed row is gone, new row carries none');
    assert.equal(body.players[0].player_id, 'pl_aaaaaaaaaaaaaaaa');
    assert.equal(body.players[1].player_id, null);
  } finally {
    await browser.close();
  }
});

test('the editor adopts server-assigned ids so the next autosave re-sends them', async () => {
  const browser = await chromium.launch();
  try {
    const { page, log } = await newClubPage(browser, { routeQuery: 'teams?edit=team_club1_cadete_m' });
    await openClubEditor(page);

    // Add a row — first save gets it a server id.
    await page.evaluate(() => {
      const m = document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]');
      m.querySelector('[data-add-player]').click();
    });
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-player-name="2"]'),
    { timeout: 10000 });
    await page.evaluate(() => {
      const m = document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]');
      const n = m.querySelector('[data-player-name="2"]');
      n.value = 'Nueva Jugadora';
      n.dispatchEvent(new Event('input', { bubbles: true }));
      n.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    await waitForPuts(log, 1, '/teams/team_club1_cadete_m');
    await waitForSavedChip(page);

    // Second save (level change) must carry the adopted id.
    await page.evaluate(() => {
      const m = document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]');
      const sel = m.querySelector('[data-edit-team-level]');
      sel.value = 'nacional';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const puts = await waitForPuts(log, 2, '/teams/team_club1_cadete_m');
    assert.ok(puts.length >= 2, 'second autosave PUT landed');
    const second = JSON.parse(puts[1].postData);
    assert.equal(second.players.length, 3);
    assert.equal(second.players[2].player_id, 'pl_0000000000000001',
      'the adopted server id travels on the next write');
    assert.equal(second.players[0].player_id, 'pl_aaaaaaaaaaaaaaaa');
  } finally {
    await browser.close();
  }
});

// ─── Categoría / Género ─────────────────────────────────────────────────

test('field order and Categoría/Género selects join the autosave chain', async () => {
  const browser = await chromium.launch();
  try {
    const { page, log } = await newClubPage(browser, { routeQuery: 'teams?edit=team_club1_cadete_m' });
    await openClubEditor(page);

    // Prototype order: Categoría → Nombre → Género → Nivel → Plantilla.
    const order = await page.evaluate(() => {
      const m = document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]');
      const pick = (sel) => {
        const el = m.querySelector(sel);
        if (!el) return -1;
        let y = el.getBoundingClientRect().top;
        const label = m.querySelector(`label[for="${el.id}"]`);
        if (label) y = Math.min(y, label.getBoundingClientRect().top);
        return y;
      };
      const rosterTop = m.querySelector('.onboard-roster').getBoundingClientRect().top;
      return {
        category: pick('[data-edit-team-category]'),
        name: pick('[data-edit-team-name]'),
        gender: pick('[data-edit-team-gender]'),
        level: pick('[data-edit-team-level]'),
        roster: rosterTop,
        categoryValue: m.querySelector('[data-edit-team-category]').value,
        genderValue: m.querySelector('[data-edit-team-gender]').value,
      };
    });
    assert.ok(order.category >= 0 && order.gender >= 0, 'club editor shows both selects');
    assert.ok(order.category < order.name, 'Categoría before Nombre');
    assert.ok(order.name < order.gender, 'Nombre before Género');
    assert.ok(order.gender < order.level, 'Género before Nivel');
    assert.ok(order.level < order.roster, 'Nivel before Plantilla');
    assert.equal(order.categoryValue, 'cadete');
    assert.equal(order.genderValue, 'M');

    // Autosave: selects accelerate the save; the chip walks the chain.
    await page.evaluate(() => {
      const m = document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]');
      const c = m.querySelector('[data-edit-team-category]');
      c.value = 'infantil';
      c.dispatchEvent(new Event('change', { bubbles: true }));
      const g = m.querySelector('[data-edit-team-gender]');
      g.value = 'F';
      g.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const t0 = Date.now();
    let body = null;
    while (Date.now() - t0 < 10000) {
      const puts = log.filter((e) => e.method === 'PUT' && e.url.includes('/teams/team_club1_cadete_m'));
      body = puts.length ? JSON.parse(puts[puts.length - 1].postData) : null;
      if (body?.category === 'infantil' && body?.gender === 'F') break;
      await page.waitForTimeout(80);
    }
    assert.ok(body, 'PUT landed');
    assert.equal(body.category, 'infantil');
    assert.equal(body.gender, 'F');
    assert.equal(body.name, 'Cadete Masculino');
    assert.equal(body.competitive_level, 'regional');
    assert.equal(body.players.length, 2, 'roster untouched by field change');
    await waitForSavedChip(page);
  } finally {
    await browser.close();
  }
});

test('unknown stored category/gender are preserved as extra selected options', async () => {
  const browser = await chromium.launch();
  try {
    const { page } = await newClubPage(browser, {
      routeQuery: 'teams?edit=team_club1_cadete_m',
      teamOverrides: { category: 'mini-legacy', gender: 'Z' },
    });
    await openClubEditor(page);
    const view = await page.evaluate(() => {
      const m = document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]');
      const cat = m.querySelector('[data-edit-team-category]');
      const gen = m.querySelector('[data-edit-team-gender]');
      const selected = (sel) => [...sel.options].filter((o) => o.selected).map((o) => [o.value, o.textContent]);
      return { cat: selected(cat), gen: selected(gen) };
    });
    assert.deepEqual(view.cat, [['mini-legacy', 'mini-legacy']],
      'legacy category preserved as selected extra option');
    assert.deepEqual(view.gen, [['Z', 'Z']],
      'legacy gender preserved as selected extra option');
  } finally {
    await browser.close();
  }
});

test('a late save completion never mutates a retired editor generation', async () => {
  const browser = await chromium.launch();
  try {
    let release;
    const hold = new Promise((r) => { release = r; });
    const { page } = await newClubPage(browser, {
      routeQuery: 'teams?edit=team_club1_cadete_m', putHold: hold,
    });
    await openClubEditor(page);
    await page.evaluate(() => {
      const m = document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]');
      const c = m.querySelector('[data-edit-team-category]');
      c.value = 'senior';
      c.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(500); // PUT dispatched, response parked

    // Retire the editor generation mid-flight (principal change) — the
    // parked response must not paint or mark anything when it lands.
    await page.evaluate(() => {
      document.getElementById('app').user = 'other-user';
    });
    release();
    await page.waitForTimeout(500);
    const state = await page.evaluate(() => {
      const sr = document.getElementById('app').shadowRoot;
      return {
        modal: !!sr.querySelector('[data-edit-modal]'),
        savedChip: sr.querySelector('[data-edit-save-status]')?.classList.contains('is-saved') || false,
      };
    });
    assert.equal(state.modal, false, 'retired editor is gone');
    assert.equal(state.savedChip, false, 'no stale saved state survives');

    // Reopen the same team — a fresh generation, unaffected by the late
    // response (category back to the pre-release fixture value).
    await page.evaluate(() => {
      const el = document.getElementById('app');
      el.user = 'admin';
      el.route = 'teams?edit=team_club1_cadete_m';
    });
    await openClubEditor(page);
    const cat = await page.evaluate(() =>
      document.getElementById('app').shadowRoot
        .querySelector('[data-edit-team-category]')?.value);
    assert.ok(['cadete', 'senior'].includes(cat), 'fresh generation loads a served value');
  } finally {
    await browser.close();
  }
});

// ─── M4-F03: personal rosters preserve player_id ────────────────────────

test('personal roster PUT preserves a served player_id; id-less rows send none', async () => {
  const browser = await chromium.launch();
  try {
    // The own-workspace read serves a row with a stable id — the editor
    // must echo it back on write. The other row stays id-less and its PUT
    // row carries no `player_id` key at all.
    const { page, log } = await newPersonalPage(browser, {
      rosterPlayers: [{ name: 'Bea Luna', number: 12, player_id: 'pl_cccccccccccccccc' }],
    });
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-player-name="0"]'),
    { timeout: 10000 });
    await page.evaluate(() => {
      const m = document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]');
      const n = m.querySelector('[data-player-name="1"]');
      n.value = 'Bea Luna Editada';
      n.dispatchEvent(new Event('input', { bubbles: true }));
      n.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    const puts = await waitForPuts(log, 1, '/roster');
    assert.ok(puts.length >= 1, 'personal autosave PUT landed');
    const body = JSON.parse(puts[puts.length - 1].postData);
    assert.equal(body.players.length, 2);
    assert.equal(body.players[1].player_id, 'pl_cccccccccccccccc',
      'served player_id must be preserved on write');
    assert.equal(body.players[1].name, 'Bea Luna Editada');
    assert.equal('player_id' in body.players[0], false,
      'rows without an id send no player_id key (server backfills)');
  } finally {
    await browser.close();
  }
});

/**
 * Consolidación "Mis equipos" → Mi Club → Equipos (dispatch 2026-09-18).
 *
 * The Equipos tab is now two data sources merged by team id:
 *   - self-scoped GET/PUT /api/org/my-teams (selection — every pick role)
 *   - management GET /api/clubs/{id}/teams (+ CRUD — management roles only)
 *
 * Covers the role matrix, the merge, save serialization/failure handling,
 * the biq-teams:selection-changed contract, archived rows, and
 * `teams?return=...` deep-link parsing.
 *
 * Run: `npm run build:lib && node --test tests/teams-selection-consolidate.test.mjs`
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
const PORT = 9133;

if (!existsSync(DIST_EMBED)) {
  throw new Error('Build output not found. Run `npm run build:lib` first.');
}

const bundle = readFileSync(DIST_EMBED, 'utf-8');
let server;

const HARNESS = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Consolidated Equipos tab</title></head>
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

// Self-scoped catalog (what /api/org/my-teams returns) — note the older name
// for cadete_m vs the management feed below: merge must de-dupe by id.
const MY_CATALOG = [
  { id: 'team_club1_senior_m', club_id: 'club1', name: 'Senior Masculino', category: 'senior', gender: 'M', label: '', archived: false },
  { id: 'team_club1_cadete_m', club_id: 'club1', name: 'Cadete Masculino (old)', category: 'cadete', gender: 'M', label: '2011', archived: false },
  { id: 'team_club1_veteranos_x', club_id: 'club1', name: 'Veteranos Mixto', category: 'veteranos', gender: 'X', label: '', archived: true },
];
// Management catalog — the same cadete_m id with the current name, plus an
// extra team that only exists in the management feed.
const MGMT_TEAMS = [
  { id: 'team_club1_senior_m', club_id: 'club1', name: 'Senior Masculino', category: 'senior', gender: 'M', label: '', archived: false },
  { id: 'team_club1_cadete_m', club_id: 'club1', name: 'Cadete Masculino', category: 'cadete', gender: 'M', label: '2011', archived: false },
  { id: 'team_club1_veteranos_x', club_id: 'club1', name: 'Veteranos Mixto', category: 'veteranos', gender: 'X', label: '', archived: true },
  { id: 'team_club1_junior_f', club_id: 'club1', name: 'Junior Femenino', category: 'junior', gender: 'F', label: '', archived: false },
];

// state: { role, myTeams: {selected, catalog}, mgmtTeams, myTeamsStatus,
//          onPut(req), putResponses: [status...] }
async function newPage(browser, state) {
  const page = await browser.newPage();
  const log = [];

  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const u = req.url();
    const method = req.method();
    log.push({ url: u, method, postData: req.postData() });

    const json = (data, status = 200) => route.fulfill({
      status, contentType: 'application/json', body: JSON.stringify(data),
    });

    if (u.includes('/api/org/my-teams') && method === 'GET') {
      if (state.myTeamsStatus && state.myTeamsStatus !== 200) {
        await json({ detail: 'boom' }, state.myTeamsStatus);
        return;
      }
      await json({ ok: true, selected: state.myTeams.selected, catalog: state.myTeams.catalog });
      return;
    }
    if (u.includes('/api/org/my-teams') && method === 'PUT') {
      const body = JSON.parse(req.postData() || '{}');
      if (state.onPut) state.onPut(body);
      const status = state.putResponses && state.putResponses.length ? state.putResponses.shift() : 200;
      if (status !== 200) {
        await json({ detail: 'save failed' }, status);
        return;
      }
      // Persist like the real endpoint: echo the validated set back.
      state.myTeams.selected = [...body.team_ids];
      await json({ ok: true, selected: state.myTeams.selected, catalog: state.myTeams.catalog });
      return;
    }
    if (u.includes('/team-seeding') && method === 'GET') {
      await json({ ok: true, team_seeding_job: { status: 'done' } });
      return;
    }
    if (u.match(/\/teams$/) && method === 'GET') {
      await json({ teams: state.mgmtTeams || [], total: (state.mgmtTeams || []).length });
      return;
    }
    await json({ ok: true });
  });

  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('biq-onboard-app', { state: 'attached', timeout: 10000 });
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el && el.shadowRoot);
  }, { timeout: 10000 });
  await page.evaluate((role) => {
    const el = document.getElementById('app');
    el.org = { club: { id: 'club1', name: 'Club Test' }, role };
    el.user = 'user1';
  }, state.role);
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el.shadowRoot && el.shadowRoot.querySelector('[data-nav="teams"]'));
  }, { timeout: 10000 });
  await page.evaluate(() => {
    document.getElementById('app').shadowRoot.querySelector('[data-nav="teams"]').click();
  });
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el.shadowRoot && el.shadowRoot.querySelector('.onboard-team-list, .onboard-error'));
  }, { timeout: 10000 });

  return { page, log };
}

const qs = (sel) => `document.getElementById('app').shadowRoot.querySelector('${sel}')`;
const qsa = (sel) => `document.getElementById('app').shadowRoot.querySelectorAll('${sel}')`;

const MANAGEMENT_SELECTORS = [
  '[data-edit-team]', '[data-archive-team]', '[data-unarchive-team]',
  '[data-delete-team]', '[data-add-team-category]', '[data-reseed-teams]',
  '[data-teams-filter]',
];

test.before(async () => { await startServer(); });
test.after(async () => { await stopServer(); });

test('coach: selects teams via self-scoped API only, never calls admin routes', async () => {
  const browser = await chromium.launch();
  const state = { role: 'coach', myTeams: { selected: [], catalog: MY_CATALOG }, mgmtTeams: MGMT_TEAMS };
  const { page, log } = await newPage(browser, state);

  const counts = await page.evaluate(() => {
    const sr = document.getElementById('app').shadowRoot;
    return {
      pick: sr.querySelectorAll('[data-pick-team]').length,
      edit: sr.querySelectorAll('[data-edit-team]').length,
      archive: sr.querySelectorAll('[data-archive-team]').length,
      del: sr.querySelectorAll('[data-delete-team]').length,
      add: sr.querySelectorAll('[data-add-team-category]').length,
      reseed: sr.querySelectorAll('[data-reseed-teams]').length,
      filter: sr.querySelectorAll('[data-teams-filter]').length,
    };
  });
  assert.equal(counts.pick, 2, 'one pick control per ACTIVE catalog team (veteranos is archived)');
  for (const sel of MANAGEMENT_SELECTORS) {
    assert.equal(await page.evaluate(`!!${qs(sel)}`), false, `no management control ${sel}`);
  }

  // Pick a team → a single PUT to the self-scoped endpoint.
  await page.evaluate(() => {
    const el = document.getElementById('app').shadowRoot.querySelector('[data-pick-team="team_club1_senior_m"]');
    el.click();
  });
  await page.waitForTimeout(900);
  const puts = log.filter((e) => e.url.includes('/api/org/my-teams') && e.method === 'PUT');
  assert.equal(puts.length, 1, 'exactly one self-scoped PUT');
  assert.deepEqual(JSON.parse(puts[0].postData).team_ids, ['team_club1_senior_m']);

  // No management endpoint was ever called — not even the catalog GET.
  // (/api/clubs/{id}/theme is the ordinary club-theme fetch every role makes.)
  const adminCalls = log.filter((e) => e.url.includes('/api/clubs/') && !e.url.includes('/theme'));
  assert.deepEqual(adminCalls, [], 'coach issues zero management requests');

  await browser.close();
});

test('coordinator: same pick-only surface as coach', async () => {
  const browser = await chromium.launch();
  const state = { role: 'coordinator', myTeams: { selected: ['team_club1_cadete_m'], catalog: MY_CATALOG }, mgmtTeams: MGMT_TEAMS };
  const { page, log } = await newPage(browser, state);

  const counts = await page.evaluate(() => {
    const sr = document.getElementById('app').shadowRoot;
    return {
      pick: sr.querySelectorAll('[data-pick-team]').length,
      checked: sr.querySelectorAll('[data-pick-team]:checked').length,
      mgmt: sr.querySelectorAll('[data-edit-team],[data-archive-team],[data-delete-team],[data-add-team-category],[data-teams-filter]').length,
    };
  });
  assert.equal(counts.pick, 2);
  assert.equal(counts.checked, 1, 'persisted selection renders checked');
  assert.equal(counts.mgmt, 0, 'coordinator sees zero management controls');
  assert.equal(log.filter((e) => e.url.includes('/api/clubs/') && !e.url.includes('/theme')).length, 0);

  await browser.close();
});

test('administrator: pick controls AND full management surface, merged catalog with no dupes', async () => {
  const browser = await chromium.launch();
  const state = { role: 'administrator', myTeams: { selected: ['team_club1_senior_m'], catalog: MY_CATALOG }, mgmtTeams: MGMT_TEAMS };
  const { page } = await newPage(browser, state);

  const view = await page.evaluate(() => {
    const sr = document.getElementById('app').shadowRoot;
    const rows = [...sr.querySelectorAll('[data-team-row]')];
    return {
      rowIds: rows.map((r) => r.getAttribute('data-team-row')),
      names: rows.map((r) => r.querySelector('.onboard-team-name')?.textContent.trim()),
      pick: sr.querySelectorAll('[data-pick-team]').length,
      checked: sr.querySelectorAll('[data-pick-team]:checked').length,
      chips: [...sr.querySelectorAll('.onboard-myteams-chip')].map((c) => c.textContent.trim()),
      edit: sr.querySelectorAll('[data-edit-team]').length,
      add: sr.querySelectorAll('[data-add-team-category]').length,
      filter: !!sr.querySelector('[data-teams-filter]'),
      mgmtCalls: true,
    };
  });

  // Merge by id: cadete_m appears once with the management (current) name;
  // junior_f (management-only id) is present too.
  const cadeteRows = view.rowIds.filter((id) => id === 'team_club1_cadete_m');
  assert.equal(cadeteRows.length, 1, 'no duplicate row for a team present in both feeds');
  assert.ok(view.names.includes('Cadete Masculino'), 'management name wins over the stale my-teams name');
  assert.ok(!view.names.includes('Cadete Masculino (old)'), 'stale self-catalog name not rendered');
  assert.ok(view.rowIds.includes('team_club1_junior_f'), 'management-only team rendered');
  assert.equal(view.checked, 1);
  assert.deepEqual(view.chips, ['Senior Masculino'], 'selected chip renders in catalog order');
  assert.ok(view.edit >= 1 && view.add >= 1 && view.filter, 'management controls present for admin');

  await browser.close();
});

test('row layout: checkbox follows name, has accessible stateful label, and no duplicate Equipos title', async () => {
  const browser = await chromium.launch();
  const state = { role: 'coach', myTeams: { selected: ['team_club1_senior_m'], catalog: MY_CATALOG }, mgmtTeams: [] };
  const { page } = await newPage(browser, state);

  const view = await page.evaluate(() => {
    const sr = document.getElementById('app').shadowRoot;
    const row = sr.querySelector('[data-team-row="team_club1_senior_m"]');
    const main = row.querySelector('.onboard-team-row-main');
    const name = main.querySelector('.onboard-team-name');
    const pick = main.querySelector('.onboard-team-pick');
    const box = main.querySelector('.onboard-team-box');
    const sectionTitle = sr.querySelector('.onboard-section > .onboard-section-title');
    const clubHeading = [...sr.querySelectorAll('.onboard-card-title')].find((el) => el.textContent.trim() === 'Equipos del club');
    const style = getComputedStyle(pick);
    return {
      nameIndex: [...main.children].indexOf(name),
      pickIndex: [...main.children].indexOf(pick),
      label: pick.getAttribute('aria-label'),
      title: pick.getAttribute('title'),
      pickWidth: parseFloat(style.width),
      pickHeight: parseFloat(style.height),
      boxWidth: parseFloat(getComputedStyle(box).width),
      sectionTitle: sectionTitle?.textContent.trim() || '',
      clubHeading: clubHeading?.textContent.trim() || '',
    };
  });

  assert.ok(view.nameIndex >= 0 && view.pickIndex > view.nameIndex, 'checkbox follows the team name in DOM order');
  assert.equal(view.label, 'Quitar Senior Masculino de Mis equipos', 'checked control has remove label');
  assert.equal(view.title, view.label, 'title mirrors the accessible action');
  assert.ok(view.pickWidth >= 44 && view.pickHeight >= 44, 'checkbox hit target is at least 44x44');
  assert.equal(view.boxWidth, 24, 'visual checkbox remains compact inside the hit target');
  assert.equal(view.sectionTitle, '', 'duplicate page-level Equipos heading is absent');
  assert.equal(view.clubHeading, 'Equipos del club', 'club catalog heading remains');

  await browser.close();
});

test('row layout: long active name wraps without shrinking the right checkbox', async () => {
  const browser = await chromium.launch();
  const longName = 'Benjamín Femenino 2017 con un nombre extraordinariamente largo';
  const state = {
    role: 'coach',
    myTeams: { selected: [], catalog: [{ ...MY_CATALOG[0], name: longName }] },
    mgmtTeams: [],
  };
  const { page } = await newPage(browser, state);
  await page.setViewportSize({ width: 390, height: 800 });

  const metrics = await page.evaluate(() => {
    const main = document.getElementById('app').shadowRoot.querySelector('.onboard-team-row-main');
    const name = main.querySelector('.onboard-team-name');
    const pick = main.querySelector('.onboard-team-pick');
    return {
      name: name.textContent.trim(),
      mainWidth: main.getBoundingClientRect().width,
      nameWidth: name.getBoundingClientRect().width,
      pickWidth: pick.getBoundingClientRect().width,
      pickLeft: pick.getBoundingClientRect().left,
      mainRight: main.getBoundingClientRect().right,
      fontSize: parseFloat(getComputedStyle(name).fontSize),
      height: name.getBoundingClientRect().height,
    };
  });
  assert.equal(metrics.name, longName, 'full long name remains in the DOM');
  assert.ok(metrics.nameWidth > 0, 'name retains available width');
  assert.equal(metrics.pickWidth, 44, 'checkbox does not shrink');
  assert.ok(metrics.pickLeft + metrics.pickWidth <= metrics.mainRight + 1, 'checkbox remains inside the primary row');
  assert.ok(metrics.height >= metrics.fontSize * 1.8, 'long name wraps to multiple lines');

  await browser.close();
});

test('player: read-only catalog — no pick and no management controls', async () => {
  const browser = await chromium.launch();
  const state = { role: 'player', myTeams: { selected: [], catalog: MY_CATALOG }, mgmtTeams: MGMT_TEAMS };
  const { page, log } = await newPage(browser, state);

  const counts = await page.evaluate(() => {
    const sr = document.getElementById('app').shadowRoot;
    return {
      rows: sr.querySelectorAll('[data-team-row]').length,
      pick: sr.querySelectorAll('[data-pick-team]').length,
      mgmt: sr.querySelectorAll('[data-edit-team],[data-archive-team],[data-delete-team],[data-add-team-category],[data-teams-filter],[data-pick-team]').length,
    };
  });
  assert.equal(counts.rows, 2, 'player sees the active catalog rows, read-only');
  assert.equal(counts.pick, 0, 'no selection controls for player');
  assert.equal(log.filter((e) => e.url.includes('/api/clubs/') && !e.url.includes('/theme')).length, 0, 'player never calls admin routes');

  await browser.close();
});

test('rapid selection changes serialize — last intent wins, ordered ids', async () => {
  const browser = await chromium.launch();
  const seen = [];
  const state = {
    role: 'coach',
    myTeams: { selected: [], catalog: MY_CATALOG },
    mgmtTeams: [],
    onPut: (body) => seen.push([...body.team_ids]),
  };
  const { page } = await newPage(browser, state);

  // Two quick toggles inside the debounce window → one PUT with both ids in
  // catalog order; then a third toggle produces a second serialized PUT.
  await page.evaluate(() => {
    const sr = document.getElementById('app').shadowRoot;
    sr.querySelector('[data-pick-team="team_club1_cadete_m"]').click();
    sr.querySelector('[data-pick-team="team_club1_senior_m"]').click();
  });
  await page.waitForTimeout(900);
  assert.equal(seen.length, 1, 'rapid toggles batch into one PUT');
  assert.deepEqual(seen[0], ['team_club1_senior_m', 'team_club1_cadete_m'], 'complete set sent in catalog order');

  await page.evaluate(() => {
    document.getElementById('app').shadowRoot.querySelector('[data-pick-team="team_club1_senior_m"]').click();
  });
  await page.waitForTimeout(900);
  assert.equal(seen.length, 2, 'second toggle issues a follow-up PUT');
  assert.deepEqual(seen[1], ['team_club1_cadete_m'], 'deselection persisted as the full set');

  await browser.close();
});

test('failed save: error is visible, no success claim, retry re-sends the intent', async () => {
  const browser = await chromium.launch();
  const seen = [];
  const state = {
    role: 'coach',
    myTeams: { selected: [], catalog: MY_CATALOG },
    mgmtTeams: [],
    putResponses: [500],
    onPut: (body) => seen.push([...body.team_ids]),
  };
  const { page } = await newPage(browser, state);

  await page.evaluate(() => {
    document.getElementById('app').shadowRoot.querySelector('[data-pick-team="team_club1_senior_m"]').click();
  });
  await page.waitForFunction(() => {
    const sr = document.getElementById('app').shadowRoot;
    const st = sr.querySelector('[data-selection-status]');
    return st && st.textContent.includes('No se pudo guardar');
  }, { timeout: 10000 });

  const status = await page.evaluate(() => {
    const sr = document.getElementById('app').shadowRoot;
    return {
      text: sr.querySelector('[data-selection-status]').textContent,
      retryHidden: sr.querySelector('[data-retry-save]').hidden,
      chips: sr.querySelectorAll('.onboard-myteams-chip').length,
      empty: sr.querySelector('.onboard-myteams-empty')?.textContent || '',
    };
  });
  assert.ok(!status.text.includes('Guardado'), 'never claims success on failure');
  assert.equal(status.retryHidden, false, 'retry control visible');
  assert.equal(status.chips, 0, 'optimistic chip reverted to last confirmed state');

  // Retry → the unsaved intent is re-sent.
  await page.evaluate(() => {
    document.getElementById('app').shadowRoot.querySelector('[data-retry-save]').click();
  });
  await page.waitForFunction(() => {
    const st = document.getElementById('app').shadowRoot.querySelector('[data-selection-status]');
    return st && st.textContent.includes('Guardado');
  }, { timeout: 10000 });
  assert.equal(seen.length, 2, 'retry issued a second PUT');
  assert.deepEqual(seen[1], ['team_club1_senior_m'], 'retry carried the original intent');

  await browser.close();
});

test('successful save updates chips and emits biq-teams:selection-changed', async () => {
  const browser = await chromium.launch();
  const state = { role: 'coach', myTeams: { selected: [], catalog: MY_CATALOG }, mgmtTeams: [] };
  const { page } = await newPage(browser, state);

  await page.evaluate(() => {
    window.__events = [];
    document.addEventListener('biq-teams:selection-changed', (e) => window.__events.push(e.detail));
  });
  await page.evaluate(() => {
    document.getElementById('app').shadowRoot.querySelector('[data-pick-team="team_club1_cadete_m"]').click();
  });
  await page.waitForFunction(() => (window.__events || []).length === 1, { timeout: 10000 });

  const result = await page.evaluate(() => {
    const sr = document.getElementById('app').shadowRoot;
    return {
      events: window.__events,
      chips: [...sr.querySelectorAll('.onboard-myteams-chip')].map((c) => c.textContent.trim()),
      status: sr.querySelector('[data-selection-status]').textContent,
    };
  });
  assert.deepEqual(result.events[0].selected, ['team_club1_cadete_m'], 'event carries persisted selection');
  assert.ok(Array.isArray(result.events[0].catalog), 'event carries the merged catalog');
  // A coach has no management feed — the chip uses the self-catalog name.
  assert.deepEqual(result.chips, ['Cadete Masculino (old)'], 'chip updated after successful save');
  assert.match(result.status, /Guardado/);

  await browser.close();
});

test('archived team renders no pick control', async () => {
  const browser = await chromium.launch();
  const state = { role: 'administrator', myTeams: { selected: [], catalog: MY_CATALOG }, mgmtTeams: MGMT_TEAMS };
  const { page } = await newPage(browser, state);

  // Archived row visible under the "all" filter but never selectable.
  await page.evaluate(() => {
    const sel = document.getElementById('app').shadowRoot.querySelector('[data-teams-filter]');
    sel.value = 'all';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(() => {
    return !!document.getElementById('app').shadowRoot.querySelector('[data-team-row="team_club1_veteranos_x"]');
  }, { timeout: 10000 });
  const pick = await page.evaluate(() => {
    const row = document.getElementById('app').shadowRoot.querySelector('[data-team-row="team_club1_veteranos_x"]');
    return !!row.querySelector('[data-pick-team]');
  });
  assert.equal(pick, false, 'archived team cannot be newly selected');

  await browser.close();
});

test('teams?return=... parses; Continuar disabled before a persisted selection, navigates after', async () => {
  const browser = await chromium.launch();
  const state = { role: 'coach', myTeams: { selected: [], catalog: MY_CATALOG }, mgmtTeams: [] };
  const page = await browser.newPage();
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (req.url().includes('/api/org/my-teams') && req.method() === 'GET') {
      await json({ ok: true, selected: [], catalog: MY_CATALOG });
      return;
    }
    if (req.url().includes('/api/org/my-teams') && req.method() === 'PUT') {
      const body = JSON.parse(req.postData() || '{}');
      state.myTeams.selected = [...body.team_ids];
      await json({ ok: true, selected: state.myTeams.selected, catalog: MY_CATALOG });
      return;
    }
    await json({ ok: true });
  });
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForFunction(() => !!(document.getElementById('app') && document.getElementById('app').shadowRoot), { timeout: 10000 });
  await page.evaluate(() => {
    const el = document.getElementById('app');
    el.org = { club: { id: 'club1', name: 'Club Test' }, role: 'coach' };
    el.user = 'user1';
    el.route = 'teams?return=cycle';
  });
  await page.waitForFunction(() => {
    return !!document.getElementById('app').shadowRoot.querySelector('.onboard-team-list');
  }, { timeout: 10000 });

  const before = await page.evaluate(() => {
    const btn = document.getElementById('app').shadowRoot.querySelector('[data-continue]');
    return { exists: !!btn, disabled: btn ? btn.disabled : null, route: document.getElementById('app').route };
  });
  assert.equal(before.exists, true, 'Continuar renders on a return deep link');
  assert.equal(before.disabled, true, 'no navigation before a persisted selection');
  assert.equal(before.route, 'teams', 'route getter exposes the bare tab id');

  await page.evaluate(() => {
    document.getElementById('app').shadowRoot.querySelector('[data-pick-team="team_club1_senior_m"]').click();
  });
  await page.waitForFunction(() => {
    const btn = document.getElementById('app').shadowRoot.querySelector('[data-continue]');
    return btn && !btn.disabled;
  }, { timeout: 10000 });

  await page.evaluate(() => {
    document.getElementById('app').shadowRoot.querySelector('[data-continue]').click();
  });
  const hash = await page.evaluate(() => location.hash);
  assert.equal(hash, '#/cycle', 'Continuar navigates to the requested return route');

  await browser.close();
});

// Mi Club administra el catálogo. Mis equipos gestiona la selección.
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
  await page.evaluate(() => { document.getElementById('app').route = 'teams'; });
  return { page, log };
}

test.before(async () => { await startServer(); });
test.after(async () => { await stopServer(); });

test('management catalog has no selection controls or personal feed', async () => {
  const browser = await chromium.launch();
  try {
    const {page,log} = await newPage(browser,{role:'administrator',mgmtTeams:MGMT_TEAMS});
    await page.locator('[data-edit-team]').first().waitFor();
    assert.equal(await page.locator('[data-myteams-chips], [data-pick-team], [data-section-subhead]').count(),0);
    assert.equal(log.some(call=>call.url.includes('/api/org/my-teams')),false);
  } finally { await browser.close(); }
});

test('coach cannot enter club catalog management', async () => {
  const browser = await chromium.launch();
  try {
    const {page,log} = await newPage(browser,{role:'coach'});
    await page.getByText('Sin acceso a la administración de equipos.').waitFor();
    assert.equal(await page.locator('[data-nav="teams"], [data-edit-team], [data-pick-team]').count(),0);
    assert.equal(log.some(call=>call.url.includes('/club1/teams')),false);
  } finally { await browser.close(); }
});

test('archived team renders no pick control', async () => {
  const browser = await chromium.launch();
  const state = { role: 'administrator', mgmtTeams: MGMT_TEAMS };
  const { page } = await newPage(browser, state);

  await page.locator('[data-edit-team]').first().waitFor();
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

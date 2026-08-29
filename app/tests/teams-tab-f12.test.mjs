/**
 * F12 — Equipos tab UI integration test.
 *
 * Verifies the list/edit/archive flow against the existing teams.py
 * endpoints (no new backend test needed beyond the authorization change).
 *
 * Run: `npm run build:lib && node --test tests/teams-tab-f12.test.mjs`
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
const PORT = 9127;

if (!existsSync(DIST_EMBED)) {
  throw new Error('Build output not found. Run `npm run build:lib` first.');
}

const bundle = readFileSync(DIST_EMBED, 'utf-8');
let server;

const HARNESS = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>F12 Equipos tab</title></head>
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

// Seed teams returned by the mocked API.
const SEED_TEAMS = [
  { id: 'team_club1_senior_m', club_id: 'club1', name: 'Senior Masculino', category: 'senior', gender: 'M', label: '', archived: false },
  { id: 'team_club1_senior_f', club_id: 'club1', name: 'Senior Femenino', category: 'senior', gender: 'F', label: '', archived: false },
  { id: 'team_club1_cadete_m', club_id: 'club1', name: 'Cadete Masculino', category: 'cadete', gender: 'M', label: '2011', archived: false },
];

async function newPage(browser) {
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

    // GET /api/clubs/{clubId}/teams → return seed teams (proxied path)
    if (u.includes('/api/clubs/') && u.includes('/teams') && method === 'GET') {
      await json({ teams: SEED_TEAMS, total: SEED_TEAMS.length });
      return;
    }
    // PUT /api/clubs/{clubId}/teams/{teamId} → update team (proxied path)
    if (u.match(/\/teams\/[^/]+$/) && method === 'PUT' && !u.includes('archive') && !u.includes('unarchive')) {
      const body = JSON.parse(req.postData() || '{}');
      await json({ ok: true, team: { id: 'updated', name: body.name || 'Updated' } });
      return;
    }
    // PUT .../archive
    if (u.includes('/archive') && method === 'PUT') {
      await json({ ok: true, team_id: 'archived', archived: true });
      return;
    }
    // PUT .../unarchive
    if (u.includes('/unarchive') && method === 'PUT') {
      await json({ ok: true, team_id: 'unarchived', archived: false });
      return;
    }
    // POST .../teams → create team
    if (u.includes('/teams') && method === 'POST') {
      await json({ ok: true, team: { id: 'new', name: 'New' } });
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
  // Set org context with a resolved club so the tab bar appears.
  await page.evaluate(() => {
    const el = document.getElementById('app');
    el.org = { club: { id: 'club1', name: 'Club Test' }, role: 'administrator' };
    el.user = 'admin';
  });
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el.shadowRoot && el.shadowRoot.querySelector('[data-nav="teams"]'));
  }, { timeout: 10000 });

  return { page, log };
}

test.before(async () => { await startServer(); });
test.after(async () => { await stopServer(); });

test('F12: Equipos tab lists teams grouped by category and allows archive', async () => {
  const browser = await chromium.launch();
  const { page, log } = await newPage(browser);

  // Click the Equipos tab
  await page.evaluate(() => {
    document.getElementById('app').shadowRoot.querySelector('[data-nav="teams"]').click();
  });

  // Wait for teams to load and render
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el.shadowRoot && el.shadowRoot.querySelector('.onboard-team-table'));
  }, { timeout: 10000 });

  // Verify teams were fetched
  assert.ok(log.some((e) => e.url.includes('/teams') && e.method === 'GET'), 'teams API called');

  // Verify team rows are rendered
  const rowCount = await page.evaluate(() => {
    return document.getElementById('app').shadowRoot.querySelectorAll('tr[data-team-row]').length;
  });
  assert.equal(rowCount, 3, '3 seed teams rendered');

  // Verify category grouping (Senior and Cadete sections)
  const sectionTitles = await page.evaluate(() => {
    return Array.from(document.getElementById('app').shadowRoot.querySelectorAll('.onboard-card-title'))
      .map((el) => el.textContent.trim());
  });
  assert.ok(sectionTitles.includes('Senior'), 'Senior category section present');
  assert.ok(sectionTitles.includes('Cadete'), 'Cadete category section present');

  // Click archive on the first team
  await page.evaluate(() => {
    const btn = document.getElementById('app').shadowRoot.querySelector('[data-archive-team]');
    if (btn) btn.click();
  });

  // Wait for the archive API call
  await page.waitForFunction(
    () => window.__testArchiveCalled,
    { timeout: 10000 }
  ).catch(() => {});

  // Check the archive request was made
  const archiveCalls = log.filter((e) => e.url.includes('/archive') && e.method === 'PUT');
  assert.equal(archiveCalls.length, 1, 'exactly one archive request');

  await browser.close();
});

test('F12: Edit team opens inline form and saves via PUT', async () => {
  const browser = await chromium.launch();
  const { page, log } = await newPage(browser);

  // Navigate to Equipos tab
  await page.evaluate(() => {
    document.getElementById('app').shadowRoot.querySelector('[data-nav="teams"]').click();
  });
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el.shadowRoot && el.shadowRoot.querySelector('.onboard-team-table'));
  }, { timeout: 10000 });

  // Click edit on the first team
  await page.evaluate(() => {
    const btn = document.getElementById('app').shadowRoot.querySelector('[data-edit-team]');
    if (btn) btn.click();
  });

  // Verify inline edit form appears
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el.shadowRoot && el.shadowRoot.querySelector('[data-edit-team-name]'));
  }, { timeout: 10000 });

  // Change the name and save
  await page.evaluate(() => {
    const input = document.getElementById('app').shadowRoot.querySelector('[data-edit-team-name]');
    input.value = 'Senior Masculino Editado';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('app').shadowRoot.querySelector('[data-save-team]').click();
  });

  // Wait for the PUT request
  await page.waitForTimeout(500);
  const putCalls = log.filter((e) => e.method === 'PUT' && !e.url.includes('archive') && !e.url.includes('unarchive'));
  assert.ok(putCalls.length >= 1, 'PUT request made to update team');
  const body = JSON.parse(putCalls[0].postData || '{}');
  assert.equal(body.name, 'Senior Masculino Editado', 'updated name sent in PUT body');

  await browser.close();
});

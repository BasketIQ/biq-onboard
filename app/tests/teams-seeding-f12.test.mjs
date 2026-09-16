/**
 * F12 — Equipos tab team-seeding states (Phase 2).
 *
 * Verifies the three distinct render branches driven by Club.team_seeding_job:
 * pending (generating banner + polling), failed (error + Reintentar → POST
 * reseed), and done/no-job with zero teams (genuine empty state, manual add
 * preserved in all states).
 *
 * Run: `npm run build:lib && node --test tests/teams-seeding-f12.test.mjs`
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
const PORT = 9131;

if (!existsSync(DIST_EMBED)) {
  throw new Error('Build output not found. Run `npm run build:lib` first.');
}

const bundle = readFileSync(DIST_EMBED, 'utf-8');
let server;

const HARNESS = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>F12 seeding states</title></head>
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

const SEED_TEAMS = [
  { id: 'team_club1_senior_m', club_id: 'club1', name: 'Senior Masculino', category: 'senior', gender: 'M', label: '', archived: false },
];

// state.job: the job object GET team-seeding returns (null → no job field).
// state.teams: what GET teams returns.
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
      await json({ ok: true, team_seeding_job: state.job });
      return;
    }
    if (u.includes('/teams/reseed') && method === 'POST') {
      if (state.onReseed) state.onReseed();
      await json({ ok: true, club_id: 'club1', teams_written: state.teams.length, team_seeding_job: state.job });
      return;
    }
    if (u.match(/\/teams$/) && method === 'GET') {
      await json({ teams: state.teams, total: state.teams.length });
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
  await page.evaluate(() => {
    const el = document.getElementById('app');
    el.org = { club: { id: 'club1', name: 'Club Test' }, role: 'administrator' };
    el.user = 'admin';
  });
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el.shadowRoot && el.shadowRoot.querySelector('[data-nav="teams"]'));
  }, { timeout: 10000 });
  await page.evaluate(() => {
    document.getElementById('app').shadowRoot.querySelector('[data-nav="teams"]').click();
  });

  return { page, log };
}

test.before(async () => { await startServer(); });
test.after(async () => { await stopServer(); });

test('F12: pending job shows generating banner, polls until done, then renders teams', async () => {
  const browser = await chromium.launch();
  const state = { job: { status: 'pending', teams_expected: 28, catalog_slug: 'club1' }, teams: [] };
  const { page, log } = await newPage(browser, state);

  // Generating banner visible while the job is pending.
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    const banner = el.shadowRoot && el.shadowRoot.querySelector('[role="status"]');
    return !!(banner && banner.textContent.includes('Generando el catálogo'));
  }, { timeout: 10000 });

  // Manual add affordance still present during generation.
  const addBtn = await page.evaluate(() => {
    return !!document.getElementById('app').shadowRoot.querySelector('[data-add-team-category]');
  });
  assert.ok(addBtn, 'manual add button still available while pending');

  // Polling: a second team-seeding request fires on the backoff interval.
  await page.waitForFunction(() => true, { timeout: 100 }); // let route log settle
  const seededCalls = () => log.filter((e) => e.url.includes('/team-seeding') && e.method === 'GET').length;
  assert.ok(seededCalls() >= 1, 'initial team-seeding fetch happened');
  await page.waitForTimeout(3600); // first backoff is 3s
  assert.ok(seededCalls() >= 2, 'seeding status is polled while pending');

  // Job reaches done + teams land → poll stops and the catalog renders.
  state.job = { status: 'done', teams_expected: 1, teams_written: 1 };
  state.teams = SEED_TEAMS;
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el.shadowRoot && el.shadowRoot.querySelector('.onboard-team-list'));
  }, { timeout: 10000 });
  const bannerGone = await page.evaluate(() => {
    const el = document.getElementById('app');
    const banner = el.shadowRoot.querySelector('[role="status"]');
    return !banner || !banner.textContent.includes('Generando el catálogo');
  });
  assert.ok(bannerGone, 'generating banner cleared once the job is done');

  await browser.close();
});

test('F12: failed job shows error + Reintentar, which POSTs reseed and recovers', async () => {
  const browser = await chromium.launch();
  const state = {
    job: { status: 'failed', reason: 'Firestore UNAVAILABLE', teams_expected: 28 },
    teams: [],
    onReseed() {
      state.job = { status: 'done', teams_expected: 1, teams_written: 1 };
      state.teams = SEED_TEAMS;
    },
  };
  const { page, log } = await newPage(browser, state);

  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    const alert = el.shadowRoot && el.shadowRoot.querySelector('[role="alert"]');
    return !!(alert && alert.textContent.includes('No se pudieron generar'));
  }, { timeout: 10000 });

  // Reason surfaced + retry button rendered.
  const content = await page.evaluate(() => {
    const el = document.getElementById('app');
    return {
      reason: el.shadowRoot.textContent.includes('Firestore UNAVAILABLE'),
      retry: !!el.shadowRoot.querySelector('[data-reseed-teams]'),
      add: !!el.shadowRoot.querySelector('[data-add-team-category]'),
    };
  });
  assert.ok(content.reason, 'job failure reason is surfaced');
  assert.ok(content.retry, 'Reintentar button rendered');
  assert.ok(content.add, 'manual add button still available on failure');

  // Click Reintentar → POST /teams/reseed → job done → list renders.
  await page.evaluate(() => {
    document.getElementById('app').shadowRoot.querySelector('[data-reseed-teams]').click();
  });
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el.shadowRoot && el.shadowRoot.querySelector('.onboard-team-list'));
  }, { timeout: 10000 });
  const reseedCalls = log.filter((e) => e.url.includes('/teams/reseed') && e.method === 'POST');
  assert.equal(reseedCalls.length, 1, 'exactly one reseed POST');

  await browser.close();
});

test('F12: no job + zero teams keeps the genuine empty state (no banner, add works)', async () => {
  const browser = await chromium.launch();
  const state = { job: null, teams: [] };
  const { page } = await newPage(browser, state);

  // Categories render with + buttons; no seeding banner anywhere.
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el.shadowRoot && el.shadowRoot.querySelector('[data-add-team-category]'));
  }, { timeout: 10000 });
  const view = await page.evaluate(() => {
    const el = document.getElementById('app');
    const status = el.shadowRoot.querySelector('[role="status"]');
    const alert = el.shadowRoot.querySelector('[role="alert"]');
    return {
      generating: !!(status && status.textContent.includes('Generando el catálogo')),
      failed: !!(alert && alert.textContent.includes('No se pudieron generar')),
      retry: !!el.shadowRoot.querySelector('[data-reseed-teams]'),
      categories: el.shadowRoot.querySelectorAll('[data-add-team-category]').length,
    };
  });
  assert.equal(view.generating, false, 'no generating banner without a pending job');
  assert.equal(view.failed, false, 'no failure banner without a failed job');
  assert.equal(view.retry, false, 'no Reintentar without a failed job');
  assert.ok(view.categories > 0, 'category add buttons render in the empty state');

  // Manual add still opens the inline row.
  await page.evaluate(() => {
    document.getElementById('app').shadowRoot.querySelector('[data-add-team-category="senior"]').click();
  });
  await page.waitForFunction(() => {
    return !!document.getElementById('app').shadowRoot.querySelector('[data-adding-row]');
  }, { timeout: 10000 });

  await browser.close();
});

test('F12: done job + zero teams is the genuine empty state (no banners)', async () => {
  const browser = await chromium.launch();
  const state = { job: { status: 'done', teams_expected: 28, teams_written: 28 }, teams: [] };
  const { page } = await newPage(browser, state);

  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el.shadowRoot && el.shadowRoot.querySelector('[data-add-team-category]'));
  }, { timeout: 10000 });
  const view = await page.evaluate(() => {
    const el = document.getElementById('app');
    const status = el.shadowRoot.querySelector('[role="status"]');
    const alert = el.shadowRoot.querySelector('[role="alert"]');
    return {
      generating: !!(status && status.textContent.includes('Generando el catálogo')),
      failed: !!(alert && alert.textContent.includes('No se pudieron generar')),
    };
  });
  assert.equal(view.generating, false, 'done job does not render the generating banner');
  assert.equal(view.failed, false, 'done job does not render the failure banner');

  await browser.close();
});

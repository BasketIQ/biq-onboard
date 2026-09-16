/**
 * Mi Club Phase 3 — Perfil tab club summary.
 *
 * The Perfil tab keeps the personal card and adds a real club summary:
 * club id, team count, member count, methodology + season-plan presence.
 * Presence is tri-state: Sí / No / Desconocido (upstream unreachable).
 *
 * Run: `npm run build:lib && node --test tests/profile-summary-p3.test.mjs`
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
const PORT = 9134;

if (!existsSync(DIST_EMBED)) {
  throw new Error('Build output not found. Run `npm run build:lib` first.');
}

const bundle = readFileSync(DIST_EMBED, 'utf-8');
let server;

const HARNESS = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>P3 Perfil summary</title></head>
<body>
  <biq-onboard-app id="app"></biq-onboard-app>
  <script type="module" src="/embed/biq-onboard.js"></script>
</body>
</html>`;

const SUMMARY = {
  club: { id: 'club1', name: 'Club Test', status: 'active' },
  team_count: 28,
  member_count: 5,
  methodology_present: true,
  season_plan_present: false,
};

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

async function newPage(browser, summary = SUMMARY) {
  const page = await browser.newPage();
  const log = [];
  await page.route('**/api/**', async (route) => {
    const u = route.request().url();
    log.push({ url: u, method: route.request().method() });
    if (u.includes('/api/clubs/') && u.includes('/summary') && route.request().method() === 'GET') {
      await route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify(summary),
      });
      return;
    }
    await route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }),
    });
  });
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('biq-onboard-app', { state: 'attached', timeout: 10000 });
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el && el.shadowRoot);
  }, { timeout: 10000 });
  return { page, log };
}

test.before(async () => { await startServer(); });
test.after(async () => { await stopServer(); });

test('P3: Perfil shows personal card plus real club summary', async () => {
  const browser = await chromium.launch();
  const { page, log } = await newPage(browser);
  try {
    await page.evaluate(() => {
      const el = document.getElementById('app');
      el.org = { club: { id: 'club1', name: 'Club Test' }, role: 'administrator' };
      el.user = 'admin';
    });
    await page.evaluate(() => {
      document.getElementById('app').shadowRoot.querySelector('[data-nav="profile"]').click();
    });
    await page.waitForFunction(() => {
      const el = document.getElementById('app');
      return !!(el.shadowRoot && el.shadowRoot.querySelector('[data-club-summary]'));
    }, { timeout: 10000 });

    assert.ok(log.some((e) => e.url.includes('/api/clubs/club1/summary')), 'summary API called');

    const vals = await page.evaluate(() => {
      const sr = document.getElementById('app').shadowRoot;
      const txt = (sel) => sr.querySelector(sel)?.textContent.trim();
      return {
        clubId: txt('[data-club-id]'),
        teams: txt('[data-team-count]'),
        members: txt('[data-member-count]'),
        methodology: txt('[data-methodology-present]'),
        plan: txt('[data-season-plan-present]'),
        name: txt('.onboard-profile-name'),
        clubName: txt('.onboard-profile-club'),
        role: txt('.onboard-profile-role'),
      };
    });
    assert.equal(vals.clubId, 'club1', 'club id prominent');
    assert.equal(vals.teams, '28');
    assert.equal(vals.members, '5');
    assert.equal(vals.methodology, 'Sí');
    assert.equal(vals.plan, 'No');
    // Personal card retained (additive, not replaced).
    assert.equal(vals.name, 'admin');
    assert.equal(vals.clubName, 'Club Test');
    assert.equal(vals.role, 'Administrador');
  } finally {
    await browser.close();
  }
});

test('P3: null presence renders Desconocido (not No)', async () => {
  const browser = await chromium.launch();
  const { page } = await newPage(browser, {
    ...SUMMARY, methodology_present: null, season_plan_present: null,
  });
  try {
    await page.evaluate(() => {
      const el = document.getElementById('app');
      el.org = { club: { id: 'club1', name: 'Club Test' }, role: 'coach' };
      el.user = 'coach1';
      el.route = 'profile';
    });
    await page.waitForFunction(() => {
      const el = document.getElementById('app');
      return !!(el.shadowRoot && el.shadowRoot.querySelector('[data-club-summary]'));
    }, { timeout: 10000 });
    const vals = await page.evaluate(() => {
      const sr = document.getElementById('app').shadowRoot;
      return {
        m: sr.querySelector('[data-methodology-present]').textContent.trim(),
        p: sr.querySelector('[data-season-plan-present]').textContent.trim(),
      };
    });
    assert.equal(vals.m, 'Desconocido');
    assert.equal(vals.p, 'Desconocido');
  } finally {
    await browser.close();
  }
});

test('P3: deep-link to profile route loads summary on org arrival', async () => {
  const browser = await chromium.launch();
  const { page, log } = await newPage(browser);
  try {
    // route set BEFORE org — mirrors the shell deep-linking before org resolves.
    await page.evaluate(() => {
      document.getElementById('app').route = 'profile';
    });
    await page.evaluate(() => {
      const el = document.getElementById('app');
      el.org = { club: { id: 'club1', name: 'Club Test' }, role: 'coach' };
      el.user = 'coach1';
    });
    await page.waitForFunction(() => {
      const el = document.getElementById('app');
      return !!(el.shadowRoot && el.shadowRoot.querySelector('[data-club-summary]'));
    }, { timeout: 10000 });
    assert.ok(log.some((e) => e.url.includes('/summary')), 'summary fetched on org arrival');
  } finally {
    await browser.close();
  }
});

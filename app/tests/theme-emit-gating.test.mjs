/**
 * B15 regression — emit-gating in loadThemeData().
 *
 * Asserts that `_emitThemeStateEvent` is NOT called from `loadThemeData()`
 * when the fetched theme/job state is unchanged from the component's
 * current state. This is the exact bug that caused an infinite refresh
 * loop: shell sees succeeded/active → refreshOrgContext() → re-inject org
 * → loadThemeData() → unconditional emit → shell sees succeeded/active →
 * repeat.
 *
 * The fix gates the emit on an actual status change, the same way
 * `_pollTheme()` already does. This test verifies that gating by counting
 * `biq-theme-state` events in a real DOM (Playwright), not just comparing
 * state in isolation.
 *
 * Run: `npm run build:lib && node --test tests/*.test.mjs`
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
const PORT = 9128;

if (!existsSync(DIST_EMBED)) {
  throw new Error('Build output not found. Run `npm run build:lib` first.');
}

const bundle = readFileSync(DIST_EMBED, 'utf-8');
let server;

const HARNESS = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>theme emit gating</title></head>
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

/**
 * Create a page that mocks the theme API with a fixed succeeded/active
 * response. Returns the page and an event counter.
 */
async function newPage(browser) {
  const page = await browser.newPage();

  // Mock all API routes — theme endpoint returns a stable succeeded/active theme.
  await page.route('**/api/**', async (route) => {
    const u = route.request().url();
    if (u.includes('/theme')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          theme: { status: 'active', palette: { primary: '#FF0000' } },
          themeJob: { status: 'succeeded' },
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    });
  });

  // Count biq-theme-state events via a DOM listener injected before the
  // element receives any org context.
  await page.addInitScript(() => {
    window.__themeStateEvents = 0;
    document.addEventListener('biq-theme-state', () => {
      window.__themeStateEvents++;
    }, { capture: true });
  });

  return page;
}

test('loadThemeData does not emit biq-theme-state when status is unchanged', async () => {
  await startServer();
  const browser = await chromium.launch();

  try {
    const page = await newPage(browser);
    await page.goto(`http://localhost:${PORT}/`);

    // Wait for the custom element to upgrade.
    await page.waitForSelector('biq-onboard-app', { state: 'attached' });
    await page.evaluate(() => customElements.whenDefined('biq-onboard-app'));

    // Inject org context — triggers initial loadThemeData() via set org.
    // The theme API returns succeeded/active, so one emit is expected
    // (status goes from undefined → succeeded).
    await page.evaluate(() => {
      const el = document.getElementById('app');
      el.org = {
        club: { id: 'club-a', name: 'Club A' },
        team: null,
        teams: [],
        season: '2026',
        role: 'coach',
        email: 'test@basketiq.io',
        display_name: 'Test',
        memberships: [],
      };
    });

    // Wait for the fetch + emit to settle.
    await page.waitForTimeout(500);

    const eventsAfterInitial = await page.evaluate(() => window.__themeStateEvents);
    assert.ok(
      eventsAfterInitial >= 1,
      `Expected at least 1 event after initial loadThemeData, got ${eventsAfterInitial}`,
    );

    // Now re-inject the SAME org context (same club ID). This simulates
    // refreshOrgContext() re-injecting org after a biq-theme-state event.
    // The set org setter gates on club ID change, so loadThemeData() should
    // NOT be called. Even if it were called, the emit is gated on status
    // change, and the status is still succeeded/active.
    await page.evaluate(() => {
      const el = document.getElementById('app');
      el.org = {
        club: { id: 'club-a', name: 'Club A' },
        team: null,
        teams: [],
        season: '2026',
        role: 'coach',
        email: 'test@basketiq.io',
        display_name: 'Test',
        memberships: [],
      };
    });

    await page.waitForTimeout(500);

    const eventsAfterReinject = await page.evaluate(() => window.__themeStateEvents);
    assert.equal(
      eventsAfterReinject,
      eventsAfterInitial,
      `Re-injecting same org should NOT emit new events: expected ${eventsAfterInitial}, got ${eventsAfterReinject}`,
    );

    // Also verify that directly calling loadThemeData() with unchanged
    // data does not emit. This is the core of the emit-gating fix.
    const eventsAfterDirectCall = await page.evaluate(async () => {
      const el = document.getElementById('app');
      // Call loadThemeData directly — it's a class method, accessible
      // even though TypeScript marks it private.
      await el.loadThemeData('club-a');
      // Wait a tick for the async emit to fire (or not).
      await new Promise((r) => setTimeout(r, 200));
      return window.__themeStateEvents;
    });

    assert.equal(
      eventsAfterDirectCall,
      eventsAfterInitial,
      `Direct loadThemeData() with unchanged status should NOT emit: expected ${eventsAfterInitial}, got ${eventsAfterDirectCall}`,
    );
  } finally {
    await browser.close();
    await stopServer();
  }
});

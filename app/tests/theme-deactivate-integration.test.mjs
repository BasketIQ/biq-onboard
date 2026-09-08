/**
 * Integration tests for Issue #31:
 * - Switch uncheck dispatches POST /deactivate
 * - State transition from active to draft emits canonical biq-theme-state event
 * - Theme preview, logo, and website URL remain visible and populated in UI
 * - Banner suppressed when switch is off / theme is draft
 * - In-flight theme generation locks controls while preserving preview
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
const PORT = 9129;

if (!existsSync(DIST_EMBED)) {
  throw new Error('Build output not found. Run `npm run build:lib` first.');
}

const bundle = readFileSync(DIST_EMBED, 'utf-8');
let server;

const HARNESS = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Issue 31 theme deactivate & guards</title></head>
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

test('Unchecking activation switch calls deactivate and emits theme state while preserving preview', async () => {
  await startServer();
  const browser = await chromium.launch();

  try {
    const page = await browser.newPage();

    let themeState = {
      status: 'active',
      palette: { primary: '#FF0000' },
      logo: { onLight: 'https://example.com/logo.png', rightsConfirmedAt: '2026-09-08T00:00:00Z' },
    };
    let themeJobState = { status: 'succeeded' };
    let deactivateCalled = false;

    await page.route('**/api/**', async (route) => {
      const u = route.request().url();
      const method = route.request().method();

      if (u.includes('/theme/deactivate')) {
        deactivateCalled = true;
        themeState = { ...themeState, status: 'draft' };
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, theme: themeState }),
        });
        return;
      }

      if (u.includes('/theme') && !u.includes('/deactivate') && method === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            theme: themeState,
            themeJob: themeJobState,
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

    await page.addInitScript(() => {
      window.__emittedEvents = [];
      document.addEventListener('biq-theme-state', (e) => {
        window.__emittedEvents.push(e.detail);
      }, { capture: true });
    });

    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForSelector('biq-onboard-app', { state: 'attached' });
    await page.evaluate(() => customElements.whenDefined('biq-onboard-app'));

    // Inject org context
    await page.evaluate(() => {
      const el = document.getElementById('app');
      el.org = {
        club: { id: 'club-test-31', name: 'Club Test 31', website: 'https://club31.es' },
        team: null,
        teams: [],
        season: '2026',
        role: 'coach',
        email: 'test@basketiq.io',
        display_name: 'Test',
        memberships: [],
      };
    });

    await page.waitForTimeout(400);

    // Initial event when loading active theme
    const initialEvents = await page.evaluate(() => window.__emittedEvents);
    assert.ok(initialEvents.length >= 1, 'Initial theme state should be emitted');
    assert.equal(initialEvents[initialEvents.length - 1].themeStatus, 'active');

    // Verify switch is checked and banner is shown
    const isCheckedBefore = await page.evaluate(() => {
      const el = document.getElementById('app');
      const sw = el.shadowRoot.querySelector('[data-activate-switch]');
      return sw ? sw.checked : null;
    });
    assert.equal(isCheckedBefore, true, 'Activation switch should initially be checked');

    const hasBannerBefore = await page.evaluate(() => {
      const el = document.getElementById('app');
      return !!el.shadowRoot.querySelector('.onboard-theme-job-state');
    });
    assert.equal(hasBannerBefore, true, 'Active banner should initially be present');

    // Click switch to uncheck
    await page.evaluate(() => {
      const el = document.getElementById('app');
      const sw = el.shadowRoot.querySelector('[data-activate-switch]');
      sw.checked = false;
      sw.dispatchEvent(new Event('change', { bubbles: true }));
    });

    await page.waitForTimeout(400);

    assert.equal(deactivateCalled, true, 'POST /theme/deactivate should have been called');

    // Check emitted event has themeStatus: "draft"
    const latestEvent = await page.evaluate(() => {
      const evts = window.__emittedEvents;
      return evts[evts.length - 1];
    });
    assert.equal(latestEvent.clubId, 'club-test-31');
    assert.equal(latestEvent.themeStatus, 'draft');

    // Verify UI state:
    // 1. Switch is unchecked
    // 2. Banner is suppressed
    // 3. Logo and website input remain visible and populated
    const uiStateAfter = await page.evaluate(() => {
      const el = document.getElementById('app');
      const shadow = el.shadowRoot;
      const sw = shadow.querySelector('[data-activate-switch]');
      const banner = shadow.querySelector('.onboard-theme-job-state');
      const websiteInput = shadow.querySelector('[data-website-input]');
      const logoImg = shadow.querySelector('.onboard-logo-preview');
      return {
        switchChecked: sw ? sw.checked : null,
        hasBanner: !!banner,
        websiteValue: websiteInput ? websiteInput.value : null,
        logoSrc: logoImg ? logoImg.src : null,
      };
    });

    assert.equal(uiStateAfter.switchChecked, false, 'Switch should now be unchecked');
    assert.equal(uiStateAfter.hasBanner, false, 'Banner should be suppressed when theme is draft');
    assert.equal(uiStateAfter.websiteValue, 'https://club31.es', 'Website URL should remain populated');
    assert.ok(uiStateAfter.logoSrc && uiStateAfter.logoSrc.includes('logo.png'), 'Logo preview should remain displayed');

  } finally {
    await browser.close();
    await stopServer();
  }
});

test('In-flight theme generation locks controls while preserving existing preview', async () => {
  await startServer();
  const browser = await chromium.launch();

  try {
    const page = await browser.newPage();

    let themeState = {
      status: 'active',
      palette: { primary: '#FF0000' },
      logo: { onLight: 'https://example.com/logo.png', rightsConfirmedAt: '2026-09-08T00:00:00Z' },
    };
    let themeJobState = { status: 'running' };

    await page.route('**/api/**', async (route) => {
      const u = route.request().url();
      if (u.includes('/theme')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            theme: themeState,
            themeJob: themeJobState,
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

    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForSelector('biq-onboard-app', { state: 'attached' });
    await page.evaluate(() => customElements.whenDefined('biq-onboard-app'));

    // Inject org context
    await page.evaluate(() => {
      const el = document.getElementById('app');
      el.org = {
        club: { id: 'club-test-inflight', name: 'Club Test Inflight', website: 'https://club-inflight.es' },
        team: null,
        teams: [],
        season: '2026',
        role: 'coach',
        email: 'test@basketiq.io',
        display_name: 'Test',
        memberships: [],
      };
    });

    await page.waitForTimeout(400);

    // Verify website input and activation switch are disabled during polling
    const controlStates = await page.evaluate(() => {
      const el = document.getElementById('app');
      const shadow = el.shadowRoot;
      const websiteInput = shadow.querySelector('[data-website-input]');
      const activateSwitch = shadow.querySelector('[data-activate-switch]');
      const logoImg = shadow.querySelector('.onboard-logo-preview');
      return {
        websiteDisabled: websiteInput ? websiteInput.disabled : null,
        switchDisabled: activateSwitch ? activateSwitch.disabled : null,
        hasLogo: !!logoImg,
      };
    });

    assert.equal(controlStates.websiteDisabled, true, 'Website input must be disabled during polling');
    assert.equal(controlStates.switchDisabled, true, 'Activation switch must be disabled during polling');
    assert.equal(controlStates.hasLogo, true, 'Previous theme preview/logo must remain displayed');

  } finally {
    await browser.close();
    await stopServer();
  }
});

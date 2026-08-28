/**
 * D21 — Executable custom-element lifecycle tests for the club decision forms.
 *
 * Covers the exact matrix required by the Architect:
 *   - One click → one request.
 *   - Repeated submit → still one request.
 *   - Success remains locked through redirect.
 *   - Failure restores values and focuses error.
 *   - Disconnect aborts and rejects stale completion.
 *
 * Requests are intercepted Node-side via Playwright routing so assertions never
 * depend on page-global state. Navigation (location.replace) cannot be stubbed
 * in Chromium, so the success tests observe the real URL transition and capture
 * the locked state synchronously at click time.
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
const PORT = 9125;

if (!existsSync(DIST_EMBED)) {
  throw new Error('Build output not found. Run `npm run build:lib` first.');
}

const bundle = readFileSync(DIST_EMBED, 'utf-8');
let server;

const HARNESS = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>club step lifecycle</title></head>
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
 * Scenario responses:
 *   'join-ok'     → /api/auth/register ok (component redirects to /)
 *   'create-ok'   → onboarding/clubs ok with club.id, select-club ok
 *   'create-fail' → onboarding/clubs 422 {"detail": "La web del club debe usar https://"}
 *   'hang'        → onboarding/clubs hangs until `releaseHang` is called
 */
async function newPage(browser, scenario) {
  const page = await browser.newPage();
  const log = [];
  let releaseHang = null;
  const hangPromise = new Promise((resolve) => { releaseHang = resolve; });

  await page.route('**/api/**', async (route) => {
    const req = route.request();
    log.push({ url: req.url(), method: req.method(), postData: req.postData() });
    const json = (data, status = 200) => route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(data),
    });
    const u = req.url();
    try {
      if (scenario === 'hang' && u.includes('/api/onboarding/clubs')) {
        await hangPromise;
        await json({ ok: true, club: { id: 'club-new' } });
        return;
      }
      if (u.includes('/api/auth/register')) {
        await json({ ok: true });
        return;
      }
      if (u.includes('/api/onboarding/clubs')) {
        if (scenario === 'create-fail') {
          await json({ detail: 'La web del club debe usar https://' }, 422);
          return;
        }
        await json({ ok: true, club: { id: 'club-new' } });
        return;
      }
      if (u.includes('/api/auth/select-club')) {
        await json({ ok: true });
        return;
      }
      if (u.includes('/api/preferences/last-club')) {
        await json({ ok: true });
        return;
      }
      await json({ ok: true });
    } catch {
      // Route was aborted (disconnect test) — nothing to do.
    }
  });

  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('biq-onboard-app', { state: 'attached', timeout: 10000 });
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el && el.shadowRoot);
  }, { timeout: 10000 });
  await page.evaluate(() => {
    const el = document.getElementById('app');
    el.org = { club: null, email: 'new@basketiq.io', display_name: 'New', memberships: [] };
    el.user = 'test-user';
  });
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el.shadowRoot && el.shadowRoot.querySelector('[data-join-btn]'));
  }, { timeout: 10000 });

  return { page, log, releaseHang };
}

/** Click the join form and return the button state captured synchronously. */
const clickJoin = (page, clubId) =>
  page.evaluate((id) => {
    const el = document.getElementById('app');
    const input = el.shadowRoot.querySelector('[data-join-id]');
    input.value = id;
    el.shadowRoot.querySelector('[data-join-btn]').click();
    const btn = el.shadowRoot.querySelector('[data-join-btn]');
    return { disabled: btn.disabled };
  }, clubId);

/** Poll a Node-side predicate until it passes (or timeout). */
async function waitFor(predicate, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

test.before(async () => { await startServer(); });
test.after(async () => { await stopServer(); });

test('one click issues exactly one join request', async (t) => {
  const browser = await chromium.launch();
  const { page, log } = await newPage(browser, 'join-ok');
  const state = await clickJoin(page, 'club_x');
  assert.equal(state.disabled, true, 'join button disabled immediately on submit');
  await waitFor(() => log.some((e) => e.url.includes('/api/auth/register')));
  const joins = log.filter((e) => e.url.includes('/api/auth/register'));
  assert.equal(joins.length, 1, 'exactly one register request');
  assert.equal(JSON.parse(joins[0].postData).club_id, 'club_x');
  await browser.close();
});

test('repeated submit still issues exactly one request', async (t) => {
  const browser = await chromium.launch();
  const { page, log } = await newPage(browser, 'join-ok');
  await page.evaluate(() => {
    const el = document.getElementById('app');
    const input = el.shadowRoot.querySelector('[data-join-id]');
    input.value = 'club_x';
    const btn = el.shadowRoot.querySelector('[data-join-btn]');
    btn.click();
    // Force additional clicks/Enter even though native disabled is applied.
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await waitFor(() => log.some((e) => e.url.includes('/api/auth/register')));
  await page.waitForTimeout(250);
  const joins = log.filter((e) => e.url.includes('/api/auth/register'));
  assert.equal(joins.length, 1, 'repeated submit still one request');
  await browser.close();
});

test('success remains locked through redirect', async (t) => {
  const browser = await chromium.launch();
  const { page, log } = await newPage(browser, 'join-ok');
  const state = await clickJoin(page, 'club_x');
  assert.equal(state.disabled, true, 'join button disabled at submission');
  await waitFor(() => log.some((e) => e.url.includes('/api/auth/register')));
  // The ok response drives window.location.replace('/'); the component must not
  // re-enable or re-submit. Give the redirect a moment to commit.
  await page.waitForTimeout(250);
  const joins = log.filter((e) => e.url.includes('/api/auth/register'));
  assert.equal(joins.length, 1, 'still exactly one request through redirect');
  assert.equal(new URL(page.url()).pathname, '/', 'redirects to home');
  await browser.close();
});

test('failure restores values, re-enables controls, and focuses the error', async (t) => {
  const browser = await chromium.launch();
  const { page } = await newPage(browser, 'create-fail');
  await page.evaluate(() => {
    const el = document.getElementById('app');
    // Activate the Create tab first (default tab is join).
    el.shadowRoot.querySelector('[data-club-tab="create"]').click();
  });
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el.shadowRoot && !el.shadowRoot.querySelector('#club-panel-create').hidden);
  });
  await page.evaluate(() => {
    const el = document.getElementById('app');
    const name = el.shadowRoot.querySelector('[data-create-name]');
    const web = el.shadowRoot.querySelector('[data-create-website]');
    name.value = 'Club Nuevo';
    web.value = 'https://club.es';
    // Real typing fires input events; the component tracks values from them.
    name.dispatchEvent(new Event('input', { bubbles: true }));
    web.dispatchEvent(new Event('input', { bubbles: true }));
    el.shadowRoot.querySelector('[data-create-btn]').click();
  });
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el.shadowRoot && el.shadowRoot.querySelector('#club-panel-create [role="alert"]'));
  }, { timeout: 10000 });
  const result = await page.evaluate(() => {
    const el = document.getElementById('app');
    const name = el.shadowRoot.querySelector('[data-create-name]');
    const btn = el.shadowRoot.querySelector('[data-create-btn]');
    const alert = el.shadowRoot.querySelector('#club-panel-create [role="alert"]');
    return {
      nameValue: name.value,
      btnDisabled: btn.disabled,
      alertText: alert.textContent,
      alertFocused: el.shadowRoot.activeElement === alert,
    };
  });
  assert.equal(result.nameValue, 'Club Nuevo', 'typed name preserved after failure');
  assert.equal(result.btnDisabled, false, 'create button re-enabled after failure');
  assert.match(result.alertText, /https/);
  assert.equal(result.alertFocused, true, 'error element receives focus');
  await browser.close();
});

test('disconnect aborts the in-flight request and rejects stale completion', async (t) => {
  const browser = await chromium.launch();
  const { page, releaseHang } = await newPage(browser, 'hang');
  await page.evaluate(() => {
    const el = document.getElementById('app');
    const name = el.shadowRoot.querySelector('[data-create-name]');
    name.value = 'Club Colgado';
    el.shadowRoot.querySelector('[data-create-btn]').click();
    window.__controller = el._clubSubmitAbort;
  });
  // Remove the element while the request hangs; the controller must abort.
  await page.evaluate(() => {
    document.getElementById('app').remove();
  });
  const aborted = await page.evaluate(() => window.__controller.signal.aborted);
  assert.equal(aborted, true, 'fetch controller aborted on disconnect');
  // Release the stale response; the component must not navigate.
  releaseHang();
  await page.waitForTimeout(400);
  assert.equal(new URL(page.url()).pathname, '/', 'page did not navigate from stale completion');
  await browser.close();
});

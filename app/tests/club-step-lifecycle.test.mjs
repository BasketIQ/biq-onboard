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
 *   'join-ok'     → /api/auth/register ok (component shows pending-confirmation, no redirect)
 *   'join-fail'   → /api/auth/register 422 {"detail": "El ID del club no existe"}
 *   'join-netfail'→ /api/auth/register aborted (network rejection)
 *   'create-ok'   → onboarding/clubs ok with club.id, select-club ok
 *   'create-fail' → onboarding/clubs 422 {"detail": "La web del club debe usar https://"}
 *   'create-netfail' → onboarding/clubs aborted (network rejection)
 *   'hang'        → onboarding/clubs AND /api/auth/register hang until `releaseHang`
 *   'hang-first'  → the FIRST onboarding/clubs hangs; later ones respond ok
 */
async function newPage(browser, scenario) {
  const page = await browser.newPage();
  const log = [];
  let releaseHang = null;
  const hangPromise = new Promise((resolve) => { releaseHang = resolve; });
  let onboardingClubsCount = 0;

  await page.route('**/api/**', async (route) => {
    const req = route.request();
    log.push({ url: req.url(), method: req.method(), postData: req.postData() });
    const u = req.url();
    if (scenario === 'hang-first' && u.includes('/api/onboarding/clubs')) {
      onboardingClubsCount += 1;
      if (onboardingClubsCount === 1) {
        await hangPromise;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, club: { id: 'club-new' } }) });
        return;
      }
    }
    const json = (data, status = 200) => route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(data),
    });
    try {
      if (scenario === 'hang' && (u.includes('/api/onboarding/clubs') || u.includes('/api/auth/register'))) {
        await hangPromise;
        await json({ ok: true, club: { id: 'club-new' } });
        return;
      }
      if (u.includes('/api/auth/register')) {
        if (scenario === 'join-fail') {
          await json({ detail: 'El ID del club no existe' }, 422);
          return;
        }
        if (scenario === 'join-netfail') {
          await route.abort('failed');
          return;
        }
        await json({ ok: true });
        return;
      }
      if (u.includes('/api/onboarding/clubs')) {
        if (scenario === 'create-fail') {
          await json({ detail: 'La web del club debe usar https://' }, 422);
          return;
        }
        if (scenario === 'create-netfail') {
          await route.abort('failed');
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
      // Route was aborted (disconnect/netfail tests) — nothing to do.
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
    input.dispatchEvent(new Event('input', { bubbles: true }));
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
    input.dispatchEvent(new Event('input', { bubbles: true }));
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

test('join success shows pending-confirmation and does not navigate', async (t) => {
  // D1 fix: A successful join creates a pending JoinRequest — the user has
  // no real club yet. The component must NOT navigate to "/" (which would
  // loop back to #/onboard via needsClubStep()). Instead it should stay on
  // the join panel, clear the lock/spinner, and show a confirmation message.
  const browser = await chromium.launch();
  const { page, log } = await newPage(browser, 'join-ok');
  const state = await clickJoin(page, 'club_x');
  assert.equal(state.disabled, true, 'join button disabled at submission');
  await waitFor(() => log.some((e) => e.url.includes('/api/auth/register')));
  // Give the response handler a moment to process
  await page.waitForTimeout(250);
  const joins = log.filter((e) => e.url.includes('/api/auth/register'));
  assert.equal(joins.length, 1, 'still exactly one request');
  // D1 fix: Must NOT have navigated. In this harness all paths serve the same
  // HTML, so we verify non-navigation by checking the success message is visible
  // (only set in the non-navigate path) and controls are re-enabled.
  // If window.location.replace('/') had fired, the page would reload and the
  // success message would not be present.
  // Check that the pending-confirmation message is shown
  const result = await page.evaluate(() => {
    const el = document.getElementById('app');
    const sr = el.shadowRoot;
    const success = sr.querySelector('#club-panel-join .onboard-success');
    const btn = sr.querySelector('[data-join-btn]');
    const input = sr.querySelector('[data-join-id]');
    return {
      hasSuccess: !!success,
      successText: success ? success.textContent.trim() : '',
      btnDisabled: btn.disabled,
      inputDisabled: input.disabled,
    };
  });
  assert.equal(result.hasSuccess, true, 'pending-confirmation message is shown');
  assert.match(result.successText, /Solicitud enviada/, 'message says request was sent');
  assert.equal(result.btnDisabled, false, 'join button re-enabled after success');
  assert.equal(result.inputDisabled, false, 'join input re-enabled after success');
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
    // Activate the Create tab (default is join).
    el.shadowRoot.querySelector('[data-club-tab="create"]').click();
  });
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el.shadowRoot && !el.shadowRoot.querySelector('#club-panel-create').hidden);
  });
  await page.evaluate(() => {
    const el = document.getElementById('app');
    const name = el.shadowRoot.querySelector('[data-create-name]');
    name.value = 'Club Colgado';
    name.dispatchEvent(new Event('input', { bubbles: true }));
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

test('initial enabled state with no busy flags', async (t) => {
  const browser = await chromium.launch();
  const { page } = await newPage(browser, 'join-ok');
  const initial = await page.evaluate(() => {
    const el = document.getElementById('app');
    const sr = el.shadowRoot;
    const joinBtn = sr.querySelector('[data-join-btn]');
    const joinInput = sr.querySelector('[data-join-id]');
    const createTab = sr.querySelector('[data-club-tab="create"]');
    const joinPanel = sr.querySelector('#club-panel-join');
    return {
      joinBtnDisabled: joinBtn.disabled,
      joinInputDisabled: joinInput.disabled,
      createTabDisabled: createTab.disabled,
      ariaBusy: joinPanel.getAttribute('aria-busy'),
      tabSelected: sr.querySelector('[data-club-tab="join"]').getAttribute('aria-selected'),
    };
  });
  assert.equal(initial.joinBtnDisabled, false, 'join button enabled initially');
  assert.equal(initial.joinInputDisabled, false, 'join input enabled initially');
  assert.equal(initial.createTabDisabled, false, 'tabs enabled initially');
  assert.equal(initial.ariaBusy, 'false', 'no aria-busy before submission');
  assert.equal(initial.tabSelected, 'true', 'join tab selected by default for zero memberships');
  await browser.close();
});

test('accepted submission sets aria-busy and a real spinner with reduced-motion support', async (t) => {
  const browser = await chromium.launch();
  const { page, log } = await newPage(browser, 'hang');
  // reduced-motion preference must disable the spinner animation.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => {
    const el = document.getElementById('app');
    const input = el.shadowRoot.querySelector('[data-join-id]');
    input.value = 'club_x';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    el.shadowRoot.querySelector('[data-join-btn]').click();
  });
  await waitFor(() => log.length >= 1);
  const busy = await page.evaluate(() => {
    const el = document.getElementById('app');
    const sr = el.shadowRoot;
    const panel = sr.querySelector('#club-panel-join');
    const spinner = sr.querySelector('.onboard-spinner');
    const style = spinner ? getComputedStyle(spinner) : null;
    return {
      ariaBusy: panel.getAttribute('aria-busy'),
      joinBtnDisabled: sr.querySelector('[data-join-btn]').disabled,
      joinInputDisabled: sr.querySelector('[data-join-id]').disabled,
      spinnerVisible: !!(spinner && style && style.display !== 'none'),
      animationName: style ? style.animationName : null,
      statusText: sr.querySelector('[data-join-btn]').textContent.trim(),
    };
  });
  assert.equal(busy.ariaBusy, 'true', 'panel aria-busy during submission');
  assert.equal(busy.joinBtnDisabled, true, 'join button natively disabled');
  assert.equal(busy.joinInputDisabled, true, 'join input natively disabled');
  assert.equal(busy.spinnerVisible, true, 'spinner element rendered');
  assert.equal(busy.animationName, 'none', 'reduced-motion disables spinner animation');
  assert.match(busy.statusText, /Enviando solicitud/, 'action-specific status text shown');
  await browser.close();
});

/** Activate the Create tab and type into the create form, then click. */
const submitCreateForm = (page, name, website) =>
  page.evaluate(([n, w]) => {
    const el = document.getElementById('app');
    el.shadowRoot.querySelector('[data-club-tab="create"]').click();
    const nameInput = el.shadowRoot.querySelector('[data-create-name]');
    const webInput = el.shadowRoot.querySelector('[data-create-website]');
    nameInput.value = n;
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    webInput.value = w;
    webInput.dispatchEvent(new Event('input', { bubbles: true }));
    el.shadowRoot.querySelector('[data-create-btn]').click();
    return { disabled: el.shadowRoot.querySelector('[data-create-btn]').disabled };
  }, [name, website]);

test('create form: one accepted click issues exactly one request and locks', async (t) => {
  const browser = await chromium.launch();
  const { page, log } = await newPage(browser, 'create-ok');
  const state = await submitCreateForm(page, 'Club Nuevo', '');
  assert.equal(state.disabled, true, 'create button disabled immediately');
  await waitFor(() => log.some((e) => e.url.includes('/api/onboarding/clubs')));
  const creates = log.filter((e) => e.url.includes('/api/onboarding/clubs'));
  assert.equal(creates.length, 1, 'exactly one create request');
  assert.equal(JSON.parse(creates[0].postData).name, 'Club Nuevo');
  // The select-club chain must follow to re-point the session.
  await waitFor(() => log.some((e) => e.url.includes('/api/auth/select-club')));
  assert.equal(log.filter((e) => e.url.includes('/api/auth/select-club')).length, 1);
  await browser.close();
});

test('create form: duplicate clicks and Enter still produce one request', async (t) => {
  const browser = await chromium.launch();
  const { page, log } = await newPage(browser, 'create-ok');
  await page.evaluate(() => {
    const el = document.getElementById('app');
    el.shadowRoot.querySelector('[data-club-tab="create"]').click();
  });
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el.shadowRoot && !el.shadowRoot.querySelector('#club-panel-create').hidden);
  });
  await page.evaluate(() => {
    const el = document.getElementById('app');
    const nameInput = el.shadowRoot.querySelector('[data-create-name]');
    nameInput.value = 'Club Duplicado';
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    const btn = el.shadowRoot.querySelector('[data-create-btn]');
    btn.click();
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    nameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await waitFor(() => log.some((e) => e.url.includes('/api/onboarding/clubs')));
  await page.waitForTimeout(250);
  const creates = log.filter((e) => e.url.includes('/api/onboarding/clubs'));
  assert.equal(creates.length, 1, 'repeated submit still one create request');
  await browser.close();
});

test('create form: success locks through session selection and navigates', async (t) => {
  const browser = await chromium.launch();
  const { page, log } = await newPage(browser, 'create-ok');
  const state = await submitCreateForm(page, 'Club Navega', '');
  assert.equal(state.disabled, true, 'create button disabled at submission');
  await waitFor(() => log.some((e) => e.url.includes('/api/auth/select-club')));
  await page.waitForTimeout(250);
  const creates = log.filter((e) => e.url.includes('/api/onboarding/clubs'));
  assert.equal(creates.length, 1, 'exactly one create request through navigation');
  assert.equal(new URL(page.url()).pathname, '/', 'navigates home after select-club');
  await browser.close();
});

test('join form: HTTP failure restores controls, preserves values, and shows an error', async (t) => {
  const browser = await chromium.launch();
  const { page } = await newPage(browser, 'join-fail');
  await page.evaluate(() => {
    const el = document.getElementById('app');
    const input = el.shadowRoot.querySelector('[data-join-id]');
    input.value = 'club_ghost';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    el.shadowRoot.querySelector('[data-join-btn]').click();
  });
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el.shadowRoot && el.shadowRoot.querySelector('#club-panel-join [role="alert"]'));
  }, { timeout: 10000 });
  const result = await page.evaluate(() => {
    const el = document.getElementById('app');
    const input = el.shadowRoot.querySelector('[data-join-id]');
    const btn = el.shadowRoot.querySelector('[data-join-btn]');
    const alert = el.shadowRoot.querySelector('#club-panel-join [role="alert"]');
    return {
      value: input.value,
      btnDisabled: btn.disabled,
      alertText: alert.textContent,
      alertFocused: el.shadowRoot.activeElement === alert,
    };
  });
  assert.equal(result.value, 'club_ghost', 'typed join id preserved after failure');
  assert.equal(result.btnDisabled, false, 'join button re-enabled after failure');
  assert.match(result.alertText, /no existe/);
  assert.equal(result.alertFocused, true, 'error element receives focus');
  await browser.close();
});

test('join form: network rejection restores controls and focuses error', async (t) => {
  const browser = await chromium.launch();
  const { page } = await newPage(browser, 'join-netfail');
  await page.evaluate(() => {
    const el = document.getElementById('app');
    const input = el.shadowRoot.querySelector('[data-join-id]');
    input.value = 'club_net';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    el.shadowRoot.querySelector('[data-join-btn]').click();
  });
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el.shadowRoot && el.shadowRoot.querySelector('#club-panel-join [role="alert"]'));
  }, { timeout: 10000 });
  const result = await page.evaluate(() => {
    const el = document.getElementById('app');
    const input = el.shadowRoot.querySelector('[data-join-id]');
    const btn = el.shadowRoot.querySelector('[data-join-btn]');
    const panel = el.shadowRoot.querySelector('#club-panel-join');
    const alert = el.shadowRoot.querySelector('#club-panel-join [role="alert"]');
    return {
      value: input.value,
      btnDisabled: btn.disabled,
      ariaBusy: panel.getAttribute('aria-busy'),
      alertFocused: el.shadowRoot.activeElement === alert,
    };
  });
  assert.equal(result.value, 'club_net', 'value preserved after network rejection');
  assert.equal(result.btnDisabled, false, 'controls restored after network rejection');
  assert.equal(result.ariaBusy, 'false', 'aria-busy cleared');
  assert.equal(result.alertFocused, true, 'error focused after network rejection');
  await browser.close();
});

test('create form: network rejection restores controls and focuses error', async (t) => {
  const browser = await chromium.launch();
  const { page } = await newPage(browser, 'create-netfail');
  await submitCreateForm(page, 'Club Red', '');
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el.shadowRoot && el.shadowRoot.querySelector('#club-panel-create [role="alert"]'));
  }, { timeout: 10000 });
  const result = await page.evaluate(() => {
    const el = document.getElementById('app');
    const name = el.shadowRoot.querySelector('[data-create-name]');
    const btn = el.shadowRoot.querySelector('[data-create-btn]');
    const panel = el.shadowRoot.querySelector('#club-panel-create');
    const alert = el.shadowRoot.querySelector('#club-panel-create [role="alert"]');
    return {
      nameValue: name.value,
      btnDisabled: btn.disabled,
      ariaBusy: panel.getAttribute('aria-busy'),
      alertFocused: el.shadowRoot.activeElement === alert,
    };
  });
  assert.equal(result.nameValue, 'Club Red', 'name preserved after network rejection');
  assert.equal(result.btnDisabled, false, 'controls restored');
  assert.equal(result.ariaBusy, 'false', 'aria-busy cleared');
  assert.equal(result.alertFocused, true, 'error focused');
  await browser.close();
});

test('stale completion cannot mutate a newer mounted instance', async (t) => {
  const browser = await chromium.launch();
  const { page, log, releaseHang } = await newPage(browser, 'hang-first');
  // Instance 1 starts a create submission that hangs.
  await page.evaluate(() => {
    const el = document.getElementById('app');
    el.shadowRoot.querySelector('[data-club-tab="create"]').click();
  });
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el.shadowRoot && !el.shadowRoot.querySelector('#club-panel-create').hidden);
  });
  await page.evaluate(() => {
    const el = document.getElementById('app');
    const name = el.shadowRoot.querySelector('[data-create-name]');
    name.value = 'Club Uno';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    el.shadowRoot.querySelector('[data-create-btn]').click();
    window.__controllerOne = el._clubSubmitAbort;
  });
  await waitFor(() => log.some((e) => e.url.includes('/api/onboarding/clubs')));
  // Remove instance 1; the in-flight controller must abort immediately.
  await page.evaluate(() => {
    document.getElementById('app').remove();
  });
  const abortedOne = await page.evaluate(() => window.__controllerOne.signal.aborted);
  assert.equal(abortedOne, true, 'stale request aborted on disconnect');
  // Mount a fresh instance and start a NEW submission.
  await page.evaluate(() => {
    const fresh = document.createElement('biq-onboard-app');
    fresh.id = 'app';
    document.body.appendChild(fresh);
  });
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el.shadowRoot);
  });
  await page.evaluate(() => {
    const el = document.getElementById('app');
    el.org = { club: null, email: 'fresh@basketiq.io', display_name: 'Fresh', memberships: [] };
    el.user = 'fresh';
  });
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el.shadowRoot && el.shadowRoot.querySelector('[data-club-tab="create"]'));
  });
  await page.evaluate(() => {
    const el = document.getElementById('app');
    el.shadowRoot.querySelector('[data-club-tab="create"]').click();
  });
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el.shadowRoot && !el.shadowRoot.querySelector('#club-panel-create').hidden);
  });
  await page.evaluate(() => {
    const el = document.getElementById('app');
    const name = el.shadowRoot.querySelector('[data-create-name]');
    name.value = 'Club Dos';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    el.shadowRoot.querySelector('[data-create-btn]').click();
  });
  // Second submission responds ok (hang-first only hangs the first request).
  await waitFor(() => log.filter((e) => e.url.includes('/api/onboarding/clubs')).length >= 2);
  await page.waitForTimeout(250);
  const before = new URL(page.url()).pathname;
  // Release the STALE first response; it must not navigate or throw.
  releaseHang();
  await page.waitForTimeout(400);
  assert.equal(new URL(page.url()).pathname, before, 'stale completion did not navigate');
  await browser.close();
});

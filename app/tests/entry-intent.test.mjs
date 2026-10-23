/**
 * Entry intent fencing — entry-login §4.2 executable contract:
 *
 *   - one in-flight intent: double clicks and competing cards are deduped;
 *   - success emits `biq-context:activated` exactly once per intent and
 *     keeps «Entrando…» until unmount, fresh bootstrap or the bounded
 *     confirm wait;
 *   - POST ok + narrowing PUT fail → recovery (Reintentar equipo = PUT
 *     only; Entrar con todos = plain activation path), no event, no
 *     second POST, no rollback claim;
 *   - uncertain transport after a mutation → «No sabemos si la entrada se
 *     completó» + «Comprobar» (bootstrap GET only — never auto-re-POST);
 *   - a stale intent's late completion emits nothing, paints nothing and
 *     releases nothing (busy stays owned by the newer intent);
 *   - create→enter and redeem→activate run inside ONE intent — busy holds
 *     across both requests and a single event fires at the end.
 *
 * Run: `npm run build:lib && node --test tests/entry-intent.test.mjs`
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
const PORT = 9154;

if (!existsSync(DIST_EMBED)) {
  throw new Error('Build output not found. Run `npm run build:lib` first.');
}

const bundle = readFileSync(DIST_EMBED, 'utf8');
let server = null;

const HARNESS = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>entry intent</title></head>
<body>
  <biq-onboard-app id="app"></biq-onboard-app>
  <script type="module" src="/embed/biq-onboard.js"></script>
</body>
</html>`;

const CLUB = (id, name) => ({
  kind: 'club',
  owner_scope: { kind: 'club', club_id: id },
  name,
  requires_verification: false,
});

const BOOTSTRAP = {
  schema_version: '1',
  state: 'context_selection_required',
  account_id: 'acc-e2e',
  identity_verified: true,
  contexts: [CLUB('club-1', 'Club Prueba')],
  active: null,
  entry_actions: {
    'club.create': { allowed: true, requires_verification: false },
    'club.invitation.redeem': { allowed: true, requires_verification: false },
    'personal.enter': { allowed: true, requires_verification: false },
  },
};

const TEAM = (id, name, extra = {}) => ({
  team_id: id,
  name,
  category_key: 'infantil',
  category_label: 'Infantil',
  gender: 'M',
  age_band: '',
  section_applicability: 'all',
  timezone: 'Europe/Madrid',
  season: '2026-27',
  team_revision: 1,
  archived: false,
  ...extra,
});

const PERSONAL_TEAMS = [TEAM('pt-1', 'Paquetillos 1'), TEAM('pt-2', 'Paquetillos 2')];

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
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

/**
 * Spec-driven route mock.
 *   activateSpec(callNo) → 'ok' | { status, body } | { network: true } | { hold: promise }
 *   putSpec(callNo)      → same shape (PUT active/working-teams)
 *   bootstrap            → payload or () => payload (dynamic per scope)
 */
async function newIntentPage(browser, {
  bootstrap = BOOTSTRAP,
  activateSpec = () => 'ok',
  putSpec = () => 'ok',
  personalTeams = PERSONAL_TEAMS,
  routeQuery = null,
} = {}) {
  const page = await browser.newPage();
  const log = [];
  let activateCalls = 0;
  let putCalls = 0;

  await page.route('**/api/**', async (route) => {
    const req = route.request();
    log.push({ url: req.url(), method: req.method(), postData: req.postData() });
    const json = (data, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    const applySpec = async (spec) => {
      if (spec === 'ok' || spec == null) return json({ ok: true });
      if (spec.hold) { await spec.hold; return json({ ok: true }); }
      if (spec.network) return route.abort();
      return json(spec.body ?? { detail: 'rejected' }, spec.status ?? 500);
    };
    try {
      const u = req.url();
      if (u.includes('/api/context/v1/bootstrap')) {
        const payload = typeof bootstrap === 'function' ? bootstrap() : bootstrap;
        return json(payload);
      }
      if (u.includes('/api/context/v1/activate')) {
        activateCalls += 1;
        return applySpec(activateSpec(activateCalls));
      }
      if (u.includes('/api/context/v1/active/working-teams')) {
        putCalls += 1;
        return applySpec(putSpec(putCalls));
      }
      if (u.includes('/api/context/v1/personal-teams') && req.method() === 'POST') {
        return json({ team: { team_id: 'pt-new' } }, 201);
      }
      if (u.includes('/api/context/v1/personal-teams')) return json({ teams: personalTeams });
      if (u.includes('/api/context/v1/invitations/') && u.includes('/preview')) {
        return json({ club_id: 'club-inv', club_name: 'Club Invitado' });
      }
      if (u.includes('/api/context/v1/invitations/redeem')) {
        return json({ ok: true, club_id: 'club-inv' });
      }
      return json({ ok: true });
    } catch {
      // Route already answered/aborted.
    }
  });

  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('biq-onboard-app', { state: 'attached', timeout: 10000 });
  await page.evaluate((rq) => {
    const el = document.getElementById('app');
    window.__activatedEvents = [];
    el.addEventListener('biq-context:activated', (ev) => {
      window.__activatedEvents.push(ev.detail || null);
    });
    if (rq) el.route = rq;
    el.org = { club: null, email: 'e2e@basketiq.io', display_name: 'E2E', memberships: [] };
    el.user = 'e2e-user';
  }, routeQuery);
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el.shadowRoot && el.shadowRoot.querySelector('.entry-step'));
  }, { timeout: 10000 });
  // Personal feed ready — cards present.
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return el._personalTeamsStatus === 'ready' || el.shadowRoot.querySelector('.entry-block');
  }, { timeout: 10000 });

  const counts = () => ({
    activate: log.filter((r) => r.url.includes('/api/context/v1/activate')).length,
    working: log.filter((r) => r.url.includes('/active/working-teams')).length,
    bootstrap: log.filter((r) => r.url.includes('/api/context/v1/bootstrap')).length,
    createTeam: log.filter((r) => r.method === 'POST' && r.url.includes('/personal-teams')).length,
    redeem: log.filter((r) => r.url.includes('/invitations/redeem')).length,
  });
  const events = () => page.evaluate(() => window.__activatedEvents);
  const shadowText = () =>
    page.evaluate(() => document.getElementById('app').shadowRoot.textContent);

  return { page, log, counts, events, shadowText };
}

const clickShadow = (page, selector) =>
  page.evaluate((s) => {
    const el = document.getElementById('app');
    el.shadowRoot.querySelector(s)?.click();
  }, selector);

test.before(async () => { await startServer(); });
test.after(async () => { await stopServer(); });

test('double click → exactly 1 activate POST and 1 event', async () => {
  const browser = await chromium.launch();
  try {
    const { page, counts, events } = await newIntentPage(browser);
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-entry-personal-enter-team="pt-1"]'),
      { timeout: 10000 });
    // Two synchronous clicks on the same control + a competing card — the
    // single-flight intent must dedupe all of them.
    await page.evaluate(() => {
      const el = document.getElementById('app');
      const btn = el.shadowRoot.querySelector('[data-entry-personal-enter-team="pt-1"]');
      const other = el.shadowRoot.querySelector('[data-entry-personal-enter-team="pt-2"]');
      btn.click();
      btn.click();
      other.click();
    });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(counts().activate, 1, 'double click issues exactly one activate POST');
    const evts = await events();
    assert.equal(evts.length, 1, 'exactly one activation event');
    assert.deepEqual(evts[0], { kind: 'personal', club_id: null, team_id: 'pt-1' });
  } finally {
    await browser.close();
  }
});

test('success → exactly 1 biq-context:activated and busy stays «Entrando…»', async () => {
  const browser = await chromium.launch();
  try {
    const { page, events } = await newIntentPage(browser);
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-entry-club-activate]'),
      { timeout: 10000 });
    await clickShadow(page, '[data-entry-club-activate]');
    await new Promise((r) => setTimeout(r, 300));
    const evts = await events();
    assert.equal(evts.length, 1);
    assert.deepEqual(evts[0], { kind: 'club', club_id: 'club-1', team_id: null });
    const busy = await page.evaluate(() => ({
      busy: document.getElementById('app')._entryBusy,
      status: document.getElementById('app').shadowRoot.querySelector('.entry-status')?.textContent.trim(),
    }));
    assert.equal(busy.busy, true, 'busy holds «Entrando…» after emission');
    assert.equal(busy.status, 'Entrando…');
  } finally {
    await browser.close();
  }
});

test('POST 200 + PUT 4xx → recovery, 0 events, no second POST; «Reintentar equipo» runs PUT only', async () => {
  const browser = await chromium.launch();
  try {
    let putFails = true;
    const { page, counts, events, shadowText } = await newIntentPage(browser, {
      putSpec: () => (putFails ? { status: 409, body: { detail: 'working-set conflict' } } : 'ok'),
    });
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-entry-personal-enter-team="pt-1"]'),
      { timeout: 10000 });
    await clickShadow(page, '[data-entry-personal-enter-team="pt-1"]');
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-entry-retry-team]'),
      { timeout: 10000 });
    assert.equal(counts().activate, 1, 'no automatic second POST');
    assert.equal(counts().working, 1);
    assert.equal((await events()).length, 0, 'no event on narrowing failure');
    const text = await shadowText();
    assert.ok(text.includes('working-set conflict'), 'recovery shows the PUT failure');
    assert.ok(text.includes('Reintentar equipo'));
    assert.ok(text.includes('Entrar con todos los equipos'));
    assert.ok(!/rollback|revertid/i.test(text), 'no rollback claim');
    // The resync already ran (bootstrap + feed GET) — keep it bounded.
    await page.waitForTimeout(600);
    assert.equal(counts().activate, 1, 'still no re-POST during resync');

    // «Reintentar equipo» → PUT only, then the single event.
    putFails = false;
    await clickShadow(page, '[data-entry-retry-team]');
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(counts().activate, 1, 'retry narrows only — the POST already applied');
    assert.equal(counts().working, 2, 'the explicit PUT retry fired once');
    const evts = await events();
    assert.equal(evts.length, 1, 'one event after the retry succeeds');
    assert.deepEqual(evts[0], { kind: 'personal', club_id: null, team_id: 'pt-1' });
  } finally {
    await browser.close();
  }
});

test('POST network failure → uncertain transport message, POST count stays 1, «Comprobar» = bootstrap GET only', async () => {
  const browser = await chromium.launch();
  try {
    let failActivate = true;
    const { page, counts, events, shadowText } = await newIntentPage(browser, {
      activateSpec: () => (failActivate ? { network: true } : 'ok'),
    });
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-entry-club-activate]'),
      { timeout: 10000 });
    await clickShadow(page, '[data-entry-club-activate]');
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-entry-check]'),
      { timeout: 10000 });
    assert.equal(counts().activate, 1, 'no automatic retry of an uncertain mutation');
    const text = await shadowText();
    assert.ok(text.includes('No sabemos si la entrada se completó'), 'uncertain copy shown');
    assert.ok(text.includes('Comprobar'));
    assert.equal((await events()).length, 0, 'no event on uncertain transport');

    const bootstrapBefore = counts().bootstrap;
    await clickShadow(page, '[data-entry-check]');
    await page.waitForFunction((n) => {
      const el = document.getElementById('app');
      return !!(el.shadowRoot && el.shadowRoot.querySelector('.entry-step') && el._bootstrap);
    }, bootstrapBefore, { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(counts().bootstrap > bootstrapBefore, 'Comprobar resynchronizes via bootstrap GET');
    assert.equal(counts().activate, 1, 'Comprobar never re-POSTs');
    assert.equal((await events()).length, 0);
  } finally {
    await browser.close();
  }
});

test('account switch while intent A POST is pending → A emits/paints/releases nothing; B keeps busy and completes alone', async () => {
  const browser = await chromium.launch();
  try {
    const heldA = deferred();
    const heldB = deferred();
    let accB = false;
    const { page, counts, events, shadowText } = await newIntentPage(browser, {
      bootstrap: () => ({ ...BOOTSTRAP, account_id: accB ? 'acc-b' : 'acc-e2e' }),
      activateSpec: (n) => (n === 1 ? { hold: heldA.promise } : n === 2 ? { hold: heldB.promise } : 'ok'),
    });
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-entry-personal-enter-team="pt-1"]'),
      { timeout: 10000 });
    // Intent A starts; its activate POST stays in flight (held).
    await clickShadow(page, '[data-entry-personal-enter-team="pt-1"]');
    await page.waitForFunction(() =>
      document.getElementById('app')._entryIntent?.team_id === 'pt-1',
      { timeout: 10000 });
    assert.equal(counts().activate, 1, 'intent A POST is in flight');

    // Account switch: new bootstrap scope for acc-b invalidates A.
    accB = true;
    await page.evaluate(() => { document.getElementById('app').user = 'acc-b'; });
    await page.waitForFunction(() =>
      document.getElementById('app')._personalTeamsStatus === 'ready'
        && !!document.getElementById('app').shadowRoot.querySelector('[data-entry-personal-enter-team="pt-2"]'),
      { timeout: 10000 });

    // Intent B starts in the new scope (second team) — its POST is held.
    await clickShadow(page, '[data-entry-personal-enter-team="pt-2"]');
    await page.waitForFunction(() =>
      document.getElementById('app')._entryIntent?.team_id === 'pt-2',
      { timeout: 10000 });

    // A's late response lands now: stale — must emit nothing, paint
    // nothing and NOT release B's busy hold.
    heldA.resolve();
    await new Promise((r) => setTimeout(r, 500));
    const mid = await page.evaluate(() => ({
      busy: document.getElementById('app')._entryBusy,
      intentTeam: document.getElementById('app')._entryIntent?.team_id,
      error: !!document.getElementById('app').shadowRoot.querySelector('.entry-error, .entry-recovery'),
    }));
    assert.equal(mid.busy, true, "A's completion must not release B's busy");
    assert.equal(mid.intentTeam, 'pt-2', 'B is still the owning intent');
    assert.equal(mid.error, false, 'A paints no error/recovery');
    assert.equal((await events()).length, 0, 'A emits nothing');

    // B completes alone — exactly one event, bound to pt-2.
    heldB.resolve();
    await new Promise((r) => setTimeout(r, 300));
    const evts = await events();
    assert.equal(evts.length, 1);
    assert.deepEqual(evts[0], { kind: 'personal', club_id: null, team_id: 'pt-2' });
    const text = await shadowText();
    assert.ok(!/No se pudo|No sabemos/.test(text), 'no stale failure painted');
  } finally {
    await browser.close();
  }
});

test('create→enter chain: busy holds across both requests, one event at the end', async () => {
  const browser = await chromium.launch();
  try {
    const heldActivate = deferred();
    const { page, counts, events } = await newIntentPage(browser, {
      activateSpec: (n) => (n === 1 ? { hold: heldActivate.promise } : 'ok'),
      // One team — below the 2-personal-team cap so «+ Crear equipo» renders.
      personalTeams: [TEAM('pt-1', 'Paquetillos 1')],
    });
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-entry-team-create-toggle]'),
      { timeout: 10000 });
    await clickShadow(page, '[data-entry-team-create-toggle]');
    await page.evaluate(() => {
      const el = document.getElementById('app');
      const form = el.shadowRoot.querySelector('[data-entry-personal-create]');
      form.querySelector('input[name="name"]').value = 'Equipo Nuevo';
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    // The create POST resolved; activate is held — busy must still hold
    // under the SAME intent (create→enter is one operation).
    await page.waitForFunction(() =>
      document.getElementById('app')._entryIntent?.kind === 'create-team'
        && document.getElementById('app')._entryIntent?.team_id === 'pt-new',
      { timeout: 10000 });
    const mid = await page.evaluate(() => ({
      busy: document.getElementById('app')._entryBusy,
      status: document.getElementById('app').shadowRoot.querySelector('.entry-status')?.textContent.trim(),
    }));
    assert.equal(counts().createTeam, 1);
    assert.equal(counts().activate, 1, 'the activation POST is in flight');
    assert.equal(mid.busy, true, 'busy holds across create→enter — no nested release');
    assert.equal(mid.status, 'Entrando…');
    heldActivate.resolve();
    await page.waitForTimeout(500);
    assert.equal(counts().working, 1, 'the new team is narrowed');
    const evts = await events();
    assert.equal(evts.length, 1, 'one event for the whole chain');
    assert.deepEqual(evts[0], { kind: 'personal', club_id: null, team_id: 'pt-new' });
  } finally {
    await browser.close();
  }
});

test('redeem→activate chain: busy holds across both requests, one event at the end', async () => {
  const browser = await chromium.launch();
  try {
    const heldActivate = deferred();
    const { page, counts, events } = await newIntentPage(browser, {
      routeQuery: 'entry?invite=tok-xyz',
      activateSpec: (n) => (n === 1 ? { hold: heldActivate.promise } : 'ok'),
    });
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-entry-invite-redeem]'),
      { timeout: 10000 });
    await clickShadow(page, '[data-entry-invite-redeem]');
    await page.waitForFunction(() =>
      document.getElementById('app')._entryIntent?.kind === 'redeem'
        && document.getElementById('app')._entryIntent?.club_id === 'club-inv',
      { timeout: 10000 });
    const mid = await page.evaluate(() => document.getElementById('app')._entryBusy);
    assert.equal(counts().redeem, 1);
    assert.equal(counts().activate, 1, 'the activation POST is in flight');
    assert.equal(mid, true, 'busy holds across redeem→activate — no nested release');
    heldActivate.resolve();
    await page.waitForTimeout(400);
    const evts = await events();
    assert.equal(evts.length, 1, 'one event for the whole chain');
    assert.deepEqual(evts[0], { kind: 'club', club_id: 'club-inv', team_id: null });
  } finally {
    await browser.close();
  }
});

test('unconfirmed entry: after the bounded wait, «No se pudo confirmar la entrada» + «Reintentar» (GET only)', async () => {
  const browser = await chromium.launch();
  try {
    const { page, counts, events } = await newIntentPage(browser);
    await page.evaluate(() => { document.getElementById('app')._entryConfirmMs = 150; });
    await clickShadow(page, '[data-entry-club-activate]');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await events()).length, 1, 'the event fired once');
    // Still mounted with no shell confirm — the bounded wait expires.
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-entry-check]'),
      { timeout: 10000 });
    const text = await page.evaluate(() => document.getElementById('app').shadowRoot.textContent);
    assert.ok(text.includes('No se pudo confirmar la entrada'));
    assert.ok(text.includes('Reintentar'));
    const activateBefore = counts().activate;
    const bootstrapBefore = counts().bootstrap;
    await clickShadow(page, '[data-entry-check]');
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(counts().bootstrap > bootstrapBefore, 'Reintentar resyncs via bootstrap GET');
    assert.equal(counts().activate, activateBefore, 'never an automatic re-POST');
    assert.equal((await events()).length, 1, 'still exactly one event');
  } finally {
    await browser.close();
  }
});

/**
 * Global navigation contract — biq-onboard adoption.
 *
 * Pins the module-side obligations from
 *   handoff/inbox/2026-10-02-global-navigation-and-section-submenu-contract
 *   -from-architect-3.md and the Developer 33 phase handoff:
 *
 *   §A  no-club state emits no module-owned replacement chrome and keeps
 *       no reserved top gap for absent shell chrome;
 *   §C  the orange section submenu renders on EVERY club-selected view:
 *       «Mi Club» on the landing (no section-back), «Mi Club: <section>»
 *       on Estilo/Equipos/Miembros/Perfil, and the same parent title plus
 *       secondary team/member context on editor subscreens (Product
 *       addendum 2026-10-02); its back control returns to the section
 *       Home/list through the deterministic close path (clears ?edit=
 *       via replaceState) — never history.back();
 *   no  submenu footer anywhere;
 *   #55/#57 deep-link, authorization fail-closed and roster focus stay
 *   intact.
 *
 * Run: `npm run build:lib && node --test tests/navigation-contract.test.mjs`
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
const PORT = 9147;

if (!existsSync(DIST_EMBED)) {
  throw new Error('Build output not found. Run `npm run build:lib` first.');
}

const bundle = readFileSync(DIST_EMBED, 'utf-8');
let server;

const HARNESS = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Nav contract</title></head>
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
  { id: 'team_club1_junior_f', club_id: 'club1', name: 'Junior Femenino', category: 'junior', gender: 'F', label: '', archived: false, players: [{ name: 'Ana García', number: 7 }] },
];
const MEMBERS = [
  { id: 'u1', display_name: 'Ana Pérez', email: 'ana@club.es', role: 'coach', roles: ['coach'], status: 'active' },
  { id: 'u2', display_name: 'Luis Gil', email: 'luis@club.es', role: 'coach', roles: ['coach'], status: 'active' },
];

async function newPage(browser) {
  const page = await browser.newPage();
  await page.route('**/api/**', async (route) => {
    const u = route.request().url();
    const method = route.request().method();
    const json = (data, status = 200) => route.fulfill({
      status, contentType: 'application/json', body: JSON.stringify(data),
    });
    if (u.includes('/api/org/my-teams') && method === 'GET') {
      await json({ ok: true, selected: [], catalog: MGMT_TEAMS });
      return;
    }
    if (u.includes('/team-seeding') && method === 'GET') {
      await json({ ok: true, team_seeding_job: { status: 'done' } });
      return;
    }
    if (u.match(/\/teams$/) && method === 'GET') {
      await json({ teams: MGMT_TEAMS, total: MGMT_TEAMS.length });
      return;
    }
    if (u.match(/\/users$/) && method === 'GET') {
      await json(MEMBERS);
      return;
    }
    if (u.match(/\/roles$/) && method === 'GET') {
      await json({ assignments: [] });
      return;
    }
    await json({ ok: true });
  });
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('biq-onboard-app', { state: 'attached', timeout: 10000 });
  await page.waitForFunction(() => !!document.getElementById('app')?.shadowRoot, { timeout: 10000 });
  return page;
}

async function mountAdmin(page) {
  await page.evaluate(() => {
    const el = document.getElementById('app');
    el.org = { club: { id: 'club1', name: 'Club Test' }, role: 'administrator' };
    el.user = 'admin';
  });
}

const subheadState = () => {
  const sr = document.getElementById('app').shadowRoot;
  const subhead = sr.querySelector('[data-section-subhead]');
  if (!subhead) return { present: false };
  const cs = getComputedStyle(subhead);
  const back = subhead.querySelector('[data-section-back]');
  const r = back ? back.getBoundingClientRect() : null;
  return {
    present: true,
    title: subhead.querySelector('.onboard-subhead-title strong')?.textContent.trim(),
    context: subhead.querySelector('.onboard-subhead-context')?.textContent.trim() || null,
    position: cs.position,
    background: cs.backgroundColor,
    color: cs.color,
    hasBack: !!back,
    backSize: r ? { w: r.width, h: r.height } : null,
    backLabel: back ? back.getAttribute('aria-label') : null,
    usesHistoryBack: back ? back.outerHTML.includes('history.back') : false,
  };
};

test.before(async () => { await startServer(); });
test.after(async () => { await stopServer(); });

test('§A no-club: no replacement chrome, no reserved top gap', async () => {
  const browser = await chromium.launch();
  try {
    const page = await newPage(browser);
    await page.evaluate(() => {
      const el = document.getElementById('app');
      el.org = null; // authenticated, no club
      el.user = 'someone';
    });
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('.onboard-clubstep'),
    { timeout: 10000 });
    const view = await page.evaluate(() => {
      const sr = document.getElementById('app').shadowRoot;
      const step = sr.querySelector('.onboard-clubstep');
      const cs = getComputedStyle(step);
      return {
        nav: !!sr.querySelector('.onboard-nav'),
        subhead: !!sr.querySelector('[data-section-subhead]'),
        footer: !!sr.querySelector('footer, [class*="footer"]'),
        // Global-style chrome controls only — the step head's semantic
        // <header> is content (title + tabs), not navigation chrome.
        globalControls: !!sr.querySelector('[class*="hamburger"], [data-nav], [class*="subhead-back"], [class*="shell"]'),
        paddingTop: cs.paddingTop,
        paddingBottom: cs.paddingBottom,
      };
    });
    assert.equal(view.nav, false, 'no-club must not render module replacement nav chrome');
    assert.equal(view.subhead, false, 'no-club must not render a section subheader');
    assert.equal(view.footer, false, 'no submenu/footer chrome in no-club');
    assert.equal(view.globalControls, false, 'no module-owned nav/back/shell chrome in no-club');
    assert.equal(view.paddingTop, '16px', 'no reserved top gap — base padding only');
    assert.equal(view.paddingBottom, '16px', 'no reserved bottom gap');
  } finally {
    await browser.close();
  }
});

test('§C team edit subscreen: «Mi Club: Equipos» + secondary context, back → list clears ?edit=', async () => {
  const browser = await chromium.launch();
  try {
    const page = await newPage(browser);
    await page.evaluate(() => {
      location.hash = '#/onboard/teams?edit=team_club1_junior_f';
      const el = document.getElementById('app');
      el.route = 'teams?edit=team_club1_junior_f';
      el.org = { club: { id: 'club1', name: 'Club Test' }, role: 'administrator' };
      el.user = 'admin';
    });
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]'),
    { timeout: 10000 });

    const view = await page.evaluate(subheadState);
    assert.equal(view.present, true, 'team edit must render the section subheader');
    assert.equal(view.title, 'Mi Club: Equipos', 'editor keeps the bold parent title');
    assert.equal(view.context, 'Junior Femenino', 'team name is secondary context only');
    assert.equal(view.position, 'sticky');
    assert.equal(view.background, 'rgb(255, 90, 0)', 'subhead must be brand orange (#FF5A00)');
    assert.ok(view.backSize.w >= 44 && view.backSize.h >= 44,
      `back control must be ≥44×44, got ${view.backSize.w}x${view.backSize.h}`);
    assert.equal(view.backLabel, 'Volver a Equipos');
    assert.equal(view.usesHistoryBack, false);
    // The list is replaced, not overlaid.
    const overlaid = await page.evaluate(() =>
      !!document.getElementById('app').shadowRoot.querySelector('.onboard-team-list'));
    assert.equal(overlaid, false, 'edit subscreen replaces the list — no overlay');

    // Section back → Equipos Home; ?edit= cleared via replaceState.
    await page.evaluate(() =>
      document.getElementById('app').shadowRoot.querySelector('[data-section-back]').click());
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('.onboard-team-list'),
    { timeout: 5000 });
    const after = await page.evaluate(() => ({
      hash: location.hash,
      modal: !!document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]'),
      title: document.getElementById('app').shadowRoot
        .querySelector('.onboard-subhead-title strong')?.textContent.trim(),
    }));
    assert.equal(after.modal, false);
    assert.equal(after.title, 'Mi Club: Equipos', 'Equipos list keeps the parent section title');
    assert.equal(after.hash, '#/onboard/teams', 'back clears ?edit= and stays on the section Home');
    assert.ok(!after.hash.includes('edit='), 'no ?edit= survives the back navigation');
  } finally {
    await browser.close();
  }
});

test('§C Plantilla entry lands on the same subscreen with roster focus', async () => {
  const browser = await chromium.launch();
  try {
    const page = await newPage(browser);
    await mountAdmin(page);
    await page.evaluate(() => { document.getElementById('app').route = 'teams'; });
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-edit-roster]'),
    { timeout: 10000 });
    await page.evaluate(() =>
      document.getElementById('app').shadowRoot
        .querySelector('[data-edit-roster="team_club1_junior_f"]').click());
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]'),
    { timeout: 5000 });
    const view = await page.evaluate(() => {
      const sr = document.getElementById('app').shadowRoot;
      return {
        title: sr.querySelector('.onboard-subhead-title strong')?.textContent.trim(),
        context: sr.querySelector('.onboard-subhead-context')?.textContent.trim() || null,
        rosterFocus: sr.activeElement?.hasAttribute('data-player-name')
          || sr.activeElement?.hasAttribute('data-add-player'),
      };
    });
    assert.equal(view.title, 'Mi Club: Equipos');
    assert.equal(view.context, 'Junior Femenino', 'team identity stays secondary context');
    assert.equal(view.rosterFocus, true, 'Plantilla must land focus on the roster editor');
  } finally {
    await browser.close();
  }
});

test('§C member edit subscreen: «Mi Club: Miembros» + member context, back → Miembros Home', async () => {
  const browser = await chromium.launch();
  try {
    const page = await newPage(browser);
    await mountAdmin(page);
    await page.evaluate(() => { document.getElementById('app').route = 'members'; });
    await page.waitForFunction(() =>
      document.getElementById('app').shadowRoot.querySelectorAll('[data-member-row]').length === 2,
    { timeout: 10000 });
    await page.evaluate(() =>
      document.getElementById('app').shadowRoot
        .querySelector('[data-member-row="u1"] [data-member-edit]').click());
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-member-edit-screen]'),
    { timeout: 5000 });
    const view = await page.evaluate(subheadState);
    assert.equal(view.title, 'Mi Club: Miembros', 'editor keeps the bold parent title');
    assert.equal(view.context, 'Ana Pérez', 'member name is secondary context only');
    assert.equal(view.backLabel, 'Volver a Miembros');
    assert.equal(view.position, 'sticky');
    assert.equal(view.background, 'rgb(255, 90, 0)');

    await page.evaluate(() =>
      document.getElementById('app').shadowRoot.querySelector('[data-section-back]').click());
    await page.waitForFunction(() =>
      document.getElementById('app').shadowRoot.querySelectorAll('[data-member-row]').length === 2,
    { timeout: 5000 });
    const after = await page.evaluate(() => ({
      hash: location.hash,
      editor: !!document.getElementById('app').shadowRoot.querySelector('[data-edit-name]'),
      title: document.getElementById('app').shadowRoot
        .querySelector('.onboard-subhead-title strong')?.textContent.trim(),
    }));
    assert.equal(after.editor, false, 'member editor closed');
    assert.equal(after.title, 'Mi Club: Miembros', 'Miembros list keeps the parent section title');
    assert.ok(!after.hash.startsWith('#/'), 'section back never navigates to app Home route');
  } finally {
    await browser.close();
  }
});

test('addendum §2/§3: submenu title matrix on every club-selected view; list back → landing', async () => {
  const browser = await chromium.launch();
  try {
    const page = await newPage(browser);
    await mountAdmin(page);

    // Mi Club landing (bare #/onboard): «Mi Club», no section-back.
    const landing = await page.evaluate(subheadState);
    assert.equal(landing.present, true, 'landing renders the section submenu');
    assert.equal(landing.title, 'Mi Club');
    assert.equal(landing.hasBack, false, 'landing has no section-back — it IS the section Home');
    assert.equal(landing.context, null);

    // Section lists: exact titles + «Volver a Mi Club» → landing.
    for (const [route, title, marker] of [
      ['club-details', 'Mi Club: Estilo', '.onboard-card'],
      ['teams', 'Mi Club: Equipos', '.onboard-team-list'],
      ['members', 'Mi Club: Miembros', '[data-member-row]'],
      ['profile', 'Mi Club: Perfil', '.onboard-profile-card'],
    ]) {
      await page.evaluate((r) => { document.getElementById('app').route = r; }, route);
      await page.waitForFunction((sel) =>
        !!document.getElementById('app').shadowRoot.querySelector(sel),
      marker, { timeout: 10000 });
      const view = await page.evaluate(subheadState);
      assert.equal(view.title, title, `${route} carries «${title}»`);
      assert.equal(view.hasBack, true, `${route} list offers section-back to landing`);
      assert.equal(view.backLabel, 'Volver a Mi Club');
      assert.equal(view.context, null);
      // Section back returns to the Mi Club landing, not app Home.
      await page.evaluate(() =>
        document.getElementById('app').shadowRoot.querySelector('[data-section-back]').click());
      await page.waitForFunction(() =>
        document.getElementById('app').shadowRoot
          .querySelector('.onboard-subhead-title strong')?.textContent.trim() === 'Mi Club',
      { timeout: 5000 });
      const back = await page.evaluate(() => ({
        hash: location.hash,
        historyBack: false,
      }));
      assert.equal(back.hash, '#/onboard', `${route} back lands on the Mi Club landing`);
    }

    // No submenu footer anywhere.
    const footer = await page.evaluate(() =>
      !!document.getElementById('app').shadowRoot.querySelector('footer, [class*="footer"]'));
    assert.equal(footer, false, 'no submenu footer on any Mi Club view');
  } finally {
    await browser.close();
  }
});

test('§C subhead sticky offset follows shell chrome state (provider seam)', async () => {
  const browser = await chromium.launch();
  try {
    const page = await newPage(browser);
    await mountAdmin(page);
    await page.evaluate(() => { document.getElementById('app').route = 'teams'; });
    await page.evaluate(() => {
      const el = document.getElementById('app');
      // Simulate today's shell header, then the provider's collapse attr.
      const header = document.createElement('header');
      header.id = 'shell-header';
      header.style.cssText = 'position:sticky;top:0;height:64px;display:block';
      document.body.prepend(header);
      el.route = 'teams?edit=team_club1_junior_f';
    });
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]'),
    { timeout: 10000 });

    const shown = await page.evaluate(() => {
      const el = document.getElementById('app');
      return getComputedStyle(el).getPropertyValue('--biq-subhead-top').trim();
    });
    assert.equal(shown, '64px', 'with a visible shell header the subhead sits below it');

    await page.evaluate(() => { document.body.dataset.shellChrome = 'collapsed'; });
    const collapsed = await page.evaluate(() => {
      const el = document.getElementById('app');
      return getComputedStyle(el).getPropertyValue('--biq-subhead-top').trim();
    });
    assert.equal(collapsed, '0px', 'collapsed chrome pins the subhead to the viewport top');
  } finally {
    await browser.close();
  }
});

test('§C provider var --biq-shell-chrome-top wins over the measured-header fallback', async () => {
  const browser = await chromium.launch();
  try {
    const page = await newPage(browser);
    await mountAdmin(page);
    await page.evaluate(() => {
      // Legacy header present (would measure 64px) AND the provider's
      // canonical var — the inherited value must win verbatim.
      const header = document.createElement('header');
      header.id = 'shell-header';
      header.style.cssText = 'position:sticky;top:0;height:64px;display:block';
      document.body.prepend(header);
      document.body.style.setProperty('--biq-shell-chrome-top', '88px');
      const el = document.getElementById('app');
      el.route = 'teams?edit=team_club1_junior_f';
    });
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]'),
    { timeout: 10000 });

    const provided = await page.evaluate(() => {
      const el = document.getElementById('app');
      return getComputedStyle(el).getPropertyValue('--biq-subhead-top').trim();
    });
    assert.equal(provided, '88px', 'inherited provider value wins over measured header');

    // Collapse: the provider publishes 0px — honored verbatim.
    await page.evaluate(() => {
      document.body.style.setProperty('--biq-shell-chrome-top', '0px');
      document.body.dataset.shellChrome = 'collapsed';
    });
    // The data-shell-chrome MutationObserver re-syncs; give it a microtask.
    await page.waitForTimeout(50);
    const collapsedVar = await page.evaluate(() => {
      const el = document.getElementById('app');
      return getComputedStyle(el).getPropertyValue('--biq-subhead-top').trim();
    });
    assert.equal(collapsedVar, '0px', 'provider 0px on collapse is honored');

    // Without the var, the collapse attribute alone still pins to top:0.
    // Re-render via the route setter to force a fresh _syncSubheadTop.
    await page.evaluate(() => {
      document.body.style.removeProperty('--biq-shell-chrome-top');
      document.getElementById('app').route = 'teams';
    });
    const collapsedAttr = await page.evaluate(() => {
      const el = document.getElementById('app');
      return getComputedStyle(el).getPropertyValue('--biq-subhead-top').trim();
    });
    assert.equal(collapsedAttr, '0px', 'attr-only collapse still yields 0px');
  } finally {
    await browser.close();
  }
});

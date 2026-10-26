/**
 * Working-context entry selector — entry screen v1 contract (entry-login
 * lot, 2026-10-23):
 *
 *   - ONE screen: no tabs, no visible title; a visually hidden <h1>
 *     keeps the accessible heading;
 *   - «Mi equipo» head carries «Salir» (logout) and «Mi club» has no
 *     head chip; block copies are the Director's 2026-10-26 «Modo …»
 *     lines;
 *   - team/club cards are full-card buttons: name + category/composition
 *     (team) or name + «Entrar como <rol>» from memberships (club), plus
 *     an arrow — no player count, no locality/team count;
 *   - the joint «Entrar con todos los equipos» link and the 2-personal-
 *     team cap note are removed (Director 2026-10-26); archived-only
 *     keeps note+Entrar;
 *   - one Chispa help action (module-local chispa-head-compact-v2.svg)
 *     opens an accessible dialog (role/aria-modal, Escape, focus return,
 *     inert background);
 *   - club creation asks ONLY for the club name; invitation deep links
 *     (#/onboard?invite=…) auto-preview a confirm card; «Salir» stays.
 *
 * Run: `npm run build:lib && node --test tests/entry-selector.test.mjs`
 * Requires: chromium (npx playwright install chromium).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(APP_ROOT, '..');
const DIST_EMBED = join(REPO_ROOT, 'dist', 'embed', 'biq-onboard.js');
const CHISPA_SVG = join(APP_ROOT, 'src', 'assets', 'chispa-head-compact-v2.svg');
const PORT = 9151;

if (!existsSync(DIST_EMBED)) {
  throw new Error('Build output not found. Run `npm run build:lib` first.');
}

const bundle = readFileSync(DIST_EMBED, 'utf8');
let server = null;

const HARNESS = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>entry selector</title></head>
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

const PERSONAL_TEAMS = [TEAM('pt-1', 'Paquetillos 1')];

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
 * Mounts the element with no club so the entry selector renders.
 * `routeQuery` optionally sets el.route (e.g. 'entry?invite=tok-1').
 * Returns { page, log } — `log` captures every /api/** request.
 */
async function newEntryPage(browser, { bootstrap = BOOTSTRAP, routeQuery = null, personalTeams = PERSONAL_TEAMS, personalContext = false, org = undefined, personalTeamsFailure = null, personalTeamsDelayMs = 0, personalTeamsHold = null, waitFeed = true } = {}) {
  const page = await browser.newPage();
  const log = [];
  let feedCalls = 0;

  await page.route('**/api/**', async (route) => {
    const req = route.request();
    log.push({ url: req.url(), method: req.method(), postData: req.postData() });
    const json = (data, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    try {
      const u = req.url();
      if (u.includes('/api/context/v1/bootstrap')) return json(bootstrap);
      if (u.includes('/api/context/v1/activate')) return json({ ok: true });
      if (u.includes('/api/context/v1/active/working-teams')) return json({ ok: true });
      if (u.includes('/api/context/v1/clubs')) return json({ ok: true, club: { id: 'club-new' } });
      if (u.includes('/api/context/v1/invitations/') && u.includes('/preview')) {
        return json({ club_id: 'club-inv', club_name: 'Club Invitado' });
      }
      if (u.includes('/api/context/v1/invitations/redeem')) return json({ ok: true, club_id: 'club-inv' });
      if (u.includes('/api/context/v1/personal-teams/') && req.method() === 'DELETE') {
        return json({ ok: true, team: { team_id: 'pt-1', archived: true } });
      }
      if (u.includes('/api/context/v1/personal-teams')) {
        if (req.method() === 'POST') return json({ team: { team_id: 'pt-new' } }, 201);
        // Request-local identity is bound BEFORE any wait — a newer request
        // must not change what this response resolves to (A3 stale-body fix).
        feedCalls += 1;
        const thisCall = feedCalls;
        const hold = typeof personalTeamsHold === 'function' ? personalTeamsHold(thisCall) : null;
        if (hold) await hold;
        if (personalTeamsDelayMs) {
          await new Promise((r) => setTimeout(r, personalTeamsDelayMs));
        }
        const fail = typeof personalTeamsFailure === 'function' ? personalTeamsFailure(thisCall) : personalTeamsFailure;
        if (fail?.network) return route.abort();
        if (fail) return json(fail.body ?? { detail: 'feed unavailable' }, fail.status ?? 503);
        return json({ teams: personalTeams });
      }
      return json({ ok: true });
    } catch {
      // Route aborted — nothing to do.
    }
  });

  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('biq-onboard-app', { state: 'attached', timeout: 10000 });
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el && el.shadowRoot);
  }, { timeout: 10000 });
  await page.evaluate(({ rq, personal, orgCtx }) => {
    const el = document.getElementById('app');
    if (rq) el.route = rq;
    if (personal) el.context = { owner_scope: { kind: 'personal' } };
    el.org = orgCtx !== null
      ? orgCtx
      : { club: null, email: 'e2e@basketiq.io', display_name: 'E2E', memberships: [] };
    el.user = 'e2e-user';
  }, { rq: routeQuery, personal: personalContext, orgCtx: org === undefined ? null : org });
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el.shadowRoot && el.shadowRoot.childElementCount > 0);
  }, { timeout: 10000 });
  // Let the personal feed settle before callers count cards: once the
  // entry step renders, account-scope sessions are already 'loading' (the
  // fetch starts inside loadBootstrap); 'uninitialized' under the selector
  // means member scope — the feed is never fetched there by design.
  // waitFeed:false is for tests that hold the response on purpose.
  if (waitFeed) {
    await page.waitForFunction(() => {
      const el = document.getElementById('app');
      if (!el.shadowRoot?.querySelector('.entry-step')) return true;
      const s = el._personalTeamsStatus;
      return s === 'ready' || s === 'error' || s === 'uninitialized';
    }, { timeout: 10000 });
  }

  return { page, log };
}

const sel = (page, selector) =>
  page.evaluate((s) => {
    const el = document.getElementById('app');
    return !!el.shadowRoot.querySelector(s);
  }, selector);

test.before(async () => { await startServer(); });
test.after(async () => { await stopServer(); });

// ─── UX-01: one screen, no tabs, no visible title ───────────────────────

test('single screen (non-coach member): no tabs, no visible title, hidden h1, both blocks with exact copies and labels', async () => {
  const browser = await chromium.launch();
  try {
    const { page } = await newEntryPage(browser, { personalTeams: [] });
    const state = await page.evaluate(() => {
      const el = document.getElementById('app');
      const step = el.shadowRoot.querySelector('.entry-step');
      const h1 = step.querySelector('h1');
      const heads = [...step.querySelectorAll('.entry-block')].map((b) => ({
        title: b.querySelector('.entry-block-title')?.textContent.trim(),
        role: b.querySelector('.entry-role')?.textContent.trim(),
        copy: b.querySelector('.entry-block-copy')?.textContent.trim(),
      }));
      const h1Style = h1 ? getComputedStyle(h1) : null;
      return {
        tabs: step.querySelectorAll('[data-entry-tab]').length,
        tabNav: !!step.querySelector('.entry-tabs, .entry-tab'),
        oldTitle: step.textContent.includes('Elige tu perfil'),
        visibleTitle: !!step.querySelector('.entry-title'),
        h1: h1?.textContent.trim(),
        h1Class: h1?.className || '',
        h1Size: h1Style ? { w: h1Style.width, h: h1Style.height, clip: h1Style.clip } : null,
        heads,
      };
    });
    assert.equal(state.tabs, 0, 'no tab controls');
    assert.equal(state.tabNav, false, 'no tab navigation remains');
    assert.equal(state.oldTitle, false, '«Elige tu perfil» is gone');
    assert.equal(state.visibleTitle, false, 'no visible title element');
    assert.ok(state.h1, 'a heading exists for the accessible hierarchy');
    assert.equal(state.h1Class, 'sr-only', 'the h1 is visually hidden');
    assert.equal(state.h1Size.w, '1px', 'visually hidden geometry');
    assert.equal(state.h1Size.h, '1px');
    assert.deepEqual(state.heads, [
      {
        title: 'Mi equipo',
        role: 'Salir',
        copy: 'Modo entrenador. Usa BasketSpark para llevar a tu equipo a su mejor nivel esta temporada.',
      },
      {
        title: 'Mi club',
        role: undefined,
        copy: 'Modo Director Deportivo. Diseña la estrategia deportiva de tu club de baloncesto y usa BasketSpark para alcanzar el mejor nivel con todos los equipos.',
      },
    ]);
  } finally {
    await browser.close();
  }
});

test('club cards state «Entrar como <rol>» from the memberships feed; club block head carries no chip', async () => {
  const browser = await chromium.launch();
  try {
    const { page } = await newEntryPage(browser, {
      bootstrap: { ...BOOTSTRAP, contexts: [CLUB('c1', 'Club Uno'), CLUB('c2', 'Club Dos')] },
      personalTeams: [],
      org: {
        club: null,
        email: 'e2e@basketiq.io',
        display_name: 'E2E',
        memberships: [
          { club_id: 'c1', club_name: 'Club Uno', role: 'sports_director' },
          { club_id: 'c2', club_name: 'Club Dos', role: 'coach' },
        ],
      },
    });
    const state = await page.evaluate(() => {
      const el = document.getElementById('app');
      const clubBlock = [...el.shadowRoot.querySelectorAll('.entry-block')]
        .find((b) => b.querySelector('.entry-block-title')?.textContent.trim() === 'Mi club');
      const cards = [...clubBlock.querySelectorAll('[data-entry-club-activate]')].map((c) => ({
        title: c.querySelector('.entry-card-title')?.textContent.trim(),
        metas: [...c.querySelectorAll('.entry-card-meta')].map((m) => m.textContent.trim()),
      }));
      return {
        roleChip: !!clubBlock?.querySelector('.entry-block-head .entry-role'),
        cards,
      };
    });
    assert.equal(state.roleChip, false, 'no role chip on the club block head');
    assert.deepEqual(state.cards, [
      { title: 'Club Uno', metas: ['Entrar como Director deportivo'] },
      { title: 'Club Dos', metas: ['Entrar como Entrenador'] },
    ]);
  } finally {
    await browser.close();
  }
});

// ─── UX-03: full-card buttons, no counts, no role line ──────────────────

test('team card is a full-card button: name + category/composition + arrow, no player count', async () => {
  const browser = await chromium.launch();
  try {
    const { page } = await newEntryPage(browser);
    const card = await page.evaluate(() => {
      const el = document.getElementById('app');
      const btn = el.shadowRoot.querySelector('[data-entry-personal-enter-team]');
      return {
        tag: btn?.tagName,
        cls: btn?.className,
        aria: btn?.getAttribute('aria-label'),
        text: btn?.textContent || '',
        title: btn?.querySelector('.entry-card-title')?.textContent.trim(),
        meta: btn?.querySelector('.entry-card-meta')?.textContent.trim(),
        arrow: !!btn?.querySelector('.entry-card-arrow svg'),
      };
    });
    assert.equal(card.tag, 'BUTTON', 'the whole card is the button');
    assert.ok(card.cls.includes('entry-card'));
    assert.equal(card.aria, 'Entrar en Paquetillos 1');
    assert.equal(card.title, 'Paquetillos 1');
    assert.equal(card.meta, 'Infantil · M');
    assert.ok(card.arrow, 'arrow affordance present');
    assert.ok(!/jugador/i.test(card.text), 'no player count on the team card');
  } finally {
    await browser.close();
  }
});

test('club card is a full-card button: name + arrow — no role line, locality or team count', async () => {
  const browser = await chromium.launch();
  try {
    const { page } = await newEntryPage(browser, { personalTeams: [] });
    const card = await page.evaluate(() => {
      const el = document.getElementById('app');
      const btn = el.shadowRoot.querySelector('[data-entry-club-activate]');
      return {
        tag: btn?.tagName,
        aria: btn?.getAttribute('aria-label'),
        text: btn?.textContent || '',
        title: btn?.querySelector('.entry-card-title')?.textContent.trim(),
        arrow: !!btn?.querySelector('.entry-card-arrow svg'),
        meta: !!btn?.querySelector('.entry-card-meta'),
      };
    });
    assert.equal(card.tag, 'BUTTON');
    assert.equal(card.aria, 'Entrar en Club Prueba');
    assert.equal(card.title, 'Club Prueba');
    assert.ok(card.arrow);
    assert.equal(card.meta, false, 'no meta line on the club card');
    assert.ok(!card.text.includes('Director'), 'no role line inside the card');
    assert.ok(!/equipos?\b/i.test(card.text), 'no team count');
  } finally {
    await browser.close();
  }
});

// ─── Team cardinalities ─────────────────────────────────────────────────

test('0 teams: create affordance only — no cards, no Entrar', async () => {
  const browser = await chromium.launch();
  try {
    const { page } = await newEntryPage(browser, { personalTeams: [] });
    const state = await page.evaluate(() => {
      const el = document.getElementById('app');
      const block = el.shadowRoot.querySelectorAll('.entry-block')[0];
      return {
        cards: block.querySelectorAll('[data-entry-personal-enter-team]').length,
        enter: !!block.querySelector('[data-entry-personal-enter]'),
        create: !!block.querySelector('[data-entry-team-create-toggle]'),
      };
    });
    assert.equal(state.cards, 0);
    assert.equal(state.enter, false, 'no bare Entrar without teams (PO gate)');
    assert.ok(state.create, 'create stays the only entry path');
  } finally {
    await browser.close();
  }
});

test('1 team: one card, no joint entry', async () => {
  const browser = await chromium.launch();
  try {
    const { page } = await newEntryPage(browser);
    const state = await page.evaluate(() => {
      const el = document.getElementById('app');
      const block = el.shadowRoot.querySelectorAll('.entry-block')[0];
      return {
        cards: block.querySelectorAll('[data-entry-personal-enter-team]').length,
        enterAll: !!block.querySelector('[data-entry-personal-enter]'),
      };
    });
    assert.equal(state.cards, 1);
    assert.equal(state.enterAll, false, 'joint entry needs ≥2 teams');
  } finally {
    await browser.close();
  }
});

test('2 teams: both cards, no joint-entry link, no cap note (Director 2026-10-26 copy cut)', async () => {
  const browser = await chromium.launch();
  try {
    const { page } = await newEntryPage(browser, {
      personalTeams: [TEAM('pt-1', 'Paquetillos 1'), TEAM('pt-2', 'Paquetillos 2')],
    });
    const state = await page.evaluate(() => {
      const el = document.getElementById('app');
      const block = el.shadowRoot.querySelectorAll('.entry-block')[0];
      return {
        cards: block.querySelectorAll('[data-entry-personal-enter-team]').length,
        enterAll: block.querySelector('[data-entry-personal-enter]')?.textContent.trim(),
        createToggle: !!block.querySelector('[data-entry-team-create-toggle]'),
        capNote: /hasta 2 equipos|Elimina uno/i.test(block.textContent),
      };
    });
    assert.equal(state.cards, 2);
    assert.equal(state.enterAll, undefined, 'joint-entry link removed');
    assert.equal(state.createToggle, false, 'no create affordance at the cap');
    assert.equal(state.capNote, false, 'cap note removed');
  } finally {
    await browser.close();
  }
});

test('3 teams: all active teams render as cards without joint entry or cap note', async () => {
  const browser = await chromium.launch();
  try {
    const { page } = await newEntryPage(browser, {
      personalTeams: [TEAM('pt-1', 'Uno'), TEAM('pt-2', 'Dos'), TEAM('pt-3', 'Tres')],
    });
    const state = await page.evaluate(() => {
      const el = document.getElementById('app');
      const block = el.shadowRoot.querySelectorAll('.entry-block')[0];
      return {
        cards: block.querySelectorAll('[data-entry-personal-enter-team]').length,
        enterAll: !!block.querySelector('[data-entry-personal-enter]'),
        capNote: /hasta 2 equipos/i.test(block.textContent),
      };
    });
    assert.equal(state.cards, 3, 'every active team renders as a card');
    assert.equal(state.enterAll, false, 'joint-entry link removed');
    assert.equal(state.capNote, false, 'cap note removed');
  } finally {
    await browser.close();
  }
});

// ─── Club cardinalities ─────────────────────────────────────────────────

test('0 clubs: «No tienes clubes todavía.» + create when allowed', async () => {
  const browser = await chromium.launch();
  try {
    const { page } = await newEntryPage(browser, {
      bootstrap: { ...BOOTSTRAP, contexts: [] },
      personalTeams: [],
    });
    const state = await page.evaluate(() => {
      const el = document.getElementById('app');
      const block = el.shadowRoot.querySelectorAll('.entry-block')[1];
      return {
        cards: block.querySelectorAll('[data-entry-club-activate]').length,
        empty: block.querySelector('.entry-empty')?.textContent.trim(),
        create: !!block.querySelector('[data-entry-club-create-toggle]'),
      };
    });
    assert.equal(state.cards, 0);
    assert.equal(state.empty, 'No tienes clubes todavía.');
    assert.ok(state.create);
  } finally {
    await browser.close();
  }
});

test('1 club: direct card entry — no chooser for a single option', async () => {
  const browser = await chromium.launch();
  try {
    const { page, log } = await newEntryPage(browser, { personalTeams: [] });
    const state = await page.evaluate(() => {
      const el = document.getElementById('app');
      const block = el.shadowRoot.querySelectorAll('.entry-block')[1];
      return { cards: block.querySelectorAll('[data-entry-club-activate]').length };
    });
    assert.equal(state.cards, 1);
    await page.evaluate(() => {
      document.getElementById('app').shadowRoot.querySelector('[data-entry-club-activate]').click();
    });
    await new Promise((r) => setTimeout(r, 300));
    const req = log.find((r) => r.url.includes('/api/context/v1/activate'));
    assert.ok(req);
    assert.deepEqual(JSON.parse(req.postData), { kind: 'club', club_id: 'club-1' });
  } finally {
    await browser.close();
  }
});

test('2 clubs: both render as cards', async () => {
  const browser = await chromium.launch();
  try {
    const { page } = await newEntryPage(browser, {
      bootstrap: { ...BOOTSTRAP, contexts: [CLUB('c1', 'Club Uno'), CLUB('c2', 'Club Dos')] },
      personalTeams: [],
    });
    const names = await page.evaluate(() => {
      const el = document.getElementById('app');
      return [...el.shadowRoot.querySelectorAll('[data-entry-club-activate] .entry-card-title')]
        .map((n) => n.textContent.trim());
    });
    assert.deepEqual(names, ['Club Uno', 'Club Dos']);
  } finally {
    await browser.close();
  }
});

test('≥3 clubs with no reciente datum: the neutral «Elegir club» access opens the searchable picker (PD-CLUBS)', async () => {
  const browser = await chromium.launch();
  try {
    const clubs = [1, 2, 3, 4, 5].map((n) => CLUB(`c${n}`, `Club ${n}`));
    const { page } = await newEntryPage(browser, {
      bootstrap: { ...BOOTSTRAP, contexts: clubs },
      personalTeams: [],
    });
    const state = await page.evaluate(() => {
      const el = document.getElementById('app');
      const openBtn = el.shadowRoot.querySelector('[data-entry-club-picker-open]');
      return {
        directCards: el.shadowRoot.querySelectorAll('.entry-step [data-entry-club-activate]').length,
        openBtn: openBtn?.textContent.trim().replace(/\s+/g, ' '),
        haspopup: openBtn?.getAttribute('aria-haspopup'),
        reciente: /Club reciente/.test(el.shadowRoot.querySelector('.entry-step').textContent),
      };
    });
    assert.equal(state.directCards, 0, 'no club cards outside the picker');
    assert.equal(state.reciente, false, 'no arbitrary reciente — the access is neutral');
    assert.ok(state.openBtn.includes('Elegir club'), 'main access is the picker');
    assert.equal(state.haspopup, 'dialog');

    // Open: dialog semantics, all five clubs as direct-entry rows, inert bg.
    await page.evaluate(() => {
      document.getElementById('app').shadowRoot.querySelector('[data-entry-club-picker-open]').click();
    });
    const open = await page.evaluate(() => {
      const el = document.getElementById('app');
      const dlg = el.shadowRoot.querySelector('.entry-picker-dialog');
      const rows = [...el.shadowRoot.querySelectorAll('[data-entry-club-picker-row]')];
      return {
        role: dlg?.getAttribute('role'),
        modal: dlg?.getAttribute('aria-modal'),
        labelledby: dlg?.getAttribute('aria-labelledby'),
        rows: rows.length,
        visible: rows.filter((r) => !r.hidden).length,
        inert: el.shadowRoot.querySelector('.entry-step').hasAttribute('inert'),
        searchFocus: el.shadowRoot.activeElement?.matches('[data-entry-club-picker-search]'),
      };
    });
    assert.equal(open.role, 'dialog');
    assert.equal(open.modal, 'true');
    assert.equal(open.rows, 5, 'every club is a direct-entry row');
    assert.equal(open.visible, 5);
    assert.ok(open.inert, 'background inert while the picker is open');
    assert.ok(open.searchFocus, 'focus lands in the search field');

    // Search filters by name (diacritic-insensitive normalization).
    await page.evaluate(() => {
      const el = document.getElementById('app');
      const input = el.shadowRoot.querySelector('[data-entry-club-picker-search]');
      input.value = 'club 3';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const filtered = await page.evaluate(() => {
      const rows = [...document.getElementById('app').shadowRoot.querySelectorAll('[data-entry-club-picker-row]')];
      return {
        visible: rows.filter((r) => !r.hidden).length,
        emptyShown: !document.getElementById('app').shadowRoot.querySelector('[data-entry-club-picker-empty]').hidden,
      };
    });
    assert.equal(filtered.visible, 1, 'only the matching club stays visible');
    assert.equal(filtered.emptyShown, false);
    await page.evaluate(() => {
      const el = document.getElementById('app');
      const input = el.shadowRoot.querySelector('[data-entry-club-picker-search]');
      input.value = 'zzz';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const noMatch = await page.evaluate(() => {
      const el = document.getElementById('app');
      const rows = [...el.shadowRoot.querySelectorAll('[data-entry-club-picker-row]')];
      return {
        visible: rows.filter((r) => !r.hidden).length,
        emptyText: el.shadowRoot.querySelector('[data-entry-club-picker-empty]')?.textContent.trim(),
        emptyHidden: el.shadowRoot.querySelector('[data-entry-club-picker-empty]').hidden,
      };
    });
    assert.equal(noMatch.visible, 0);
    assert.equal(noMatch.emptyHidden, false, 'empty state shows on no match');
    assert.ok(noMatch.emptyText.includes('zzz'));

    // Escape closes and restores focus to the trigger.
    await page.evaluate(() => {
      document.getElementById('app').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    const closed = await page.evaluate(() => {
      const el = document.getElementById('app');
      return {
        dialog: !!el.shadowRoot.querySelector('.entry-picker-dialog'),
        focus: el.shadowRoot.activeElement?.matches('[data-entry-club-picker-open]'),
      };
    });
    assert.equal(closed.dialog, false);
    assert.ok(closed.focus, 'focus returns to the picker trigger');
  } finally {
    await browser.close();
  }
});

test('≥3 clubs with an active club context: the reciente card is the main access (PD-CLUBS)', async () => {
  const browser = await chromium.launch();
  try {
    const clubs = [1, 2, 3].map((n) => CLUB(`c${n}`, `Club ${n}`));
    const { page } = await newEntryPage(browser, {
      bootstrap: {
        ...BOOTSTRAP,
        contexts: clubs,
        active: {
          context_id: 'ctx-1',
          context_epoch: 1,
          owner_scope: { kind: 'club', club_id: 'c2' },
          team_ids: [],
          working_team_ids: [],
        },
      },
      personalTeams: [],
    });
    const state = await page.evaluate(() => {
      const el = document.getElementById('app');
      const card = el.shadowRoot.querySelector('.entry-step [data-entry-club-activate]');
      return {
        clubId: card?.dataset.entryClubActivate,
        meta: card?.querySelector('.entry-card-meta')?.textContent.trim(),
        pickerOpen: !!el.shadowRoot.querySelector('[data-entry-club-picker-open]'),
      };
    });
    assert.equal(state.clubId, 'c2', 'the active club is the reciente main access');
    assert.equal(state.meta, 'Club reciente');
    assert.ok(state.pickerOpen, 'the picker stays available for the other clubs');
  } finally {
    await browser.close();
  }
});

test('≥3 clubs: a successful club entry stores the account-bound reciente marker (PD-CLUBS)', async () => {
  const browser = await chromium.launch();
  try {
    const clubs = [1, 2, 3].map((n) => CLUB(`c${n}`, `Club ${n}`));
    const { page, log } = await newEntryPage(browser, {
      bootstrap: { ...BOOTSTRAP, contexts: clubs },
      personalTeams: [],
    });
    // No datum → neutral access; enter club c3 through the picker row.
    await page.evaluate(() => {
      document.getElementById('app').shadowRoot.querySelector('[data-entry-club-picker-open]').click();
    });
    await page.evaluate(() => {
      document.getElementById('app').shadowRoot.querySelector('[data-entry-club-activate="c3"]').click();
    });
    await new Promise((r) => setTimeout(r, 400));
    const activate = log.find((r) => r.url.includes('/api/context/v1/activate'));
    assert.deepEqual(JSON.parse(activate.postData), { kind: 'club', club_id: 'c3' }, 'picker row enters the club directly');
    const marker = await page.evaluate(() => sessionStorage.getItem('biq.entry.lastClub.acc-e2e'));
    assert.equal(marker, 'c3', 'the entry stores the reciente marker for the next visit');

    // A stale marker for a club not in the feed is ignored — the access
    // falls back to the neutral picker, never to an arbitrary club.
    const ghost = await page.evaluate(() => {
      const el = document.getElementById('app');
      sessionStorage.setItem('biq.entry.lastClub.acc-e2e', 'c-ghost');
      el._entryBusy = false; // hold from the completed entry — force repaint
      el.render();
      return {
        recienteCard: !!el.shadowRoot.querySelector('.entry-step [data-entry-club-activate]'),
        neutralAccess: !!el.shadowRoot.querySelector('[data-entry-club-picker-open]'),
      };
    });
    assert.equal(ghost.recienteCard, false, 'a ghost marker never paints a club card');
    assert.ok(ghost.neutralAccess, 'falls back to the neutral picker access');
  } finally {
    await browser.close();
  }
});

// ─── «Mi club» always renders (Director 2026-10-24 — supersedes the
// PD-ENTRY 2026-10-23 coach-hiding): with no clubs the block offers
// «Crear club»; membership never depends on the personal-teams feed ────

test('«Mi club» always renders: a user with personal teams and clubs sees both blocks', async () => {
  const browser = await chromium.launch();
  try {
    const { page } = await newEntryPage(browser, {
      bootstrap: { ...BOOTSTRAP, contexts: [CLUB('c1', 'Club Uno'), CLUB('c2', 'Club Dos')] },
      personalTeams: [TEAM('pt-1', 'Paquetillos 1')],
    });
    const state = await page.evaluate(() => {
      const el = document.getElementById('app');
      return {
        blocks: [...el.shadowRoot.querySelectorAll('.entry-block-title')].map((b) => b.textContent.trim()),
        clubCards: el.shadowRoot.querySelectorAll('[data-entry-club-activate]').length,
        crearClub: !!el.shadowRoot.querySelector('[data-entry-club-create-toggle]'),
        teamCards: el.shadowRoot.querySelectorAll('[data-entry-personal-enter-team]').length,
      };
    });
    assert.deepEqual(state.blocks, ['Mi equipo', 'Mi club'], 'coach and club spaces render together');
    assert.equal(state.clubCards, 2, 'both club cards render');
    assert.equal(state.crearClub, true, 'club creation stays reachable');
    assert.equal(state.teamCards, 1);
  } finally {
    await browser.close();
  }
});

// Bug 2 regression (2026-10-24-bugfix-auth-club-roster): the exact case the
// Director reported — a user with a personal team and NO club must see
// «Mi club» with the «Crear club» action.
test('a personal-team user with no club sees «Mi club» + «Crear club»', async () => {
  const browser = await chromium.launch();
  try {
    const { page } = await newEntryPage(browser, {
      bootstrap: { ...BOOTSTRAP, contexts: [] },
      personalTeams: [TEAM('pt-1', 'Paquetillos 1')],
    });
    const state = await page.evaluate(() => {
      const el = document.getElementById('app');
      return {
        blocks: [...el.shadowRoot.querySelectorAll('.entry-block-title')].map((b) => b.textContent.trim()),
        crearClub: !!el.shadowRoot.querySelector('[data-entry-club-create-toggle]'),
        teamCards: el.shadowRoot.querySelectorAll('[data-entry-personal-enter-team]').length,
      };
    });
    assert.deepEqual(state.blocks, ['Mi equipo', 'Mi club'], 'Mi club renders with no clubs');
    assert.equal(state.crearClub, true, '«Crear club» is offered when the user has none');
    assert.equal(state.teamCards, 1);
  } finally {
    await browser.close();
  }
});

test('archived-only owner — «Mi club» stays visible', async () => {
  const browser = await chromium.launch();
  try {
    const { page } = await newEntryPage(browser, {
      bootstrap: { ...BOOTSTRAP, contexts: [CLUB('c1', 'Club Uno')] },
      personalTeams: [{ ...PERSONAL_TEAMS[0], archived: true }],
    });
    const blocks = await page.evaluate(() =>
      [...document.getElementById('app').shadowRoot.querySelectorAll('.entry-block-title')]
        .map((b) => b.textContent.trim()));
    assert.deepEqual(blocks, ['Mi equipo', 'Mi club']);
  } finally {
    await browser.close();
  }
});

test('a failed team feed keeps «Mi club» reachable', async () => {
  const browser = await chromium.launch();
  try {
    const { page } = await newEntryPage(browser, {
      bootstrap: { ...BOOTSTRAP, contexts: [CLUB('c1', 'Club Uno')] },
      personalTeamsFailure: { status: 503 },
    });
    await page.waitForFunction(() =>
      document.getElementById('app')._personalTeamsStatus === 'error',
      { timeout: 10000 });
    const state = await page.evaluate(() => {
      const el = document.getElementById('app');
      return {
        blocks: [...el.shadowRoot.querySelectorAll('.entry-block-title')].map((b) => b.textContent.trim()),
        clubCards: el.shadowRoot.querySelectorAll('[data-entry-club-activate]').length,
      };
    });
    assert.deepEqual(state.blocks, ['Mi equipo', 'Mi club'], 'feed failure never strands memberships');
    assert.equal(state.clubCards, 1);
  } finally {
    await browser.close();
  }
});

test('a coach still sees an emailed invite — redemption is not part of the club block', async () => {
  const browser = await chromium.launch();
  try {
    const { page } = await newEntryPage(browser, {
      routeQuery: 'entry?invite=tok-abc',
      personalTeams: [TEAM('pt-1', 'Paquetillos 1')],
    });
    await page.waitForFunction(() => {
      const el = document.getElementById('app');
      return !!(el.shadowRoot && el.shadowRoot.querySelector('[data-entry-invite-redeem]'));
    }, { timeout: 10000 });
    const state = await page.evaluate(() => {
      const el = document.getElementById('app');
      return {
        invite: el.shadowRoot.querySelector('.entry-invite')?.textContent || '',
        blocks: [...el.shadowRoot.querySelectorAll('.entry-block-title')].map((b) => b.textContent.trim()),
      };
    });
    assert.ok(state.invite.includes('Club Invitado'), 'the invite preview renders for a coach');
    assert.deepEqual(state.blocks, ['Mi equipo', 'Mi club']);
  } finally {
    await browser.close();
  }
});

// ─── Chispa help: accessible dialog ─────────────────────────────────────

test('Chispa help uses the module-local compact SVG and opens an accessible dialog', async () => {
  const browser = await chromium.launch();
  try {
    const { page } = await newEntryPage(browser);
    const trigger = await page.evaluate(() => {
      const el = document.getElementById('app');
      const btn = el.shadowRoot.querySelector('[data-entry-help]');
      const rect = btn.getBoundingClientRect();
      return {
        aria: btn.getAttribute('aria-label'),
        haspopup: btn.getAttribute('aria-haspopup'),
        src: btn.querySelector('img')?.getAttribute('src') || '',
        copy: btn.textContent,
        size: { w: rect.width, h: rect.height },
        shellHosted: btn.querySelector('img')?.getAttribute('src')?.includes('/assets/') || false,
      };
    });
    assert.equal(trigger.aria, 'Chispa: ayuda sobre Mi equipo y Mi club');
    assert.equal(trigger.haspopup, 'dialog');
    assert.ok(trigger.src.startsWith('data:image/svg'), 'icon is bundled — module-local asset, not shell-hosted');
    assert.equal(trigger.shellHosted, false);
    assert.ok(trigger.copy.includes('¿Mi equipo o mi club?'));
    assert.ok(trigger.copy.includes('Chispa te ayuda a elegir'));
    assert.ok(trigger.size.w >= 44 && trigger.size.h >= 44, 'hit target ≥44px');
  } finally {
    await browser.close();
  }
});

test('help dialog: role/aria-modal/labelledby, content structure, inert background, focus in/out, Escape', async () => {
  const browser = await chromium.launch();
  try {
    const { page } = await newEntryPage(browser);
    await page.evaluate(() => {
      document.getElementById('app').shadowRoot.querySelector('[data-entry-help]').click();
    });
    const open = await page.evaluate(() => {
      const el = document.getElementById('app');
      const dlg = el.shadowRoot.querySelector('[role="dialog"]');
      const step = el.shadowRoot.querySelector('.entry-step');
      const focused = el.shadowRoot.activeElement;
      return {
        role: dlg?.getAttribute('role'),
        ariaModal: dlg?.getAttribute('aria-modal'),
        labelledby: dlg?.getAttribute('aria-labelledby'),
        title: dlg?.querySelector('#entry-help-title')?.textContent.trim(),
        sections: [...dlg.querySelectorAll('.entry-help-section h3')].map((h) => h.textContent.trim()),
        lists: dlg.querySelectorAll('.entry-help-section ul li').length,
        inert: step?.hasAttribute('inert'),
        focusTag: focused?.getAttribute('data-entry-help-close') !== null ? 'close' : focused?.tagName,
        imgSrc: dlg?.querySelector('.entry-help-chispa')?.getAttribute('src') || '',
      };
    });
    assert.equal(open.role, 'dialog');
    assert.equal(open.ariaModal, 'true');
    assert.equal(open.labelledby, 'entry-help-title');
    assert.equal(open.title, 'Cada forma de entrenar, su lugar');
    assert.deepEqual(open.sections, ['Mi equipo', 'Mi club']);
    assert.equal(open.lists, 6, 'a three-item list per block');
    assert.equal(open.inert, true, 'background is inert while the dialog is open');
    assert.equal(open.focusTag, 'close', 'focus moved into the dialog (close button)');
    assert.ok(open.imgSrc.startsWith('data:image/svg'), 'dialog icon is the bundled SVG');

    // Escape closes and focus returns to the help trigger.
    await page.evaluate(() => {
      const el = document.getElementById('app');
      el.shadowRoot.querySelector('[data-entry-help-close]').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }),
      );
    });
    const closed = await page.evaluate(() => {
      const el = document.getElementById('app');
      return {
        dialog: !!el.shadowRoot.querySelector('[role="dialog"]'),
        inert: el.shadowRoot.querySelector('.entry-step')?.hasAttribute('inert'),
        active: el.shadowRoot.activeElement?.hasAttribute('data-entry-help'),
      };
    });
    assert.equal(closed.dialog, false, 'dialog closed');
    assert.equal(closed.inert, false, 'background no longer inert');
    assert.equal(closed.active, true, 'focus returned to the help trigger');
  } finally {
    await browser.close();
  }
});

test('the compact Chispa asset is byte-identical to the approved model (sha256 pinned)', () => {
  const hash = createHash('sha256').update(readFileSync(CHISPA_SVG)).digest('hex');
  assert.equal(hash, '1b1c51a69eed455657f75e91250d5db7f1101b2408657b3387d949d78dabe9c9');
});

// ─── Activation paths ───────────────────────────────────────────────────

test('team card click activates personal context and narrows the working set', async () => {
  const browser = await chromium.launch();
  try {
    const { page, log } = await newEntryPage(browser);
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-entry-personal-enter-team]'),
      { timeout: 10000 });
    log.length = 0;
    await page.evaluate(() => {
      document.getElementById('app').shadowRoot.querySelector('[data-entry-personal-enter-team]').click();
    });
    await new Promise((r) => setTimeout(r, 300));
    const activate = log.find((r) => r.url.includes('/api/context/v1/activate'));
    const working = log.find((r) => r.url.includes('/api/context/v1/active/working-teams'));
    assert.ok(activate, 'activation must fire');
    assert.deepEqual(JSON.parse(activate.postData), { kind: 'personal' });
    assert.ok(working, 'working-set narrowing must fire');
    assert.deepEqual(JSON.parse(working.postData), { working_team_ids: ['pt-1'] });
  } finally {
    await browser.close();
  }
});

test('joint entry control is gone — a team card always narrows to that team', async () => {
  const browser = await chromium.launch();
  try {
    const { page } = await newEntryPage(browser, {
      personalTeams: [TEAM('pt-1', 'Paquetillos 1'), TEAM('pt-2', 'Paquetillos 2')],
    });
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-entry-personal-enter-team]'),
      { timeout: 10000 });
    assert.equal(
      await sel(page, '.entry-step [data-entry-personal-enter]'),
      false,
      '«Entrar con todos los equipos» removed (Director 2026-10-26)',
    );
  } finally {
    await browser.close();
  }
});

// ─── Preserved states ───────────────────────────────────────────────────

// D2 regression: a member-scope session is denied personal authority by
// design (R1) — the selector must never prefetch personal-teams (the 403
// console error on every club-context login) and the Mi equipo block must
// state the verified-session requirement instead of a dead retry.
const BOOTSTRAP_MEMBER = {
  ...BOOTSTRAP,
  identity_scope: 'membership',
  contexts: [
    {
      kind: 'personal',
      owner_scope: { kind: 'personal', workspace_id: 'ws-acc-e2e', account_id: 'acc-e2e' },
      requires_verification: true,
    },
    ...BOOTSTRAP.contexts,
  ],
  entry_actions: {
    ...BOOTSTRAP.entry_actions,
    'personal.team.read': { allowed: false, requires_verification: true },
  },
};

test('member-scope session never fetches personal-teams and shows the verified-session note', async () => {
  const browser = await chromium.launch();
  try {
    const { page, log } = await newEntryPage(browser, { bootstrap: BOOTSTRAP_MEMBER });
    const feedGets = () =>
      log.filter((r) => r.method === 'GET' && r.url.includes('/api/context/v1/personal-teams')).length;
    // Bootstrap prefetch is gated — the feed is never touched.
    await page.waitForTimeout(500);
    assert.equal(feedGets(), 0, 'member-scope prefetch must not issue GET /personal-teams');
    // Mi equipo block renders the honest elevation note, no spinner/retry/CTAs.
    const state = await page.evaluate(() => {
      const el = document.getElementById('app');
      const block = el.shadowRoot.querySelectorAll('.entry-block')[0];
      return {
        text: block?.textContent || '',
        loading: !!block?.querySelector('.entry-loading'),
        retry: !!block?.querySelector('[data-personal-teams-retry]'),
        create: !!block?.querySelector('[data-entry-team-create-toggle]'),
        enter: !!block?.querySelector('[data-entry-personal-enter], [data-entry-personal-enter-team]'),
      };
    });
    assert.match(state.text, /sesión verificada/i, 'denied state must explain the verified-session requirement');
    assert.equal(state.loading, false, 'denied state must not spin forever');
    assert.equal(state.retry, false, 'denied state must not offer a retry that can never succeed');
    assert.equal(state.create, false, 'denied state must not offer team creation');
    assert.equal(state.enter, false, 'denied state must not offer Entrar');
    await page.waitForTimeout(500);
    assert.equal(feedGets(), 0, 'render must not trigger the feed either');
  } finally {
    await browser.close();
  }
});

test('archived-only owner still gets Entrar — restore path is not a forced create (A3 D3)', async () => {
  // The server gate allows re-entry for has-ever-team accounts; a returning
  // owner whose teams are ALL archived must be able to enter (empty working
  // set) and restore from «Mis equipos» — not be funnelled into create.
  const browser = await chromium.launch();
  try {
    const { page, log } = await newEntryPage(browser, {
      personalTeams: [{ ...PERSONAL_TEAMS[0], archived: true }],
    });
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-entry-personal-enter]'),
      { timeout: 10000 });
    const state = await page.evaluate(() => {
      const el = document.getElementById('app');
      const block = el.shadowRoot.querySelectorAll('.entry-block')[0];
      return {
        enter: !!block.querySelector('[data-entry-personal-enter]'),
        enterLabel: block.querySelector('[data-entry-personal-enter]')?.textContent.trim(),
        teamCards: block.querySelectorAll('[data-entry-personal-enter-team]').length,
        createToggle: !!block.querySelector('[data-entry-team-create-toggle]'),
        archivedNote: /archivados/i.test(block.textContent),
      };
    });
    assert.ok(state.enter, 'archived-only history must still offer Entrar');
    assert.equal(state.enterLabel, 'Entrar', 'single Enter affordance (no per-team card)');
    assert.equal(state.teamCards, 0, 'archived teams stay out of the cards');
    assert.ok(state.createToggle, 'create remains available below the cap');
    assert.ok(state.archivedNote, 'the note explains the restore path');

    // Entrar activates the personal context — no working-set narrowing.
    log.length = 0;
    await page.evaluate(() => {
      document.getElementById('app').shadowRoot.querySelector('[data-entry-personal-enter]').click();
    });
    await new Promise((r) => setTimeout(r, 300));
    const activate = log.find((r) => r.url.includes('/api/context/v1/activate'));
    assert.ok(activate, 'activation must fire for the archived-only owner');
    assert.deepEqual(JSON.parse(activate.postData), { kind: 'personal' });
    assert.ok(!log.some((r) => r.url.includes('/active/working-teams')),
      'no working-set narrowing when every team is archived');
  } finally {
    await browser.close();
  }
});

test('archived teams do not appear and do not count against the cap', async () => {
  const browser = await chromium.launch();
  try {
    const { page } = await newEntryPage(browser, {
      personalTeams: [
        { ...PERSONAL_TEAMS[0] },
        { ...PERSONAL_TEAMS[0], team_id: 'pt-arch', name: 'Viejo', archived: true },
      ],
    });
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-entry-personal-enter-team]'),
      { timeout: 10000 });
    const state = await page.evaluate(() => {
      const el = document.getElementById('app');
      const block = el.shadowRoot.querySelectorAll('.entry-block')[0];
      return {
        teamCards: block.querySelectorAll('[data-entry-personal-enter-team]').length,
        createToggle: !!block.querySelector('[data-entry-team-create-toggle]'),
        text: block.textContent,
      };
    });
    assert.equal(state.teamCards, 1, 'archived team must be hidden');
    assert.ok(state.createToggle, 'one active team leaves room to create');
    assert.ok(!state.text.includes('Viejo'));
  } finally {
    await browser.close();
  }
});

test('personal panel (in-session) deletes a team via DELETE and frees the slot', async () => {
  const browser = await chromium.launch();
  try {
    const { page, log } = await newEntryPage(browser, {
      personalContext: true,
      personalTeams: [
        { ...PERSONAL_TEAMS[0] },
        { ...PERSONAL_TEAMS[0], team_id: 'pt-2', name: 'Paquetillos 2' },
      ],
    });
    // At cap inside the session: create form hidden, delete affordance shown.
    const before = await page.evaluate(() => {
      const el = document.getElementById('app');
      return {
        create: !!el.shadowRoot.querySelector('[data-entry-personal-create]'),
        del: el.shadowRoot.querySelectorAll('[data-personal-team-delete]').length,
      };
    });
    assert.equal(before.create, false, 'create form hidden at cap');
    assert.equal(before.del, 2, 'each team gets a delete control');
    await page.evaluate(() => {
      window.confirm = () => true;
      const el = document.getElementById('app');
      el.shadowRoot.querySelector('[data-personal-team-delete]').click();
    });
    await new Promise((r) => setTimeout(r, 300));
    const del = log.find((r) => r.method === 'DELETE' && r.url.includes('/api/context/v1/personal-teams/'));
    assert.ok(del, 'DELETE must fire');
    assert.ok(del.url.includes('pt-1') || del.url.includes('pt-2'));
  } finally {
    await browser.close();
  }
});

test('no manual invitation-code form anywhere in the entry step', async () => {
  const browser = await chromium.launch();
  try {
    const { page } = await newEntryPage(browser);
    const found = await page.evaluate(() => {
      const el = document.getElementById('app');
      const step = el.shadowRoot.querySelector('.entry-step');
      const text = step.textContent;
      return {
        hasInviteLabel: /invitaci[oó]n|c[oó]digo/i.test(text) && !text.includes('Invitación para'),
        inviteInput: !!step.querySelector('[data-entry-invite] input, input[name="token"], input[name="code"]'),
      };
    });
    assert.equal(found.hasInviteLabel, false, 'no "Tengo una invitación / Código de invitación" copy');
    assert.equal(found.inviteInput, false, 'no manual invitation-code input');
  } finally {
    await browser.close();
  }
});

test('+ Crear club opens a name-only form posting {name} — no url/website field', async () => {
  const browser = await chromium.launch();
  try {
    const { page, log } = await newEntryPage(browser, { personalTeams: [] });
    // Form hidden until the toggle.
    assert.equal(await sel(page, '[data-entry-club-create]'), false);
    await page.evaluate(() => {
      const el = document.getElementById('app');
      el.shadowRoot.querySelector('[data-entry-club-create-toggle]').click();
    });
    const fields = await page.evaluate(() => {
      const el = document.getElementById('app');
      const form = el.shadowRoot.querySelector('[data-entry-club-create]');
      if (!form) return null;
      return [...form.querySelectorAll('input,select,textarea')].map((i) => i.name);
    });
    assert.deepEqual(fields, ['name'], 'club creation collects the name only — URL lives inside the club session');
    // Submit posts {name, idempotency_key} — no url.
    await page.evaluate(() => {
      const el = document.getElementById('app');
      const form = el.shadowRoot.querySelector('[data-entry-club-create]');
      form.querySelector('input[name="name"]').value = 'Club Nuevo';
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await new Promise((r) => setTimeout(r, 300));
    const createReq = log.find((r) => r.url.includes('/api/context/v1/clubs'));
    assert.ok(createReq, 'club create request must fire');
    const body = JSON.parse(createReq.postData);
    assert.equal(body.name, 'Club Nuevo');
    assert.ok(!('url' in body) && !('website' in body), 'no url/website in the create payload');
  } finally {
    await browser.close();
  }
});

test('invitation deep link (?invite=) auto-previews and confirms on Mi club', async () => {
  const browser = await chromium.launch();
  try {
    const { page, log } = await newEntryPage(browser, { routeQuery: 'entry?invite=tok-abc' });
    await page.waitForFunction(() => {
      const el = document.getElementById('app');
      return !!(el.shadowRoot && el.shadowRoot.querySelector('[data-entry-invite-redeem]'));
    }, { timeout: 10000 });
    const cardText = await page.evaluate(() => {
      const el = document.getElementById('app');
      return el.shadowRoot.querySelector('.entry-invite').textContent;
    });
    assert.ok(cardText.includes('Club Invitado'), 'preview must show the invited club name');
    await page.evaluate(() => {
      const el = document.getElementById('app');
      el.shadowRoot.querySelector('[data-entry-invite-redeem]').click();
    });
    await new Promise((r) => setTimeout(r, 300));
    const redeem = log.find((r) => r.url.includes('/api/context/v1/invitations/redeem'));
    assert.ok(redeem, 'redeem request must fire');
    assert.deepEqual(JSON.parse(redeem.postData), { token: 'tok-abc' });
  } finally {
    await browser.close();
  }
});

// ─── R6: selector reachable under every cohort ──────────────────────────

test('spaces route renders the selector for an existing club member (R6)', async () => {
  const browser = await chromium.launch();
  try {
    const { page } = await newEntryPage(browser, {
      routeQuery: 'spaces',
      personalTeams: [],
      org: {
        club: { id: 'club-1', name: 'Club Uno' },
        role: 'administrator',
        email: 'e2e@basketiq.io',
        display_name: 'E2E',
        memberships: [{ club_id: 'club-1', club_name: 'Club Uno', role: 'administrator' }],
      },
    });
    const found = await page.evaluate(() => {
      const el = document.getElementById('app');
      return {
        selector: !!el.shadowRoot.querySelector('.entry-step'),
        blocks: [...el.shadowRoot.querySelectorAll('.entry-block-title')].map((b) => b.textContent.trim()),
      };
    });
    assert.ok(found.selector, 'a club member must reach the selector via #/onboard/spaces');
    assert.deepEqual(found.blocks, ['Mi equipo', 'Mi club']);
  } finally {
    await browser.close();
  }
});

test('club nav exposes an Espacios tab that opens the selector (R6)', async () => {
  const browser = await chromium.launch();
  try {
    const { page } = await newEntryPage(browser, {
      org: {
        club: { id: 'club-1', name: 'Club Uno' },
        role: 'coach',
        email: 'e2e@basketiq.io',
        display_name: 'E2E',
        memberships: [{ club_id: 'club-1', club_name: 'Club Uno', role: 'coach' }],
      },
    });
    // The member lands on club admin — an «Espacios» nav item must exist.
    const navHasSpaces = await page.evaluate(() => {
      const el = document.getElementById('app');
      return !!el.shadowRoot.querySelector('[data-nav="spaces"]');
    });
    assert.ok(navHasSpaces, 'club admin nav must carry the Espacios switch');
    await page.evaluate(() => {
      const el = document.getElementById('app');
      el.shadowRoot.querySelector('[data-nav="spaces"]').click();
    });
    await page.waitForFunction(() => {
      const el = document.getElementById('app');
      return !!(el.shadowRoot && el.shadowRoot.querySelector('.entry-step'));
    }, { timeout: 10000 });
  } finally {
    await browser.close();
  }
});

test('personal panel offers the space switch (R6)', async () => {
  const browser = await chromium.launch();
  try {
    const { page } = await newEntryPage(browser, { personalContext: true });
    const hasSwitch = await page.evaluate(() => {
      const el = document.getElementById('app');
      return !!el.shadowRoot.querySelector('[data-personal-switch-space]');
    });
    assert.ok(hasSwitch, 'personal mode must expose the space switch');
  } finally {
    await browser.close();
  }
});

test('personal panel edit issues PATCH with expected_revision (R6)', async () => {
  const browser = await chromium.launch();
  try {
    const teams = [{ ...PERSONAL_TEAMS[0], team_revision: 7 }];
    const { page, log } = await newEntryPage(browser, { personalContext: true, personalTeams: teams });
    await page.waitForFunction(() => {
      const el = document.getElementById('app');
      return !!(el.shadowRoot && el.shadowRoot.querySelector('[data-personal-team-edit-open]'));
    }, { timeout: 10000 });
    await page.evaluate(() => {
      const el = document.getElementById('app');
      el.shadowRoot.querySelector('[data-personal-team-edit-open]').click();
    });
    await page.waitForFunction(() => {
      const el = document.getElementById('app');
      return !!el.shadowRoot.querySelector('[data-personal-team-edit]');
    }, { timeout: 10000 });
    await page.evaluate(() => {
      const el = document.getElementById('app');
      const form = el.shadowRoot.querySelector('[data-personal-team-edit]');
      form.querySelector('input[name="name"]').value = 'Paquetillos Pro';
      form.dispatchEvent(new Event('submit', { cancelable: true }));
    });
    await new Promise((r) => setTimeout(r, 300));
    const patch = log.find((r) => r.method === 'PATCH' && r.url.includes('/api/context/v1/personal-teams/pt-1'));
    assert.ok(patch, 'PATCH must fire for the edited team');
    const body = JSON.parse(patch.postData);
    assert.equal(body.name, 'Paquetillos Pro');
    assert.equal(body.expected_revision, 7, 'CAS revision must ride the patch');
  } finally {
    await browser.close();
  }
});

test('archived personal teams can be restored (R6)', async () => {
  const browser = await chromium.launch();
  try {
    const teams = [{ ...PERSONAL_TEAMS[0], archived: true }];
    const { page, log } = await newEntryPage(browser, { personalContext: true, personalTeams: teams });
    await page.waitForFunction(() => {
      const el = document.getElementById('app');
      return !!(el.shadowRoot && el.shadowRoot.querySelector('[data-personal-team-restore]'));
    }, { timeout: 10000 });
    await page.evaluate(() => {
      const el = document.getElementById('app');
      el.shadowRoot.querySelector('[data-personal-team-restore]').click();
    });
    await new Promise((r) => setTimeout(r, 300));
    const restore = log.find((r) => r.method === 'POST' && r.url.includes('/personal-teams/pt-1/restore'));
    assert.ok(restore, 'restore POST must fire');
  } finally {
    await browser.close();
  }
});

test('OB60-3: failed personal feed is a bounded error — one fetch, explicit retry recovers', async () => {
  const browser = await chromium.launch();
  try {
    let failing = true;
    const { page, log } = await newEntryPage(browser, {
      personalContext: true,
      personalTeamsFailure: () => (failing ? { status: 503 } : null),
    });
    const feedGets = () =>
      log.filter((r) => r.method === 'GET' && r.url.includes('/api/context/v1/personal-teams')).length;
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-personal-teams-retry]'),
      { timeout: 10000 });
    const atError = feedGets();
    // Give render/completion cycles a chance to retrigger — none may fire.
    await page.waitForTimeout(1200);
    assert.equal(feedGets(), atError, 'no render/completion-triggered refetch loop');
    const emptyText = await page.evaluate(() =>
      document.getElementById('app').shadowRoot.textContent.includes('Todavía no tienes'));
    assert.equal(emptyText, false, 'a failed feed never renders as a healthy empty list');
    // Explicit retry is the only recovery path — and it recovers.
    failing = false;
    await page.evaluate(() =>
      document.getElementById('app').shadowRoot.querySelector('[data-personal-teams-retry]').click());
    await page.waitForFunction(() =>
      document.getElementById('app').shadowRoot.textContent.includes('Paquetillos'),
      { timeout: 10000 });
    assert.equal(feedGets(), atError + 1, 'explicit retry issues exactly one more fetch');
  } finally {
    await browser.close();
  }
});

test('OB60-3: malformed feed body is an error, not empty data', async () => {
  const browser = await chromium.launch();
  try {
    const { page } = await newEntryPage(browser, {
      personalContext: true,
      personalTeamsFailure: { status: 200, body: { ok: true } },
    });
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-personal-teams-retry]'),
      { timeout: 10000 });
    const txt = await page.evaluate(() => document.getElementById('app').shadowRoot.textContent);
    assert.ok(txt.includes('Respuesta de equipos inválida'), 'malformed body surfaces as error');
    assert.ok(!txt.includes('Todavía no tienes'), 'malformed body never becomes an empty list');
  } finally {
    await browser.close();
  }
});

test('OB60-3: spaces?edit intent survives a failed feed and drains on explicit retry', async () => {
  const browser = await chromium.launch();
  try {
    let failing = true;
    const { page, log } = await newEntryPage(browser, {
      personalTeamsFailure: () => (failing ? { status: 503 } : null),
    });
    const feedGets = () =>
      log.filter((r) => r.method === 'GET' && r.url.includes('/api/context/v1/personal-teams')).length;
    // The shell sets user/context before the deep-link navigation lands —
    // set the route after mount so the intent survives the session scope.
    await page.evaluate(() => {
      document.getElementById('app').route = 'spaces?edit=pt-1';
    });
    // The feed error lives directly in the Mi equipo block — no tabs.
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-personal-teams-retry]'),
      { timeout: 10000 });
    // The pending edit drains nothing and triggers no extra fetches while
    // the feed is in its error state.
    const atError = feedGets();
    await page.waitForTimeout(1200);
    assert.equal(feedGets(), atError, 'pending edit does not loop the failed feed');
    const kept = await page.evaluate(() => document.getElementById('app')._pendingEditTeamId);
    assert.equal(kept, 'pt-1', 'failed feed keeps the edit intent pending');
    failing = false;
    await page.evaluate(() =>
      document.getElementById('app').shadowRoot.querySelector('[data-personal-teams-retry]').click());
    await page.waitForFunction(() =>
      document.getElementById('app')._personalTeamsStatus === 'ready',
      { timeout: 10000 });
    // SF1: the alias forwards to the shared roster editor — that surface
    // only exists under an active personal context, so the intent holds
    // until the shell injects one (never drains into the legacy form).
    assert.equal(
      await page.evaluate(() => document.getElementById('app')._pendingEditTeamId),
      'pt-1', 'no personal context yet — intent still held');
    await page.evaluate(() => {
      document.getElementById('app').context = {
        context_id: 'ctx-fwd', context_epoch: 1,
        owner_scope: { kind: 'personal', workspace_id: 'ws-1', account_id: 'acc-e2e' },
        team_ids: ['pt-1'], working_team_ids: ['pt-1'],
      };
    });
    await page.waitForFunction(() =>
      document.getElementById('app')._subRoute === 'teams',
      { timeout: 10000 });
    const pending = await page.evaluate(() => document.getElementById('app')._pendingEditTeamId);
    assert.equal(pending, null, 'drained intent is consumed once');
  } finally {
    await browser.close();
  }
});

test('OB60-3: account switch fences the feed — stale state drops, new scope refetches', async () => {
  const browser = await chromium.launch();
  try {
    const { page, log } = await newEntryPage(browser, { personalContext: true });
    await page.waitForFunction(() =>
      document.getElementById('app').shadowRoot.textContent.includes('Paquetillos'),
      { timeout: 10000 });
    const before = log.filter((r) => r.method === 'GET' && r.url.includes('/api/context/v1/personal-teams')).length;
    await page.evaluate(() => { document.getElementById('app').user = 'other-account'; });
    const state = await page.evaluate(() => ({
      teams: document.getElementById('app')._personalTeams,
      status: document.getElementById('app')._personalTeamsStatus,
    }));
    assert.equal(state.teams, null, 'previous account teams dropped');
    await page.waitForFunction(() =>
      document.getElementById('app').shadowRoot.textContent.includes('Paquetillos'),
      { timeout: 10000 });
    const after = log.filter((r) => r.method === 'GET' && r.url.includes('/api/context/v1/personal-teams')).length;
    assert.ok(after > before, 'new account scope refetches the feed');
  } finally {
    await browser.close();
  }
});

test('OB60-3: malformed rows fail closed — never ready, never phantom-empty', async () => {
  const browser = await chromium.launch();
  try {
    const badBodies = [
      { teams: [null] },
      { teams: [{}] },
      { teams: [{ ...PERSONAL_TEAMS[0], team_id: '' }] },
      { teams: [PERSONAL_TEAMS[0], PERSONAL_TEAMS[0]] }, // duplicate identity
      { teams: [{ ...PERSONAL_TEAMS[0], archived: 'no' }] },
      { teams: [{ ...PERSONAL_TEAMS[0], team_revision: '1' }] },
      { teams: [{ ...PERSONAL_TEAMS[0], name: 42 }] },
    ];
    for (const body of badBodies) {
      const errors = [];
      const { page, log } = await newEntryPage(browser, {
        personalContext: true,
        personalTeamsFailure: { status: 200, body },
      });
      page.on('pageerror', (e) => errors.push(e));
      await page.waitForFunction(() =>
        !!document.getElementById('app').shadowRoot.querySelector('[data-personal-teams-retry]'),
        { timeout: 10000 });
      const atError = log.filter((r) => r.url.includes('/api/context/v1/personal-teams')).length;
      await page.waitForTimeout(800);
      assert.equal(
        log.filter((r) => r.url.includes('/api/context/v1/personal-teams')).length,
        atError,
        `malformed rows must not refetch: ${JSON.stringify(body)}`,
      );
      const state = await page.evaluate(() => ({
        status: document.getElementById('app')._personalTeamsStatus,
        teams: document.getElementById('app')._personalTeams,
        editing: document.getElementById('app')._editingPersonalTeamId,
        emptyShown: document.getElementById('app').shadowRoot.textContent.includes('Todavía no tienes'),
      }));
      assert.equal(state.status, 'error', `corrupt feed must land in error: ${JSON.stringify(body)}`);
      assert.equal(state.teams, null, 'corrupt rows never become feed state');
      assert.equal(state.emptyShown, false, 'corrupt feed is not a healthy empty list');
      assert.equal(errors.length, 0, `no unhandled page error: ${JSON.stringify(body)}`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test('OB60-3: 401/403/network failures are bounded errors with explicit retry', async () => {
  const browser = await chromium.launch();
  try {
    for (const failure of [{ status: 401 }, { status: 403 }, { network: true }]) {
      const { page, log } = await newEntryPage(browser, {
        personalContext: true,
        personalTeamsFailure: () => failure,
      });
      const feedGets = () =>
        log.filter((r) => r.method === 'GET' && r.url.includes('/api/context/v1/personal-teams')).length;
      await page.waitForFunction(() =>
        !!document.getElementById('app').shadowRoot.querySelector('[data-personal-teams-retry]'),
        { timeout: 10000 });
      const atError = feedGets();
      await page.waitForTimeout(800);
      assert.equal(feedGets(), atError, `no refetch loop for ${JSON.stringify(failure)}`);
      const txt = await page.evaluate(() => document.getElementById('app').shadowRoot.textContent);
      assert.ok(txt.includes('No se pudieron cargar'), `error copy for ${JSON.stringify(failure)}`);
      assert.ok(!txt.includes('Todavía no tienes'), 'failure never claims an empty roster');
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test('OB60-3: foreign and archived edit ids never open — intent consumed once', async () => {
  const browser = await chromium.launch();
  try {
    const archivedTeam = { ...PERSONAL_TEAMS[0], team_id: 'pt-arch', name: 'Viejo', archived: true };
    for (const editId of ['pt-foreign', 'pt-arch']) {
      const { page } = await newEntryPage(browser, {
        routeQuery: `spaces?edit=${editId}`,
        personalTeams: [...PERSONAL_TEAMS, archivedTeam],
      });
      await page.waitForFunction(() =>
        document.getElementById('app')._personalTeamsStatus === 'ready',
        { timeout: 10000 });
      await page.waitForTimeout(400); // give a wrongful drain time to fire
      const state = await page.evaluate(() => ({
        editing: document.getElementById('app')._editingPersonalTeamId,
        pending: document.getElementById('app')._pendingEditTeamId,
      }));
      assert.equal(state.editing, null, `${editId} must not open an editor`);
      assert.equal(state.pending, null, `${editId} intent consumed once`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test('OB60-3: both mount orders keep the edit intent — route-before-user and user-before-route', async () => {
  const browser = await chromium.launch();
  try {
    const personalContext = () => {
      document.getElementById('app').context = {
        context_id: 'ctx-fwd', context_epoch: 1,
        owner_scope: { kind: 'personal', workspace_id: 'ws-1', account_id: 'acc-e2e' },
        team_ids: ['pt-1'], working_team_ids: ['pt-1'],
      };
    };
    // Route before user (harness order): user assignment must not wipe the
    // just-captured ?edit= intent. SF1: the alias holds the intent until a
    // personal context arrives, then forwards to the shared editor route.
    {
      const { page } = await newEntryPage(browser, { routeQuery: 'spaces?edit=pt-1' });
      await page.waitForFunction(() =>
        document.getElementById('app')._personalTeamsStatus === 'ready',
        { timeout: 10000 });
      await page.evaluate(personalContext);
      await page.waitForFunction(() =>
        document.getElementById('app')._subRoute === 'teams',
        { timeout: 10000 });
      await page.close();
    }
    // User before route: intent set after the session is already bound.
    {
      const { page } = await newEntryPage(browser, {});
      await page.waitForFunction(() =>
        document.getElementById('app')._personalTeamsStatus === 'ready',
        { timeout: 10000 });
      await page.evaluate(() => { document.getElementById('app').route = 'spaces?edit=pt-1'; });
      await page.evaluate(personalContext);
      await page.waitForFunction(() =>
        document.getElementById('app')._subRoute === 'teams',
        { timeout: 10000 });
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test('OB60-3: delayed stale response after account switch never assigns old data', async () => {
  const browser = await chromium.launch();
  try {
    const errors = [];
    const staleTeam = { ...PERSONAL_TEAMS[0], team_id: 'pt-stale', name: 'STALE-TEAM' };
    let releaseOld;
    const oldResponseHeld = new Promise((r) => (releaseOld = r));
    const { page, log } = await newEntryPage(browser, {
      personalContext: true,
      // The mount's feed requests (prefetch + session-bound ensure) carry
      // the OLD scope's data and stay held; the post-switch request is
      // free to return the fresh account's roster.
      personalTeamsHold: (n) => (n <= 2 ? oldResponseHeld : null),
      personalTeamsFailure: (n) =>
        n <= 2 ? { status: 200, body: { teams: [staleTeam] } } : null,
      // The mount's requests stay held on purpose — the test drives its own
      // status waits around the account switch.
      waitFeed: false,
    });
    page.on('pageerror', (e) => errors.push(e));
    const feedGets = () =>
      log.filter((r) => r.method === 'GET' && r.url.includes('/api/context/v1/personal-teams')).length;
    // 1. A known old-scope request is pending before the account switch.
    await page.waitForFunction(() =>
      document.getElementById('app')._personalTeamsStatus === 'loading',
      { timeout: 10000 });
    assert.ok(feedGets() >= 1, 'old-scope feed request must be in flight');
    // 2. Switch — the fresh-scope request returns different data first.
    await page.evaluate(() => { document.getElementById('app').user = 'second-account'; });
    await page.waitForFunction(() =>
      document.getElementById('app')._personalTeamsStatus === 'ready',
      { timeout: 10000 });
    const fresh = await page.evaluate(() =>
      (document.getElementById('app')._personalTeams || []).map((t) => t.team_id));
    assert.deepEqual(fresh, ['pt-1'], 'fresh scope renders before the old body lands');
    // 3. Releasing the held old-scope response cannot overwrite state,
    //    render, open an editor, or retrigger a load.
    releaseOld();
    await page.waitForTimeout(800);
    const state = await page.evaluate(() => ({
      teams: (document.getElementById('app')._personalTeams || []).map((t) => t.team_id),
      editing: document.getElementById('app')._editingPersonalTeamId,
      status: document.getElementById('app')._personalTeamsStatus,
      text: document.getElementById('app').shadowRoot.textContent,
    }));
    assert.deepEqual(state.teams, ['pt-1'], 'late stale body cannot overwrite fresh state');
    assert.equal(state.status, 'ready');
    assert.equal(state.editing, null, 'no editor from a stale completion');
    assert.ok(!state.text.includes('STALE-TEAM'), 'stale body never renders');
    assert.equal(errors.length, 0, 'no unhandled stale completion');
    const getsAfter = feedGets();
    assert.ok(getsAfter <= 3, `fenced refetch, not a loop (${getsAfter} gets)`);
    await page.close();
  } finally {
    await browser.close();
  }
});

test('OB60-3: disconnect mid-flight aborts — late body cannot resurrect the feed', async () => {
  const browser = await chromium.launch();
  try {
    const errors = [];
    const { page } = await newEntryPage(browser, {
      personalContext: true,
      personalTeamsDelayMs: 700,
    });
    page.on('pageerror', (e) => errors.push(e));
    await page.evaluate(() => {
      const el = document.getElementById('app');
      window.__detached = el; // keep the detached node observable
      el.remove();
    });
    await page.waitForTimeout(1100); // response lands after disconnect
    const state = await page.evaluate(() => ({
      connected: window.__detached.isConnected,
      status: window.__detached._personalTeamsStatus,
      teams: window.__detached._personalTeams,
    }));
    assert.equal(state.connected, false);
    assert.equal(state.teams, null, 'detached feed never assigns');
    assert.equal(errors.length, 0, 'no unhandled completion after disconnect');
    await page.close();
  } finally {
    await browser.close();
  }
});

// ─── Salir (canonical exit) ─────────────────────────────────────────────

test('Salir stays reachable in the entry content — standalone posts logout and redirects to /login', async () => {
  const browser = await chromium.launch();
  try {
    const { page, log } = await newEntryPage(browser);
    const state = await page.evaluate(() => {
      const el = document.getElementById('app');
      const btn = el.shadowRoot.querySelector('[data-entry-logout]');
      return {
        btnText: btn?.textContent.trim(),
        insideStep: !!btn?.closest('.entry-step'),
        noChrome: !el.shadowRoot.querySelector('header, footer'),
      };
    });
    assert.equal(state.btnText, 'Salir');
    assert.ok(state.insideStep, 'Salir is a secondary action inside the content');
    assert.ok(state.noChrome, 'onboard draws no header/footer of its own');

    await page.evaluate(() => {
      document.getElementById('app').shadowRoot.querySelector('[data-entry-logout]').click();
    });
    await page.waitForURL('**/login', { timeout: 10000 });
    assert.ok(
      log.some((r) => r.method === 'POST' && r.url.includes('/api/auth/logout')),
      'Salir must close the session server-side',
    );
    await page.close();
  } finally {
    await browser.close();
  }
});

test('hosted Salir delegates to requestLogout once — never a local POST/redirect (F1)', async () => {
  const browser = await chromium.launch();
  try {
    const { page, log } = await newEntryPage(browser);
    await page.evaluate(() => {
      const el = document.getElementById('app');
      el.shellHosted = true;
      window.__logoutCalls = 0;
      el.requestLogout = () => { window.__logoutCalls += 1; return Promise.resolve(); };
    });
    await page.evaluate(() => {
      document.getElementById('app').shadowRoot.querySelector('[data-entry-logout]').click();
    });
    await page.waitForTimeout(400);
    const calls = await page.evaluate(() => window.__logoutCalls);
    assert.equal(calls, 1, 'the hosted capability is invoked exactly once');
    assert.equal(
      log.filter((r) => r.url.includes('/api/auth/logout')).length, 0,
      'hosted Salir never emits a module-side logout POST',
    );
    assert.ok(!page.url().endsWith('/login'), 'no local redirect — the host owns navigation');
    await page.close();
  } finally {
    await browser.close();
  }
});

test('hosted Salir without the capability fails closed — feedback, no POST, no redirect', async () => {
  const browser = await chromium.launch();
  try {
    const { page, log } = await newEntryPage(browser);
    await page.evaluate(() => {
      const el = document.getElementById('app');
      el.shellHosted = true; // hosted document lacks requestLogout
    });
    await page.evaluate(() => {
      document.getElementById('app').shadowRoot.querySelector('[data-entry-logout]').click();
    });
    await page.waitForFunction(() => {
      const el = document.getElementById('app');
      const err = el.shadowRoot.querySelector('.entry-error');
      return !!(err && /cerrar la sesión/i.test(err.textContent));
    }, { timeout: 10000 });
    assert.equal(
      log.filter((r) => r.url.includes('/api/auth/logout')).length, 0,
      'hosted without capability never falls back to the local bypass',
    );
    assert.ok(!page.url().endsWith('/login'));
    await page.close();
  } finally {
    await browser.close();
  }
});

/**
 * Working-context entry selector — executable contract for the Director's
 * 2026-10-05 flow ruling (BIQ-PERSONAL-CLUB-CONTEXT):
 *
 *   - tabs are «Mi equipo» and «Mi club»;
 *   - Mi equipo = explanation + Entrar (no email, no verification form —
 *     the session is already authenticated);
 *   - Mi club = help + «+ Crear club» on TOP of the tab + club list;
 *   - both tabs carry a help button using the footer chispa icon that
 *     opens an accessible modal (role=dialog, aria-modal) with the
 *     context explanation;
 *   - club creation asks ONLY for the club name — the website/URL field
 *     lives inside the club session, never at entry;
 *   - no manual invitation-code form — invites arrive by emailed deep
 *     link (#/onboard?invite=…) which auto-previews a confirm card.
 *
 * Run: `npm run build:lib && node --test tests/entry-selector.test.mjs`
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

const BOOTSTRAP = {
  schema_version: '1',
  state: 'context_selection_required',
  account_id: 'acc-e2e',
  identity_verified: true,
  contexts: [
    {
      kind: 'club',
      owner_scope: { kind: 'club', club_id: 'club-1' },
      name: 'Club Prueba',
      requires_verification: false,
    },
  ],
  active: null,
  entry_actions: {
    'club.create': { allowed: true, requires_verification: false },
    'club.invitation.redeem': { allowed: true, requires_verification: false },
    'personal.enter': { allowed: true, requires_verification: false },
  },
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
 * Mounts the element with no club so the entry selector renders.
 * `routeQuery` optionally sets el.route (e.g. 'entry?invite=tok-1').
 * Returns { page, log } — `log` captures every /api/** request.
 */
const PERSONAL_TEAMS = [
  {
    team_id: 'pt-1',
    name: 'Paquetillos 1',
    category_key: 'infantil',
    category_label: 'Infantil',
    gender: 'M',
    age_band: '',
    archived: false,
  },
];

async function newEntryPage(browser, { bootstrap = BOOTSTRAP, routeQuery = null, personalTeams = PERSONAL_TEAMS, personalContext = false, org = undefined, personalTeamsFailure = null } = {}) {
  const page = await browser.newPage();
  const log = [];

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
        const fail = typeof personalTeamsFailure === 'function' ? personalTeamsFailure() : personalTeamsFailure;
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

  return { page, log };
}

const sel = (page, selector) =>
  page.evaluate((s) => {
    const el = document.getElementById('app');
    return !!el.shadowRoot.querySelector(s);
  }, selFix(selector));

// Playwright evaluate arg must be serializable — plain string is fine.
function selFix(s) { return s; }

test.before(async () => { await startServer(); });
test.after(async () => { await stopServer(); });

test('tabs render as Mi equipo / Mi club', async () => {
  const browser = await chromium.launch();
  try {
    const { page } = await newEntryPage(browser);
    const tabs = await page.evaluate(() => {
      const el = document.getElementById('app');
      return [...el.shadowRoot.querySelectorAll('[data-entry-tab]')].map((b) => b.textContent.trim());
    });
    assert.deepEqual(tabs, ['Mi equipo', 'Mi club']);
  } finally {
    await browser.close();
  }
});

test('Mi club has a help button with the footer chispa icon and + Crear club on top', async () => {
  const browser = await chromium.launch();
  try {
    const { page } = await newEntryPage(browser);
    // Default tab is club (a club candidate exists).
    const order = await page.evaluate(() => {
      const el = document.getElementById('app');
      const panel = el.shadowRoot.querySelector('.entry-panel');
      const children = [...panel.children].map((n) =>
        n.hasAttribute('data-entry-club-create-toggle') ? 'create-toggle'
          : n.classList.contains('entry-h') ? n.textContent.trim()
          : n.querySelector('h3')?.textContent || n.className || n.tagName);
      // Help lives INSIDE the tab title — not in the panel.
      const tab = el.shadowRoot.querySelector('[data-entry-tab="club"]').closest('.entry-tab');
      const helpBtn = tab.querySelector('[data-entry-help="club"]');
      const imgs = helpBtn ? [...helpBtn.querySelectorAll('img')].map((i) => i.getAttribute('src')) : [];
      const dupTitle = !!panel.querySelector('.entry-head');
      return { children, imgs, helpInTab: !!helpBtn, helpAria: helpBtn?.getAttribute('aria-label'), dupTitle };
    });
    assert.ok(order.helpInTab, 'help button must sit inside the Mi club tab title');
    assert.equal(order.helpAria, 'Ayuda');
    assert.ok(order.imgs.some((s) => s.includes('chispa-speaking')), 'help button must use the footer chispa icon');
    assert.equal(order.dupTitle, false, 'the duplicate "Mi club" panel title must be gone');
    assert.equal(
      order.children[0],
      'create-toggle',
      '+ Crear club must be the first element of the Mi club tab container',
    );
    assert.ok(
      order.children.indexOf('create-toggle') < order.children.findIndex((c) => String(c).includes('Tus clubes')),
      '+ Crear club must sit above the club list',
    );
  } finally {
    await browser.close();
  }
});

test('help opens an accessible modal with the club explanation and closes', async () => {
  const browser = await chromium.launch();
  try {
    const { page } = await newEntryPage(browser);
    await page.evaluate(() => {
      const el = document.getElementById('app');
      el.shadowRoot.querySelector('[data-entry-help="club"]').click();
    });
    const modal = await page.evaluate(() => {
      const el = document.getElementById('app');
      const dlg = el.shadowRoot.querySelector('[role="dialog"]');
      if (!dlg) return null;
      return {
        ariaModal: dlg.getAttribute('aria-modal'),
        text: dlg.textContent,
      };
    });
    assert.ok(modal, 'dialog should be open');
    assert.equal(modal.ariaModal, 'true');
    assert.ok(modal.text.includes('Espacio de gestión del club'), 'club explanation must be shown');
    assert.ok(modal.text.includes('staff deportivo'));
    await page.evaluate(() => {
      const el = document.getElementById('app');
      el.shadowRoot.querySelector('[data-entry-help-close].onboard-btn').click();
    });
    const closed = await sel(page, '[role="dialog"]');
    assert.equal(closed, false, 'dialog must close');
  } finally {
    await browser.close();
  }
});

test('Mi equipo lists personal teams each with Entrar — no email field', async () => {
  const browser = await chromium.launch();
  try {
    const { page } = await newEntryPage(browser);
    await page.evaluate(() => {
      const el = document.getElementById('app');
      el.shadowRoot.querySelector('[data-entry-tab="personal"]').click();
    });
    const state = await page.evaluate(() => {
      const el = document.getElementById('app');
      const panel = el.shadowRoot.querySelector('.entry-panel');
      const row = panel.querySelector('[data-entry-personal-enter-team]');
      const tab = el.shadowRoot.querySelector('[data-entry-tab="personal"]').closest('.entry-tab');
      return {
        help: !!tab.querySelector('[data-entry-help="personal"]'),
        enter: !!panel.querySelector('[data-entry-personal-enter]'),
        teamRow: !!row,
        teamLabel: row?.textContent.trim() || '',
        emailInput: !!panel.querySelector('input[type="email"], input[name="email"]'),
      };
    });
    assert.ok(state.help, 'personal tab must carry a help button');
    assert.ok(state.enter, 'personal tab must carry Entrar');
    assert.ok(state.teamRow, 'each created team must offer Entrar');
    assert.ok(state.teamLabel.includes('Paquetillos 1'));
    assert.equal(state.emailInput, false, 'no email field on the authenticated session');
    // Help modal carries the personal explanation.
    await page.evaluate(() => {
      const el = document.getElementById('app');
      el.shadowRoot.querySelector('[data-entry-help="personal"]').click();
    });
    const modalText = await page.evaluate(() => {
      const el = document.getElementById('app');
      return el.shadowRoot.querySelector('[role="dialog"]')?.textContent || '';
    });
    assert.ok(modalText.includes('Espacio personal para preparar entrenamientos semanales y partidos'));
  } finally {
    await browser.close();
  }
});

test('Entrar on a team activates personal context and narrows the working set', async () => {
  const browser = await chromium.launch();
  try {
    const { page, log } = await newEntryPage(browser);
    await page.evaluate(() => {
      const el = document.getElementById('app');
      el.shadowRoot.querySelector('[data-entry-tab="personal"]').click();
    });
    await new Promise((r) => setTimeout(r, 150));
    log.length = 0;
    await page.evaluate(() => {
      const el = document.getElementById('app');
      el.shadowRoot.querySelector('[data-entry-personal-enter-team]').click();
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

test('at the 2-team cap the create affordance is replaced by the cap note', async () => {
  const browser = await chromium.launch();
  try {
    const { page } = await newEntryPage(browser, {
      personalTeams: [
        { ...PERSONAL_TEAMS[0] },
        { ...PERSONAL_TEAMS[0], team_id: 'pt-2', name: 'Paquetillos 2' },
      ],
    });
    await page.evaluate(() => {
      const el = document.getElementById('app');
      el.shadowRoot.querySelector('[data-entry-tab="personal"]').click();
    });
    const state = await page.evaluate(() => {
      const el = document.getElementById('app');
      const panel = el.shadowRoot.querySelector('.entry-panel');
      return {
        teamRows: panel.querySelectorAll('[data-entry-personal-enter-team]').length,
        createToggle: !!panel.querySelector('[data-entry-team-create-toggle]'),
        createForm: !!panel.querySelector('[data-entry-personal-create]'),
        capNote: /hasta 2 equipos|Elimina uno/i.test(panel.textContent),
      };
    });
    assert.equal(state.teamRows, 2);
    assert.equal(state.createToggle, false, 'no create affordance at the cap');
    assert.equal(state.createForm, false);
    assert.ok(state.capNote, 'cap note must explain delete-to-create');
  } finally {
    await browser.close();
  }
});

test('Mi equipo with zero teams offers no Entrar — first entry requires creating one (PO gate)', async () => {
  const browser = await chromium.launch();
  try {
    const { page } = await newEntryPage(browser, { personalTeams: [] });
    await page.evaluate(() => {
      const el = document.getElementById('app');
      el.shadowRoot.querySelector('[data-entry-tab="personal"]').click();
    });
    const state = await page.evaluate(() => {
      const el = document.getElementById('app');
      const panel = el.shadowRoot.querySelector('.entry-panel');
      return {
        enter: !!panel.querySelector('[data-entry-personal-enter]'),
        createToggle: !!panel.querySelector('[data-entry-team-create-toggle]'),
      };
    });
    assert.equal(state.enter, false, 'no bare Entrar without teams — a first team is required');
    assert.ok(state.createToggle, 'create affordance remains the only entry path');
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
    await page.evaluate(() => {
      const el = document.getElementById('app');
      el.shadowRoot.querySelector('[data-entry-tab="personal"]').click();
    });
    const state = await page.evaluate(() => {
      const el = document.getElementById('app');
      const panel = el.shadowRoot.querySelector('.entry-panel');
      return {
        enter: !!panel.querySelector('[data-entry-personal-enter]'),
        enterLabel: panel.querySelector('[data-entry-personal-enter]')?.textContent.trim(),
        teamRows: panel.querySelectorAll('[data-entry-personal-enter-team]').length,
        createToggle: !!panel.querySelector('[data-entry-team-create-toggle]'),
        archivedNote: /archivados/i.test(panel.textContent),
      };
    });
    assert.ok(state.enter, 'archived-only history must still offer Entrar');
    assert.equal(state.enterLabel, 'Entrar', 'single Enter affordance (no per-team row)');
    assert.equal(state.teamRows, 0, 'archived rows stay out of the active list');
    assert.ok(state.createToggle, 'create remains available below the cap');
    assert.ok(state.archivedNote, 'the note explains the restore path');

    // Entrar activates the personal context — no working-set narrowing.
    log.length = 0;
    await page.evaluate(() => {
      const el = document.getElementById('app');
      el.shadowRoot.querySelector('[data-entry-personal-enter]').click();
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
    await page.evaluate(() => {
      const el = document.getElementById('app');
      el.shadowRoot.querySelector('[data-entry-tab="personal"]').click();
    });
    const state = await page.evaluate(() => {
      const el = document.getElementById('app');
      const panel = el.shadowRoot.querySelector('.entry-panel');
      return {
        teamRows: panel.querySelectorAll('[data-entry-personal-enter-team]').length,
        createToggle: !!panel.querySelector('[data-entry-team-create-toggle]'),
        text: panel.textContent,
      };
    });
    assert.equal(state.teamRows, 1, 'archived team must be hidden');
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
      const inputs = [...step.querySelectorAll('input')].map((i) => `${i.type}:${i.name}`);
      return {
        hasInviteLabel: /invitaci[oó]n|c[oó]digo/i.test(text) && !text.includes('Invitación para'),
        inputs,
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
    const { page, log } = await newEntryPage(browser);
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
    await page.waitForFunction(() => true);
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

test('Entrar on Mi equipo posts personal activation; Entrar como posts club activation', async () => {
  const browser = await chromium.launch();
  try {
    const { page, log } = await newEntryPage(browser);
    // Club list action.
    await page.evaluate(() => {
      const el = document.getElementById('app');
      el.shadowRoot.querySelector('[data-entry-club-activate]').click();
    });
    await new Promise((r) => setTimeout(r, 200));
    const clubReq = log.find((r) => r.url.includes('/api/context/v1/activate'));
    assert.ok(clubReq);
    assert.deepEqual(JSON.parse(clubReq.postData), { kind: 'club', club_id: 'club-1' });

    // Switch to Mi equipo → Entrar → personal activation.
    await page.evaluate(() => {
      const el = document.getElementById('app');
      el.shadowRoot.querySelector('[data-entry-tab="personal"]').click();
    });
    log.length = 0;
    await page.evaluate(() => {
      const el = document.getElementById('app');
      el.shadowRoot.querySelector('[data-entry-personal-enter]').click();
    });
    await new Promise((r) => setTimeout(r, 200));
    const personalReq = log.find((r) => r.url.includes('/api/context/v1/activate'));
    assert.ok(personalReq);
    assert.deepEqual(JSON.parse(personalReq.postData), { kind: 'personal' });
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

// ─── R6: selector reachable under every cohort ───────────────────────────

test('spaces route renders the selector for an existing club member (R6)', async () => {
  const browser = await chromium.launch();
  try {
    const { page } = await newEntryPage(browser, {
      routeQuery: 'spaces',
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
        tabs: [...el.shadowRoot.querySelectorAll('[data-entry-tab]')].map((b) => b.textContent.trim()),
      };
    });
    assert.ok(found.selector, 'a club member must reach the selector via #/onboard/spaces');
    assert.deepEqual(found.tabs, ['Mi equipo', 'Mi club']);
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
    // The selector defaults to Mi club when a club context exists — the
    // feed error lives on the Mi equipo tab.
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-entry-tab="personal"]'),
      { timeout: 10000 });
    await page.evaluate(() =>
      document.getElementById('app').shadowRoot.querySelector('[data-entry-tab="personal"]').click());
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
      document.getElementById('app')._editingPersonalTeamId === 'pt-1',
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

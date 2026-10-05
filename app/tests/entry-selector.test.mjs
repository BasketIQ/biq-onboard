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
async function newEntryPage(browser, { bootstrap = BOOTSTRAP, routeQuery = null } = {}) {
  const page = await browser.newPage();
  const log = [];

  await page.route('**/api/**', async (route) => {
    const req = route.request();
    log.push({ url: req.url(), method: req.method(), postData: req.postData() });
    const json = (data, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    try {
      if (req.url().includes('/api/context/v1/bootstrap')) return json(bootstrap);
      if (req.url().includes('/api/context/v1/activate')) return json({ ok: true });
      if (req.url().includes('/api/context/v1/clubs')) return json({ ok: true, club: { id: 'club-new' } });
      if (req.url().includes('/api/context/v1/invitations/') && req.url().includes('/preview')) {
        return json({ club_id: 'club-inv', club_name: 'Club Invitado' });
      }
      if (req.url().includes('/api/context/v1/invitations/redeem')) return json({ ok: true, club_id: 'club-inv' });
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
  await page.evaluate((rq) => {
    const el = document.getElementById('app');
    if (rq) el.route = rq;
    el.org = { club: null, email: 'e2e@basketiq.io', display_name: 'E2E', memberships: [] };
    el.user = 'e2e-user';
  }, routeQuery);
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el.shadowRoot && el.shadowRoot.querySelector('.entry-step'));
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
        n.classList.contains('entry-head') ? 'head'
          : n.hasAttribute('data-entry-club-create-toggle') ? 'create-toggle'
          : n.classList.contains('entry-h') ? n.textContent.trim()
          : n.querySelector('h3')?.textContent || n.className || n.tagName);
      const helpBtn = panel.querySelector('[data-entry-help="club"]');
      const imgs = [...helpBtn.querySelectorAll('img')].map((i) => i.getAttribute('src'));
      return { children, imgs, helpAria: helpBtn.getAttribute('aria-label') };
    });
    assert.equal(order.helpAria, 'Ayuda');
    assert.ok(order.imgs.some((s) => s.includes('chispa-speaking')), 'help button must use the footer chispa icon');
    assert.ok(
      order.children.indexOf('create-toggle') > order.children.indexOf('head'),
      '+ Crear club must render at the top of the Mi club tab (right under the header)',
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

test('Mi equipo has help + Entrar only — no email field, no verification form', async () => {
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
      return {
        help: !!panel.querySelector('[data-entry-help="personal"]'),
        enter: !!panel.querySelector('[data-entry-personal-enter]'),
        emailInput: !!panel.querySelector('input[type="email"], input[name="email"]'),
        text: panel.textContent,
      };
    });
    assert.ok(state.help, 'personal tab must carry a help button');
    assert.ok(state.enter, 'personal tab must carry Entrar');
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

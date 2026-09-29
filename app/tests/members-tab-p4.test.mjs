/**
 * Mi Club Phase 4 — Miembros tab.
 *
 * Verifies: tab visibility gate (admin tiers only), member listing,
 * edit (name/email/roles), deactivate/reactivate, delete confirm, invite.
 *
 * Run: `npm run build:lib && node --test tests/members-tab-p4.test.mjs`
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
const PORT = 9136;

if (!existsSync(DIST_EMBED)) {
  throw new Error('Build output not found. Run `npm run build:lib` first.');
}

const bundle = readFileSync(DIST_EMBED, 'utf-8');
let server;

const HARNESS = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>P4 Miembros</title></head>
<body>
  <biq-onboard-app id="app"></biq-onboard-app>
  <script type="module" src="/embed/biq-onboard.js"></script>
</body>
</html>`;

const MEMBERS = {
  users: [
    { id: 'u1', display_name: 'Ana Entrenadora', email: 'ana@club.es', role: 'coach', roles: ['coach', 'coordinator'], status: 'active' },
    { id: 'u2', display_name: 'Luis Jugador', email: 'luis@club.es', role: 'player', roles: ['player'], status: 'deactivated' },
    { id: 'u3', display_name: 'Marta Admin', email: 'marta@club.es', role: 'administrator', roles: ['administrator'], status: 'active' },
  ],
};
const ASSIGNMENTS = {
  assignments: [
    { id: 'u1__coordinator__club:club1', user_id: 'u1', role: 'coordinator', club_id: 'club1' },
  ],
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

async function newPage(browser) {
  const page = await browser.newPage();
  const log = [];
  await page.route('**/api/**', async (route) => {
    const u = route.request().url();
    const m = route.request().method();
    log.push({ url: u, method: m, body: route.request().postData() });
    if (u.includes('/api/clubs/') && u.endsWith('/users') && m === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MEMBERS) });
      return;
    }
    if (u.includes('/api/clubs/') && u.endsWith('/roles') && m === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ASSIGNMENTS) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('biq-onboard-app', { state: 'attached', timeout: 10000 });
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el && el.shadowRoot);
  }, { timeout: 10000 });
  return { page, log };
}

async function mount(page, role) {
  await page.evaluate((r) => {
    const el = document.getElementById('app');
    el.org = { club: { id: 'club1', name: 'Club Test' }, role: r };
    el.user = 'admin';
    el.route = 'members';
  }, role);
}

test.before(async () => { await startServer(); });
test.after(async () => { await stopServer(); });

test('P4: Miembros tab hidden for coach, visible for administrator', async () => {
  const browser = await chromium.launch();
  const { page } = await newPage(browser);
  try {
    await page.evaluate(() => {
      const el = document.getElementById('app');
      el.org = { club: { id: 'club1', name: 'Club Test' }, role: 'coach' };
      el.user = 'coach';
      el.route = 'club-details';
    });
    let has = await page.evaluate(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-nav="members"]'));
    assert.equal(has, false, 'Miembros hidden for coach');

    await page.evaluate(() => {
      const el = document.getElementById('app');
      el.org = { club: { id: 'club1', name: 'Club Test' }, role: 'administrator' };
      el.route = 'club-details';
    });
    has = await page.evaluate(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-nav="members"]'));
    assert.equal(has, true, 'Miembros visible for administrator');
  } finally {
    await browser.close();
  }
});

test('P4: member list renders name, email, roles, status', async () => {
  const browser = await chromium.launch();
  const { page, log } = await newPage(browser);
  try {
    await mount(page, 'administrator');
    await page.waitForFunction(() =>
      document.getElementById('app').shadowRoot.querySelectorAll('[data-member-row]').length === 3,
    { timeout: 10000 });

    assert.ok(log.some((e) => e.url.includes('/api/clubs/club1/users') && e.method === 'GET'));
    assert.ok(log.some((e) => e.url.includes('/api/clubs/club1/roles') && e.method === 'GET'));

    const txt = await page.evaluate(() => {
      const sr = document.getElementById('app').shadowRoot;
      const row = (id) => sr.querySelector(`[data-member-row="${id}"]`);
      return {
        u1: row('u1').textContent,
        u2: row('u2').textContent,
        badges: row('u1').querySelectorAll('.onboard-role-badge').length,
      };
    });
    assert.ok(txt.u1.includes('Ana Entrenadora') && txt.u1.includes('ana@club.es'));
    assert.ok(txt.u1.includes('Entrenador') && txt.u1.includes('Coordinador'));
    assert.equal(txt.badges, 2, 'primary + secondary role badges');
    assert.ok(txt.u2.includes('Desactivado'), 'deactivated badge shown');
    assert.ok(txt.u2.includes('Reactivar'), 'reactivate action shown');
  } finally {
    await browser.close();
  }
});

test('P4: invite submits email to the invite endpoint', async () => {
  const browser = await chromium.launch();
  const { page, log } = await newPage(browser);
  try {
    await mount(page, 'administrator');
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-invite-form]'),
    { timeout: 10000 });
    await page.evaluate(() => {
      const sr = document.getElementById('app').shadowRoot;
      sr.querySelector('[data-invite-email]').value = 'nuevo@club.es';
      sr.querySelector('[data-invite-form]').dispatchEvent(new Event('submit', { cancelable: true }));
    });
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-invite-sent]'),
    { timeout: 10000 });
    const invite = log.find((e) => e.url.includes('/api/clubs/club1/invite'));
    assert.ok(invite, 'invite POST sent');
    assert.equal(invite.method, 'POST');
    assert.ok(JSON.parse(invite.body).email === 'nuevo@club.es');
  } finally {
    await browser.close();
  }
});

test('P4: deactivate PATCHes status; reactivate appears for deactivated', async () => {
  const browser = await chromium.launch();
  const { page, log } = await newPage(browser);
  try {
    await mount(page, 'administrator');
    await page.waitForFunction(() =>
      document.getElementById('app').shadowRoot.querySelectorAll('[data-member-row]').length === 3,
    { timeout: 10000 });
    await page.evaluate(() => {
      document.getElementById('app').shadowRoot
        .querySelector('[data-member-row="u1"] [data-member-status]').click();
    });
    await page.waitForFunction(() => true); // let the fetch fire
    const patch = log.find((e) => e.url.includes('/users/u1/status'));
    assert.ok(patch, 'status PATCH sent');
    assert.equal(patch.method, 'PATCH');
    assert.equal(JSON.parse(patch.body).status, 'deactivated');
  } finally {
    await browser.close();
  }
});

test('P4: delete is two-step and sends DELETE', async () => {
  const browser = await chromium.launch();
  const { page, log } = await newPage(browser);
  try {
    await mount(page, 'administrator');
    await page.waitForFunction(() =>
      document.getElementById('app').shadowRoot.querySelectorAll('[data-member-row]').length === 3,
    { timeout: 10000 });
    // First click arms confirm.
    await page.evaluate(() =>
      document.getElementById('app').shadowRoot
        .querySelector('[data-member-row="u3"] [data-member-delete]').click());
    let label = await page.evaluate(() =>
      document.getElementById('app').shadowRoot
        .querySelector('[data-member-row="u3"] [data-member-delete]').textContent.trim());
    assert.equal(label, 'Confirmar');
    // Second click deletes.
    await page.evaluate(() =>
      document.getElementById('app').shadowRoot
        .querySelector('[data-member-row="u3"] [data-member-delete]').click());
    await page.waitForFunction(() => true);
    const del = log.find((e) => e.method === 'DELETE' && e.url.endsWith('/users/u3'));
    assert.ok(del, 'DELETE sent after confirm');
  } finally {
    await browser.close();
  }
});

test('P4: edit mode saves changed identity via PUT; role add/remove hit roles API', async () => {
  const browser = await chromium.launch();
  const { page, log } = await newPage(browser);
  try {
    await mount(page, 'administrator');
    await page.waitForFunction(() =>
      document.getElementById('app').shadowRoot.querySelectorAll('[data-member-row]').length === 3,
    { timeout: 10000 });

    // Open u1 edit, change name, save → PUT.
    await page.evaluate(() =>
      document.getElementById('app').shadowRoot
        .querySelector('[data-member-row="u1"] [data-member-edit]').click());
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-edit-name="u1"]'),
    { timeout: 5000 });
    await page.evaluate(() => {
      const sr = document.getElementById('app').shadowRoot;
      const input = sr.querySelector('[data-edit-name="u1"]');
      input.value = 'Ana Actualizada';
      sr.querySelector('[data-member-save="u1"]').click();
    });
    await page.waitForFunction(() => true);
    const put = log.find((e) => e.method === 'PUT' && e.url.endsWith('/users/u1'));
    assert.ok(put, 'PUT sent');
    assert.equal(JSON.parse(put.body).display_name, 'Ana Actualizada');

    // Reopen u1 (members refetched) — remove coordinator chip → DELETE role.
    await page.waitForFunction(() =>
      document.getElementById('app').shadowRoot.querySelectorAll('[data-member-row]').length === 3,
    { timeout: 10000 });
    await page.evaluate(() =>
      document.getElementById('app').shadowRoot
        .querySelector('[data-member-row="u1"] [data-member-edit]').click());
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-member-role-remove="u1"]'),
    { timeout: 5000 });
    await page.evaluate(() =>
      document.getElementById('app').shadowRoot
        .querySelector('[data-member-role-remove="u1"]').click());
    await page.waitForFunction(() => true);
    const roleDel = log.find((e) =>
      e.method === 'DELETE' && e.url.includes('/api/clubs/club1/roles/u1__coordinator__club%3Aclub1'));
    assert.ok(roleDel, 'role assignment DELETE sent');
  } finally {
    await browser.close();
  }
});

test('P4: sports_director sees roles/deactivate but no delete or identity edit', async () => {
  const browser = await chromium.launch();
  const { page } = await newPage(browser);
  try {
    await mount(page, 'sports_director');
    await page.waitForFunction(() =>
      document.getElementById('app').shadowRoot.querySelectorAll('[data-member-row]').length === 3,
    { timeout: 10000 });
    const out = await page.evaluate(() => {
      const sr = document.getElementById('app').shadowRoot;
      const row = (id) => sr.querySelector(`[data-member-row="${id}"]`);
      return {
        u1Edit: !!row('u1').querySelector('[data-member-edit]'),     // coach → editable
        u1Delete: !!row('u1').querySelector('[data-member-delete]'), // never for SD
        u3Edit: !!row('u3').querySelector('[data-member-edit]'),     // admin target → not editable
        u3Status: !!row('u3').querySelector('[data-member-status]'),
      };
    });
    assert.equal(out.u1Edit, true, 'SD can edit sporting member');
    assert.equal(out.u1Delete, false, 'SD never sees delete');
    assert.equal(out.u3Edit, false, 'SD cannot edit administrator');
    assert.equal(out.u3Status, false, 'SD cannot deactivate administrator');
  } finally {
    await browser.close();
  }
});

// ─── Navigation-load regression (empty-roster bug) ──────────────────────────
// The reported defect: clicking Miembros from another tab rendered
// "Aún no hay miembros" without ever fetching the roster. These tests drive
// real nav clicks and pin loading/empty/error state boundaries.

function usersGetCount(log, club = 'club1') {
  return log.filter((e) => e.method === 'GET' && e.url.includes(`/api/clubs/${club}/users`)).length;
}

async function mountAt(page, role, route) {
  await page.evaluate((r) => {
    const el = document.getElementById('app');
    el.org = { club: { id: 'club1', name: 'Club Test' }, role: r.role };
    el.user = 'admin';
    el.route = r.route;
  }, { role, route });
}

async function clickNav(page, nav) {
  await page.evaluate((n) => {
    document.getElementById('app').shadowRoot
      .querySelector(`[data-nav="${n}"]`).click();
  }, nav);
}

test('P4-nav: clicking Miembros from Estilo triggers exactly one roster fetch', async () => {
  const browser = await chromium.launch();
  const { page, log } = await newPage(browser);
  try {
    let resolveUsers;
    const gate = new Promise((r) => { resolveUsers = r; });
    await page.route('**/api/clubs/club1/users', async (route) => {
      log.push({ url: route.request().url(), method: 'GET' });
      await gate;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MEMBERS) });
    });
    await mountAt(page, 'administrator', 'club-details');
    // No roster request before entering the tab.
    assert.equal(usersGetCount(log), 0, 'no fetch before members entry');
    await clickNav(page, 'members');
    // Loading state must be distinct from the empty state while the
    // response is pending.
    await page.waitForFunction(() =>
      document.getElementById('app').shadowRoot
        .querySelector('[data-testid="members-tab"]')?.textContent.includes('Cargando miembros'),
      { timeout: 5000 });
    const shownEmptyEarly = await page.evaluate(() =>
      document.getElementById('app').shadowRoot
        .querySelector('[data-testid="members-tab"]').textContent.includes('Aún no hay miembros'));
    assert.equal(shownEmptyEarly, false, 'no false empty state while loading');
    resolveUsers();
    await page.waitForFunction(() =>
      document.getElementById('app').shadowRoot.querySelectorAll('[data-member-row]').length === 3,
      { timeout: 10000 });
    assert.equal(usersGetCount(log), 1, 'exactly one users GET');
    const badges = await page.evaluate(() =>
      document.getElementById('app').shadowRoot
        .querySelectorAll('.onboard-role-badge').length);
    assert.ok(badges >= 3, 'role badges rendered');
  } finally {
    await browser.close();
  }
});

test('P4-nav: clicking Miembros from Equipos and Perfil loads the roster', async () => {
  for (const start of ['teams', 'profile']) {
    const browser = await chromium.launch();
    const { page, log } = await newPage(browser);
    try {
      await mountAt(page, 'administrator', start);
      await clickNav(page, 'members');
      await page.waitForFunction(() =>
        document.getElementById('app').shadowRoot.querySelectorAll('[data-member-row]').length === 3,
        { timeout: 10000 });
      assert.ok(usersGetCount(log) >= 1, `roster fetched after ${start} → members click`);
    } finally {
      await browser.close();
    }
  }
});

test('P4-nav: rapid members → teams → members keeps a single in-flight fetch', async () => {
  const browser = await chromium.launch();
  const { page, log } = await newPage(browser);
  try {
    let resolveUsers;
    const gate = new Promise((r) => { resolveUsers = r; });
    await page.route('**/api/clubs/club1/users', async (route) => {
      log.push({ url: route.request().url(), method: 'GET' });
      await gate;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MEMBERS) });
    });
    await mountAt(page, 'administrator', 'club-details');
    await clickNav(page, 'members');
    await clickNav(page, 'teams');
    await clickNav(page, 'members');
    resolveUsers();
    await page.waitForFunction(() =>
      document.getElementById('app').shadowRoot.querySelectorAll('[data-member-row]').length === 3,
      { timeout: 10000 });
    assert.equal(usersGetCount(log), 1, 'one in-flight request deduplicated');
  } finally {
    await browser.close();
  }
});

test('P4-nav: 5xx shows bounded error + retry, never a false empty roster', async () => {
  const browser = await chromium.launch();
  const { page } = await newPage(browser);
  try {
    let calls = 0;
    await page.route('**/api/clubs/club1/users', async (route) => {
      calls += 1;
      if (calls === 1) {
        await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
      } else {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MEMBERS) });
      }
    });
    await mountAt(page, 'administrator', 'club-details');
    await clickNav(page, 'members');
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-members-error]'),
      { timeout: 10000 });
    const tab = await page.evaluate(() =>
      document.getElementById('app').shadowRoot
        .querySelector('[data-testid="members-tab"]').textContent);
    assert.ok(!tab.includes('Aún no hay miembros'), 'error never rendered as empty roster');
    assert.equal(await page.evaluate(() =>
      document.getElementById('app').shadowRoot.querySelectorAll('[data-member-row]').length), 0);
    // Retry button recovers.
    await page.evaluate(() =>
      document.getElementById('app').shadowRoot.querySelector('[data-members-retry]').click());
    await page.waitForFunction(() =>
      document.getElementById('app').shadowRoot.querySelectorAll('[data-member-row]').length === 3,
      { timeout: 10000 });
    assert.equal(calls, 2, 'retry issued a second fetch');
  } finally {
    await browser.close();
  }
});

test('P4-nav: 401/403 and malformed payloads surface errors, not empty rosters', async () => {
  for (const variant of [
    { name: '401', status: 401, body: '{}' },
    { name: '403', status: 403, body: '{}' },
    { name: 'malformed', status: 200, body: JSON.stringify({ ok: true }) },
  ]) {
    const browser = await chromium.launch();
    const { page } = await newPage(browser);
    try {
      await page.route('**/api/clubs/club1/users', async (route) => {
        await route.fulfill({ status: variant.status, contentType: 'application/json', body: variant.body });
      });
      await mountAt(page, 'administrator', 'club-details');
      await clickNav(page, 'members');
      await page.waitForFunction(() =>
        !!document.getElementById('app').shadowRoot.querySelector('[data-members-error]'),
        { timeout: 10000 });
      const tab = await page.evaluate(() =>
        document.getElementById('app').shadowRoot
          .querySelector('[data-testid="members-tab"]').textContent);
      assert.ok(!tab.includes('Aún no hay miembros'), `${variant.name}: no false empty state`);
      assert.equal(await page.evaluate(() =>
        document.getElementById('app').shadowRoot.querySelectorAll('[data-member-edit]').length), 0,
        `${variant.name}: no unauthorized controls`);
    } finally {
      await browser.close();
    }
  }
});

test('P4-nav: confirmed empty array renders the empty message only after 200', async () => {
  const browser = await chromium.launch();
  const { page } = await newPage(browser);
  try {
    let resolveUsers;
    const gate = new Promise((r) => { resolveUsers = r; });
    await page.route('**/api/clubs/club1/users', async (route) => {
      await gate;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ users: [] }) });
    });
    await mountAt(page, 'administrator', 'club-details');
    await clickNav(page, 'members');
    await page.waitForFunction(() =>
      document.getElementById('app').shadowRoot
        .querySelector('[data-testid="members-tab"]')?.textContent.includes('Cargando miembros'),
      { timeout: 5000 });
    const earlyEmpty = await page.evaluate(() =>
      document.getElementById('app').shadowRoot
        .querySelector('[data-testid="members-tab"]').textContent.includes('Aún no hay miembros'));
    assert.equal(earlyEmpty, false, 'empty message only after confirmed response');
    resolveUsers();
    await page.waitForFunction(() =>
      document.getElementById('app').shadowRoot
        .querySelector('[data-testid="members-tab"]')?.textContent.includes('Aún no hay miembros'),
      { timeout: 10000 });
  } finally {
    await browser.close();
  }
});

test('P4-nav: club switch drops a late response from the previous club', async () => {
  const browser = await chromium.launch();
  const { page, log } = await newPage(browser);
  try {
    let resolveC1;
    const gateC1 = new Promise((r) => { resolveC1 = r; });
    await page.route('**/api/clubs/club1/users', async (route) => {
      await gateC1;
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ users: [{ id: 'stale1', display_name: 'Pedro Viejo', email: 'p@old.es', role: 'coach', roles: ['coach'], status: 'active' }] }),
      });
    });
    await mountAt(page, 'administrator', 'members');
    // Switch club while club1's roster fetch is still pending.
    await page.evaluate(() => {
      document.getElementById('app').org = { club: { id: 'club2', name: 'Club Dos' }, role: 'administrator' };
    });
    await page.waitForFunction(() =>
      document.getElementById('app').shadowRoot.querySelectorAll('[data-member-row]').length === 3,
      { timeout: 10000 });
    resolveC1(); // late club1 response must be dropped
    await page.waitForTimeout(300);
    const txt = await page.evaluate(() =>
      document.getElementById('app').shadowRoot
        .querySelector('[data-testid="members-tab"]').textContent);
    assert.ok(!txt.includes('Pedro Viejo'), 'stale club1 member never rendered');
    assert.ok(log.some((e) => e.url.includes('/api/clubs/club2/users')), 'club2 roster fetched');
  } finally {
    await browser.close();
  }
});

test('P4-nav: user/session change clears the roster and refetches', async () => {
  const browser = await chromium.launch();
  const { page, log } = await newPage(browser);
  try {
    await mountAt(page, 'administrator', 'members');
    await page.waitForFunction(() =>
      document.getElementById('app').shadowRoot.querySelectorAll('[data-member-row]').length === 3,
      { timeout: 10000 });
    assert.equal(usersGetCount(log), 1);
    await page.evaluate(() => { document.getElementById('app').user = 'other-subject'; });
    await page.waitForFunction(() =>
      document.getElementById('app').shadowRoot.querySelectorAll('[data-member-row]').length === 3,
      { timeout: 10000 });
    assert.equal(usersGetCount(log), 2, 'roster refetched for new subject');
  } finally {
    await browser.close();
  }
});

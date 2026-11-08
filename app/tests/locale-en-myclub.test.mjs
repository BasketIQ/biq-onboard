/**
 * Mi Club in English — every administrator surface renders through
 * onboard-copy.ts when the shell injects `i18n.locale = 'en-US'`, and no
 * Spanish UI copy leaks. Stored codes (categories, roles, levels) stay as-is.
 *
 * Run: `npm run build:lib && node --test tests/locale-en-myclub.test.mjs`
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
const DIST_EMBED = join(resolve(__dirname, '..', '..'), 'dist', 'embed', 'biq-onboard.js');
const PORT = 9151;

if (!existsSync(DIST_EMBED)) throw new Error('Build output not found. Run `npm run build:lib` first.');
const bundle = readFileSync(DIST_EMBED, 'utf-8');

const HARNESS = `<!doctype html><html lang="en-US"><head><meta charset="utf-8"></head>
<body><biq-onboard-app id="app"></biq-onboard-app><script type="module" src="/embed/biq-onboard.js"></script></body></html>`;

const MEMBERS = { users: [
  { id: 'u1', display_name: 'Ana', email: 'ana@club.es', role: 'coach', roles: ['coach'], status: 'active' },
  { id: 'u2', display_name: 'Luis', email: 'luis@club.es', role: 'coach', roles: ['coach'], status: 'deactivated' },
] };
const TEAMS = { teams: [
  { id: 't1', name: 'Infantil A', category: 'infantil', gender: 'F', competitive_level: 'regional_top', archived: false, players: [] },
  { id: 't2', name: 'Cadete B', category: 'cadete', gender: 'M', competitive_level: '', archived: false, players: [] },
] };
const SUMMARY = { club: { id: 'club1', name: 'Club Test' }, team_count: 2, member_count: 2, methodology_present: true, season_plan_present: null };

// Spanish UI words that must never reach an English screen. Team names in the
// fixtures ("Infantil A", "Cadete B") are user data and are excluded below.
const SPANISH = /\b(Identidad|Equipos|Miembros|Perfil|Espacios|Invitar|Desactivado|Reactivar|Eliminar|Editar|Guardar|Cancelar|Cargando|Plantilla|Archivar|Restaurar|Confirmar|Todos|Activos|Ver:|Sin definir|Regional máximo|Entrenador|Metodología|Plan de temporada|Desconocido|Sí|Tu club|Colores del club|Proponer identidad|Logo del club|Subir archivo|Unirme|Solicitar acceso|Crear club|Nombre del club)\b/;

let server;
test.before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/embed/biq-onboard.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(bundle); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(HARNESS);
  });
  await new Promise((r) => server.listen(PORT, r));
});
test.after(async () => { await new Promise((r) => server.close(r)); });

async function open(browser) {
  const page = await browser.newPage();
  await page.route('**/api/**', async (route) => {
    const u = route.request().url();
    const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (u.endsWith('/users')) return json(MEMBERS);
    if (u.endsWith('/roles')) return json({ assignments: [] });
    if (u.includes('/teams')) return json(TEAMS);
    if (u.includes('/summary')) return json(SUMMARY);
    return json({ ok: true });
  });
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForFunction(() => !!document.getElementById('app')?.shadowRoot, { timeout: 10000 });
  return page;
}

async function mountAt(page, route) {
  await page.evaluate((r) => {
    const el = document.getElementById('app');
    el.i18n = { locale: 'en-US' };
    el.org = { club: { id: 'club1', name: 'Club Test' }, role: 'administrator' };
    el.user = 'admin';
    el.route = r;
  }, route);
}

const uiText = (page) => page.evaluate(() => {
  const sr = document.getElementById('app').shadowRoot;
  const walker = document.createTreeWalker(sr, NodeFilter.SHOW_TEXT);
  const parts = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.parentElement?.closest('style,script')) continue;
    parts.push(n.textContent);
  }
  for (const e of sr.querySelectorAll('[aria-label],[title],[placeholder]')) {
    parts.push(e.getAttribute('aria-label') || '', e.getAttribute('title') || '', e.getAttribute('placeholder') || '');
  }
  return parts.join(' ').replace(/Infantil A|Cadete B|Club Test/g, ' ').replace(/\s+/g, ' ');
});

function assertEnglish(text, where) {
  const hit = text.match(SPANISH);
  assert.equal(hit, null, `${where}: Spanish copy leaked: «${hit?.[0]}»`);
}

test('EN: members tab — nav, invite, row actions and status', async () => {
  const browser = await chromium.launch();
  try {
    const page = await open(browser);
    await mountAt(page, 'members');
    await page.waitForFunction(() => document.getElementById('app').shadowRoot.querySelectorAll('[data-member-row]').length === 2, { timeout: 10000 });
    const text = await uiText(page);
    for (const s of ['Identity', 'Teams', 'Members', 'Profile', 'Spaces', 'Invite a member', 'Deactivated', 'Coach']) {
      assert.ok(text.includes(s), `members EN: missing «${s}»`);
    }
    const labels = await page.evaluate(() => {
      const sr = document.getElementById('app').shadowRoot;
      return {
        edit: sr.querySelector('[data-member-row="u1"] [data-member-edit]')?.getAttribute('aria-label'),
        status: sr.querySelector('[data-member-row="u2"] [data-member-status]')?.getAttribute('aria-label'),
      };
    });
    assert.equal(labels.edit, 'Edit ana@club.es');
    assert.equal(labels.status, 'Reactivate luis@club.es');
    assertEnglish(text, 'members');
  } finally { await browser.close(); }
});

test('EN: teams tab — age groups, levels, filters and row actions', async () => {
  const browser = await chromium.launch();
  try {
    const page = await open(browser);
    await mountAt(page, 'teams');
    await page.waitForFunction(() => !!document.getElementById('app').shadowRoot.querySelector('[data-team-row="t1"]'), { timeout: 10000 });
    const text = await uiText(page);
    for (const s of ['Club teams', 'U14', 'U16', 'Top regional', 'Not set', 'Active', 'All']) {
      assert.ok(text.includes(s), `teams EN: missing «${s}»`);
    }
    const editLabel = await page.evaluate(() => document.getElementById('app').shadowRoot
      .querySelector('[data-team-row="t1"] [data-edit-team]')?.getAttribute('aria-label'));
    assert.equal(editLabel, 'Edit team');
    assertEnglish(text, 'teams');

    await page.evaluate(() => document.getElementById('app').shadowRoot.querySelector('[data-team-row="t1"] [data-edit-team]').click());
    await page.waitForFunction(() => !!document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]'), { timeout: 10000 });
    const editor = await uiText(page);
    for (const s of ['Edit team', 'Age group', 'Team name', 'Gender', 'Competition level', 'Roster', '+ Add player', 'Back', 'My Club: Teams']) {
      assert.ok(editor.includes(s), `team editor EN: missing «${s}»`);
    }
    assertEnglish(editor, 'team editor');
  } finally { await browser.close(); }
});

test('EN: identity and profile surfaces', async () => {
  const browser = await chromium.launch();
  try {
    const page = await open(browser);
    await mountAt(page, 'club-details');
    await page.waitForFunction(() => !!document.getElementById('app').shadowRoot.querySelector('[data-generate-btn]'), { timeout: 10000 });
    let text = await uiText(page);
    for (const s of ['Visual identity', 'Propose identity', 'Club logo', 'Club colours']) {
      assert.ok(text.includes(s), `identity EN: missing «${s}»`);
    }
    assertEnglish(text, 'identity');

    await mountAt(page, 'profile');
    await page.waitForFunction(() => !!document.getElementById('app').shadowRoot.querySelector('.onboard-profile-card'), { timeout: 10000 });
    await page.waitForFunction(() => !!document.getElementById('app').shadowRoot.querySelector('[data-club-summary]'), { timeout: 10000 }).catch(() => {});
    text = await uiText(page);
    assert.ok(text.includes('Sports director'), 'profile EN: role label');
    assertEnglish(text, 'profile');
  } finally { await browser.close(); }
});

/**
 * navReady — acreditación de destino para la pantalla de transición
 * unificada (mission 2026-10-24-unified-transition-screen).
 *
 * Contrato verificado con un spy inyectado como `el.navReady`:
 *   - landing/club-details emiten UNA vez cuando la carga del tema del
 *     club alcanza su estado terminal ('content', 'error' si falla);
 *   - la reentrada en caliente (route aplicada con datos ya cargados)
 *     emite de inmediato — una señal por destino (`<subRoute>:<clubId>`);
 *   - reaplicar el MISMO destino no reemite; cambiar de pestaña habilita
 *     una emisión nueva para el destino nuevo.
 *
 * Run: `npm run build:lib && node --test tests/nav-readiness.test.mjs`
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
const PORT = 9170;

if (!existsSync(DIST_EMBED)) {
  throw new Error('Build output not found. Run `npm run build:lib` first.');
}

const bundle = readFileSync(DIST_EMBED, 'utf-8');
let server;

const HARNESS = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>nav readiness</title></head>
<body>
  <biq-onboard-app id="app"></biq-onboard-app>
  <script type="module" src="/embed/biq-onboard.js"></script>
</body>
</html>`;

const ORG = {
  club: { id: 'club-a', name: 'Club A' },
  team: null,
  teams: [],
  season: '2026',
  role: 'coach',
  email: 'e2e@basketiq.io',
  display_name: 'E2E',
  memberships: [],
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

/** Página con la API stubbed; `themeStatus` controla el feed del tema. */
async function newPage(browser, { themeStatus = 200 } = {}) {
  const page = await browser.newPage();
  await page.route('**/api/**', async (route) => {
    const u = route.request().url();
    if (u.includes('/api/clubs/') && u.includes('/theme')) {
      if (themeStatus !== 200) {
        await route.fulfill({ status: themeStatus, contentType: 'application/json', body: '{}' });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          theme: { status: 'active', palette: { primary: '#FF0000' } },
          themeJob: null,
        }),
      });
      return;
    }
    if (u.includes('/api/org/my-teams')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          catalog: [{ id: 'team-1', clubId: 'club-a', name: 'Infantil', label: 'I' }],
          selected: ['team-1'],
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
  // Spy del contrato — la carcasa asigna el productor al montar.
  await page.evaluate(() => {
    window.__nav = [];
    document.getElementById('app').navReady = (r) => {
      window.__nav.push(r);
      return true;
    };
  });
  const nav = () => page.evaluate(() => window.__nav);
  return { page, nav };
}

test.before(async () => { await startServer(); });
test.after(async () => { await stopServer(); });

test('club-details/landing: el tema resuelto acredita una vez; reentrada en caliente emite otra por destino', async () => {
  const browser = await chromium.launch();
  try {
    const { page, nav } = await newPage(browser);
    await page.evaluate((org) => { document.getElementById('app').org = org; }, ORG);
    // Landing ('') — el finally de loadThemeData acredita 'content'.
    await page.waitForFunction(() => window.__nav.length === 1, null, { timeout: 10000 });
    assert.deepEqual(await nav(), [{ state: 'content' }]);

    // Reentrada en caliente a club-details: el tema ya resolvió → una
    // emisión inmediata para el destino nuevo.
    await page.evaluate(() => { document.getElementById('app').route = 'club-details'; });
    await page.waitForFunction(() => window.__nav.length === 2, null, { timeout: 10000 });
    assert.deepEqual(await nav(), [{ state: 'content' }, { state: 'content' }]);

    // Reaplicar el MISMO destino no reemite (una señal por destino).
    await page.evaluate(() => { document.getElementById('app').route = 'club-details'; });
    await page.waitForTimeout(300);
    assert.equal((await nav()).length, 2);

    // Equipos: su catálogo resuelve y acredita su propio destino.
    await page.evaluate(() => { document.getElementById('app').route = 'teams'; });
    await page.waitForFunction(() => window.__nav.length === 3, null, { timeout: 10000 });
    assert.deepEqual((await nav())[2], { state: 'content' });

    // Vuelta a club-details: otro destino → acredita de nuevo en caliente.
    await page.evaluate(() => { document.getElementById('app').route = 'club-details'; });
    await page.waitForFunction(() => window.__nav.length === 4, null, { timeout: 10000 });
    assert.deepEqual((await nav())[3], { state: 'content' });
  } finally {
    await browser.close();
  }
});

test('club-details: un fallo del feed del tema acredita error una vez', async () => {
  const browser = await chromium.launch();
  try {
    const { page, nav } = await newPage(browser, { themeStatus: 500 });
    await page.evaluate((org) => { document.getElementById('app').org = org; }, ORG);
    await page.waitForFunction(() => window.__nav.length === 1, null, { timeout: 10000 });
    assert.deepEqual(await nav(), [{ state: 'error' }]);
    // Sin nueva navegación no hay segunda emisión.
    await page.waitForTimeout(400);
    assert.equal((await nav()).length, 1);
  } finally {
    await browser.close();
  }
});

// ── spaces: el selector también es productor (back/historia, «Cambiar de
// espacio») — una emisión por scope de entrada; nunca con un intent en
// vuelo, porque ese ticket pertenece al T1 → home.

const BOOT_PERSONAL = {
  schema_version: '1.0', state: 'ready', account_id: 'acc_1', identity_verified: true,
  contexts: [], active: null, entry_actions: {},
};

/** Página con los endpoints del flujo de entrada controlados. */
async function newSpacesPage(browser, { bootstrapStatus = 200, bootstrap = BOOT_PERSONAL, holdTeams = false } = {}) {
  const page = await browser.newPage();
  let releaseTeams = null;
  const teamsGate = holdTeams ? new Promise((r) => { releaseTeams = r; }) : Promise.resolve();
  if (holdTeams) await page.exposeFunction('__releaseTeams', () => releaseTeams());
  await page.route('**/api/**', async (route) => {
    const u = route.request().url();
    if (u.includes('/api/context/v1/bootstrap')) {
      await route.fulfill({ status: bootstrapStatus, contentType: 'application/json', body: JSON.stringify(bootstrap) });
      return;
    }
    if (u.includes('/api/context/v1/personal-teams')) {
      await teamsGate;
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ teams: [{
          team_id: 'pt1', name: 'Cadete Verde', role: 'coach', archived: false, team_revision: 1,
          category_key: 'cadete', category_label: 'Cadete', age_band: 'U15', gender: 'mixed',
          section_applicability: 'both', timezone: 'Europe/Madrid', season: '2026',
        }] }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('biq-onboard-app', { state: 'attached' });
  await page.evaluate(() => customElements.whenDefined('biq-onboard-app'));
  await page.evaluate(() => {
    window.__nav = [];
    document.getElementById('app').navReady = (r) => { window.__nav.push(r); return true; };
  });
  const nav = () => page.evaluate(() => window.__nav);
  return { page, nav };
}

test('spaces: el selector acredita content tras el resync y vuelve a emitir en cada scope', async () => {
  const browser = await chromium.launch();
  try {
    const { page, nav } = await newSpacesPage(browser);
    // Contexto inyectado por la carcasa (scope personal) antes de entrar.
    await page.evaluate(() => { document.getElementById('app').context = { owner_scope: { kind: 'personal', workspace_id: 'ws1' } }; });
    await page.evaluate(() => { document.getElementById('app').route = 'spaces'; });
    await page.waitForFunction(() => window.__nav.length === 1, null, { timeout: 10000 });
    assert.deepEqual(await nav(), [{ state: 'content' }]);

    // Salir y volver: el resync abre un scope nuevo → segunda emisión.
    await page.evaluate(() => { document.getElementById('app').route = 'profile'; });
    await page.evaluate(() => { document.getElementById('app').route = 'spaces'; });
    await page.waitForFunction(() => window.__nav.length === 2, null, { timeout: 10000 });
    assert.deepEqual(await nav(), [{ state: 'content' }, { state: 'content' }]);
  } finally {
    await browser.close();
  }
});

test('spaces: sin autoridad de contexto (bootstrap fallido) acredita blocked — la vista legacy', async () => {
  const browser = await chromium.launch();
  try {
    const { page, nav } = await newSpacesPage(browser, { bootstrapStatus: 500 });
    await page.evaluate(() => { document.getElementById('app').route = 'spaces'; });
    await page.waitForFunction(() => window.__nav.length === 1, null, { timeout: 10000 });
    assert.deepEqual(await nav(), [{ state: 'blocked' }]);
    await page.waitForTimeout(300);
    assert.equal((await nav()).length, 1, 'una señal por scope');
  } finally {
    await browser.close();
  }
});

test('spaces: nunca emite con un intent de entrada en vuelo (el ticket es de home)', async () => {
  const browser = await chromium.launch();
  try {
    const { page, nav } = await newSpacesPage(browser, { holdTeams: true });
    await page.evaluate(() => { document.getElementById('app').context = { owner_scope: { kind: 'personal', workspace_id: 'ws1' } }; });
    await page.evaluate(() => { document.getElementById('app').route = 'spaces'; });
    // Bootstrap resuelto; el feed de equipos queda retenido por la puerta.
    await page.waitForFunction(() => {
      const el = document.getElementById('app');
      return el && el.shadowRoot && el.shadowRoot.querySelector('.entry-loading');
    }, null, { timeout: 10000 });
    // Gesto de entrada admitido: intent en vuelo ANTES de que asiente el feed.
    await page.evaluate(() => { document.getElementById('app')._beginEntryIntent('personal_team', { team_id: 'pt1' }); });
    await page.evaluate(() => window.__releaseTeams());
    await page.waitForTimeout(500);
    assert.equal((await nav()).length, 0, 'el feed asentó pero el intent en vuelo veta la emisión');
  } finally {
    await browser.close();
  }
});

test('spaces: con un club activo (contexto club) el selector también acredita — el guard de club no lo veta', async () => {
  const browser = await chromium.launch();
  try {
    const { page, nav } = await newSpacesPage(browser);
    // Org con club inyectada como en la carcasa real — pre-fix el guard
    // `clubId !== org.club.id` rechazaba siempre la emisión de 'spaces'.
    await page.evaluate((org) => { document.getElementById('app').org = org; }, ORG);
    // La landing ('') acredita primero con su destino propio.
    await page.waitForFunction(() => window.__nav.length === 1, null, { timeout: 10000 });
    assert.deepEqual(await nav(), [{ state: 'content' }]);
    await page.evaluate(() => { document.getElementById('app').route = 'spaces'; });
    await page.waitForFunction(() => window.__nav.length === 2, null, { timeout: 10000 });
    assert.deepEqual(await nav(), [{ state: 'content' }, { state: 'content' }],
      'spaces emite aunque org.club esté poblado — su identidad es el scope, no el club');
  } finally {
    await browser.close();
  }
});

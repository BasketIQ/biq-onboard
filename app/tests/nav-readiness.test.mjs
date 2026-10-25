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

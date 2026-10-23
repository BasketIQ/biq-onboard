// Entry screen v1 evidence captures (entry-login lot, E-B2).
//
// Manual tool — NOT part of `npm test` or CI. Renders <biq-onboard-app>
// against the REAL shell stylesheets (tokens/theme/components/styles/shell
// from biq-app origin/main, read via `git show` — the biq-app working tree
// is never touched) so captures carry the genuine font, canvas and
// light/dark semantic tokens. Asserts, from computed styles:
//   - no horizontal overflow at every width (scrollWidth <= innerWidth);
//   - help-dialog text >= 4.5:1 vs its surface, close icon >= 3:1
//     (same gate family as biq-app tests/design-system/menu-contrast).
//
// Usage:  npm run build:lib && node scripts/screenshot-entry.mjs <outdir>
// Env:    BIQ_APP_DIR — path to the biq-app checkout (default ../../biq-app).

import { chromium } from 'playwright';
import { createServer } from 'http';
import { execFileSync } from 'child_process';
import { readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(APP_ROOT, '..');
const DIST_EMBED = join(REPO_ROOT, 'dist', 'embed', 'biq-onboard.js');
const BIQ_APP_DIR = process.env.BIQ_APP_DIR || resolve(APP_ROOT, '..', '..', '..', 'biq-app');
const OUT = process.argv[2];
if (!OUT) throw new Error('Usage: node scripts/screenshot-entry.mjs <outdir> (explicit output directory required)');
const PORT = 9152;

if (!existsSync(DIST_EMBED)) throw new Error('Run `npm run build:lib` first.');
const bundle = readFileSync(DIST_EMBED, 'utf8');
mkdirSync(OUT, { recursive: true });

// ─── Shell stylesheets (from biq-app origin/main — read-only) ─────────
const SHELL_CSS = ['tokens.css', 'theme.css', 'biq-components.css', 'styles.css', 'shell.css'];
const tmp = mkdtempSync(join(tmpdir(), 'biq-entry-shots-'));
const cleanup = () => rmSync(tmp, { recursive: true, force: true });
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

const cssLinks = [];
for (const file of SHELL_CSS) {
  try {
    const css = execFileSync('git', ['-C', BIQ_APP_DIR, 'show', `origin/main:app/${file}`]);
    writeFileSync(join(tmp, file), css);
    cssLinks.push(`<link rel="stylesheet" href="/shell-css/${file}">`);
  } catch {
    console.warn(`warn: ${file} not readable from ${BIQ_APP_DIR} origin/main — skipped`);
  }
}
if (!cssLinks.length) throw new Error(`no shell CSS from ${BIQ_APP_DIR}`);

const HARNESS = `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>entry captures</title>
${cssLinks.join('\n')}
<style>biq-onboard-app{display:block;min-height:100vh;box-sizing:border-box;padding:24px 16px}</style>
</head>
<body><biq-onboard-app id="app"></biq-onboard-app>
<script type="module" src="/embed/biq-onboard.js"></script></body></html>`;

const CLUB = (id, name) => ({
  kind: 'club', owner_scope: { kind: 'club', club_id: id }, name, requires_verification: false,
});
const TEAM = (id, name, extra = {}) => ({
  team_id: id, name, category_key: 'infantil', category_label: 'Infantil', gender: 'M',
  age_band: '', section_applicability: 'all', timezone: 'Europe/Madrid', season: '2026-27',
  team_revision: 1, archived: false, ...extra,
});
const BASE_BOOTSTRAP = {
  schema_version: '1', state: 'context_selection_required', account_id: 'acc-e2e',
  identity_verified: true, active: null,
  entry_actions: {
    'club.create': { allowed: true, requires_verification: false },
    'club.invitation.redeem': { allowed: true, requires_verification: false },
    'personal.enter': { allowed: true, requires_verification: false },
  },
};
const CASES = {
  '1team-1club': {
    bootstrap: { ...BASE_BOOTSTRAP, contexts: [CLUB('club-1', 'Club Baloncesto Prueba')] },
    teams: [TEAM('pt-1', 'Paquetillos Infantil')],
  },
  '2teams-0clubs': {
    bootstrap: { ...BASE_BOOTSTRAP, contexts: [] },
    teams: [TEAM('pt-1', 'Paquetillos Infantil'), TEAM('pt-2', 'Veteranos del Barrio', { category_label: 'Senior', category_key: 'senior' })],
  },
  '0teams-1club': {
    bootstrap: { ...BASE_BOOTSTRAP, contexts: [CLUB('club-1', 'Club Baloncesto Prueba')] },
    teams: [],
  },
  // PD-ENTRY: a coach (≥1 active coached team) sees «Mi equipo» only —
  // «Mi club» is hidden even with memberships present.
  '1team-5clubs-coach': {
    bootstrap: { ...BASE_BOOTSTRAP, contexts: [
      CLUB('club-1', 'Club Baloncesto Prueba'),
      CLUB('club-2', 'Escuela Deportiva Norte'),
      CLUB('club-3', 'Asociación Basket Sur'),
      CLUB('club-4', 'CB Linares Academy'),
      CLUB('club-5', 'Club Polideportivo Este'),
    ] },
    teams: [TEAM('pt-1', 'Paquetillos Infantil')],
  },
  // PD-CLUBS: ≥3 clubs for a non-coach member — the neutral
  // «Elegir club» access (no valid reciente datum).
  '0teams-5clubs': {
    bootstrap: { ...BASE_BOOTSTRAP, contexts: [
      CLUB('club-1', 'Club Baloncesto Prueba'),
      CLUB('club-2', 'Escuela Deportiva Norte'),
      CLUB('club-3', 'Asociación Basket Sur'),
      CLUB('club-4', 'CB Linares Academy'),
      CLUB('club-5', 'Club Polideportivo Este'),
    ] },
    teams: [],
  },
  // PD-CLUBS: an active club context is a valid reciente datum — the
  // club card is the main access, the picker stays for the rest.
  '0teams-5clubs-reciente': {
    bootstrap: { ...BASE_BOOTSTRAP, contexts: [
      CLUB('club-1', 'Club Baloncesto Prueba'),
      CLUB('club-2', 'Escuela Deportiva Norte'),
      CLUB('club-3', 'Asociación Basket Sur'),
      CLUB('club-4', 'CB Linares Academy'),
      CLUB('club-5', 'Club Polideportivo Este'),
    ], active: {
      context_id: 'ctx-1', context_epoch: 1,
      owner_scope: { kind: 'club', club_id: 'club-2' },
      team_ids: [], working_team_ids: [],
    } },
    teams: [],
  },
  '0teams-0clubs': {
    bootstrap: { ...BASE_BOOTSTRAP, contexts: [] },
    teams: [],
  },
};
const WIDTHS = [320, 390, 430, 1280];
const THEMES = ['light', 'dark'];

// ─── Contrast helpers (same maths as biq-app menu-contrast gate) ──────
function rgbToHex(rgb) {
  if (!rgb || typeof rgb !== 'string') return '#000000';
  const m = rgb.match(/rgba?\((\d+)[, ]\s*(\d+)[, ]\s*(\d+)/);
  if (!m) return '#000000';
  return '#' + [m[1], m[2], m[3]].map((n) => parseInt(n).toString(16).padStart(2, '0')).join('');
}
const channelLinear = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const luminance = (hex) => {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * channelLinear(r) + 0.7152 * channelLinear(g) + 0.0722 * channelLinear(b);
};
const contrast = (fg, bg) => {
  const l1 = luminance(fg); const l2 = luminance(bg);
  return Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100;
};

const server = createServer((req, res) => {
  if (req.url === '/embed/biq-onboard.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    res.end(bundle);
    return;
  }
  const cssPath = req.url?.match(/^\/shell-css\/([\w.-]+)$/)?.[1];
  if (cssPath && existsSync(join(tmp, cssPath))) {
    res.writeHead(200, { 'Content-Type': 'text/css' });
    res.end(readFileSync(join(tmp, cssPath)));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(HARNESS);
});
await new Promise((r) => server.listen(PORT, r));

const results = [];
const failures = [];

const browser = await chromium.launch();
async function shoot(caseName, width, theme, spec, openDialog = null) {
  const page = await browser.newPage();
  await page.setViewportSize({ width, height: 800 });
  await page.route('**/api/**', async (route) => {
    const u = route.request().url();
    const json = (body, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    try {
      if (u.includes('/api/context/v1/bootstrap')) return json(spec.bootstrap);
      if (u.includes('/api/context/v1/personal-teams')) return json({ teams: spec.teams });
      return json({ ok: true });
    } catch { /* answered */ }
  });
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('biq-onboard-app', { state: 'attached' });
  // Same theme mechanism as the shell: documentElement.dataset.theme
  // (biq-app app/index.html + shell.js theme toggle).
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
    const el = document.getElementById('app');
    el.route = 'spaces';
    el.org = { club: null, email: 'e2e@basketiq.io', display_name: 'E2E', memberships: [] };
    el.user = 'e2e-user';
  }, theme);
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el.shadowRoot && el.shadowRoot.querySelector('.entry-step')
      && el.shadowRoot.querySelector('.entry-block'));
  }, { timeout: 15000 });
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return el._personalTeamsStatus === 'ready'
      || !!el.shadowRoot.querySelector('[data-entry-personal-enter-team]')
      || !!el.shadowRoot.querySelector('.entry-note');
  }, { timeout: 15000 });
  if (openDialog === 'help') {
    await page.evaluate(() => {
      document.getElementById('app').shadowRoot.querySelector('[data-entry-help]').click();
    });
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[role="dialog"]'), { timeout: 10000 });
  } else if (openDialog === 'picker') {
    await page.evaluate(() => {
      document.getElementById('app').shadowRoot.querySelector('[data-entry-club-picker-open]').click();
    });
    await page.waitForFunction(() =>
      !!document.getElementById('app').shadowRoot.querySelector('.entry-picker-dialog'), { timeout: 10000 });
  }
  await page.waitForTimeout(350);

  // ── Assertions ──
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth <= window.innerWidth);
  if (!overflow) failures.push(`${caseName}-${width}-${theme}: horizontal overflow`);
  results.push({ case: caseName, width, theme, check: 'scrollWidth<=innerWidth', ok: overflow });

  if (openDialog === 'help' || openDialog === 'picker') {
    const picker = openDialog === 'picker';
    const m = await page.evaluate((p) => {
      const sr = document.getElementById('app').shadowRoot;
      const dlg = sr.querySelector(p ? '.entry-picker-dialog' : '.entry-help-dialog');
      const title = sr.querySelector(p ? '.entry-picker-title' : '.entry-help-title');
      const para = sr.querySelector(p ? '[data-entry-club-picker-search]' : '.entry-help-dialog p');
      const close = sr.querySelector(p ? '.entry-picker-dialog .entry-help-close' : '.entry-help-close');
      const cs = (el) => getComputedStyle(el);
      return {
        bg: cs(dlg).backgroundColor,
        title: cs(title).color,
        para: cs(para).color,
        closeFg: cs(close).color,
        closeBg: cs(close).backgroundColor,
      };
    }, picker);
    const bgHex = rgbToHex(m.bg);
    const titleR = contrast(rgbToHex(m.title), bgHex);
    const paraR = contrast(rgbToHex(m.para), bgHex);
    const closeBgHex = rgbToHex(m.closeBg);
    const closeR = contrast(rgbToHex(m.closeFg), closeBgHex === bgHex ? bgHex : closeBgHex);
    const checks = [
      { what: 'dialog title vs surface', ratio: titleR, min: 4.5 },
      { what: 'dialog paragraph vs surface', ratio: paraR, min: 4.5 },
      { what: 'close icon vs its bg', ratio: closeR, min: 3 },
    ];
    for (const c of checks) {
      const ok = c.ratio >= c.min;
      results.push({ case: caseName, width, theme, check: c.what, ratio: c.ratio, ok });
      if (!ok) failures.push(`${caseName}-${width}-${theme}: ${c.what} ${c.ratio}<${c.min}`);
    }
  }

  const name = `${caseName}-${width}-${theme}.png`;
  await page.screenshot({ path: join(OUT, name) });
  console.log('saved', name);
  await page.close();
}

for (const [caseName, spec] of Object.entries(CASES)) {
  for (const width of WIDTHS) {
    for (const theme of THEMES) {
      await shoot(caseName, width, theme, spec);
    }
  }
}
for (const theme of THEMES) {
  await shoot('help-open', 390, theme, CASES['1team-1club'], 'help');
  await shoot('picker-open', 390, theme, CASES['0teams-5clubs'], 'picker');
}

await browser.close();
await new Promise((r) => server.close(r));
cleanup();

console.log('\n=== assertion report ===');
for (const r of results) {
  const r_ = r.ratio !== undefined ? ` ratio=${r.ratio}` : '';
  console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.case}-${r.width}-${r.theme} ${r.check}${r_}`);
}
if (failures.length) {
  console.error(`\n${failures.length} assertion(s) failed`);
  process.exit(1);
}
console.log(`\nall ${results.length} assertions passed`);

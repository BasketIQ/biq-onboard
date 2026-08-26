/**
 * Screenshot evidence script for the club step (ADDENDUM-07 §6 — onboarding completion).
 *
 * Serves the built `dist/embed/biq-onboard.js`, mounts `<biq-onboard-app>` with
 * stubbed `el.org` (club-less × three variants: zero memberships / one
 * membership / memberships+admin role) and captures `picker`, `join`, `create`
 * states to PNG.
 *
 * Usage:
 *   node scripts/screenshot-club-step.mjs
 *
 * Requires: `npx playwright install chromium` (or `npm install -D playwright`).
 * Outputs PNGs to `handoff/processed/evidence/` (relative to the workspace root).
 */

import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, '..');
const DIST_EMBED = join(APP_ROOT, 'dist', 'embed', 'biq-onboard.js');

const OUTPUT_DIR = resolve(APP_ROOT, '..', '..', 'handoff', 'processed', 'evidence');

const PORT = 9123;

function checkPrerequisites() {
  if (!existsSync(DIST_EMBED)) {
    console.error(`Build output not found: ${DIST_EMBED}`);
    console.error('Run `npm run build:lib` first.');
    process.exit(1);
  }
}

function serveEmbed() {
  const bundle = readFileSync(DIST_EMBED, 'utf-8');
  const server = createServer((req, res) => {
    if (req.url === '/embed/biq-onboard.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end(bundle);
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  });
  return new Promise((resolve) => server.listen(PORT, () => resolve(server)));
}

function stubHtml(orgJson, title) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    body { margin: 0; font-family: system-ui, sans-serif; background: #F4F6FA; }
    biq-onboard-app { display: block; min-height: 100vh; }
  </style>
</head>
<body>
  <biq-onboard-app></biq-onboard-app>
  <script type="module" src="/embed/biq-onboard.js"></script>
  <script>
    window.addEventListener('DOMContentLoaded', () => {
      const el = document.querySelector('biq-onboard-app');
      el.org = ${orgJson};
      el.user = 'test-user';
    });
  </script>
</body>
</html>`;
}

const VARIANTS = [
  {
    name: 'picker',
    title: 'Club step — picker (multi-membership)',
    org: JSON.stringify({
      club: null,
      email: 'multi@basketiq.io',
      display_name: 'Multi User',
      memberships: [
        { club_id: 'club_a', club_name: 'Club A', role: 'coach' },
        { club_id: 'club_b', club_name: 'Club B', role: 'administrator' },
      ],
    }),
  },
  {
    name: 'join',
    title: 'Club step — join by ID (no memberships)',
    org: JSON.stringify({
      club: null,
      email: 'new@basketiq.io',
      display_name: 'New User',
      memberships: [],
    }),
  },
  {
    name: 'create',
    title: 'Club step — create (admin role)',
    org: JSON.stringify({
      club: null,
      email: 'admin@basketiq.io',
      display_name: 'Admin User',
      memberships: [
        { club_id: 'club_a', club_name: 'Club A', role: 'administrator' },
      ],
    }),
  },
];

async function main() {
  checkPrerequisites();
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

  const server = await serveEmbed();
  console.log(`Serving embed on http://localhost:${PORT}`);

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 480, height: 800 },
    deviceScaleFactor: 2,
  });

  for (const variant of VARIANTS) {
    const page = await context.newPage();
    await page.route('**/*', (route) => {
      if (route.request().url().includes('/embed/biq-onboard.js')) {
        route.continue();
        return;
      }
      if (route.request().url().endsWith('.html') || route.request().url() === `http://localhost:${PORT}/`) {
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: stubHtml(variant.org, variant.title),
        });
        return;
      }
      route.continue();
    });

    await page.goto(`http://localhost:${PORT}/`);
    // Wait for the custom element to render.
    await page.waitForSelector('biq-onboard-app', { timeout: 10000 });
    await page.waitForTimeout(500); // let shadow DOM settle

    const outPath = join(OUTPUT_DIR, `club-step-${variant.name}.png`);
    await page.screenshot({ path: outPath, fullPage: true });
    console.log(`Captured: ${outPath}`);
    await page.close();
  }

  await browser.close();
  server.close();
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

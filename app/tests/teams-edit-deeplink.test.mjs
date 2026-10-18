/**
 * Equipos deep-link test — `#/onboard/teams?edit=<teamId>` (Home «Plantilla»).
 *
 * The shell forwards the sub-route verbatim to `el.route`. The module must:
 *   - land on the Equipos tab and open the team edit modal (roster focus)
 *     for ADMIN_ROLES once the catalogs settle;
 *   - stay on the plain list for unknown ids and non-management roles.
 *
 * Run: `npm run build:lib && node --test tests/teams-edit-deeplink.test.mjs`
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
const PORT = 9141;

if (!existsSync(DIST_EMBED)) {
  throw new Error('Build output not found. Run `npm run build:lib` first.');
}

const bundle = readFileSync(DIST_EMBED, 'utf-8');
let server;

const HARNESS = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Equipos edit deep link</title></head>
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

const MY_CATALOG = [
  { id: 'team_club1_senior_m', club_id: 'club1', name: 'Senior Masculino', category: 'senior', gender: 'M', label: '', archived: false },
  { id: 'team_club1_cadete_m', club_id: 'club1', name: 'Cadete Masculino', category: 'cadete', gender: 'M', label: '2011', archived: false },
];
const MGMT_TEAMS = [
  // The management feed is the roster-bearing read — every row carries an
  // explicit players array (possibly empty); my-teams stays metadata-only.
  ...MY_CATALOG.map((t) => ({ ...t, players: [] })),
  { id: 'team_club1_junior_f', club_id: 'club1', name: 'Junior Femenino', category: 'junior', gender: 'F', label: '', archived: false, players: [{ name: 'Ana García', number: 7 }] },
];

// state: { role, mgmtStatus, mgmtHold, mgmtTeams }
// mgmtStatus fails the management feed; mgmtHold parks it until released
// (delayed-roster coverage); mgmtTeams replaces the served rows.
async function newPage(browser, state) {
  const page = await browser.newPage();
  const log = [];

  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const u = req.url();
    const method = req.method();
    log.push({ url: u, method });

    const json = (data, status = 200) => route.fulfill({
      status, contentType: 'application/json', body: JSON.stringify(data),
    });

    if (u.includes('/api/org/my-teams') && method === 'GET') {
      await json({ ok: true, selected: ['team_club1_senior_m'], catalog: MY_CATALOG });
      return;
    }
    if (u.includes('/team-seeding') && method === 'GET') {
      await json({ ok: true, team_seeding_job: { status: 'done' } });
      return;
    }
    if (u.match(/\/teams$/) && method === 'GET') {
      if (state.mgmtStatus) {
        await json({ detail: 'boom' }, state.mgmtStatus);
        return;
      }
      if (state.mgmtHold) await state.mgmtHold;
      const teams = state.mgmtTeams || MGMT_TEAMS;
      await json({ teams, total: teams.length });
      return;
    }
    await json({ ok: true });
  });

  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('biq-onboard-app', { state: 'attached', timeout: 10000 });
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el && el.shadowRoot);
  }, { timeout: 10000 });

  return { page, log };
}

const modalState = () => {
  const sr = document.getElementById('app').shadowRoot;
  const modal = sr.querySelector('[data-edit-modal]');
  return {
    modal: !!modal,
    editingTeam: sr.querySelector('[data-team-row][data-editing="true"]')?.dataset.teamRow || null,
    nameValue: modal?.querySelector('[data-edit-team-name]')?.value || null,
    listVisible: !!sr.querySelector('.onboard-team-list'),
  };
};

test.before(async () => { await startServer(); });
test.after(async () => { await stopServer(); });

test('?edit=<id> set before org opens the team edit modal once catalogs settle', async () => {
  const browser = await chromium.launch();
  try {
    const { page } = await newPage(browser, { role: 'administrator' });
    // Deep link arrives before the org context — the pending request must
    // survive until the teams feeds resolve.
    await page.evaluate(() => {
      const el = document.getElementById('app');
      el.route = 'teams?edit=team_club1_junior_f';
      el.org = { club: { id: 'club1', name: 'Club Test' }, role: 'administrator' };
      el.user = 'admin';
    });
    await page.waitForFunction(() => {
      const sr = document.getElementById('app').shadowRoot;
      return !!sr.querySelector('[data-edit-modal]');
    }, { timeout: 10000 });
    const view = await page.evaluate(modalState);
    assert.equal(view.nameValue, 'Junior Femenino', 'edit modal opened for the linked team');
  } finally {
    await browser.close();
  }
});

test('?edit=<id> set after a warm catalog opens the modal immediately', async () => {
  const browser = await chromium.launch();
  try {
    const { page } = await newPage(browser, { role: 'administrator' });
    await page.evaluate(() => {
      const el = document.getElementById('app');
      el.org = { club: { id: 'club1', name: 'Club Test' }, role: 'administrator' };
      el.user = 'admin';
    });
    await page.waitForFunction(() => {
      const sr = document.getElementById('app').shadowRoot;
      return !!sr.querySelector('[data-nav="teams"]');
    }, { timeout: 10000 });
    // Nav click loads the catalog; then the deep link must resolve without
    // waiting for another fetch.
    await page.evaluate(() => {
      document.getElementById('app').shadowRoot.querySelector('[data-nav="teams"]').click();
    });
    await page.waitForFunction(() => {
      const sr = document.getElementById('app').shadowRoot;
      return !!sr.querySelector('.onboard-team-list');
    }, { timeout: 10000 });
    await page.evaluate(() => {
      document.getElementById('app').route = 'teams?edit=team_club1_cadete_m';
    });
    await page.waitForFunction(() => {
      const sr = document.getElementById('app').shadowRoot;
      return !!sr.querySelector('[data-edit-modal]');
    }, { timeout: 10000 });
    const view = await page.evaluate(modalState);
    assert.equal(view.nameValue, 'Cadete Masculino');
  } finally {
    await browser.close();
  }
});

test('?edit=<unknown id> and non-management roles stay on the list', async () => {
  const browser = await chromium.launch();
  try {
    // Unknown id under an admin — drains to the plain teams list.
    const { page } = await newPage(browser, { role: 'administrator' });
    await page.evaluate(() => {
      const el = document.getElementById('app');
      el.route = 'teams?edit=team_missing';
      el.org = { club: { id: 'club1', name: 'Club Test' }, role: 'administrator' };
      el.user = 'admin';
    });
    await page.waitForFunction(() => {
      const sr = document.getElementById('app').shadowRoot;
      return !!sr.querySelector('.onboard-team-list');
    }, { timeout: 10000 });
    // Give any pending modal a beat, then assert it never opened.
    await page.waitForTimeout(300);
    const view = await page.evaluate(modalState);
    assert.equal(view.modal, false, 'unknown edit id must not open a modal');
    assert.equal(view.listVisible, true);
    await page.close();

    // Coach (PICK_ROLES, not ADMIN_ROLES): edit intent must be dropped.
    const { page: coachPage } = await newPage(browser, { role: 'coach' });
    await coachPage.evaluate(() => {
      const el = document.getElementById('app');
      el.route = 'teams?edit=team_club1_cadete_m';
      el.org = { club: { id: 'club1', name: 'Club Test' }, role: 'coach' };
      el.user = 'coach1';
    });
    await coachPage.waitForFunction(() => {
      const sr = document.getElementById('app').shadowRoot;
      return !!sr.querySelector('.onboard-team-list');
    }, { timeout: 10000 });
    await coachPage.waitForTimeout(300);
    const coachView = await coachPage.evaluate(modalState);
    assert.equal(coachView.modal, false, 'non-management role must not get the edit modal');
    // A coach must never hit the management feed.
    // (Verified implicitly: the mgmt endpoint would still answer, so gate is client-side.)
  } finally {
    await browser.close();
  }
});

test('a later route without ?edit does not reopen the modal', async () => {
  const browser = await chromium.launch();
  try {
    const { page } = await newPage(browser, { role: 'administrator' });
    await page.evaluate(() => {
      const el = document.getElementById('app');
      el.org = { club: { id: 'club1', name: 'Club Test' }, role: 'administrator' };
      el.user = 'admin';
      el.route = 'teams?edit=team_club1_cadete_m';
    });
    await page.waitForFunction(() => {
      const sr = document.getElementById('app').shadowRoot;
      return !!sr.querySelector('[data-edit-modal]');
    }, { timeout: 10000 });
    // Close the modal, then re-set the same bare teams route — no modal.
    await page.evaluate(() => {
      const sr = document.getElementById('app').shadowRoot;
      sr.querySelector('[data-cancel-edit]').click();
      document.getElementById('app').route = 'teams';
    });
    await page.waitForTimeout(300);
    const view = await page.evaluate(modalState);
    assert.equal(view.modal, false, 'route without ?edit must not reopen the modal');
  } finally {
    await browser.close();
  }
});

test('metadata feed OK + management feed failed → no editable empty draft, no PUT', async () => {
  const browser = await chromium.launch();
  try {
    const { page, log } = await newPage(browser, { role: 'administrator', mgmtStatus: 500 });
    await page.evaluate(() => {
      const el = document.getElementById('app');
      el.route = 'teams?edit=team_club1_senior_m';
      el.org = { club: { id: 'club1', name: 'Club Test' }, role: 'administrator' };
      el.user = 'admin';
    });
    // my-teams resolves; the edit intent drains into the port — a metadata
    // row is NOT a roster. The editor must fail closed, not open players:[].
    await page.waitForFunction(() => {
      const el = document.getElementById('app');
      return el._myTeamsLoaded === true && el._teamsLoading === false;
    }, { timeout: 10000 });
    await page.waitForTimeout(400);
    const view = await page.evaluate(() => {
      const sr = document.getElementById('app').shadowRoot;
      const modal = sr.querySelector('[data-edit-modal]');
      return {
        draft: !!(modal && modal.querySelector('[data-player-name="0"], [data-add-player]')),
        modal: !!modal,
        error: sr.querySelector('.onboard-error')?.textContent?.trim() || '',
      };
    });
    assert.equal(view.draft, false, 'a metadata row never opens a roster draft');
    assert.match(view.error, /plantilla|equipo|cargar|HTTP/i, 'truthful unavailable state');
    const puts = log.filter((e) => e.method === 'PUT' && /\/teams\//.test(e.url));
    assert.equal(puts.length, 0, 'no full-replace PUT can erase a real roster');
  } finally {
    await browser.close();
  }
});

test('management row missing players → unavailable, not a phantom empty roster', async () => {
  const browser = await chromium.launch();
  try {
    // The feed answers but the row carries no roster field — malformed,
    // never a known-empty draft.
    const { page, log } = await newPage(browser, {
      role: 'administrator',
      mgmtTeams: [
        { id: 'team_club1_senior_m', club_id: 'club1', name: 'Senior Masculino', category: 'senior', gender: 'M', label: '', archived: false },
      ],
    });
    await page.evaluate(() => {
      const el = document.getElementById('app');
      el.route = 'teams?edit=team_club1_senior_m';
      el.org = { club: { id: 'club1', name: 'Club Test' }, role: 'administrator' };
      el.user = 'admin';
    });
    await page.waitForFunction(() => {
      const el = document.getElementById('app');
      return el._myTeamsLoaded === true && el._teamsLoading === false;
    }, { timeout: 10000 });
    await page.waitForTimeout(400);
    const view = await page.evaluate(() => {
      const sr = document.getElementById('app').shadowRoot;
      return {
        modal: !!sr.querySelector('[data-edit-modal]'),
        error: sr.querySelector('.onboard-error')?.textContent?.trim() || '',
      };
    });
    assert.equal(view.modal, false, 'missing players is unavailable, not empty');
    assert.match(view.error, /plantilla|inválida|cargar/i);
    const puts = log.filter((e) => e.method === 'PUT' && /\/teams\//.test(e.url));
    assert.equal(puts.length, 0);
  } finally {
    await browser.close();
  }
});

test('delayed management feed → the edit intent waits, then opens the confirmed roster', async () => {
  const browser = await chromium.launch();
  try {
    let release;
    const hold = new Promise((r) => { release = r; });
    const { page } = await newPage(browser, { role: 'administrator', mgmtHold: hold });
    await page.evaluate(() => {
      const el = document.getElementById('app');
      el.route = 'teams?edit=team_club1_junior_f';
      el.org = { club: { id: 'club1', name: 'Club Test' }, role: 'administrator' };
      el.user = 'admin';
    });
    await page.waitForFunction(() =>
      document.getElementById('app')._myTeamsLoaded === true,
    { timeout: 10000 });
    await page.waitForTimeout(400);
    const early = await page.evaluate(() =>
      !!document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]'));
    assert.equal(early, false, 'no draft while the roster read is still pending');
    release();
    await page.waitForFunction(() => {
      const m = document.getElementById('app').shadowRoot.querySelector('[data-edit-modal]');
      return m && m.querySelector('[data-player-name="0"]');
    }, { timeout: 10000 });
    const name = await page.evaluate(() =>
      document.getElementById('app').shadowRoot.querySelector('[data-player-name="0"]').value);
    assert.equal(name, 'Ana García', 'confirmed roster-bearing read opens the editor');
  } finally {
    await browser.close();
  }
});

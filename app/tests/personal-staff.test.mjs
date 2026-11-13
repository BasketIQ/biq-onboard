import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const bundle = readFileSync(new URL('../../dist/embed/biq-onboard.js', import.meta.url));
let browser;
let server;
let origin;
before(async () => {
  server = createServer((request, response) => {
    response.setHeader('Content-Type', request.url === '/embed.js' ? 'text/javascript' : 'text/html');
    const lang = request.url === '/embed.js' ? 'es-ES' : new URL(request.url, 'http://localhost').searchParams.get('lang') || 'es-ES';
    response.end(request.url === '/embed.js' ? bundle
      : `<!doctype html><html lang="${lang}"><meta charset="utf-8"><biq-personal-staff></biq-personal-staff><script type="module" src="/embed.js"></script></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  try { browser = await chromium.launch({ headless: true }); }
  catch (error) { await new Promise(resolve => server.close(resolve)); throw error; }
});
after(async () => {
  await browser?.close();
  server?.closeAllConnections();
  if (server?.listening) await new Promise(resolve => server.close(resolve));
});

const initial = () => ({
  teams: [{ team_id: 'team-one', name: 'Infantil Azul' }],
  invitations: [],
  directory: {
    name: 'Infantil Azul',
    grant: { account_id: 'owner', owner_account_id: 'owner', generation: 1, plan_state: 'premium', archived: false },
    members: [
      { account_id: 'owner', generation: 1, revision: 1, display_name: 'Entrenadora Ana', premium_access_enabled: true },
      { account_id: 'guest', generation: 2, revision: 1, display_name: 'Entrenador Luis', premium_access_enabled: false },
    ],
    invitations: [], transfer: null,
  },
});

async function scenario(state, command, fn, width = 390, lang = 'es-ES') {
  const context = await browser.newContext({ viewport: { width, height: 844 } });
  const page = await context.newPage();
  const operations = [];
  try {
    await page.route('**/api/context/v1/personal-staff/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname.split('/personal-staff')[1];
      if (request.method() === 'GET') {
        const payload = path === '/teams' ? { teams: state.teams }
          : path === '/invitations' ? { invitations: state.invitations } : state.directory;
        return route.fulfill({ json: payload });
      }
      const body = request.postDataJSON();
      operations.push({ path, body, method: request.method() });
      return route.fulfill({ json: await command(path, body, state) });
    });
    await page.goto(`${origin}?lang=${encodeURIComponent(lang)}`);
    await page.getByRole('heading', { name: lang === 'en' ? 'Team staff' : 'Staff del equipo' }).waitFor();
    await fn(page, operations);
  } finally { await context.close(); }
}

test('failed email leaves a durable invitation with resend and original expiry', async () => {
  const state = initial();
  const expires = 1_900_000_000;
  await scenario(state, async (path, body) => {
    if (path.endsWith('/invitations')) {
      assert.match(body.operation_id, /^[a-f0-9-]{36}$/);
      assert.equal(body.email, 'new@example.test');
      const invitation = { invitation_id: 'invite-one', email: body.email, expires_at: expires, mail_delivery_state: 'failed' };
      state.directory.invitations = [invitation];
      return invitation;
    }
    assert.equal(path, '/invitations/resend');
    assert.equal(body.invitation_id, 'invite-one');
    state.directory.invitations[0].mail_delivery_state = 'sent';
    return state.directory.invitations[0];
  }, async (page, operations) => {
    await page.getByLabel('Correo del entrenador').fill('new@example.test');
    await page.getByRole('button', { name: 'Invitar al staff', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Invitación guardada' }).waitFor();
    await page.getByRole('button', { name: 'Reenviar', exact: true }).click();
    await page.getByText('sent', { exact: true }).waitFor();
    assert.equal(state.directory.invitations[0].expires_at, expires);
    assert.equal(operations.length, 2);
  });
});

test('account entry accepts pending staff without sending an actor or locator', async () => {
  const state = initial();
  state.teams = [];
  state.invitations = [{ invitation_id: 'invite-one', team_id: 'team-one', name: 'Infantil Azul', expires_at: 1_900_000_000 }];
  await scenario(state, async (path, body) => {
    assert.equal(path, '/invitations/accept');
    assert.deepEqual(body, { invitation_id: 'invite-one' });
    state.invitations = [];
    state.teams = [{ team_id: 'team-one', name: 'Infantil Azul' }];
    state.directory.grant.account_id = 'guest';
    state.directory.grant.generation = 2;
    return { team_id: 'team-one', generation: 2, premium_access_enabled: false };
  }, async (page, operations) => {
    await page.getByRole('button', { name: 'Aceptar invitación', exact: true }).click();
    await page.getByRole('button', { name: 'Salir del equipo', exact: true }).waitFor();
    assert.equal(operations.length, 1);
    assert.equal(await page.getByRole('checkbox', { name: 'Permitir Premium y Smart' }).count(), 0);
  }, 1280);
});

test('owner permission uses current generation and revision; transfer stays pending', async () => {
  const state = initial();
  await scenario(state, async (path, body) => {
    if (path.endsWith('/permission')) {
      assert.deepEqual(body, { account_id: 'guest', generation: 2, expected_revision: 1, enabled: true });
      state.directory.members[1].premium_access_enabled = true;
      state.directory.members[1].revision++;
      return state.directory.members[1];
    }
    assert.equal(path, '/teams/team-one/transfers');
    assert.equal(body.account_id, 'guest');
    state.directory.transfer = { transfer_id: 'transfer-one', to_account_id: 'guest' };
    return state.directory.transfer;
  }, async (page, operations) => {
    await page.getByRole('checkbox', { name: 'Permitir Premium y Smart' }).check();
    await page.waitForFunction(() => !document.querySelector('biq-personal-staff [data-permission]')?.disabled);
    await page.getByRole('button', { name: 'Proponer transferencia', exact: true }).click();
    await page.getByText('Transferencia de propiedad pendiente de aceptación.').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Aceptar propiedad', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Salir del equipo', exact: true }).count(), 0);
    assert.equal(state.directory.grant.owner_account_id, 'owner');
    assert.equal(operations.length, 2);
  });
});

test('courtesy exposes ordinary work but no invitation form or consumption permission for guests', async () => {
  const state = initial();
  state.directory.grant.plan_state = 'grace';
  state.directory.grant.account_id = 'guest';
  await scenario(state, async () => assert.fail('No automatic mutation is allowed'), async page => {
    await page.getByText(/Cortesía: trabajo ordinario/).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Invitar al staff', exact: true }).count(), 0);
    assert.equal(await page.getByRole('checkbox', { name: 'Permitir Premium y Smart' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Salir del equipo', exact: true }).count(), 1);
  });
});

test('English renders Coach, staff actions and Smart permission without overflow', async () => {
  const state = initial();
  state.directory.grant.plan_state = 'free';
  await scenario(state, async () => assert.fail('No automatic mutation is allowed'), async page => {
    await page.getByRole('heading', { name: 'Team staff' }).waitFor();
    await page.getByText('Coach', { exact: true }).waitFor();
    await page.getByRole('checkbox', { name: 'Allow Premium and Smart' }).waitFor();
    await page.getByRole('button', { name: 'Refresh staff', exact: true }).waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 1280));
  }, 1280, 'en');
});

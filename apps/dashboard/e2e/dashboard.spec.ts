/**
 * Dashboard end-to-end (DSH-01..DSH-10, DX-06) and accessibility (A5-5): one signed-in session walks every page,
 * and axe must report no critical or serious violations on any of them.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import * as Y from 'yjs';

test.describe.configure({ mode: 'serial' });

const EMAIL = `owner${String(Date.now())}@example.com`;
const PASSWORD = 'correct-horse-battery';
const ORG = 'Acme Field Ops';
let page: Page;
let secretKey = '';

async function expectAccessible(label: string): Promise<void> {
  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const bad = r.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
  expect(
    bad.map(
      (v) =>
        `${v.id} (${v.impact}): ${v.nodes
          .slice(0, 2)
          .map((n) => n.target.join(' '))
          .join(' | ')}`,
    ),
    `axe violations on ${label}`,
  ).toEqual([]);
}

test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext()).newPage();
});
test.afterAll(async () => {
  await page.context().close();
});

test('DSH-01: signup validates input, shows the secret key once, and cannot be dismissed until saved', async () => {
  await page.goto('/signup');
  await expectAccessible('signup');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('Enter your name')).toBeVisible();
  await expect(page.getByText('Use at least 10 characters')).toBeVisible();

  await page.getByLabel('Your name').fill('Dana');
  await page.getByLabel('Organization').fill(ORG);
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();

  const dialog = page.getByRole('dialog', { name: 'Your secret API key' });
  await expect(dialog).toBeVisible();
  secretKey = (await page.getByTestId('secret').innerText()).trim();
  expect(secretKey).toMatch(/^sk_live_/);
  await expectAccessible('secret key dialog');

  await expect(dialog.getByRole('button', { name: 'Done' })).toBeDisabled();
  await page.keyboard.press('Escape'); // not closable before the user confirms
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('I saved this key').check();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
});

test('login: wrong password shows an error; logout then login works; a reload keeps the session via the refresh cookie', async () => {
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login/);
  await expectAccessible('login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill('wrong-password-123');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('alert')).toContainText('Invalid email or password');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
});

test('DSH-02: the overview shows live KPIs, quota gauges and is accessible', async () => {
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await expect(page.getByTestId('kpi-connections')).not.toHaveText('-');
  await expect(page.getByRole('progressbar', { name: 'Documents' })).toBeVisible();
  await expect(page.getByTestId('plan')).toHaveText('selfhost');
  await expectAccessible('overview');
});

test('DSH-03 / DSH-04: create a document, browse it, and inspect JSON and ops', async () => {
  await page.getByRole('link', { name: 'Collections' }).click();
  await expect(page.getByText('No collections yet')).toBeVisible();
  await expectAccessible('collections (empty)');
  await page.getByRole('button', { name: 'New document' }).click();
  await page.getByLabel('Collection').fill('inspections');
  await page.getByLabel('Document id (optional)').fill('site-42');
  await page.getByLabel('Initial data (JSON)').fill('{"status":"draft","score":1}');
  await page.getByRole('button', { name: 'Create', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'inspections / site-42' })).toBeVisible();
  await expect(page.getByTestId('doc-json')).toContainText('"status": "draft"');
  await expectAccessible('document inspector');
  await page.getByRole('tab', { name: 'Ops' }).click();
  await expect(page.getByRole('cell', { name: 'rest' })).toBeVisible();

  await page.getByRole('link', { name: 'Collections' }).click();
  await expect(page.getByRole('link', { name: 'inspections' })).toBeVisible();
  await expectAccessible('collections');
  await page.getByRole('link', { name: 'inspections' }).click();
  await page.getByLabel('Search by id prefix').fill('zzz');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByText('No documents start with "zzz"')).toBeVisible();
  await page.getByLabel('Search by id prefix').fill('site');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByRole('link', { name: 'site-42' })).toBeVisible();
  await expectAccessible('documents');
});

test('DSH-04 / DSH-06 time travel: scrubbing the slider changes the rendered JSON without mutating the server; restore is non-destructive', async () => {
  const mint = await page.request.post('/v1/tokens', {
    headers: { authorization: `Bearer ${secretKey}` },
    data: { userId: 'e2e', access: [{ collection: 'inspections', docs: '*', mode: 'rw' }] },
  });
  const token = ((await mint.json()) as { token: string }).token;

  // Edit the document over the HTTP sync fallback so a second checkpoint exists.
  const state = await page.request.get('/v1/collections/inspections/docs/site-42/state', {
    headers: { authorization: `Bearer ${secretKey}` },
  });
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(await state.body()));
  const before = Y.encodeStateVector(doc);
  doc.getMap('data').set('status', 'submitted');
  doc.getMap('data').set('score', 9);
  const push = await page.request.post('/v1/sync/inspections/site-42/push', {
    headers: { authorization: `Bearer ${token}` },
    data: {
      clientId: 'e2e',
      opId: 'edit-1',
      update: Buffer.from(Y.encodeStateAsUpdate(doc, before)).toString('base64url'),
    },
  });
  expect(push.ok()).toBe(true);

  // Checkpoints are created by a background job; wait until both exist before opening the page.
  await expect
    .poll(
      async () => {
        const r = await page.request.get('/v1/collections/inspections/docs/site-42/history', {
          headers: { authorization: `Bearer ${secretKey}` },
        });
        return ((await r.json()) as { items: unknown[] }).items.length;
      },
      { timeout: 30_000 },
    )
    .toBe(2);

  await page.goto('/collections/inspections/site-42');
  await page.getByRole('tab', { name: 'History' }).click();
  const slider = page.getByRole('slider');
  await expect(slider).toHaveAttribute('max', '1');
  await expect(page.getByTestId('history-json')).toContainText('"submitted"');
  await expectAccessible('history');

  await slider.fill('0'); // scrub back in time
  await expect(page.getByTestId('history-json')).toContainText('"draft"');
  const live = await page.request.get('/v1/collections/inspections/docs/site-42', {
    headers: { authorization: `Bearer ${secretKey}` },
  });
  expect(((await live.json()) as { json: { data: { status: string } } }).json.data.status).toBe(
    'submitted',
  ); // scrubbing changed nothing

  await page.getByRole('button', { name: 'Restore this version' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByText('Restored to checkpoint')).toBeVisible();
  await page.getByRole('tab', { name: 'JSON' }).click();
  await expect(page.getByTestId('doc-json')).toContainText('"status": "draft"');
  await page.getByRole('tab', { name: 'Ops' }).click();
  await expect(page.getByRole('cell', { name: 'system:restore' })).toBeVisible();
});

test('DSH-05: keys page creates a publishable key once and revokes it behind a confirmation', async () => {
  await page.getByRole('link', { name: 'API keys' }).click();
  await expect(page.getByRole('heading', { name: 'API keys' })).toBeVisible();
  await expectAccessible('keys');
  await page.getByRole('button', { name: 'Create key' }).click();
  const form = page.getByRole('dialog', { name: 'Create API key' });
  await form.getByLabel('Name').fill('Web app');
  await form.getByLabel('Publishable').check();
  await form.getByRole('button', { name: 'Create', exact: true }).click();
  const dlg = page.getByRole('dialog', { name: 'Copy your new key' });
  await expect(page.getByTestId('secret')).toContainText('pk_live_');
  await dlg.getByLabel('I saved this key').check();
  await dlg.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('cell', { name: 'Web app', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Revoke Web app' }).click();
  await expect(page.getByRole('dialog', { name: 'Revoke "Web app"?' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Revoke Web app' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByText('Revoked (publishable)')).toBeVisible();
});

test('DSH-07: webhook endpoint receives a signed test event and the delivery log shows it', async () => {
  const received: { sig: string; event: string }[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    received.push({
      sig: String(req.headers['syncra-signature']),
      event: String(req.headers['syncra-event']),
    });
    res.end('ok');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/hook`;
  try {
    await page.getByRole('link', { name: 'Webhooks' }).click();
    await expect(page.getByText('No webhook endpoints')).toBeVisible();
    await expectAccessible('webhooks (empty)');
    await page.getByRole('button', { name: 'Add endpoint' }).click();
    await page.getByLabel('Endpoint URL').fill(url);
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    const dlg = page.getByRole('dialog', { name: 'Signing secret' });
    await expect(page.getByTestId('secret')).toContainText('whsec_');
    await dlg.getByLabel('I saved this key').check();
    await dlg.getByRole('button', { name: 'Done' }).click();

    await page.getByRole('button', { name: `Send test event to ${url}` }).click();
    await page.getByRole('button', { name: `Deliveries for ${url}` }).click();
    const log = page.getByRole('dialog', { name: 'Delivery log' });
    await expect(log.getByText('Delivered')).toBeVisible({ timeout: 20_000 });
    await expectAccessible('delivery log');
    expect(received[0]?.event).toBe('webhook.test');
    expect(received[0]?.sig).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    await log.getByRole('button', { name: 'Close' }).click();
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('DSH-08 / DSH-09: invite a member, then verify the audit chain', async () => {
  await page.getByRole('link', { name: 'Members' }).click();
  await expect(page.getByRole('cell', { name: EMAIL })).toBeVisible();
  await expectAccessible('members');
  await page.getByRole('button', { name: 'Invite member' }).click();
  await page.getByLabel('Email').fill('teammate@example.com');
  await page.getByLabel('Role').selectOption('viewer');
  await page.getByRole('button', { name: 'Send invite' }).click();
  await expect(page.getByRole('dialog', { name: 'Invitation link' })).toContainText(
    '/accept-invite?token=',
  );
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText('teammate@example.com (viewer)')).toBeVisible();

  await page.getByRole('link', { name: 'Audit log' }).click();
  await expect(page.getByRole('cell', { name: 'member.invited' })).toBeVisible();
  await page.getByRole('button', { name: 'Verify chain' }).click();
  await expect(page.getByTestId('verify-result')).toContainText('no tampering detected');
  await expectAccessible('audit');
});

test('DSH-06: usage and billing page renders quota, chart area and the invoice section', async () => {
  await page.getByRole('link', { name: 'Usage & billing' }).click();
  await expect(page.getByRole('heading', { name: 'Usage & billing' })).toBeVisible();
  await expect(page.getByRole('progressbar', { name: 'Operations this month' })).toBeVisible();
  await expect(page.getByText('No invoices yet')).toBeVisible();
  await expectAccessible('usage');
});

test('DSH-10: the live monitor lists this node and updates every second', async () => {
  await page.getByRole('link', { name: 'Live monitor' }).click();
  await expect(page.getByTestId('node-card').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Live, updating every second')).toBeVisible();
  await expectAccessible('monitor');
});

test('DX-06: playground merges edits made while one device is offline', async () => {
  await page.getByRole('link', { name: 'Playground' }).click();
  const a = page.getByTestId('Device A-text');
  const b = page.getByTestId('Device B-text');
  await expect(page.getByTestId('Device A-status')).toHaveAttribute('data-state', 'live', {
    timeout: 20_000,
  });
  await expect(page.getByTestId('Device B-status')).toHaveAttribute('data-state', 'live', {
    timeout: 20_000,
  });
  await expectAccessible('playground');

  await a.fill('hello from A. ');
  await expect(b).toHaveValue('hello from A. ');

  await page.getByRole('button', { name: 'Go offline' }).nth(1).click();
  await expect(page.getByTestId('Device B-status')).toHaveAttribute('data-state', 'offline');
  await b.press('End');
  await b.pressSequentially('B typed offline. ');
  await a.press('End');
  await a.pressSequentially('A kept going. ');
  await expect(a).not.toHaveValue(/B typed/);

  await page.getByRole('button', { name: 'Go online' }).click();
  await expect(page.getByTestId('Device B-status')).toHaveAttribute('data-state', 'live', {
    timeout: 20_000,
  });
  await expect(a).toHaveValue(/B typed offline\./);
  await expect(b).toHaveValue(/A kept going\./);
  expect(await a.inputValue()).toBe(await b.inputValue());
});

test('settings: a role-aware page; deleting the organization needs the name typed and logs out', async () => {
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expectAccessible('settings');
  await page.getByRole('button', { name: 'Delete organization' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete this organization?' });
  await expectAccessible('confirm dialog');
  await expect(confirm.getByRole('button', { name: 'Delete organization' })).toBeDisabled();
  await confirm.getByLabel(`Type "${ORG}" to confirm`).fill(ORG);
  await confirm.getByRole('button', { name: 'Delete organization' }).click();
  await expect(page).toHaveURL(/\/login/);
});

test('responsive: usable at 360 px width without horizontal scrolling', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 } });
  const p = await ctx.newPage();
  await p.goto('/login');
  await expect(p.getByRole('heading', { name: 'Log in' })).toBeVisible();
  expect(
    await p.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await ctx.close();
});

/** DEM-02 / A6-2: field inspection PWA — installable, virtualized, role split, fully offline. */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

async function login(page: Page, name: string, role: 'inspector' | 'supervisor'): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Your name').fill(name);
  await page.getByRole('radio', { name: new RegExp(role, 'i') }).check();
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByTestId('conn')).toHaveAttribute('data-state', 'live');
}

/** Waits until the seeded sites index has reached this device. */
async function sitesLoaded(page: Page): Promise<void> {
  await expect(page.getByTestId('site-count')).toContainText('of 5000 sites');
}

const synced = (page: Page) => expect(page.getByTestId('pending')).toHaveText('0 unsynced');

test('installable: manifest, icons and an active service worker', async ({ page }) => {
  await login(page, 'Ines', 'inspector');
  const manifest = await page.evaluate(async () => {
    const href = document.querySelector<HTMLLinkElement>('link[rel=manifest]')?.href ?? '';
    return (await (await fetch(href)).json()) as {
      display: string;
      start_url: string;
      icons: unknown[];
    };
  });
  expect(manifest.display).toBe('standalone');
  expect(manifest.icons.length).toBeGreaterThan(0);
  await expect
    .poll(() => page.evaluate(async () => (await navigator.serviceWorker.ready).active?.state))
    .toBe('activated');
});

test('5,000 sites render through a virtualized list and search narrows them', async ({ page }) => {
  await login(page, 'Ines', 'inspector');
  await sitesLoaded(page);
  const rows = await page.locator('.vrow').count();
  expect(rows).toBeGreaterThan(5);
  expect(rows).toBeLessThan(60); // not 5,000 DOM nodes
  await page.getByLabel('Search sites').fill('Warehouse 0042');
  await expect(page.getByTestId('site-count')).toContainText('1 of 5000');
});

async function inspect(page: Page): Promise<void> {
  await page.getByLabel('Search sites').fill('0007');
  await page.locator('.vrow').first().click();
  await page.getByRole('button', { name: 'New inspection' }).click();
  await expect(page.getByRole('heading', { name: /Inspection/ })).toBeVisible();
}

test('works fully offline: reload with no network, edit, and sync when back online', async ({
  page,
  context,
}) => {
  await login(page, 'Olga', 'inspector');
  await sitesLoaded(page);
  await page.waitForFunction(
    async () => (await navigator.serviceWorker.ready).active?.state === 'activated',
  );
  // Let the three templates reach the device before the network goes away.
  await page.waitForTimeout(1500);

  await context.setOffline(true);
  await page.reload(); // app shell comes from the service worker
  await expect(page.getByLabel('Search sites')).toBeVisible();
  await sitesLoaded(page); // list comes from IndexedDB

  await inspect(page);
  await page
    .getByRole('group', { name: 'Fire exits clear result' })
    .getByRole('button', { name: 'pass' })
    .click();
  await page.getByLabel('Inspector notes').fill('Gate latch is loose');
  await expect(page.getByTestId('saved')).toHaveText('Saved on device');
  await page.waitForTimeout(500); // the SDK batches local writes for 50 ms; let the last edit reach IndexedDB

  await page.reload(); // still offline: edits survived
  await expect(page.getByLabel('Inspector notes')).toHaveValue('Gate latch is loose');
  await expect(
    page
      .getByRole('group', { name: 'Fire exits clear result' })
      .getByRole('button', { name: 'pass' }),
  ).toHaveAttribute('aria-pressed', 'true');

  await context.setOffline(false);
  await expect(page.getByTestId('conn')).toHaveAttribute('data-state', 'live', { timeout: 40_000 });
  await synced(page);
});

test("role split: supervisor sees the inspector's work, comments, and cannot edit the checklist", async ({
  browser,
}) => {
  const ctxA: BrowserContext = await browser.newContext();
  const ctxB: BrowserContext = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  await login(a, 'Ravi', 'inspector');
  await sitesLoaded(a);
  await a.waitForTimeout(1500);
  await inspect(a);
  await a.getByLabel('Inspector notes').fill('Pump vibrates');
  await synced(a);
  const url = a.url();
  await a.getByRole('button', { name: 'Submit inspection' }).click();
  await synced(a);

  await login(b, 'Sam', 'supervisor');
  await b.goto(url);
  await expect(b.getByLabel('Inspector notes')).toHaveValue('Pump vibrates');
  await expect(b.getByTestId('insp-status')).toHaveText('submitted');
  await expect(b.getByRole('button', { name: 'Submit inspection' })).toHaveCount(0);
  await expect(b.getByLabel('Inspector notes')).toBeDisabled();
  await b.getByLabel('Supervisor comment').fill('Book a repair');
  await synced(b);
  await a.evaluate((h) => {
    location.hash = h;
  }, new URL(url).hash); // back to this inspection
  await expect(a.getByLabel('Supervisor comment')).toHaveValue('Book a repair');
  await expect(a.getByTestId('insp-status')).toHaveText('submitted'); // the supervisor's note did not undo the submit
  await ctxA.close();
  await ctxB.close();
});

test('screenshot for the README (SCREENSHOTS=1)', async ({ page }) => {
  test.skip(!process.env.SCREENSHOTS, 'set SCREENSHOTS=1 to regenerate docs/images');
  await page.setViewportSize({ width: 430, height: 800 });
  await login(page, 'Ines', 'inspector');
  await sitesLoaded(page);
  await page.waitForTimeout(1500);
  await inspect(page);
  await page
    .getByRole('group', { name: 'Fire exits clear result' })
    .getByRole('button', { name: 'pass' })
    .click();
  await page
    .getByRole('group', { name: 'First aid kit stocked result' })
    .getByRole('button', { name: 'fail' })
    .click();
  await page.getByLabel('Inspector notes').fill('First aid kit is empty; restock before Friday.');
  await page.setViewportSize({ width: 430, height: 1400 }); // tall enough that no sticky bar floats mid-image
  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });
  await page.screenshot({ path: '../../docs/images/inspection.png' });
});

/** README screenshots. Run with SCREENSHOTS=1; skipped otherwise. */
import { expect, test } from '@playwright/test';

test.skip(!process.env.SCREENSHOTS, 'set SCREENSHOTS=1 to regenerate docs/images');

test('dashboard overview', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 760 });
  await page.goto('/signup');
  await page.getByLabel('Your name').fill('Dana');
  await page.getByLabel('Organization').fill('Acme Field Ops');
  await page.getByLabel('Email').fill(`shot${String(Date.now())}@example.com`);
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  const dialog = page.getByRole('dialog', { name: 'Your secret API key' });
  await dialog.getByLabel('I saved this key').check();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await page.waitForTimeout(2500); // let the live chart draw a few points
  await page.screenshot({ path: '../../docs/images/dashboard.png' });
});

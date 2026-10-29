import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

interface Window2 {
  ctx: BrowserContext;
  page: Page;
}

async function signIn(browser: Browser, name: string): Promise<Window2> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/');
  await page.getByLabel('Your name').fill(name);
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByTestId('sync-badge')).toHaveAttribute(
    'data-state',
    /live|syncing|connecting/,
  );
  return { ctx, page };
}

const badge = (p: Page) => p.getByTestId('sync-badge');
const editor = (p: Page) => p.getByTestId('editor');
const pending = async (p: Page): Promise<number> =>
  Number((await p.getByTestId('pending').innerText()).split(' ')[0]);

test.describe('DEM-01 scripted scenario (Doc 04 §10.1, steps 1-5)', () => {
  test('two people edit, one goes offline, reload keeps edits, reconnect merges cleanly', async ({
    browser,
  }) => {
    const ada = await signIn(browser, 'Ada');
    const ben = await signIn(browser, 'Ben');

    // Step 1: same note in both windows; typing in A shows up in B; B sees A's cursor.
    await ada.page.getByRole('button', { name: 'New note' }).click();
    await expect(editor(ada.page)).toBeVisible();
    const noteUrl = ada.page.url();
    await ben.page.goto(noteUrl);
    await expect(editor(ben.page)).toBeVisible();
    await expect(badge(ben.page)).toHaveAttribute('data-state', 'live');
    await editor(ada.page).click();
    await ada.page.keyboard.type('Plan for Monday. ');
    await expect(editor(ben.page)).toContainText('Plan for Monday.');
    await expect(
      ben.page.locator('.collaboration-cursor__label', { hasText: 'Ada' }),
    ).toBeVisible();

    // Step 2: B goes offline and types three sentences; the badge and counter react.
    await ben.page.getByTestId('chaos-offline').click();
    await expect(badge(ben.page)).toHaveAttribute('data-state', 'offline');
    await expect(badge(ben.page)).toContainText('Offline');
    await editor(ben.page).click();
    await ben.page.keyboard.press('Control+End');
    await ben.page.keyboard.type('Ben one. Ben two. Ben three. ');
    await expect.poll(() => pending(ben.page)).toBeGreaterThan(0);

    // Step 3: A makes different edits while B is offline, including deleting text.
    await editor(ada.page).click();
    await ada.page.keyboard.press('Control+End');
    await ada.page.keyboard.type('Ada added a second line. Temporary text.');
    for (let i = 0; i < 'Temporary text.'.length; i++) await ada.page.keyboard.press('Backspace');

    // Step 4: reload B while still offline; its edits are still there (persisted).
    await ben.page.reload();
    await expect(editor(ben.page)).toContainText('Ben three.');
    await expect(badge(ben.page)).toHaveAttribute('data-state', 'offline');

    // Step 5: B comes back online; both windows converge on one merged note.
    await ben.page.getByTestId('chaos-offline').click();
    await expect(badge(ben.page)).toHaveAttribute('data-state', 'live');
    await expect.poll(() => pending(ben.page)).toBe(0);
    await expect
      .poll(async () => (await editor(ada.page).innerText()).includes('Ben three.'))
      .toBe(true);
    await expect
      .poll(
        async () => (await editor(ada.page).innerText()) === (await editor(ben.page).innerText()),
      )
      .toBe(true);
    const merged = await editor(ben.page).innerText();
    expect(merged).toContain('Plan for Monday.');
    expect(merged).toContain('Ada added a second line.');
    expect(merged).not.toContain('Temporary text.');
    expect(merged).toContain('Ben one. Ben two. Ben three.');

    await ada.ctx.close();
    await ben.ctx.close();
  });

  test('A2-1: offline edit survives closing the tab, then reaches the server', async ({
    browser,
  }) => {
    const w = await signIn(browser, 'Cleo');
    await w.page.getByRole('button', { name: 'New note' }).click();
    await expect(editor(w.page)).toBeVisible();
    const url = w.page.url();
    await expect(badge(w.page)).toHaveAttribute('data-state', 'live');

    await w.page.getByTestId('chaos-offline').click();
    await editor(w.page).click();
    await w.page.keyboard.type('written with no signal');
    await w.page.waitForTimeout(300); // past the 50 ms batch window: the edit is on disk
    await w.page.close();

    const again = await w.ctx.newPage();
    await again.goto(url);
    await expect(editor(again)).toContainText('written with no signal');
    // The offline flag lived in the closed tab's sessionStorage, so this tab reconnects by itself.
    await expect(badge(again)).toHaveAttribute('data-state', 'live');
    await expect.poll(() => pending(again)).toBe(0);

    const other = await signIn(browser, 'Dev');
    await other.page.goto(url);
    await expect(editor(other.page)).toContainText('written with no signal');
    await w.ctx.close();
    await other.ctx.close();
  });
});

test.describe('A2-3 multi-tab', () => {
  test('three tabs share one connection leader; closing it hands over without losing edits', async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    const first = await ctx.newPage();
    await first.goto('/');
    await first.getByLabel('Your name').fill('Tabby');
    await first.getByRole('button', { name: 'Start' }).click();
    await first.getByRole('button', { name: 'New note' }).click();
    await expect(editor(first)).toBeVisible();
    const url = first.url();

    const pages = [first];
    for (let i = 0; i < 2; i++) {
      const p = await ctx.newPage();
      await p.goto(url);
      await expect(editor(p)).toBeVisible();
      pages.push(p);
    }
    const leaders = async (ps: Page[]): Promise<number[]> =>
      Promise.all(
        ps.map((p) =>
          p.evaluate(() =>
            (window as unknown as { __syncra: { status: { isLeader: boolean } } }).__syncra.status
              .isLeader
              ? 1
              : 0,
          ),
        ),
      );
    await expect.poll(async () => (await leaders(pages)).reduce((a, b) => a + b, 0)).toBe(1);

    await editor(pages[2] as Page).click();
    await (pages[2] as Page).keyboard.type('typed in a follower tab');
    await expect(editor(pages[0] as Page)).toContainText('typed in a follower tab');
    await expect(editor(pages[1] as Page)).toContainText('typed in a follower tab');

    const idx = (await leaders(pages)).indexOf(1);
    const closedAt = Date.now();
    await (pages[idx] as Page).close();
    const survivors = pages.filter((_, i) => i !== idx);
    await expect.poll(async () => (await leaders(survivors)).reduce((a, b) => a + b, 0)).toBe(1);
    expect(Date.now() - closedAt).toBeLessThan(3000 + 1000);

    await editor(survivors[0] as Page).click();
    await (survivors[0] as Page).keyboard.type(' and after failover');
    await expect(editor(survivors[1] as Page)).toContainText('and after failover');
    await expect((survivors[1] as Page).getByTestId('sync-badge')).toHaveAttribute(
      'data-state',
      'live',
    );
    await expect.poll(() => pending(survivors[1] as Page)).toBe(0);

    const check = await signIn(browser, 'Checker');
    await check.page.goto(url);
    await expect(editor(check.page)).toContainText('typed in a follower tab');
    await expect(editor(check.page)).toContainText('and after failover');
    await ctx.close();
    await check.ctx.close();
  });
});

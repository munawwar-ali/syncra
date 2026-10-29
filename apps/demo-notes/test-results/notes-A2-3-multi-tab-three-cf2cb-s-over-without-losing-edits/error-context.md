# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: notes.spec.ts >> A2-3 multi-tab >> three tabs share one connection leader; closing it hands over without losing edits
- Location: e2e\notes.spec.ts:109:3

# Error details

```
Error: expect(locator).toContainText(expected) failed

Locator: getByTestId('editor')
Expected substring: "typed in a follower tab"
Received string:    ""
Timeout: 15000ms

Call log:
  - Expect "toContainText" getByTestId('editor') with timeout 15000ms
  - waiting for getByTestId('editor')
    33 × locator resolved to <div tabindex="0" translate="no" data-testid="editor" contenteditable="true" aria-label="Note body" class="tiptap ProseMirror">…</div>
       - unexpected value ""

```

```yaml
- paragraph
```

# Test source

```ts
  40  |     await expect(ben.page.locator('.collaboration-cursor__label', { hasText: 'Ada' })).toBeVisible();
  41  |
  42  |     // Step 2: B goes offline and types three sentences; the badge and counter react.
  43  |     await ben.page.getByTestId('chaos-offline').click();
  44  |     await expect(badge(ben.page)).toHaveAttribute('data-state', 'offline');
  45  |     await expect(badge(ben.page)).toContainText('Offline');
  46  |     await editor(ben.page).click();
  47  |     await ben.page.keyboard.press('Control+End');
  48  |     await ben.page.keyboard.type('Ben one. Ben two. Ben three. ');
  49  |     await expect.poll(() => pending(ben.page)).toBeGreaterThan(0);
  50  |
  51  |     // Step 3: A makes different edits while B is offline, including deleting text.
  52  |     await editor(ada.page).click();
  53  |     await ada.page.keyboard.press('Control+End');
  54  |     await ada.page.keyboard.type('Ada added a second line. Temporary text.');
  55  |     for (let i = 0; i < 'Temporary text.'.length; i++) await ada.page.keyboard.press('Backspace');
  56  |
  57  |     // Step 4: reload B while still offline; its edits are still there (persisted).
  58  |     await ben.page.reload();
  59  |     await expect(editor(ben.page)).toContainText('Ben three.');
  60  |     await expect(badge(ben.page)).toHaveAttribute('data-state', 'offline');
  61  |
  62  |     // Step 5: B comes back online; both windows converge on one merged note.
  63  |     await ben.page.getByTestId('chaos-offline').click();
  64  |     await expect(badge(ben.page)).toHaveAttribute('data-state', 'live');
  65  |     await expect.poll(() => pending(ben.page)).toBe(0);
  66  |     await expect.poll(async () => (await editor(ada.page).innerText()).includes('Ben three.')).toBe(true);
  67  |     await expect
  68  |       .poll(async () => (await editor(ada.page).innerText()) === (await editor(ben.page).innerText()))
  69  |       .toBe(true);
  70  |     const merged = await editor(ben.page).innerText();
  71  |     expect(merged).toContain('Plan for Monday.');
  72  |     expect(merged).toContain('Ada added a second line.');
  73  |     expect(merged).not.toContain('Temporary text.');
  74  |     expect(merged).toContain('Ben one. Ben two. Ben three.');
  75  |
  76  |     await ada.ctx.close();
  77  |     await ben.ctx.close();
  78  |   });
  79  |
  80  |   test('A2-1: offline edit survives closing the tab, then reaches the server', async ({ browser }) => {
  81  |     const w = await signIn(browser, 'Cleo');
  82  |     await w.page.getByRole('button', { name: 'New note' }).click();
  83  |     await expect(editor(w.page)).toBeVisible();
  84  |     const url = w.page.url();
  85  |     await expect(badge(w.page)).toHaveAttribute('data-state', 'live');
  86  |
  87  |     await w.page.getByTestId('chaos-offline').click();
  88  |     await editor(w.page).click();
  89  |     await w.page.keyboard.type('written with no signal');
  90  |     await w.page.waitForTimeout(300); // past the 50 ms batch window: the edit is on disk
  91  |     await w.page.close();
  92  |
  93  |     const again = await w.ctx.newPage();
  94  |     await again.goto(url);
  95  |     await expect(editor(again)).toContainText('written with no signal');
  96  |     // The offline flag lived in the closed tab's sessionStorage, so this tab reconnects by itself.
  97  |     await expect(badge(again)).toHaveAttribute('data-state', 'live');
  98  |     await expect.poll(() => pending(again)).toBe(0);
  99  |
  100 |     const other = await signIn(browser, 'Dev');
  101 |     await other.page.goto(url);
  102 |     await expect(editor(other.page)).toContainText('written with no signal');
  103 |     await w.ctx.close();
  104 |     await other.ctx.close();
  105 |   });
  106 | });
  107 |
  108 | test.describe('A2-3 multi-tab', () => {
  109 |   test('three tabs share one connection leader; closing it hands over without losing edits', async ({
  110 |     browser,
  111 |   }) => {
  112 |     const ctx = await browser.newContext();
  113 |     const first = await ctx.newPage();
  114 |     await first.goto('/');
  115 |     await first.getByLabel('Your name').fill('Tabby');
  116 |     await first.getByRole('button', { name: 'Start' }).click();
  117 |     await first.getByRole('button', { name: 'New note' }).click();
  118 |     await expect(editor(first)).toBeVisible();
  119 |     const url = first.url();
  120 |
  121 |     const pages = [first];
  122 |     for (let i = 0; i < 2; i++) {
  123 |       const p = await ctx.newPage();
  124 |       await p.goto(url);
  125 |       await expect(editor(p)).toBeVisible();
  126 |       pages.push(p);
  127 |     }
  128 |     const leaders = async (ps: Page[]): Promise<number[]> =>
  129 |       Promise.all(
  130 |         ps.map((p) =>
  131 |           p.evaluate(() =>
  132 |             (window as unknown as { __syncra: { status: { isLeader: boolean } } }).__syncra.status.isLeader ? 1 : 0,
  133 |           ),
  134 |         ),
  135 |       );
  136 |     await expect.poll(async () => (await leaders(pages)).reduce((a, b) => a + b, 0)).toBe(1);
  137 |
  138 |     await editor(pages[2] as Page).click();
  139 |     await (pages[2] as Page).keyboard.type('typed in a follower tab');
> 140 |     await expect(editor(pages[0] as Page)).toContainText('typed in a follower tab');
      |                                            ^ Error: expect(locator).toContainText(expected) failed
  141 |     await expect(editor(pages[1] as Page)).toContainText('typed in a follower tab');
  142 |
  143 |     const idx = (await leaders(pages)).indexOf(1);
  144 |     const closedAt = Date.now();
  145 |     await (pages[idx] as Page).close();
  146 |     const survivors = pages.filter((_, i) => i !== idx);
  147 |     await expect.poll(async () => (await leaders(survivors)).reduce((a, b) => a + b, 0)).toBe(1);
  148 |     expect(Date.now() - closedAt).toBeLessThan(3000 + 1000);
  149 |
  150 |     await editor(survivors[0] as Page).click();
  151 |     await (survivors[0] as Page).keyboard.type(' and after failover');
  152 |     await expect(editor(survivors[1] as Page)).toContainText('and after failover');
  153 |     await expect((survivors[1] as Page).getByTestId('sync-badge')).toHaveAttribute('data-state', 'live');
  154 |     await expect.poll(() => pending(survivors[1] as Page)).toBe(0);
  155 |
  156 |     const check = await signIn(browser, 'Checker');
  157 |     await check.page.goto(url);
  158 |     await expect(editor(check.page)).toContainText('typed in a follower tab');
  159 |     await expect(editor(check.page)).toContainText('and after failover');
  160 |     await ctx.close();
  161 |     await check.ctx.close();
  162 |   });
  163 | });
  164 |
```

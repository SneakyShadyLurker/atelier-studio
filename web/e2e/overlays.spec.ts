import { expect, test, type Page } from '@playwright/test';

/*
 * The behaviours the dialog/menu scaffolds owe their users. These are pinned
 * HERE rather than in the happy-dom unit suite because happy-dom implements
 * neither the top layer nor light dismiss (`:modal` never matches,
 * `showPopover` is undefined), so it cannot tell a working overlay from a
 * broken one. Keep them implementation-agnostic: they must pass whether focus
 * containment comes from our own trap or from the platform.
 */

const activeId = (page: Page) => page.evaluate(() => document.activeElement?.id ?? '');

test.describe('modal dialog', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/e2e/harness/index.html?case=dialog');
    await page.locator('#background').click();
    await expect(page.locator('#first')).toBeVisible();
  });

  test('moves focus into the dialog on open', async ({ page }) => {
    expect(await activeId(page)).toBe('first');
  });

  test('Tab cycles inside the dialog and never reaches the background', async ({ page }) => {
    const seen: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      await page.keyboard.press('Tab');
      seen.push(await activeId(page));
    }
    // The contract is containment, not an exact cycle: a native modal wraps via
    // the document (so `''` appears for <body>) before returning to the first
    // control, which a JS trap does not. What must never happen is focus
    // landing on anything outside the dialog.
    expect(seen).not.toContain('background');
    expect(seen).not.toContain('background-2');
    expect(seen).toContain('first');
    expect(seen).toContain('middle');
    expect(seen).toContain('last');
  });

  test('Shift+Tab cycles backwards without escaping', async ({ page }) => {
    const seen: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      await page.keyboard.press('Shift+Tab');
      seen.push(await activeId(page));
    }
    expect(seen).not.toContain('background');
    expect(seen).not.toContain('background-2');
  });

  test('the background is not clickable while the dialog is open', async ({ page }) => {
    // Either inert or covered by the backdrop — both are correct, and both mean
    // a click on the background must not reach it.
    const reached = await page.evaluate(() => {
      const bg = document.querySelector<HTMLButtonElement>('#background-2');
      if (!bg) return 'missing';
      const state = { hit: false };
      bg.addEventListener('click', () => { state.hit = true; }, { once: true });
      const box = bg.getBoundingClientRect();
      document.elementFromPoint(box.x + 2, box.y + 2)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return state.hit ? 'reached' : 'blocked';
    });
    expect(reached).toBe('blocked');
  });

  test('Escape closes and returns focus to the opener', async ({ page }) => {
    await page.keyboard.press('Escape');
    await expect(page.locator('#first')).toHaveCount(0);
    await expect.poll(() => activeId(page)).toBe('background');
  });

  test('a click on the backdrop closes', async ({ page }) => {
    await page.mouse.click(4, 4);
    await expect(page.locator('#first')).toHaveCount(0);
  });
});

test.describe('anchored action menu', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/e2e/harness/index.html?case=menu');
    await page.locator('#trigger').click();
    await expect(page.getByRole('menu')).toBeVisible();
  });

  test('opens as a menu and takes focus', async ({ page }) => {
    await expect.poll(async () => page.evaluate(() => {
      const active = document.activeElement;
      return active?.closest('[role="menu"]') !== null;
    })).toBe(true);
  });

  test('Arrow keys roam the items', async ({ page }) => {
    // Menu items carry no ids — track the focused item by its label instead.
    const focusedLabel = () => page.evaluate(() => document.activeElement?.textContent.trim() ?? '');
    const first = await focusedLabel();
    expect(first).not.toBe('');
    await page.keyboard.press('ArrowDown');
    expect(await focusedLabel()).not.toBe(first);
  });

  test('Escape closes and returns focus to the trigger', async ({ page }) => {
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect.poll(() => activeId(page)).toBe('trigger');
  });

  test('Escape then Enter during the exit fade does not fire the focused item', async ({ page }) => {
    // The fade must be running for the race to exist (reduced motion shortens it).
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('role') ?? '')).toBe('menuitem');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.locator('#picked')).toHaveText('none');
  });

  test('a click outside dismisses it', async ({ page }) => {
    // Click by coordinate, not by locator: the menu lays a dismiss surface over
    // the page, so a locator click would (correctly) report the button as
    // covered. A real user's click lands on whatever is topmost — that is the
    // gesture under test.
    await page.mouse.click(4, 4);
    await expect(page.getByRole('menu')).toHaveCount(0);
  });

  test('choosing an item reports the action and closes', async ({ page }) => {
    await page.getByRole('menuitem').first().click();
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.locator('#picked')).not.toHaveText('none');
  });
});

/*
 * R15: closing the Lightbox never leaves focus on <body>. The harness renders
 * under StrictMode like the production entry, which runs layout effects twice
 * on mount: the second run once captured the viewer's own Close button as the
 * opener.
 */
test.describe('lightbox focus restore', () => {
  const opener = (page: Page, batch: string, index = 1) =>
    page.locator(`section[data-batch-id="${batch}"] button[aria-label^="Open image ${String(index)}"]`);
  const focusedLabel = (page: Page) => page.evaluate(() => {
    const active = document.activeElement;
    return active === document.body ? 'body' : active?.getAttribute('aria-label') ?? active?.getAttribute('data-testid') ?? active?.tagName ?? '';
  });

  async function openFrom(page: Page, batch: string, index = 1) {
    const button = opener(page, batch, index);
    await expect(button).toBeVisible();
    await button.focus();
    await button.press('Enter');
    await expect(page.getByRole('button', { name: 'Close lightbox' })).toBeFocused();
  }

  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    for (const mechanism of ['Escape', 'Close'] as const) {
      test(`${mechanism} returns focus to the opening tile at ${String(viewport.width)}px`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto('/e2e/harness/index.html?case=feed-lightbox&strict=1');
        await openFrom(page, 'batch-105');
        const dialog = page.getByRole('dialog');
        if (mechanism === 'Escape') {
          // The first Escape may only dismiss the Close button's tooltip.
          await page.keyboard.press('Escape');
          if (await dialog.count()) await page.keyboard.press('Escape');
        } else {
          await page.getByRole('button', { name: 'Close lightbox' }).click();
        }
        await expect(dialog).toHaveCount(0);
        await page.waitForTimeout(600);
        await expect(opener(page, 'batch-105')).toBeFocused();
      });
    }
  }

  test('an opener removed while open hands focus to its neighbouring tile', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?case=feed-lightbox&strict=1');
    await openFrom(page, 'batch-104');
    await page.evaluate(() => { window.__harnessFeed?.removeTile('tile-104'); });
    await expect(opener(page, 'batch-104')).toHaveCount(1);
    await page.getByRole('button', { name: 'Close lightbox' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.waitForTimeout(600);
    // The batch's remaining tile (now image 1 of 1).
    await expect(opener(page, 'batch-104')).toBeFocused();
  });

  test('removing the whole opening batch hands focus to a neighbouring row', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?case=feed-lightbox&strict=1');
    await openFrom(page, 'batch-104');
    await page.evaluate(() => { window.__harnessFeed?.removeBatch('batch-104'); });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.waitForTimeout(600);
    expect(await focusedLabel(page)).not.toBe('body');
    const inRow = await page.evaluate(() => document.activeElement?.closest('[data-batch-id]')?.getAttribute('data-batch-id') ?? null);
    expect(inRow).toBe('batch-105');
  });

  test('archiving from the Lightbox hands focus on, down to the last tile of a batch', async ({ page }) => {
    await page.goto('/e2e/studio/index.html?writable=1&writeDelay=50');
    const batch = page.locator('section[data-batch-id="studio-batch-4"]');
    const first = batch.getByRole('button', { name: /^Open image 1/ });
    await expect(first).toBeVisible();
    await first.focus();
    await first.press('Enter');
    // Archiving one of two tiles closes the viewer; the opener left with it,
    // so focus lands on the batch's remaining tile.
    await page.getByRole('button', { name: 'Archive expanded image' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(batch.locator('[data-feed-tile]')).toHaveCount(1);
    await expect(batch.getByRole('button', { name: /^Open image 1/ })).toBeFocused();
    // The last tile takes the batch with it: the only batch in Unsorted, so
    // focus falls back to the feed scroller, never <body>.
    await batch.getByRole('button', { name: /^Open image 1/ }).press('Enter');
    await page.getByRole('button', { name: 'Archive expanded image' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(batch).toHaveCount(0);
    await page.waitForTimeout(600);
    expect(await focusedLabel(page)).toBe('canvas-scroller');
  });
});

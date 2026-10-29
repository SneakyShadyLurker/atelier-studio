import { expect, test, type Page } from '@playwright/test';

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`archive at ${viewport.width}px`, () => {
    test.use({ viewport, hasTouch: viewport.width < 768, isMobile: viewport.width < 768 });

    test('keeps the header visible while scrolling to the last archived item', async ({ page }, testInfo) => {
      await page.goto('/e2e/harness/archive.html');
      const header = page.locator('header');
      const emptyButton = page.getByRole('button', { name: 'Empty Archive' });
      const grid = page.locator('[data-virtualized="archive"]');
      const scroller = grid.locator('..');
      await expect(page.getByText('ARCHIVE · 80 ITEMS')).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const headerBefore = await header.boundingBox();
      const buttonBefore = await emptyButton.boundingBox();
      expect(headerBefore).not.toBeNull();
      expect(buttonBefore).not.toBeNull();

      await scroller.hover();
      await page.mouse.wheel(0, 700);
      await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
      await expect(header).toBeInViewport();
      await expect(emptyButton).toBeInViewport();
      expect(await header.boundingBox()).toEqual(headerBefore);
      expect(await emptyButton.boundingBox()).toEqual(buttonBefore);

      await expect(async () => {
        await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; });
        await expect(page.getByRole('button', { name: 'Open archived image: Archive fixture 80', exact: true })).toBeInViewport();
        await expect(page.getByText('END · 80 ARCHIVED')).toBeInViewport();
      }).toPass();
      expect(await header.boundingBox()).toEqual(headerBefore);
      expect(await emptyButton.boundingBox()).toEqual(buttonBefore);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      expect(await page.getByRole('button', { name: /Open archived image:/ }).count()).toBeLessThan(80);
      await page.screenshot({ path: testInfo.outputPath('archive-scrolled.png') });
    });
  });
}

// Offline: the harness scripts each tile's first action to reject and the
// retry to resolve, so motion, rollback, retry and success run in Chromium.
test.describe('archive failed actions', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  const actions = {
    restore: async (page: Page) => {
      await page.getByRole('button', { name: 'Restore', exact: true }).click();
    },
    delete: async (page: Page) => {
      await page.getByRole('button', { name: 'Delete permanently', exact: true }).click();
      await page.getByRole('dialog', { name: 'Delete permanently?' }).getByRole('button', { name: 'Delete', exact: true }).click();
    },
  } as const;

  for (const kind of ['restore', 'delete'] as const) {
    // 0 ms rejects while the 240 ms exit still plays; 900 ms rejects after it.
    for (const delayMs of [0, 900]) {
      test(`${kind} rejected after ${delayMs} ms brings the tile back, and the retry keeps it gone`, async ({ page }) => {
        await page.goto(`/e2e/harness/archive.html?count=1&failFirst=${delayMs}`);
        const frame = page.getByRole('button', { name: 'Open archived image: Archive fixture 1', exact: true });
        const body = page.locator('body');
        await expect(frame).toBeVisible();

        await actions[kind](page);
        if (delayMs > 0) await expect(frame).toHaveCount(0);
        await expect(body).toHaveAttribute('data-archive-settled', `${kind}:archive-0:rejected`);
        await expect(frame).toBeVisible();
        // Outlast the exit timer the rejection had to cancel.
        await page.waitForTimeout(400);
        await expect(frame).toBeVisible();

        await actions[kind](page);
        await expect(frame).toHaveCount(0);
        await expect(body).toHaveAttribute(
          'data-archive-settled',
          `${kind}:archive-0:rejected,${kind}:archive-0:resolved`,
        );
        await expect(frame).toHaveCount(0);
      });
    }
  }
});

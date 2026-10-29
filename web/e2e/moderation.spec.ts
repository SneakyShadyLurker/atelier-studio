import { expect, test } from '@playwright/test';

for (const viewport of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 820, height: 1180 },
  { name: 'iphone', width: 390, height: 844 },
  { name: 'small-phone', width: 320, height: 568 },
  { name: 'phone-landscape', width: 844, height: 390 },
]) {
  test.describe(viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });
    test('explains blocks and unavailability, contains focus, preserves input and fits the viewport', async ({ page }, testInfo) => {
      await page.goto('/e2e/harness/index.html?case=moderation');
      const opener = page.getByRole('button', { name: 'Preview nudity block' });
      await opener.click();
      const dialog = page.getByRole('dialog', { name: 'Request stopped' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('heading', { name: 'Explicit nudity', exact: true })).toBeVisible();
      await expect(dialog.getByText(/This restriction applies to adults too/)).toBeVisible();
      await expect(dialog.getByText('Not sent to GPT-6.1 Sol')).toBeVisible();
      await expect(dialog.getByText(/minor|graphic violence/i)).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath('moderation.png'), animations: 'disabled' });
      // Containment contract (as in overlays.spec): the native modal may wrap
      // through the document (<body>), but focus never lands outside the dialog.
      for (let i = 0; i < 4; i += 1) {
        await page.keyboard.press('Tab');
        expect(await page.evaluate(() => (
          document.activeElement === document.body
          || document.querySelector('dialog')?.contains(document.activeElement) === true
        ))).toBe(true);
      }
      const card = page.locator('[data-moderation-notice]');
      const box = await card.boundingBox();
      expect(box).not.toBeNull();
      if (!box) throw new Error('missing notice');
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
      expect(await card.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      const back = dialog.getByRole('button', { name: 'Back to my input' });
      await back.scrollIntoViewIfNeeded();
      expect((await back.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      await back.click();
      await expect(dialog).not.toBeVisible();
      await expect(opener).toBeFocused();
      await expect(page.getByLabel('Your brief')).toHaveValue('My original creative brief');

      await page.getByRole('button', { name: 'Preview age block' }).click();
      await expect(dialog.getByRole('heading', { name: 'Sexual content & age', exact: true })).toBeVisible();
      await expect(dialog.getByText(/someone whose adulthood is unclear/)).toBeVisible();
      await expect(dialog.getByText(/nudity|graphic violence/i)).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible();

      await page.getByRole('button', { name: 'Preview all reasons' }).click();
      for (const name of ['Explicit nudity', 'Sexual content & age', 'Graphic violence']) {
        const heading = dialog.getByRole('heading', { name, exact: true });
        await heading.scrollIntoViewIfNeeded();
        await expect(heading).toBeVisible();
      }
      expect(await card.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      await back.scrollIntoViewIfNeeded();
      const backBox = await back.boundingBox();
      expect(backBox && backBox.y >= 0 && backBox.y + backBox.height <= viewport.height + 1).toBe(true);
      await page.screenshot({ path: testInfo.outputPath('moderation-all.png'), animations: 'disabled' });
      await back.click();
      await expect(dialog).not.toBeVisible();

      await page.getByRole('button', { name: 'Preview unavailable check' }).click();
      const unavailable = page.getByRole('dialog', { name: 'Content check unavailable' });
      await expect(unavailable.getByText('No classification made')).toBeVisible();
      await expect(unavailable.getByText(/not a content rejection/)).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(unavailable).not.toBeVisible();

      await page.getByRole('button', { name: 'Details', exact: true }).click();
      await expect(page.getByRole('dialog').getByText('Graphic violence', { exact: true })).toBeVisible();
      await expect(page.getByRole('dialog').getByText('Not sent to GPT Image')).toBeVisible();
    });
  });
}

test('dark mode and reduced motion preserve the content and dismissal', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.goto('/e2e/harness/index.html?case=moderation');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.getByRole('button', { name: 'Preview all reasons' }).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'Explicit nudity', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close content check' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
});

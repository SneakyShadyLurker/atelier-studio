import { expect, test } from '@playwright/test';

test.describe('generated-image edit actions', () => {
  test('desktop hover reveals Edit and the fullscreen viewer exposes the same action', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/e2e/harness/index.html?case=edit');

    const tile = page.getByRole('button', { name: 'Open image 1' });
    const edit = page.getByRole('button', { name: 'Edit image 1' });
    const overlayOpacity = () => edit.evaluate((button) => {
      const overlay = button.parentElement?.parentElement?.parentElement;
      return overlay ? getComputedStyle(overlay).opacity : 'missing';
    });
    await expect.poll(overlayOpacity).toBe('0');
    await tile.hover();
    await expect.poll(overlayOpacity).toBe('1');

    await tile.click();
    await expect(page.getByRole('button', { name: 'Edit from this image' })).toBeVisible();
  });
});

test.describe('generated-image edit action on touch', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('phone layout keeps the tile Edit action reachable without hover', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?case=edit');

    await expect(page.getByRole('button', { name: 'Edit image 1' })).toBeVisible();
  });
});

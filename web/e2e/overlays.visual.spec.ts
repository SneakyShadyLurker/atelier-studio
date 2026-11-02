import { expect, test } from '@playwright/test';

/*
 * Pixel baselines for the overlay scaffolds. The design contract is
 * pixel-faithful to docs/handoff, and the behaviour specs cannot see layout —
 * so any refactor that changes the overlay substrate (e.g. moving the modal
 * onto <dialog> and the top layer) has to prove it renders identically.
 *
 * Baselines are captured from a real Chromium; regenerate deliberately with
 * `playwright test --update-snapshots` and eyeball the diff before accepting.
 */

test('the modal dialog renders unchanged', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?case=dialog');
  await page.locator('#background').click();
  await expect(page.locator('#first')).toBeVisible();
  // Entrance animation settles before the shot.
  await page.waitForTimeout(400);
  await expect(page).toHaveScreenshot('dialog.png', { animations: 'disabled' });
});

test('the anchored action menu preserves its surface and mirrors at the edge', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?case=menu');
  await page.locator('#trigger').click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.waitForTimeout(400);
  await expect(page).toHaveScreenshot('menu.png', { animations: 'disabled' });
});

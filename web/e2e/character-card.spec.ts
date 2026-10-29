import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

/*
 * The character-card dialog's kind picker: native radios dressed as options.
 * Real layout is the point here: the three options must sit inside the dialog
 * at desktop and phone widths, and the radios must keep the platform's
 * arrow-key selection and single tab stop.
 */

const open = async (page: Page) => {
  await page.goto('/e2e/harness/index.html?case=character-card');
  await expect(page.getByRole('dialog', { name: 'Create a character card' })).toBeVisible();
};

async function expectOptionsInsideDialog(page: Page) {
  const dialog = await page.getByRole('dialog').boundingBox();
  expect(dialog).not.toBeNull();
  for (const name of ['Single subject', 'Multiple subjects', 'Scenario']) {
    const box = await page.getByRole('radio', { name: new RegExp(name) }).locator('xpath=..').boundingBox();
    expect(box, name).not.toBeNull();
    if (!dialog || !box) continue;
    expect(box.x, name).toBeGreaterThanOrEqual(dialog.x);
    expect(box.x + box.width, name).toBeLessThanOrEqual(dialog.x + dialog.width);
  }
}

test.describe('character card kind picker', () => {
  test('arrow keys move the selection and the submit carries the kind', async ({ page }) => {
    await open(page);
    await expect(page.getByRole('radio', { name: /Single subject/ })).toBeChecked();
    await page.getByRole('radio', { name: /Single subject/ }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('radio', { name: /Multiple subjects/ })).toBeChecked();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('radio', { name: /Scenario/ })).toBeChecked();
    await expect(page.getByLabel('Direction for the character card')).toHaveAttribute('placeholder', /port city/);
    await page.getByRole('button', { name: 'Create card' }).click();
    await expect(page.locator('#card-submitted')).toHaveText('scenario:');
  });

  test('the options fit inside the dialog on desktop', async ({ page }) => {
    await open(page);
    await expectOptionsInsideDialog(page);
  });

  test.describe('phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });

    test('the options fit inside the sheet and a tap selects one', async ({ page }) => {
      await open(page);
      await expectOptionsInsideDialog(page);
      await page.getByText('Two or three people').tap();
      await expect(page.getByRole('radio', { name: /Multiple subjects/ })).toBeChecked();
    });
  });
});

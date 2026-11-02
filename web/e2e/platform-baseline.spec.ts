import { expect, test } from '@playwright/test';

// Guards the premise of the dialog/popover migrations: the real browser gives
// us the top layer and light dismiss that happy-dom cannot. If this ever fails
// the migrated components have lost their platform substrate.
test('the browser implements modal dialogs and the popover API', async ({ page }) => {
  await page.setContent('<dialog id="d"><button id="inside">ok</button></dialog>');
  await page.evaluate(() => {
    const dialog = document.querySelector<HTMLDialogElement>('#d');
    dialog?.showModal();
  });
  expect(await page.evaluate(() => document.querySelector('#d')?.matches(':modal') ?? false)).toBe(true);
  expect(await page.evaluate(() => typeof document.createElement('div').showPopover)).toBe('function');
});

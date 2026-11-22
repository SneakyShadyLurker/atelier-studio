import type { Locator, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

/*
 * Variable-list draft review (spec list-draft-review R4 to R6): Draft List on
 * a populated list opens a dialog with Add options and Rework; an answer with
 * placed changes replaces the option table with a review of rows in the same
 * body zone. The harness case `library-list-draft` answers from the request's
 * own options: a rework edits a value, reweights a row, removes the last row,
 * adds two and leaves one suggestion unplaced. Layout, focus, the top layer
 * and each engine's scrolling are what happy-dom cannot see.
 */

const EDITOR = 'Edit variable list scarf';

function editorOf(page: Page): Locator {
  return page.getByRole('form', { name: EDITOR });
}

async function openLibrary(page: Page, query = ''): Promise<void> {
  await page.goto(`/e2e/harness/index.html?case=library-list-draft${query}`);
  await expect(editorOf(page).getByRole('textbox', { name: 'Option 1: a red wool scarf' })).toBeVisible();
}

async function submitRework(page: Page): Promise<Locator> {
  const dialog = page.getByRole('dialog', { name: /the list$/ });
  await expect(dialog).toBeVisible();
  // The chips are visually hidden radios inside their labels.
  await dialog.getByText('Rework', { exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'Rework the list' })).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Change instructions' }).fill('Name the fabrics and drop near-duplicates.');
  await dialog.getByRole('button', { name: 'Rework list' }).click();
  return dialog;
}

/** Opens the dialog from the desktop head and submits a rework; resolves once the review shows. */
async function startReview(page: Page, query = ''): Promise<Locator> {
  await openLibrary(page, query);
  await editorOf(page).locator('[data-zone="head"]').getByRole('button', { name: 'Draft List' }).click();
  const dialog = await submitRework(page);
  await expect(dialog).toHaveCount(0);
  const sheet = editorOf(page).locator('[data-zone="body"]').getByRole('group', { name: 'Options, under review' });
  await expect(sheet).toBeVisible();
  return sheet;
}

function decisionControls(sheet: Locator): Locator {
  return sheet.getByRole('button', { name: /^(Reject|Accept)$/ });
}

async function box(locator: Locator) {
  const rect = await locator.boundingBox();
  if (!rect) throw new Error('element has no box');
  return rect;
}

function centreY(rect: { y: number; height: number }): number {
  return rect.y + rect.height / 2;
}

async function optionValues(editor: Locator): Promise<string[]> {
  return editor.locator('[data-zone="body"]').getByRole('textbox', { name: /^Option \d+/ }).evaluateAll(
    (inputs) => inputs.map((input) => (input as HTMLInputElement).value),
  );
}

test.describe('desktop list draft review', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('the populated dialog offers Add options and Rework, with the model fields', async ({ page }) => {
    await openLibrary(page);
    await editorOf(page).getByRole('button', { name: 'Draft List' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add to the list' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('radio', { name: 'Add options' })).toBeChecked();
    await expect(dialog.getByRole('textbox', { name: 'What to add' })).toBeFocused();
    await expect(dialog.getByLabel('Model')).toBeVisible();
    await expect(editorOf(page).getByRole('button', { name: 'Drafting…' })).toBeVisible();
    await dialog.getByRole('textbox', { name: 'What to add' }).fill('warmer ones');
    await dialog.getByText('Rework', { exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Rework the list' }).getByRole('textbox', { name: 'Change instructions' })).toHaveValue('warmer ones');
    // Escape closes an idle dialog.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(editorOf(page).getByRole('button', { name: 'Draft List' })).toBeVisible();
  });

  test('a blank Add options opens a review of the additions', async ({ page }) => {
    await openLibrary(page);
    await editorOf(page).getByRole('button', { name: 'Draft List' }).click();
    await page.getByRole('dialog', { name: 'Add to the list' }).getByRole('button', { name: 'Add options' }).click();
    const sheet = editorOf(page).getByRole('group', { name: 'Options, under review' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Show 15 unchanged options' })).toBeVisible();
    await expect(sheet.getByRole('group', { name: 'Change 1 of 2' })).toBeFocused();
    await expect(editorOf(page).getByRole('button', { name: 'Apply 2 changes' })).toBeVisible();
  });

  test('a rework answer opens the review in place of the option table', async ({ page }) => {
    const sheet = await startReview(page);
    const editor = editorOf(page);
    const head = editor.locator('[data-zone="head"]');

    await expect(editor.getByRole('textbox', { name: /^Option \d+/ })).toHaveCount(0);
    await expect(sheet.getByRole('group', { name: 'Change 1 of 5' })).toBeFocused();
    await expect(head.getByRole('button', { name: 'Rework again' })).toBeVisible();
    await expect(head.getByRole('button', { name: 'Discard' })).toBeVisible();
    await expect(head.getByRole('button', { name: 'Apply 5 changes' })).toBeVisible();
    await expect(head.getByRole('button', { name: 'Save list' })).toHaveCount(0);
    await expect(editor.getByRole('button', { name: '+ Add option' })).toBeDisabled();
    await expect(sheet.getByRole('group', { name: 'Change 2 of 5' })).toContainText('weight 1 to 5');
    await expect(sheet.getByRole('button', { name: 'Show 12 unchanged options' })).toBeVisible();
    expect(await sheet.locator('ins').count()).toBeGreaterThan(0);
    expect(await sheet.locator('del').count()).toBeGreaterThan(0);
  });

  test('a decision flips in place: focus stays, the count follows, no row moves', async ({ page }) => {
    const sheet = await startReview(page);
    const head = editorOf(page).locator('[data-zone="head"]');
    const rows = [1, 2, 3, 4, 5].map((n) => sheet.getByRole('group', { name: `Change ${String(n)} of 5` }));
    const control = decisionControls(sheet).nth(0);
    await expect(control).toHaveAccessibleDescription(/finer fabric/);
    const before = await Promise.all(rows.map(box));
    await control.focus();
    await page.keyboard.press('Enter');
    await expect(control).toHaveAccessibleName('Accept');
    await expect(control).toBeFocused();
    await expect(head.getByRole('button', { name: 'Apply 4 changes' })).toBeVisible();
    await expect(rows[0]?.locator('del, ins') ?? sheet).toHaveCount(0);
    const after = await Promise.all(rows.map(box));
    for (const [index, rect] of after.entries()) {
      const was = before[index];
      if (!was) throw new Error('missing box');
      expect(Math.abs(rect.y - was.y)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(rect.height - was.height)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(rect.width - was.width)).toBeLessThanOrEqual(0.5);
    }
  });

  test('the first rejection brings Accept all in without moving the head or the sheet, at any width', async ({ page }) => {
    const sheet = await startReview(page);
    const body = editorOf(page).locator('[data-zone="body"]');
    const firstDecision = decisionControls(sheet).first();
    for (let width = 1280; width >= 780; width -= 20) {
      await page.setViewportSize({ width, height: 800 });
      const before = await box(sheet);
      const rejectAll = await box(body.getByRole('button', { name: 'Reject all' }));
      await firstDecision.click();
      await expect(body.getByRole('button', { name: 'Accept all' })).toBeVisible();
      const after = await box(sheet);
      expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(0.5);
      const rejectAllAfter = await box(body.getByRole('button', { name: 'Reject all' }));
      expect(Math.abs(rejectAllAfter.x - rejectAll.x)).toBeLessThanOrEqual(0.5);
      await firstDecision.click();
      await expect(body.getByRole('button', { name: 'Accept all' })).toHaveCount(0);
    }
  });

  test('rejecting every change never changes the sheet height, at any width', async ({ page }) => {
    const sheet = await startReview(page);
    const body = editorOf(page).locator('[data-zone="body"]');
    for (let width = 1280; width >= 780; width -= 100) {
      await page.setViewportSize({ width, height: 800 });
      const before = await sheet.evaluate((el) => el.scrollHeight);
      await body.getByRole('button', { name: 'Reject all' }).click();
      await expect(body.getByRole('button', { name: 'Reject all' })).toHaveCount(0);
      expect(await sheet.evaluate((el) => el.scrollHeight)).toBe(before);
      await body.getByRole('button', { name: 'Accept all' }).click();
      await expect(body.getByRole('button', { name: 'Accept all' })).toHaveCount(0);
    }
  });

  test('J, K, A and R move and decide; Cmd/Ctrl+Enter applies', async ({ page }) => {
    const sheet = await startReview(page);
    const editor = editorOf(page);
    await page.keyboard.press('j');
    await expect(editor.getByText('2 / 5', { exact: true })).toBeVisible();
    await expect(sheet.getByRole('group', { name: 'Change 2 of 5' })).toBeFocused();
    await page.keyboard.press('r');
    await expect(editor.getByRole('button', { name: 'Apply 4 changes' })).toBeVisible();
    await expect(editor.getByText('3 / 5', { exact: true })).toBeVisible();
    await page.keyboard.press('k');
    await page.keyboard.press('a');
    await expect(editor.getByRole('button', { name: 'Apply 5 changes' })).toBeVisible();
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(sheet).toHaveCount(0);
    await expect(page.getByText('Applied 5 changes', { exact: true }).first()).toBeVisible();
  });

  test('Apply writes the accepted changes without saving, and Undo reopens the review', async ({ page }) => {
    const sheet = await startReview(page);
    const editor = editorOf(page);
    const saves: string[] = [];
    page.on('request', (request) => { if (request.method() !== 'GET' && request.url().includes('/api/prompts/lists/list-scarf')) saves.push(request.url()); });
    // Reject the reweight (change 2).
    await decisionControls(sheet).nth(1).click();
    await editor.getByRole('button', { name: 'Apply 4 changes' }).click();

    const values = await optionValues(editor);
    expect(values[0]).toBe('a red silk scarf');
    expect(values).not.toContain('a pink scarf');
    expect(values.slice(-2)).toEqual(['a green scarf', 'a scarf with a tassel']);
    expect(values).toHaveLength(16);
    await expect(editor.getByRole('spinbutton').nth(1)).toHaveValue('1');
    await expect(editor.getByRole('spinbutton').last()).toHaveValue('3');
    await expect(editor.getByRole('button', { name: 'Save list' })).toBeEnabled();
    expect(saves).toEqual([]);

    await expect(page.getByText('Applied 4 changes', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(sheet).toBeVisible();
    await expect(decisionControls(sheet).nth(1)).toHaveAccessibleName('Accept');
    await expect(editor.getByRole('button', { name: 'Apply 4 changes' })).toBeVisible();
  });

  test('Discard leaves the rows as they were and Undo reopens the review', async ({ page }) => {
    await startReview(page);
    const editor = editorOf(page);
    await editor.getByRole('button', { name: 'Discard' }).click();
    const values = await optionValues(editor);
    expect(values[0]).toBe('a red wool scarf');
    expect(values).toHaveLength(15);
    await expect(page.getByText('Changes discarded', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(editor.getByRole('group', { name: 'Options, under review' })).toBeVisible();
    await expect(editor.getByRole('button', { name: 'Apply 5 changes' })).toBeVisible();
  });

  test('Rework again reopens the dialog on its instructions; Cmd/Ctrl+Enter there does not apply the review', async ({ page }) => {
    await startReview(page);
    const editor = editorOf(page);
    await editor.getByRole('button', { name: 'Rework again' }).click();
    const dialog = page.getByRole('dialog', { name: 'Rework the list' });
    const field = dialog.getByRole('textbox', { name: 'Change instructions' });
    await expect(field).toHaveValue('Name the fabrics and drop near-duplicates.');
    await expect(field).toBeFocused();
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(dialog).toHaveCount(0);
    await expect(editor.getByRole('group', { name: 'Options, under review' })).toBeVisible();
    await expect(page.getByText(/^Applied \d+ changes?$/)).toHaveCount(0);
  });

  test('suggestions that could not be placed list their cause', async ({ page }) => {
    await startReview(page);
    const editor = editorOf(page);
    const toggle = editor.getByRole('button', { name: '1 suggestion could not be placed' });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(editor.getByText('The option it names is not in the list')).toBeVisible();
    await expect(editor.getByText('a black scarf')).toBeVisible();
  });

  test('an answer with nothing to change keeps the dialog open with its note', async ({ page }) => {
    await openLibrary(page, '&answer=none');
    await editorOf(page).getByRole('button', { name: 'Draft List' }).click();
    const dialog = await submitRework(page);
    await expect(dialog.getByRole('status').filter({ hasText: 'The model found nothing to change.' })).toBeVisible();
    await expect(dialog.getByRole('textbox', { name: 'Change instructions' })).toHaveValue('Name the fabrics and drop near-duplicates.');
    await expect(editorOf(page).getByRole('group', { name: 'Options, under review' })).toHaveCount(0);
  });

  test('a fold shows its unchanged options and goes', async ({ page }) => {
    const sheet = await startReview(page);
    const fold = sheet.getByRole('button', { name: 'Show 12 unchanged options' });
    await expect(sheet.getByText('a tartan scarf')).toHaveCount(0);
    await fold.click();
    await expect(fold).toHaveCount(0);
    await expect(sheet.getByText('a tartan scarf')).toBeVisible();
  });

  test('the Lists pane offers Draft New List beside New', async ({ page }) => {
    await openLibrary(page);
    const pane = page.getByRole('complementary', { name: 'Lists' });
    const [newBox, draftBox] = await Promise.all([box(pane.getByRole('button', { name: 'New', exact: true })), box(pane.getByRole('button', { name: 'Draft New List' }))]);
    expect(Math.abs(centreY(newBox) - centreY(draftBox))).toBeLessThanOrEqual(2);
    await pane.getByRole('button', { name: 'Draft New List' }).click();
    await expect(page.getByRole('dialog', { name: 'Describe the new list' })).toBeVisible();
  });
});

test.describe('phone list draft review', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });

  async function startPhoneReview(page: Page): Promise<Locator> {
    await openLibrary(page);
    const head = editorOf(page).locator('[data-zone="head"]');
    await head.getByRole('button', { name: 'More list actions' }).click();
    await page.getByRole('menu', { name: 'Variable list actions' }).getByRole('menuitem', { name: 'Draft List' }).click();
    const dialog = await submitRework(page);
    await expect(dialog).toHaveCount(0);
    const sheet = editorOf(page).getByRole('group', { name: 'Options, under review' });
    await expect(sheet).toBeVisible();
    return sheet;
  }

  test('the head is one row (name, Apply, More) and More holds Rework again and Discard', async ({ page }) => {
    await startPhoneReview(page);
    const head = editorOf(page).locator('[data-zone="head"]');
    const name = head.getByRole('textbox', { name: 'Variable list name' });
    const apply = head.getByRole('button', { name: 'Apply 5 changes' });
    const more = head.getByRole('button', { name: 'More list actions' });
    await expect(head.getByRole('button', { name: 'Discard' })).toHaveCount(0);
    await expect(head.getByRole('button', { name: 'Rework again' })).toHaveCount(0);

    const [nameBox, applyBox, moreBox, headBox] = await Promise.all([box(name), box(apply), box(more), box(head)]);
    expect(Math.abs(centreY(applyBox) - centreY(moreBox))).toBeLessThanOrEqual(2);
    expect(applyBox.y).toBeLessThan(nameBox.y + nameBox.height);
    expect(applyBox.x).toBeGreaterThan(nameBox.x);
    expect(moreBox.x + moreBox.width).toBeLessThanOrEqual(headBox.x + headBox.width + 0.5);

    await more.click();
    const menu = page.getByRole('menu', { name: 'Variable list actions' });
    await expect(menu.getByRole('menuitem', { name: 'Rework again' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Discard' })).toBeVisible();
    await menu.getByRole('menuitem', { name: 'Discard' }).click();
    await expect(editorOf(page).getByRole('group', { name: 'Options, under review' })).toHaveCount(0);
  });

  test('the review fits the width and its decisions meet the touch floor', async ({ page }) => {
    const sheet = await startPhoneReview(page);
    expect(await sheet.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    const controls = decisionControls(sheet);
    await expect(controls).toHaveCount(5);
    for (let index = 0; index < 5; index += 1) {
      const control = controls.nth(index);
      await control.scrollIntoViewIfNeeded();
      expect((await box(control)).height, `change ${String(index + 1)} control height`).toBeGreaterThanOrEqual(44);
    }
  });
});

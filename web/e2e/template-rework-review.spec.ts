import type { Locator, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

/*
 * Template rework review (spec template-rework-review R4 to R8, R11): Draft
 * Template on a filled body opens the rework dialog; its answer replaces the
 * body field with a tracked-changes review in the same zone. The harness case
 * `library-rework` answers the draft request from the body it was sent, with
 * four placed changes (a word swap, a phrase turned into a token, an
 * insertion, a rewritten closing sentence that reads as a block) and one
 * suggestion that could not be placed. Layout, focus and the engines' own
 * scrolling are what happy-dom cannot see.
 */

const OLD_CLOSE = 'The overall feeling should be calm and slightly nostalgic';
const NEW_CLOSE = 'Let the frame stay hard and honest';

function editorOf(page: Page): Locator {
  return page.getByRole('form', { name: /template/i });
}

async function openLibrary(page: Page, query = ''): Promise<void> {
  await page.goto(`/e2e/harness/index.html?case=library-rework${query}`);
  await expect(editorOf(page).getByRole('textbox', { name: 'Body' })).toBeVisible();
}

async function submitInstructions(page: Page): Promise<Locator> {
  const dialog = page.getByRole('dialog', { name: 'Rework the template' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Change instructions' }).fill('Make the light moodier and move the outfit into a list.');
  await dialog.getByRole('button', { name: 'Rework template' }).click();
  return dialog;
}

/** Opens the dialog from the desktop head and submits; resolves once the review shows. */
async function startReview(page: Page, query = ''): Promise<Locator> {
  await openLibrary(page, query);
  await editorOf(page).locator('[data-zone="head"]').getByRole('button', { name: /Draft Template/ }).click();
  const dialog = await submitInstructions(page);
  await expect(dialog).toHaveCount(0);
  const sheet = editorOf(page).locator('[data-zone="body"]').getByRole('group', { name: 'Body, under review' });
  await expect(sheet).toBeVisible();
  return sheet;
}

/** The Reject/Accept control of every change, in text order. */
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

test.describe('desktop template rework review', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('a rework answer opens the review in place of the body', async ({ page }) => {
    const sheet = await startReview(page);
    const editor = editorOf(page);
    const head = editor.locator('[data-zone="head"]');

    await expect(editor.getByRole('textbox', { name: 'Body' })).toHaveCount(0);
    await expect(sheet.getByRole('group', { name: 'Change 1 of 4' })).toBeFocused();
    await expect(head.getByRole('button', { name: /Rework again/ })).toBeVisible();
    await expect(head.getByRole('button', { name: 'Discard' })).toBeVisible();
    await expect(head.getByRole('button', { name: 'Apply 4 changes' })).toBeVisible();
    await expect(head.getByRole('button', { name: 'Save template' })).toHaveCount(0);
    expect(await sheet.locator('ins').count()).toBeGreaterThan(0);
    expect(await sheet.locator('del').count()).toBeGreaterThan(0);

    const block = sheet.getByRole('group', { name: 'Change 4 of 4' });
    await expect(block.getByText('Removed', { exact: true })).toBeVisible();
    await expect(block.getByText('Proposed', { exact: true })).toBeVisible();
    await expect(block.getByText(NEW_CLOSE, { exact: false })).toBeVisible();
  });

  test('a decision flips in place: focus stays, the count follows, nothing moves', async ({ page }) => {
    const sheet = await startReview(page);
    const head = editorOf(page).locator('[data-zone="head"]');
    const change = sheet.getByRole('group', { name: 'Change 2 of 4' });
    const control = decisionControls(sheet).nth(1);
    await expect(control).toHaveAccessibleDescription(/outfit into a variable list/);

    const before = await box(change);
    // Pressed from the keyboard: WebKit on macOS never focuses a button on a
    // mouse click, so only a keyboard press has focus for the flip to keep.
    await control.focus();
    await page.keyboard.press('Enter');
    await expect(control).toHaveAccessibleName('Accept');
    await expect(control).toBeFocused();
    await expect(head.getByRole('button', { name: 'Apply 3 changes' })).toBeVisible();
    await expect(change.locator('del, ins')).toHaveCount(0);
    const after = await box(change);
    expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(after.width - before.width)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(0.5);

    await editorOf(page).getByRole('button', { name: 'Accept all' }).click();
    await expect(control).toHaveAccessibleName('Reject');
    await expect(head.getByRole('button', { name: 'Apply 4 changes' })).toBeVisible();
  });

  test('rejecting every change never changes the sheet height, at any width', async ({ page }) => {
    const sheet = await startReview(page);
    const tools = editorOf(page).locator('[data-zone="body"]');
    // A reason that ends near its line's edge is where a visible "Rejected"
    // would wrap; sweeping widths moves every note's line ends.
    for (let width = 1280; width >= 780; width -= 50) {
      await page.setViewportSize({ width, height: 800 });
      const before = await sheet.evaluate((el) => el.scrollHeight);
      await tools.getByRole('button', { name: 'Reject all' }).click();
      await expect(tools.getByRole('button', { name: 'Reject all' })).toHaveCount(0);
      expect(await sheet.evaluate((el) => el.scrollHeight)).toBe(before);
      await tools.getByRole('button', { name: 'Accept all' }).click();
      await expect(tools.getByRole('button', { name: 'Accept all' })).toHaveCount(0);
    }
  });

  test('J, K, A and R move and decide; Cmd/Ctrl+Enter applies', async ({ page }) => {
    const sheet = await startReview(page);
    const editor = editorOf(page);
    const head = editor.locator('[data-zone="head"]');

    await page.keyboard.press('j');
    await expect(editor.getByText('2 / 4', { exact: true })).toBeVisible();
    await expect(sheet.getByRole('group', { name: 'Change 2 of 4' })).toBeFocused();
    await page.keyboard.press('r');
    await expect(head.getByRole('button', { name: 'Apply 3 changes' })).toBeVisible();
    await expect(editor.getByText('3 / 4', { exact: true })).toBeVisible();
    await expect(decisionControls(sheet).nth(1)).toHaveAccessibleName('Accept');
    await page.keyboard.press('k');
    await expect(editor.getByText('2 / 4', { exact: true })).toBeVisible();
    await page.keyboard.press('a');
    await expect(head.getByRole('button', { name: 'Apply 4 changes' })).toBeVisible();
    await expect(editor.getByText('3 / 4', { exact: true })).toBeVisible();

    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(editor.getByRole('textbox', { name: 'Body' })).toBeVisible();
    await expect(page.getByText('Applied 4 changes', { exact: true }).first()).toBeVisible();
  });

  test('Apply writes the accepted changes and Undo reopens the review', async ({ page }) => {
    const sheet = await startReview(page);
    const editor = editorOf(page);
    const saves: string[] = [];
    page.on('request', (request) => { if (request.method() !== 'GET' && request.url().includes('/api/prompts/templates/tpl-')) saves.push(request.url()); });
    await decisionControls(sheet).nth(1).click();
    await editor.getByRole('button', { name: 'Apply 3 changes' }).click();

    const body = editor.getByRole('textbox', { name: 'Body' });
    await expect(body).toBeFocused();
    const value = await body.inputValue();
    expect(value).toContain('The light is low and grey');
    // Change 2 was rejected: the original phrase stays, the token does not arrive.
    expect(value).toContain('her plain wool coat');
    expect(value).not.toContain('{{var::outfit}}');
    expect(value).toContain('She leans on a cold railing and waits for the first tram of the day.');
    expect(value).toContain(NEW_CLOSE);
    expect(value).not.toContain(OLD_CLOSE);
    expect(value.endsWith('tired and unbothered.')).toBe(true);
    // Apply never saves (R5.6): the template is still unsaved work.
    await expect(editor.getByRole('button', { name: 'Save template' })).toBeEnabled();
    expect(saves).toEqual([]);

    await expect(page.getByText('Applied 3 changes', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(sheet).toBeVisible();
    await expect(editor.getByRole('textbox', { name: 'Body' })).toHaveCount(0);
    await expect(decisionControls(sheet).nth(1)).toHaveAccessibleName('Accept');
    await expect(editor.getByRole('button', { name: 'Apply 3 changes' })).toBeVisible();
  });

  test('Discard leaves the body as it was and Undo reopens the review', async ({ page }) => {
    await openLibrary(page);
    const editor = editorOf(page);
    const original = await editor.getByRole('textbox', { name: 'Body' }).inputValue();
    await editor.getByRole('button', { name: /Draft Template/ }).click();
    await submitInstructions(page);
    const sheet = editor.getByRole('group', { name: 'Body, under review' });
    await expect(sheet).toBeVisible();

    await editor.getByRole('button', { name: 'Discard' }).click();
    const body = editor.getByRole('textbox', { name: 'Body' });
    await expect(body).toHaveValue(original);
    await expect(page.getByText('Rework discarded', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(sheet).toBeVisible();
    await expect(editor.getByRole('button', { name: 'Apply 4 changes' })).toBeVisible();
  });

  test('suggestions that could not be placed list their cause', async ({ page }) => {
    await startReview(page);
    const editor = editorOf(page);
    const toggle = editor.getByRole('button', { name: '1 suggestion could not be placed' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(editor.getByText('The passage it quotes is not in the template')).toBeVisible();
    await expect(editor.getByText('a black umbrella')).toBeVisible();
  });

  test('a rework with nothing to change keeps the dialog open with its summary', async ({ page }) => {
    await openLibrary(page, '&answer=none');
    const editor = editorOf(page);
    await editor.getByRole('button', { name: /Draft Template/ }).click();
    const dialog = await submitInstructions(page);
    await expect(dialog.getByRole('status').filter({ hasText: 'The template already reads the way you asked.' })).toBeVisible();
    await expect(dialog.getByRole('textbox', { name: 'Change instructions' })).toHaveValue('Make the light moodier and move the outfit into a list.');
    await expect(editor.getByRole('group', { name: 'Body, under review' })).toHaveCount(0);
  });

  test('a fold shows its unchanged words and goes', async ({ page }) => {
    const sheet = await startReview(page);
    const fold = sheet.getByRole('button', { name: /^Show \d+ unchanged words$/ });
    await expect(fold).toHaveCount(1);
    await expect(sheet.getByText(/quiet weight of an early winter morning/)).toHaveCount(0);
    await fold.click();
    await expect(fold).toHaveCount(0);
    await expect(sheet.getByText(/quiet weight of an early winter morning/)).toBeVisible();
  });
});

test.describe('phone template rework review', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });

  async function startPhoneReview(page: Page): Promise<Locator> {
    await openLibrary(page);
    const head = editorOf(page).locator('[data-zone="head"]');
    await head.getByRole('button', { name: 'More template actions' }).click();
    await page.getByRole('menu', { name: 'Template actions' }).getByRole('menuitem', { name: /Draft Template/ }).click();
    const dialog = await submitInstructions(page);
    await expect(dialog).toHaveCount(0);
    const sheet = editorOf(page).getByRole('group', { name: 'Body, under review' });
    await expect(sheet).toBeVisible();
    return sheet;
  }

  test('the head is one row (name, Apply, More) and More holds the rest', async ({ page }) => {
    await startPhoneReview(page);
    const head = editorOf(page).locator('[data-zone="head"]');
    const name = head.getByRole('textbox', { name: 'Template name' });
    const apply = head.getByRole('button', { name: 'Apply 4 changes' });
    const more = head.getByRole('button', { name: 'More template actions' });
    await expect(head.getByRole('button', { name: 'Discard' })).toHaveCount(0);
    await expect(head.getByRole('button', { name: /Rework again/ })).toHaveCount(0);

    const [nameBox, applyBox, moreBox, headBox] = await Promise.all([box(name), box(apply), box(more), box(head)]);
    expect(Math.abs(centreY(applyBox) - centreY(moreBox))).toBeLessThanOrEqual(2);
    expect(applyBox.y).toBeLessThan(nameBox.y + nameBox.height);
    expect(applyBox.x).toBeGreaterThan(nameBox.x);
    expect(moreBox.x + moreBox.width).toBeLessThanOrEqual(headBox.x + headBox.width + 0.5);

    await more.click();
    const menu = page.getByRole('menu', { name: 'Template actions' });
    await expect(menu.getByRole('menuitem', { name: /Rework again/ })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Discard' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Delete template' })).toBeVisible();
  });

  test('the review fits the width and its decisions meet the touch floor', async ({ page }) => {
    const sheet = await startPhoneReview(page);
    expect(await sheet.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    const controls = decisionControls(sheet);
    await expect(controls).toHaveCount(4);
    for (let index = 0; index < 4; index += 1) {
      const control = controls.nth(index);
      await control.scrollIntoViewIfNeeded();
      expect((await box(control)).height, `change ${String(index + 1)} control height`).toBeGreaterThanOrEqual(44);
    }
  });
});

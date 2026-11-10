import { expect, test, type Page } from '@playwright/test';

// R24: the desktop Composer yields the viewport to the feed, even while it
// holds text, and comes back only on intent. R25: a Generate press that the
// browser delivers to the root (hit-testing suspended while a view transition
// prepares) still queues exactly one generation.

const expandButton = (page: Page) => page.getByRole('button', { name: /^Expand composer/ });
const prompt = (page: Page) => page.getByRole('textbox', { name: 'Prompt', exact: true });
const generated = (page: Page) => page.evaluate(() => (window as Window & { __studioGenerated?: number }).__studioGenerated ?? 0);

async function openWithPrompt(page: Page, query: string, text: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/e2e/studio/index.html?${query}`);
  const expand = expandButton(page);
  if (await expand.isVisible()) await expand.click();
  await prompt(page).fill(text);
}

async function feedPoint(page: Page): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId('canvas-scroller').boundingBox();
  if (!box) throw new Error('Missing feed');
  return { x: box.x + box.width / 2, y: box.y + 120 };
}

test('a reader scroll and a press in the feed each minimize a Composer holding text', async ({ page }) => {
  await openWithPrompt(page, 'batches=16', 'a lighthouse at dusk');
  const feed = await feedPoint(page);

  await page.mouse.move(feed.x, feed.y);
  await page.mouse.wheel(0, -400);
  await expect(expandButton(page)).toBeVisible();
  await expect(expandButton(page)).toContainText('a lighthouse at dusk');

  await expandButton(page).click();
  await expect(prompt(page)).toBeVisible();
  await expect(prompt(page)).toHaveValue('a lighthouse at dusk');
  // The view heading is not the feed's content: the draft stays in sight.
  await page.getByTestId('feed').getByRole('heading', { name: 'Unsorted' }).click();
  await expect(prompt(page)).toBeVisible();
  // A press on a batch row (its header, not a control) yields the viewport.
  const row = page.locator('[data-virtualized="canvas"] section[data-batch-id]').last();
  const header = await row.locator('header, [class*="head"]').first().boundingBox();
  if (!header) throw new Error('Missing batch header');
  await page.mouse.click(header.x + 4, header.y + header.height - 2);
  await expect(expandButton(page)).toBeVisible();
  await expect(expandButton(page)).toContainText('a lighthouse at dusk');
});

test('idle while a batch is in flight minimizes after the delay, never while the pointer rests on it', async ({ page }) => {
  test.setTimeout(45_000);
  await openWithPrompt(page, 'generate=1&generateDelay=50', 'a lighthouse at dusk');
  const go = page.getByRole('button', { name: 'Generate', exact: true });
  await go.click();
  await expect.poll(() => generated(page)).toBe(1);

  // The pointer rests on Generate: the Composer stays well past the delay.
  await page.waitForTimeout(8_000);
  await expect(prompt(page)).toBeVisible();

  // Pointer off the Composer: it yields after the idle delay, not before.
  const feed = await feedPoint(page);
  await page.mouse.move(feed.x, feed.y);
  await page.waitForTimeout(4_000);
  await expect(prompt(page)).toBeVisible();
  await expect(expandButton(page)).toBeVisible({ timeout: 6_000 });
  await expect(expandButton(page)).toContainText('a lighthouse at dusk');
});

test('a character typed on the focused collapsed bar expands it and is inserted once', async ({ page }) => {
  await openWithPrompt(page, '', 'a fox');
  await page.getByRole('button', { name: 'Minimize composer' }).click();
  await expect(expandButton(page)).toBeFocused();
  await page.keyboard.press('s');
  await expect(prompt(page)).toBeFocused();
  await expect(prompt(page)).toHaveValue('a foxs');
  await page.keyboard.type(' at dawn');
  await expect(prompt(page)).toHaveValue('a foxs at dawn');
});

test('a click delivered to the root inside Generate queues one generation', async ({ page }) => {
  await openWithPrompt(page, 'generate=1&generateDelay=50', 'a lighthouse at dusk');
  const box = await page.getByRole('button', { name: 'Generate', exact: true }).boundingBox();
  if (!box) throw new Error('Missing Generate');
  await page.evaluate(({ x, y }) => {
    document.documentElement.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  await expect.poll(() => generated(page)).toBe(1);
  await page.waitForTimeout(500);
  expect(await generated(page)).toBe(1);

  // Behind a native modal dialog (which sets no `inert` attribute) the same
  // root-targeted click is a press on the dialog, not on Generate.
  await page.evaluate(({ x, y }) => {
    const dialog = document.createElement('dialog');
    dialog.textContent = 'modal';
    document.body.append(dialog);
    dialog.showModal();
    document.documentElement.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    dialog.close();
    dialog.remove();
  }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  await page.waitForTimeout(500);
  expect(await generated(page)).toBe(1);
});

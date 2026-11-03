import { expect, test, type Page } from '@playwright/test';

// Spamming Generate queues one generation per click. Each accepted press
// enters the feed through a view transition, and a captured element is not
// hit-testable while it runs, so the Composer must stay out of transitions it
// does not own: a press during a batch's entrance has to reach Generate.

const viewTransitionRunning = (page: Page) => page.evaluate(() => document.getAnimations()
  .some((animation) => animation.effect instanceof KeyframeEffect
    && animation.effect.pseudoElement?.startsWith('::view-transition') === true
    && animation.playState === 'running'));

const generated = (page: Page) => page.evaluate(() => (window as Window & { __studioGenerated?: number }).__studioGenerated ?? 0);

const hitAt = (page: Page, point: { x: number; y: number }) => page.evaluate(({ x, y }) => {
  const hit = document.elementFromPoint(x, y);
  return hit?.closest('button')?.textContent.trim() ?? hit?.tagName ?? null;
}, point);

const centre = async (page: Page, name: 'Generate' | 'Prompt') => {
  const locator = name === 'Generate'
    ? page.getByRole('button', { name: 'Generate', exact: true })
    : page.getByRole('textbox', { name: 'Prompt', exact: true });
  const box = await locator.boundingBox();
  if (!box) throw new Error(`Missing ${name}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

test('every Generate press queues a generation, including presses while a batch enters the feed', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/e2e/studio/index.html?generate=1');
  const expand = page.getByRole('button', { name: 'Expand composer', exact: true });
  if (await expand.isVisible()) await expand.click();
  await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill('a lighthouse at dusk');
  const generate = await centre(page, 'Generate');
  const prompt = await centre(page, 'Prompt');

  const presses = 6;
  await page.mouse.click(generate.x, generate.y);
  for (let press = 2; press <= presses; press += 1) {
    // Wait for the previous press's batch to start entering the feed, then
    // press while that transition is still running.
    await expect.poll(() => viewTransitionRunning(page), { intervals: [10], timeout: 5000 }).toBe(true);
    expect(await hitAt(page, generate)).toBe('Generate');
    expect(await hitAt(page, prompt)).toBe('TEXTAREA');
    await page.mouse.click(generate.x, generate.y);
  }
  await expect.poll(() => generated(page)).toBe(presses);
});

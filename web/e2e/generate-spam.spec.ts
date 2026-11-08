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

// The server caps each user's queued batches (MAX_QUEUED_BATCHES_PER_USER), so
// a long spam answers QUEUE_FULL and the rest wait in the roll queue while a
// drain retries them. Generate must stay on screen and pressable for that whole
// drain: every press joins the queue, and a press bumping the queue count must
// not capture the Composer frame and swallow the next one.
test('Generate keeps queueing presses while the server is at capacity', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/e2e/studio/index.html?generate=1&generateCap=2&generateDelay=50');
  const expand = page.getByRole('button', { name: 'Expand composer', exact: true });
  if (await expand.isVisible()) await expand.click();
  await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill('a lighthouse at dusk');
  const generateButton = page.getByRole('button', { name: /^Generate/ });
  const firstPress = await centre(page, 'Generate');
  for (let press = 1; press <= 2; press += 1) {
    await page.mouse.click(firstPress.x, firstPress.y);
    await expect.poll(() => generated(page)).toBe(press);
  }
  // At the cap: this press is held back and a drain starts working the queue.
  await page.mouse.click(firstPress.x, firstPress.y);
  await expect(page.getByRole('button', { name: 'Stop working through the queue', exact: true })).toBeVisible();
  await expect(generateButton).toBeVisible();

  const box = await generateButton.boundingBox();
  if (!box) throw new Error('Missing Generate');
  const generate = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const queued = async () => Number((await generateButton.textContent())?.match(/\d+/)?.[0] ?? 0);
  await expect.poll(queued).toBeGreaterThan(0);
  const before = await queued();
  const presses = 6;
  for (let press = 1; press <= presses; press += 1) {
    expect(await hitAt(page, generate)).toMatch(/^Generate/);
    await page.mouse.click(generate.x, generate.y);
    // The press lands, and right after its commit Generate is still hit-tested.
    await expect.poll(queued, { intervals: [10] }).toBe(before + press);
    expect(await hitAt(page, generate)).toMatch(/^Generate/);
  }
  expect(await generated(page)).toBe(2);
});

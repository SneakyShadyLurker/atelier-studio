import { devices, expect, test, type Page } from '@playwright/test';

// Every optional image action on (Edit, Animate, Tell Story, Character card,
// Download, Archive, Expand): no control may be clipped or pushed out of the
// tile, and touch targets keep the 44px floor. The index label may truncate.
const ACTION_ORDER = [
  'Edit image 1',
  'Animate image 1',
  'Tell story from image 1',
  'Create character card from image 1',
  'Download tile',
  'Archive tile',
  'Expand tile 1',
];

interface Box { x: number; y: number; width: number; height: number }

async function measure(page: Page): Promise<{ tile: Box; buttons: { label: string; box: Box }[] }> {
  const tile = page.locator('main > div');
  await expect(tile).toBeVisible();
  await tile.evaluate(async (element) => {
    await Promise.all(element.getAnimations({ subtree: true })
      .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
      .map((animation) => animation.finished.catch(() => undefined)));
  });
  return tile.evaluate((element) => {
    const rect = (node: Element) => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return { x, y, width, height };
    };
    const actions = element.querySelectorAll('button[data-tip]');
    return {
      tile: rect(element),
      buttons: Array.from(actions, (node) => ({ label: node.getAttribute('aria-label') ?? '', box: rect(node) })),
    };
  });
}

function expectContained(tile: Box, buttons: readonly { label: string; box: Box }[], minTarget: number) {
  expect(buttons.map((button) => button.label)).toEqual(ACTION_ORDER);
  for (const { box } of buttons) {
    expect(box.x).toBeGreaterThanOrEqual(tile.x - 1);
    expect(box.x + box.width).toBeLessThanOrEqual(tile.x + tile.width + 1);
    expect(box.y).toBeGreaterThanOrEqual(tile.y - 1);
    expect(box.y + box.height).toBeLessThanOrEqual(tile.y + tile.height + 1);
    expect(box.height).toBeGreaterThanOrEqual(minTarget - 0.1);
    expect(box.width).toBeGreaterThanOrEqual(minTarget - 0.1);
  }
}

test('narrowest grid tile keeps every action inside the overlay on desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/e2e/harness/index.html?case=tile-actions');
  await page.locator('main > div').hover();
  const { tile, buttons } = await measure(page);
  // 220px column (--tile-min's floor) plus the tile's 1px borders.
  expect(tile.width).toBeLessThanOrEqual(222);
  expectContained(tile, buttons, 26);
});

// Reachable touch columns (web/src/components/Batch/index.module.css grid +
// --tile-min/--grid-gap in tokens.css, inside the `feed` container): the
// 4-column layout starts at a 920px container, (920 - 3 × 14) / 4 = 219.5px;
// the auto-fill layout never goes below --tile-min's 220px floor; below a
// 480px container a single column fills a phone (`phone`). 256–266px is where
// the label-beside-buttons layout dropped to three rows and clipped 16:9.
const TOUCH_WIDTHS = ['219.5', '232', '256', '260', '266', '300', 'phone'] as const;
// 1:1 and the widest landscape ratio in shared RATIO_VALUES (16:9).
const TOUCH_ASPECTS = ['1:1', '16:9'] as const;

for (const aspect of TOUCH_ASPECTS) {
  for (const width of TOUCH_WIDTHS) {
    test(`touch ${aspect} tile at ${width} keeps every action inside with 44px targets`, async ({ browser }) => {
      const context = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 375, height: 667 } });
      try {
        const page = await context.newPage();
        await page.goto(`/e2e/harness/index.html?case=tile-actions&width=${width}&aspect=${aspect}`);
        const { tile, buttons } = await measure(page);
        expect(await page.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true);
        expectContained(tile, buttons, 44);
        // The index label sits above the buttons on touch; it may truncate
        // horizontally but must not be pushed out of the tile's top edge.
        const label = await page.locator('main > div span').first().boundingBox();
        expect(label?.y ?? Number.NaN).toBeGreaterThanOrEqual(tile.y - 1);
      } finally {
        await context.close();
      }
    });
  }
}

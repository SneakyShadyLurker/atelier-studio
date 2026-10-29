import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

/*
 * Phone feed reachability. The composer FLOATS over the scroller, so the only
 * thing keeping the newest batch's tile actions usable is the bottom padding
 * the canvas reserves from `--composer-top` — and the scroll position actually
 * landing at the end of it. happy-dom cannot see either: both are layout.
 *
 * Regression: `scroll-snap-type: y proximity` on the scroller plus
 * `scroll-snap-align: start` on each batch (both `@media (hover: none)`, so
 * phones only) re-snapped every programmatic and user scroll to the last
 * batch's TOP, parking its action row a full composer-height below the fold and
 * yanking the reader back there on every re-measure.
 */
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });

const COMPOSER_HEIGHT = 150;

interface Reach {
  readonly scrollTop: number;
  readonly maxScroll: number;
  readonly composerTop: number;
  readonly lastActionBottom: number;
}

async function measure(page: Page): Promise<Reach> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>('[data-testid="canvas-scroller"]');
    const composer = document.getElementById('composer');
    if (!canvas || !composer) throw new Error('harness not mounted');
    const rows = document.querySelectorAll<HTMLElement>('[data-batch-id]');
    const last = rows[rows.length - 1];
    const action = last?.querySelector<HTMLElement>('[aria-label^="Expand tile"]');
    if (!action) throw new Error('newest batch has no tile action');
    return {
      scrollTop: canvas.scrollTop,
      maxScroll: canvas.scrollHeight - canvas.clientHeight,
      composerTop: composer.getBoundingClientRect().top,
      lastActionBottom: action.getBoundingClientRect().bottom,
    };
  });
}

async function openFeed(page: Page): Promise<void> {
  await page.goto('/e2e/harness/index.html?case=phone-feed&seed=4');
  await expect(page.getByTestId('canvas-scroller')).toBeVisible();
  await page.waitForTimeout(600);
}

async function flingToBottom(page: Page): Promise<void> {
  await page.getByTestId('canvas-scroller').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(600);
}

test.describe('phone feed reaches past the composer', () => {
  test('landing on the newest batch leaves its tile actions above the composer', async ({ page }) => {
    await openFeed(page);
    const reach = await measure(page);

    expect(reach.lastActionBottom).toBeLessThan(reach.composerTop);
  });

  test('the reader can rest at the true bottom of the feed', async ({ page }) => {
    await openFeed(page);
    await flingToBottom(page);

    const reach = await measure(page);
    expect(reach.scrollTop).toBeGreaterThanOrEqual(reach.maxScroll - 2);
  });

  test('a row settling to its real height does not yank the reader off the bottom', async ({ page }) => {
    await openFeed(page);
    await flingToBottom(page);

    // Stand in for a clip resolving its true height after metadata loads.
    await page.evaluate(() => {
      const first = document.querySelector<HTMLElement>('[data-batch-id]');
      if (first) first.style.paddingBottom = '60px';
    });
    await page.waitForTimeout(700);

    const reach = await measure(page);
    expect(reach.scrollTop).toBeGreaterThanOrEqual(reach.maxScroll - 2);
    expect(reach.lastActionBottom).toBeLessThan(reach.composerTop);
  });

  test('a composer that grows after landing does not cover the newest batch', async ({ page }) => {
    await openFeed(page);
    await flingToBottom(page);

    // The composer finishes loading (or the prompt wraps): its reserve grows
    // with no feed row changing, so only the scroller's padding moves the end.
    await page.evaluate((height) => {
      document.documentElement.style.setProperty('--composer-top', `${String(height)}px`);
      const composer = document.getElementById('composer');
      if (composer) composer.style.height = `${String(height)}px`;
    }, COMPOSER_HEIGHT + 125);
    await page.waitForTimeout(600);

    const reach = await measure(page);
    expect(reach.scrollTop).toBeGreaterThanOrEqual(reach.maxScroll - 2);
    expect(reach.lastActionBottom).toBeLessThan(reach.composerTop);
  });

  test('the canvas reserves the composer height it is told about', async ({ page }) => {
    await openFeed(page);
    const padding = await page.getByTestId('canvas-scroller').evaluate((el) =>
      Number.parseFloat(getComputedStyle(el).paddingBottom));
    expect(padding).toBeGreaterThan(COMPOSER_HEIGHT);
  });
});

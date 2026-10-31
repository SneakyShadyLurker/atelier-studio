import { expect, test, type Page } from '@playwright/test';

/*
 * The feed is bottom-anchored: it reads oldest → newest, so the newest batch
 * sits adjacent to the composer and a queued burst grows DOWNWARD from the
 * batch currently generating. These specs pin the three things that decide
 * whether that feels premium rather than lurchy — where you land, which way new
 * work grows, and whether it can move a reader who scrolled away.
 *
 * happy-dom cannot verify any of it (no layout, no scroll metrics), which is
 * why it lives in the browser lane.
 */

const scroller = (page: Page) => page.locator('[data-testid="canvas-scroller"]');

async function metrics(page: Page) {
  return page.locator('[data-testid="canvas-scroller"]').evaluate((el) => ({
    top: el.scrollTop,
    max: el.scrollHeight - el.clientHeight,
    height: el.scrollHeight,
  }));
}

const atBottom = (m: { top: number; max: number }) => m.max - m.top <= 2;

test.describe('bottom-anchored feed', () => {
  test('opens on the newest work, not the top of history', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?case=feed&seed=30');
    await expect(page.getByText('Prompt 129', { exact: true })).toBeVisible();
    const m = await metrics(page);
    expect(m.max).toBeGreaterThan(0);          // the feed really does overflow
    expect(atBottom(m)).toBe(true);
  });

  test('the newest batch is the last one in the DOM', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?case=feed&seed=30');
    await expect(page.getByText('Prompt 129', { exact: true })).toBeVisible();
    const order = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-batch-id]'))
        .filter((el) => el.tagName === 'SECTION')
        .map((el) => el.getAttribute('data-batch-id')));
    const rendered = order.filter((id): id is string => id !== null);
    const numbers = rendered.map((id) => Number(id.replace('batch-', '')));
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));   // ascending, oldest first
    expect(Math.max(...numbers)).toBe(129);                         // newest is in the last window
  });

  test('a two-batch feed keeps chapter spacing between its rows', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 1200 });
    await page.goto('/e2e/harness/index.html?case=feed&seed=2');
    await expect(page.getByText('Prompt 101', { exact: true })).toBeVisible();

    const layout = await page.evaluate(() => {
      const oldest = document.querySelector('section[data-batch-id="batch-100"]');
      const newest = document.querySelector('section[data-batch-id="batch-101"]');
      const newestHeader = newest?.querySelector('header');
      if (!oldest || !newest || !newestHeader) return null;
      return {
        oldestIsFirst: oldest.getAttribute('data-first') === 'true',
        newestIsFirst: newest.getAttribute('data-first') === 'true',
        chapterGap: newestHeader.getBoundingClientRect().top - oldest.getBoundingClientRect().bottom,
      };
    });

    expect(layout).not.toBeNull();
    expect(layout?.oldestIsFirst).toBe(true);
    expect(layout?.newestIsFirst).toBe(false);
    expect(layout?.chapterGap).toBeGreaterThanOrEqual(40);
  });

  test('a queued batch appends below and keeps the reader pinned to it', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?case=feed&seed=30');
    await expect(page.getByText('Prompt 129', { exact: true })).toBeVisible();
    // Precondition: the landing has settled, so we genuinely start pinned.
    await expect.poll(async () => atBottom(await metrics(page))).toBe(true);
    const before = await metrics(page);

    await page.locator('#queue').click();
    await expect(page.getByText('Prompt 130', { exact: true })).toBeVisible();

    await expect.poll(async () => (await metrics(page)).height).toBeGreaterThan(before.height);

    // The contract is "the new batch is on screen and we are still following",
    // not a pixel-exact bottom. followOnAppend targets the end using the
    // appended row's ESTIMATE and Canvas re-asserts once it measures, so the
    // resting position can sit up to one row-error above the true end — which
    // shows as slightly more clearance above the composer, never as a batch
    // out of view. Assert what the reader actually experiences.
    // The batch ELEMENT, not its prompt text: a batch is taller than the
    // canvas, so at the bottom its header is legitimately clipped above.
    await expect(page.locator('[data-batch-id="batch-130"]').first()).toBeInViewport();
    await expect.poll(async () => {
      const m = await metrics(page);
      return m.max - m.top;
    }).toBeLessThan(200);   // still inside the follow band, so the next append follows too
  });

  test('a reader who scrolled up is not pulled down when work arrives', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?case=feed&seed=30');
    await expect(page.getByText('Prompt 129', { exact: true })).toBeVisible();

    await scroller(page).evaluate((el) => { el.scrollTop = Math.round(el.scrollHeight * 0.35); });
    await page.waitForTimeout(120);
    const before = await metrics(page);
    expect(atBottom(before)).toBe(false);

    await page.locator('#queue').click();
    await page.waitForTimeout(400);

    const after = await metrics(page);
    expect(atBottom(after)).toBe(false);
    // Their row must not shift either — appends land below the viewport.
    expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(2);
  });

  test('a reader just a short way above the end is not pulled down either', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?case=feed&seed=30');
    await expect(page.getByText('Prompt 129', { exact: true })).toBeVisible();
    await expect.poll(async () => atBottom(await metrics(page))).toBe(true);

    // Past the shared 80px follow threshold but well inside one batch height:
    // the band an older Canvas-side correction used to treat as still pinned.
    await page.mouse.move(600, 300);
    await page.mouse.wheel(0, -250);
    await expect.poll(async () => {
      const m = await metrics(page);
      return m.max - m.top;
    }).toBeGreaterThan(200);
    const before = await metrics(page);

    await page.locator('#queue').click();
    await expect(page.getByText('Prompt 130', { exact: true })).toBeAttached();
    await page.waitForTimeout(400);

    const after = await metrics(page);
    expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(2);
  });

  test('loading older history above does not move the reader', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?case=feed&seed=30');
    await expect(page.getByText('Prompt 129', { exact: true })).toBeVisible();

    await scroller(page).evaluate((el) => { el.scrollTop = Math.round(el.scrollHeight * 0.5); });
    await page.waitForTimeout(120);
    const before = await metrics(page);

    await page.locator('#load-older').click();
    // The prepended page is far above the viewport, so virtualization keeps it
    // unmounted — assert on the scroll metrics, not on a row being in the DOM.
    await expect.poll(async () => (await metrics(page)).height).toBeGreaterThan(before.height);
    await page.waitForTimeout(300);

    const after = await metrics(page);
    expect(after.height).toBeGreaterThan(before.height);        // history really did prepend
    // The reader's row must hold: scrollTop absorbs exactly what appeared above.
    expect(after.top - before.top).toBeGreaterThan(0);
    expect(Math.abs((after.top - before.top) - (after.height - before.height))).toBeLessThanOrEqual(4);
  });

  test('a feed too short to scroll starts at the top of the canvas', async ({ page }) => {
    // Tall enough that a single batch plus the canvas' composer clearance does
    // not itself overflow — otherwise there is no short-feed case to assert.
    await page.setViewportSize({ width: 900, height: 1200 });
    await page.goto('/e2e/harness/index.html?case=feed&seed=1');
    await expect(page.getByText('Prompt 100', { exact: true })).toBeVisible();
    const { gap, max } = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="canvas-scroller"]');
      const first = document.querySelector('section[data-batch-id]');
      if (!el || !first) return { gap: -1, max: -1 };
      return {
        gap: first.getBoundingClientRect().top - el.getBoundingClientRect().top,
        max: el.scrollHeight - el.clientHeight,
      };
    });
    expect(max).toBeLessThanOrEqual(0);   // precondition: this feed really is too short to scroll
    // Canvas top padding plus the infinite-scroll sentinel above the feed —
    // NOT a lone batch floating down the middle of an empty column.
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThan(120);
  });
});

/*
 * A lone batch on a wide feed spans two tracks, so its tile grows with the
 * window. On a short window the end-anchored feed used to keep the tile's
 * bottom clear of the floating composer by pushing the batch header off the
 * top. The lone-tile cap now also respects the room above the composer.
 */
test.describe('a lone batch fits above the composer', () => {
  const sizes = [
    { width: 1280, height: 577 },
    { width: 1280, height: 800 },
    { width: 1440, height: 900 },
  ] as const;

  for (const ratio of ['1:1', '9:16'] as const) {
    for (const size of sizes) {
      test(`${ratio} at ${size.width}×${size.height} keeps header and tile in view`, async ({ page }) => {
        await page.setViewportSize(size);
        await page.goto(`/e2e/harness/index.html?case=phone-feed&seed=1&composer=215&ratio=${ratio}`);
        await expect(page.getByText('Prompt 100', { exact: true })).toBeVisible();
        // Let the end-anchored landing settle before measuring.
        await page.waitForTimeout(400);
        const box = await page.evaluate(() => {
          const canvas = document.querySelector('[data-testid="canvas-scroller"]');
          const composer = document.getElementById('composer');
          const header = document.querySelector('section[data-batch-id] header');
          const tile = document.querySelector('[data-testid="batch-grid"] > *');
          if (!canvas || !composer || !header || !tile) throw new Error('harness not mounted');
          return {
            canvasTop: canvas.getBoundingClientRect().top,
            composerTop: composer.getBoundingClientRect().top,
            headerTop: header.getBoundingClientRect().top,
            tileBottom: tile.getBoundingClientRect().bottom,
            tileHeight: tile.getBoundingClientRect().height,
            headerLeft: header.getBoundingClientRect().left,
            tileLeft: tile.getBoundingClientRect().left,
          };
        });
        expect(box.headerTop).toBeGreaterThanOrEqual(box.canvasTop);
        expect(box.tileBottom).toBeLessThanOrEqual(box.composerTop);
        // Not shrunk to a thumbnail to get there.
        expect(box.tileHeight).toBeGreaterThanOrEqual(220);
        // Still aligned under the header, not centred in its empty span.
        expect(Math.abs(box.tileLeft - box.headerLeft)).toBeLessThanOrEqual(1);
      });
    }
  }
});

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

  // The first window the feed renders is already its newest end: rendering
  // from offset 0 mounted the oldest rows for a frame before the landing,
  // and their thumbnail downloads were aborted and requested again later.
  for (const [label, url, newestId, oldestId] of [
    ['history at mount', '/e2e/harness/index.html?case=feed&seed=30', 'batch-129', 'batch-100'],
    ['history after mount', '/e2e/studio/index.html?batches=20', 'studio-batch-4', 'studio-extra-1'],
  ] as const) {
    test(`the first painted frame already shows the newest end (${label})`, async ({ page }) => {
      await page.addInitScript(() => {
        // Every frame's mounted feed rows, from the first frame that has any.
        const frames: string[][] = [];
        // The newest mounted row's top, per frame (how far the landing moves it).
        const tops: { id: string; top: number }[] = [];
        (window as unknown as { __feedFrames: string[][] }).__feedFrames = frames;
        (window as unknown as { __feedTops: typeof tops }).__feedTops = tops;
        const tick = () => {
          const elements = [...document.querySelectorAll('[data-testid="canvas-scroller"] [data-index][data-batch-id]')];
          const rows = elements.map((row) => row.getAttribute('data-batch-id') ?? '');
          if (rows.length > 0 || frames.length > 0) frames.push(rows);
          const newest = elements.at(-1);
          if (newest) tops.push({ id: newest.getAttribute('data-batch-id') ?? '', top: Math.round(newest.getBoundingClientRect().top) });
          if (frames.length < 120) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      await page.goto(url);
      await expect(page.locator(`section[data-batch-id="${newestId}"]`)).toBeVisible();
      await page.waitForTimeout(500);
      const frames = await page.evaluate(() => (window as unknown as { __feedFrames: string[][] }).__feedFrames);
      const first = frames[0] ?? [];
      const settled = await page.locator('[data-testid="canvas-scroller"] [data-index][data-batch-id]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-batch-id') ?? ''));
      const tops = await page.evaluate(() => (window as unknown as { __feedTops: { id: string; top: number }[] }).__feedTops);
      const jumps = tops.slice(1).map((entry, index) => {
        const previous = tops[index];
        return previous?.id === entry.id ? Math.abs(entry.top - previous.top) : 0;
      });
      test.info().annotations.push({ type: 'first-frame', description: `${first.join(',')} | settled ${settled.join(',')} | largest newest-row jump ${String(Math.max(0, ...jumps))}px` });
      expect(first).toContain(newestId);
      expect(first).not.toContain(oldestId);
      // No row of the first frame leaves when the landing settles.
      expect(first.filter((id) => !settled.includes(id))).toEqual([]);
    });
  }

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

  test('a reader who scrolled up is not pulled down when work arrives', async ({ page }, testInfo) => {
    await page.goto('/e2e/harness/index.html?case=feed&seed=30');
    await expect(page.getByText('Prompt 129', { exact: true })).toBeVisible();

    await expect.poll(async () => atBottom(await metrics(page))).toBe(true);
    const landing = await metrics(page);
    const visible = await scroller(page).evaluate((el) => {
      const box = el.getBoundingClientRect();
      return {
        left: Math.max(0, box.left), right: Math.min(innerWidth, box.right),
        top: Math.max(0, box.top), bottom: Math.min(innerHeight, box.bottom),
      };
    });
    expect(visible.right).toBeGreaterThan(visible.left);
    expect(visible.bottom).toBeGreaterThan(visible.top);
    const gesture = {
      x: (visible.left + visible.right) / 2,
      y: (visible.top + visible.bottom) / 2,
      deltaY: Math.round(landing.max * 0.35) - landing.top,
    };
    // A native reader gesture releases the initial landing reconciliation.
    await page.mouse.move(gesture.x, gesture.y);
    await page.mouse.wheel(0, gesture.deltaY);
    await expect.poll(async () => {
      const m = await metrics(page);
      return m.max - m.top;
    }).toBeGreaterThan(200);
    const before = await metrics(page);
    await testInfo.attach('reader-scroll-setup', {
      body: JSON.stringify({ landing, visible, gesture, before }), contentType: 'application/json',
    });
    expect(atBottom(before)).toBe(false);

    await page.locator('#queue').click();
    await page.waitForTimeout(400);

    const after = await metrics(page);
    await testInfo.attach('reader-scroll-after-append', {
      body: JSON.stringify({ before, after, movement: after.top - before.top }), contentType: 'application/json',
    });
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
    const { gap, max, status } = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="canvas-scroller"]');
      const first = document.querySelector('section[data-batch-id]');
      const row = el?.querySelector('[role="status"]')?.parentElement;
      if (!el || !first || !row) return { gap: -1, max: -1, status: -1 };
      return {
        gap: first.getBoundingClientRect().top - el.getBoundingClientRect().top,
        max: el.scrollHeight - el.clientHeight,
        status: row.getBoundingClientRect().height,
      };
    });
    expect(max).toBeLessThanOrEqual(0);   // precondition: this feed really is too short to scroll
    // Canvas top padding plus the load-more row above the feed (it reserves
    // one footprint in every state, InfiniteStatus) — NOT a lone batch
    // floating down the middle of an empty column.
    expect(gap).toBeGreaterThanOrEqual(status);
    expect(gap - status).toBeLessThan(60);
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
        // Not shrunk to a thumbnail to get there (the CSS floor is 200px since
        // the scope title bar took 70px of the 577px window; a 9:16 tile's
        // frame border renders it ~2px under the cap).
        expect(box.tileHeight).toBeGreaterThanOrEqual(196);
        // Still aligned under the header, not centred in its empty span.
        expect(Math.abs(box.tileLeft - box.headerLeft)).toBeLessThanOrEqual(1);
      });
    }
  }
});

/*
 * R11: an unmeasured row is laid out at its estimate, so the estimate must
 * match what the grid renders. Every rendered row's height is compared with
 * `estimateBatchHeight` on the geometry the Canvas reads (the harness calls
 * the same lib/feedEstimate functions).
 */
async function estimateErrors(page: Page) {
  return page.evaluate(() => {
    const estimate = (window as unknown as { __feedEstimate: (id: string) => number | null }).__feedEstimate;
    return Array.from(document.querySelectorAll<HTMLElement>('[data-index][data-batch-id]')).map((row) => {
      const id = row.dataset.batchId ?? '';
      const tiles = row.querySelectorAll('[data-feed-tile]').length;
      return { id, tiles, rendered: row.offsetHeight, estimate: estimate(id) ?? Number.NaN, error: Math.abs(row.offsetHeight - (estimate(id) ?? Number.NaN)) };
    });
  });
}

test.describe('row estimates match the rendered grid', () => {
  for (const size of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }] as const) {
    test(`within 8px at ${size.width}×${size.height}`, async ({ page }, testInfo) => {
      await page.setViewportSize(size);
      await page.goto('/e2e/harness/index.html?case=feed&seed=12&mix=1');
      await expect(page.getByText('Prompt 111', { exact: true })).toBeVisible();
      await page.waitForTimeout(300);
      const rows = await estimateErrors(page);
      await testInfo.attach('estimate-errors', { body: JSON.stringify(rows, null, 2), contentType: 'application/json' });
      console.log('estimate-errors', size.width, JSON.stringify(rows));
      expect(rows.length).toBeGreaterThan(2);
      for (const row of rows) expect(row.error, `${row.id} (${String(row.tiles)} tiles)`).toBeLessThanOrEqual(8);
    });
  }

  test('a lone tile follows an expanded composer', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/e2e/harness/index.html?case=phone-feed&seed=3&composer=320&ratio=9:16');
    await expect(page.getByText('Prompt 102', { exact: true })).toBeVisible();
    await page.waitForTimeout(300);
    const rows = await estimateErrors(page);
    await testInfo.attach('estimate-errors', { body: JSON.stringify(rows, null, 2), contentType: 'application/json' });
    console.log('estimate-errors lone', JSON.stringify(rows));
    const lone = rows.find((row) => row.id === 'batch-102');
    expect(lone).toBeDefined();
    expect(lone?.error).toBeLessThanOrEqual(8);
  });
});

/*
 * After a column-count change, rows measured at the old width and now
 * offscreen keep their old size until they mount again (the measurement
 * cache is not cleared mid-resize, see Canvas). Scrolling back to them must
 * not visibly correct the row the reader is looking at by more than 8px:
 * every frame after the reader's scroll is sampled for the largest move of
 * the row under the viewport's middle.
 */
test('offscreen rows measured before a column change do not jump the reader when they return', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/e2e/harness/index.html?case=feed&seed=30&mix=1');
  await expect(page.getByText('Prompt 129', { exact: true })).toBeVisible();
  await expect.poll(async () => atBottom(await metrics(page))).toBe(true);
  // Measure a band of rows in the middle of the feed, then go back to the end.
  for (const fraction of [0.6, 0.45, 0.3, 0.15]) {
    await scroller(page).evaluate((el, f) => { el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) * f); }, fraction);
    await page.waitForTimeout(250);
  }
  await scroller(page).evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(300);
  // Across 920px of feed width: four columns to three.
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.waitForTimeout(400);
  await page.mouse.move(800, 400);
  const samples: { fraction: number; batch: string; maxMove: number; frames: number }[] = [];
  for (const fraction of [0.6, 0.45, 0.3, 0.15]) {
    const delta = await scroller(page).evaluate((el, f) => Math.round((el.scrollHeight - el.clientHeight) * f) - el.scrollTop, fraction);
    // A reader's wheel scroll; sampling starts on the first frame after it lands.
    await page.mouse.wheel(0, delta);
    const sample = await page.evaluate(() => new Promise<{ batch: string; maxMove: number; frames: number }>((resolve) => {
      const el = document.querySelector<HTMLElement>('[data-testid="canvas-scroller"]');
      if (!el) throw new Error('no scroller');
      const middle = () => el.getBoundingClientRect().top + el.clientHeight / 2;
      const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-index][data-batch-id]'));
      const row = rows.find((candidate) => candidate.getBoundingClientRect().bottom > middle()) ?? rows[0];
      const id = row?.dataset.batchId ?? '';
      const top = () => document.querySelector<HTMLElement>(`[data-index][data-batch-id="${id}"]`)?.getBoundingClientRect().top ?? Number.NaN;
      const start = top();
      let maxMove = 0;
      let frames = 0;
      const tick = () => {
        frames += 1;
        maxMove = Math.max(maxMove, Math.abs(top() - start));
        if (frames < 40) requestAnimationFrame(tick);
        else resolve({ batch: id, maxMove, frames });
      };
      requestAnimationFrame(tick);
    }));
    samples.push({ fraction, ...sample });
  }
  await testInfo.attach('column-change-corrections', { body: JSON.stringify(samples, null, 2), contentType: 'application/json' });
  console.log('column-change-corrections', JSON.stringify(samples));
  for (const sample of samples) expect(sample.maxMove, `${sample.batch} at ${String(sample.fraction)}`).toBeLessThanOrEqual(8);
});

/* R17: Pinned and a collection have their own empty states; only Unsorted invites a first generation. */
test.describe('scope-aware empty states', () => {
  for (const scope of [
    { view: 'pinned', title: 'Nothing pinned yet', body: 'Pin a batch from its menu to keep it here.' },
    { view: 'collection', title: 'This collection is empty', body: 'Move batches here from Unsorted.' },
  ] as const) {
    test(`an empty ${scope.view} scope`, async ({ page }) => {
      await page.goto(`/e2e/harness/index.html?case=plate&view=${scope.view}`);
      await expect(page.getByRole('heading', { name: scope.title })).toBeVisible();
      await expect(page.getByText(scope.body, { exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'What would you like to make?' })).toHaveCount(0);
    });
  }

  test('an empty Unsorted scope keeps the invitation', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?case=plate');
    await expect(page.getByRole('heading', { name: 'What would you like to make?' })).toBeVisible();
  });
});

/*
 * The feed on the real history query (harness `feed-history`: an in-page
 * /api/history with 200 batches, 30 per page, seeded with `pages` pages).
 */
interface FeedHistoryProbe {
  server: { total: number; fail: boolean; requests: string[] };
  pages: () => number;
  refetch: () => Promise<unknown>;
  arrive: () => void;
}

const feedHistory = <T,>(page: Page, run: (probe: FeedHistoryProbe) => T | Promise<T>) =>
  page.evaluate<T>(`(${run.toString()})(window.__feedHistory)`);

async function newestBottom(page: Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-testid="canvas-scroller"]');
    const rows = document.querySelectorAll<HTMLElement>('[data-index][data-batch-id]');
    const newest = rows[rows.length - 1];
    if (!el || !newest) throw new Error('feed not mounted');
    return newest.getBoundingClientRect().bottom - el.getBoundingClientRect().top;
  });
}

test.describe('feed on the history query', () => {
  test('a reader resting at the end lets older pages go without moving, and they load again above', async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    await page.goto('/e2e/harness/index.html?case=feed-history&pages=5');
    await expect(page.getByText('Prompt 1000', { exact: true })).toBeVisible();
    await expect.poll(async () => atBottom(await metrics(page))).toBe(true);
    expect(await feedHistory(page, (probe) => probe.pages())).toBe(5);
    await page.waitForTimeout(500);
    const before = await newestBottom(page);
    // 20 s at rest at the newest end (R7 c).
    await expect.poll(async () => feedHistory(page, (probe) => probe.pages()), { timeout: 30_000, intervals: [1_000] }).toBe(3);
    await page.waitForTimeout(300);
    const after = await newestBottom(page);
    await testInfo.attach('newest-row', { body: JSON.stringify({ before, after, movement: after - before }), contentType: 'application/json' });
    console.log('retention-newest-row', JSON.stringify({ before, after, movement: after - before }));
    expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
    expect(atBottom(await metrics(page))).toBe(true);
    // Scrolling up reaches the load-more row again and reads the next page from the kept cursor.
    await expect.poll(async () => {
      await scroller(page).evaluate((el) => { el.scrollTop = 0; });
      return feedHistory(page, (probe) => probe.pages());
    }, { timeout: 15_000 }).toBeGreaterThanOrEqual(4);
    expect(await feedHistory(page, (probe) => probe.server.requests)).toContain('?limit=30&cursor=90&collectionId=null');
  });

  test('a failed refresh shows one status row with Retry at the newest end, gone after the next read', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?case=feed-history&pages=1');
    await expect(page.getByText('Prompt 1000', { exact: true })).toBeVisible();
    await expect.poll(async () => atBottom(await metrics(page))).toBe(true);
    await feedHistory(page, async (probe) => {
      probe.server.fail = true;
      await probe.refetch().catch(() => undefined);
    });
    const status = page.getByTestId('history-refresh-status');
    await expect(status.getByRole('status')).toHaveText('Couldn’t refresh Unsorted.');
    await expect(status.getByRole('status')).toHaveAttribute('aria-live', 'polite');
    const retry = status.getByRole('button', { name: 'Retry' });
    await expect(retry).toBeVisible();
    // The rows stay, and a reader at the end sees the row above the composer.
    await expect(page.getByText('Prompt 1000', { exact: true })).toBeVisible();
    await expect.poll(async () => {
      const box = await retry.boundingBox();
      const composer = await page.locator('#composer').boundingBox();
      return box && composer ? composer.y - (box.y + box.height) : -1;
    }).toBeGreaterThanOrEqual(0);
    await feedHistory(page, (probe) => { probe.server.fail = false; });
    await retry.click();
    await expect(status.getByRole('status')).toHaveText('');
    await expect(status.getByRole('button', { name: 'Retry' })).toHaveCount(0);
  });

  test('a reader far from the end gets one Jump to latest control, marked when work arrives below', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?case=feed-history&pages=2');
    await expect(page.getByText('Prompt 1000', { exact: true })).toBeVisible();
    await expect.poll(async () => atBottom(await metrics(page))).toBe(true);
    const jump = page.getByRole('button', { name: 'Jump to latest' });
    await expect(jump).toBeHidden();

    await page.mouse.move(800, 400);
    await page.mouse.wheel(0, -3000);
    await expect(jump).toBeVisible();
    await expect(jump).toHaveAttribute('data-tip', 'Jump to latest');
    expect(await jump.getAttribute('data-marker')).toBeNull();
    // Centred in the feed shell, just above the composer.
    const placement = await page.evaluate(() => {
      const button = document.querySelector<HTMLElement>('[data-testid="jump-to-latest"]');
      const shell = document.querySelector<HTMLElement>('[data-testid="canvas-scroller"]')?.parentElement;
      const composer = document.getElementById('composer');
      if (!button || !shell || !composer) throw new Error('not mounted');
      const b = button.getBoundingClientRect();
      const s = shell.getBoundingClientRect();
      return { offCentre: Math.abs((b.left + b.right) / 2 - (s.left + s.right) / 2), clearance: composer.getBoundingClientRect().top - b.bottom };
    });
    expect(placement.offCentre).toBeLessThanOrEqual(1);
    expect(placement.clearance).toBeGreaterThan(0);
    expect(placement.clearance).toBeLessThanOrEqual(24);

    const before = await metrics(page);
    await feedHistory(page, (probe) => { probe.arrive(); });
    await expect(jump).toHaveAttribute('data-marker', 'true');
    // The reader was not pulled down by the arrival.
    expect(Math.abs((await metrics(page)).top - before.top)).toBeLessThanOrEqual(2);

    await jump.click();
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('canvas-scroller');
    await expect.poll(async () => atBottom(await metrics(page)), { timeout: 5_000 }).toBe(true);
    await expect(jump).toBeHidden();
    await expect(page.getByText('Arrival 201', { exact: true })).toBeVisible();
  });
});

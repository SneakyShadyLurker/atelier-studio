import { expect, test, type Page } from '@playwright/test';

/*
 * Session media cache (feed-polish R8). Authenticated media is `no-store`, so
 * without the in-memory cache every virtualized remount downloads its
 * thumbnail again. Here a tile scrolled out of the virtual window and back
 * must cost one thumbnail request in total, repaint without the develop
 * transition (data-cached) and show its image within two frames.
 */

// A real 2x2 PNG, so the browser decodes what the route serves.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64');

async function serveMedia(page: Page): Promise<Map<string, number>> {
  const requests = new Map<string, number>();
  await page.route('**/api/img/**', async (route) => {
    const url = new URL(route.request().url());
    const key = `${url.pathname}${url.search}`;
    requests.set(key, (requests.get(key) ?? 0) + 1);
    await route.fulfill({ status: 200, contentType: 'image/png', headers: { 'Cache-Control': 'private, no-store' }, body: PNG });
  });
  return requests;
}

const scroller = (page: Page) => page.locator('[data-testid="canvas-scroller"]');
const frameOf = (page: Page, tileId: string) => page.locator(`[data-feed-tile="${tileId}"] button[aria-label^="Open image"]`);

test('a tile scrolled out of the virtual window and back downloads its thumbnail once and repaints from memory', async ({ page }) => {
  const requests = await serveMedia(page);
  await page.goto('/e2e/harness/media-session-cache.html?count=40');
  const newest = 'tile-39';
  const thumbPath = `/api/img/${newest}/thumb?media=2`;
  await expect(frameOf(page, newest)).toHaveAttribute('data-media-ready', 'true');
  expect(requests.get(thumbPath)).toBe(1);
  // The original is not requested while the thumbnail serves.
  expect(requests.get(`/api/img/${newest}?media=2`)).toBeUndefined();

  // Out of the virtual window: the tile unmounts.
  await scroller(page).evaluate((element) => { element.scrollTop = 0; });
  await expect(page.locator(`[data-feed-tile="${newest}"]`)).toHaveCount(0);

  // Record when the remounted tile appears and when it is visibly ready.
  await page.evaluate((tileId) => {
    const marks: { mounted?: number; ready?: number; cachedAtMount?: string | null } = {};
    (window as unknown as { __mediaMarks: typeof marks }).__mediaMarks = marks;
    const observer = new MutationObserver(() => {
      const frame = document.querySelector(`[data-feed-tile="${tileId}"] button`);
      if (!frame) return;
      if (marks.mounted === undefined) {
        marks.mounted = performance.now();
        marks.cachedAtMount = frame.getAttribute('data-cached');
      }
      if (marks.ready === undefined && frame.getAttribute('data-media-ready') === 'true') {
        marks.ready = performance.now();
        observer.disconnect();
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-media-ready'] });
  }, newest);
  await scroller(page).evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(frameOf(page, newest)).toHaveAttribute('data-media-ready', 'true');
  await expect(frameOf(page, newest)).toHaveAttribute('data-cached', 'true');

  const marks = await page.evaluate(() => (window as unknown as { __mediaMarks: { mounted?: number; ready?: number; cachedAtMount?: string | null } }).__mediaMarks);
  const frameMs = await page.evaluate(() => new Promise<number>((resolve) => {
    requestAnimationFrame((first) => { requestAnimationFrame((second) => { resolve(second - first); }); });
  }));
  const elapsed = (marks.ready ?? Infinity) - (marks.mounted ?? 0);
  test.info().annotations.push({ type: 'remount-to-ready-ms', description: elapsed.toFixed(1) }, { type: 'frame-ms', description: frameMs.toFixed(1) });
  console.log(`[media-session-cache] remount to ready ${elapsed.toFixed(1)} ms (frame ${frameMs.toFixed(1)} ms)`);
  expect(marks.cachedAtMount).toBe('true');
  // Within two frames of the remount (with a little scheduling slack).
  expect(elapsed).toBeLessThanOrEqual(frameMs * 2 + 4);
  // The image is painted: decoded pixels, full opacity, no develop.
  const painted = await frameOf(page, newest).locator('img').evaluate((image: HTMLImageElement) => ({
    naturalWidth: image.naturalWidth,
    src: image.src,
    opacity: getComputedStyle(image).opacity,
  }));
  expect(painted.naturalWidth).toBe(2);
  expect(painted.src.startsWith('blob:')).toBe(true);
  expect(painted.opacity).toBe('1');

  // One request in total for the round trip.
  expect(requests.get(thumbPath)).toBe(1);
});

// A tile that leaves before its download finishes aborts it (its last
// consumer left), so each stop waits for the mounted tiles to finish, as a
// reader's pause does (every mounted tile holds its cached <img>; native lazy
// loading decodes it near the viewport). Counted from navigation: the first
// window is already the newest end, so no row mounts for a frame before the
// landing and aborts its download; three passes over settled stops cost one
// request per thumbnail.
test('every thumbnail is requested once from navigation across three settled scroll passes', async ({ page }) => {
  const requests = await serveMedia(page);
  await page.goto('/e2e/harness/media-session-cache.html?count=40');
  await expect(frameOf(page, 'tile-39')).toHaveAttribute('data-media-ready', 'true');
  const landed = [...requests.keys()].filter((path) => path.includes('/thumb'));
  test.info().annotations.push({ type: 'landing-thumbs', description: landed.join(' ') });
  // The landing requested the newest tiles only.
  expect(landed.length).toBeGreaterThan(0);
  expect(landed.filter((path) => !/tile-3\d\/thumb/.test(path))).toEqual([]);
  for (let pass = 0; pass < 3; pass += 1) {
    for (const fraction of [0.66, 0.33, 0, 0.5, 1]) {
      await scroller(page).evaluate((element, share) => { element.scrollTop = (element.scrollHeight - element.clientHeight) * share; }, fraction);
      await expect.poll(() => page.locator('[data-feed-tile] button[aria-label^="Open image"]:not(:has(img))').count()).toBe(0);
    }
  }
  const thumbs = [...requests.entries()].filter(([path]) => path.includes('/thumb'));
  test.info().annotations.push({ type: 'thumb-requests', description: `${String(thumbs.length)} urls, ${String(thumbs.reduce((total, [, hits]) => total + hits, 0))} requests` });
  expect(thumbs.length).toBeGreaterThan(landed.length);
  expect(thumbs.filter(([, hits]) => hits !== 1)).toEqual([]);
  expect([...requests.keys()].filter((path) => !path.includes('/thumb'))).toEqual([]);
});

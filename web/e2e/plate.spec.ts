import { expect, test, type Page } from '@playwright/test';

/*
 * The plate (design 1.1, 4.4): every empty surface frames an etched still life
 * in a debossed plate, and the loading tile is the monochrome plate wipe that
 * replaced the aurora gradient. happy-dom resolves no masks and computes no
 * layout, so whether the etching actually paints, at a real size, through
 * `mask` in each engine and theme is pinned here.
 */

async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
}

for (const theme of ['light', 'dark'] as const) {
  test(`the first-run canvas shows a masked etching in the plate (${theme})`, async ({ page }) => {
    await page.goto('/e2e/harness/index.html?case=plate');
    await setTheme(page, theme);
    await expect(page.getByRole('heading', { name: 'What would you like to make?' })).toBeVisible();

    const etching = page.locator('[data-etching="empty-canvas"]');
    await expect(etching).toHaveAttribute('aria-hidden', 'true');
    const box = await etching.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(100);
    expect(box?.height ?? 0).toBeGreaterThan(50);
    // 3:2 asset.
    if (box) expect(box.width / box.height).toBeCloseTo(1.5, 1);

    const painted = await etching.evaluate((element) => {
      const style = getComputedStyle(element);
      const webkit = style.getPropertyValue('-webkit-mask-image');
      const plate = element.parentElement ? getComputedStyle(element.parentElement) : null;
      return {
        mask: style.maskImage,
        webkitMask: webkit,
        fill: style.backgroundColor,
        fillImage: style.backgroundImage,
        plateFill: plate?.backgroundColor ?? '',
        plateShadow: plate?.boxShadow ?? '',
      };
    });
    expect(painted.mask).toContain('empty-canvas');
    expect(painted.mask).toContain('url(');
    expect(painted.webkitMask).toContain('empty-canvas');
    // The ink is a plain fill (--etch-ink), never a gradient; the mask draws the line.
    expect(painted.fillImage).toBe('none');
    expect(painted.fill).not.toBe('rgba(0, 0, 0, 0)');
    // The plate: a filled mat with the debossed plate mark.
    expect(painted.plateFill).not.toBe('rgba(0, 0, 0, 0)');
    expect(painted.plateShadow).toContain('inset');
    // The mask asset is actually served.
    const url = /url\("?([^")]+)"?\)/.exec(painted.mask)?.[1];
    expect(url).toBeDefined();
    if (url) expect((await page.request.get(url)).ok()).toBe(true);
  });
}

test('the etching ink follows the theme from one asset', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?case=plate');
  const etching = page.locator('[data-etching="empty-canvas"]');
  await expect(etching).toBeVisible();
  const read = () => etching.evaluate((element) => {
    const style = getComputedStyle(element);
    return { fill: style.backgroundColor, mask: style.maskImage };
  });
  await setTheme(page, 'light');
  const light = await read();
  await setTheme(page, 'dark');
  const dark = await read();
  expect(dark.mask).toBe(light.mask);
  expect(dark.fill).not.toBe(light.fill);
});

test('the loading tile is the monochrome plate wipe, and a queued tile the plate at rest', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/e2e/harness/index.html?case=plate&tiles=loading');
  const cancels = page.getByRole('button', { name: 'Cancel generation' });
  await expect(cancels).toHaveCount(2);

  const layers = await page.evaluate(() => {
    const tiles = Array.from(document.querySelectorAll('button[aria-label="Cancel generation"]'))
      .map((button) => button.parentElement)
      .filter((tile): tile is HTMLElement => tile !== null);
    return tiles.map((tile) => {
      const elements = Array.from(tile.querySelectorAll<HTMLElement>('div, span'));
      // The plate of the layer the tile currently shows (queued or running).
      const plates = elements.filter((element) => {
        const style = getComputedStyle(element);
        return element.closest('[data-visible]')?.getAttribute('data-visible') === 'true'
          && style.position === 'absolute' && style.boxShadow.includes('inset');
      });
      const plate = plates[0];
      if (!plate) return null;
      const style = getComputedStyle(plate);
      const before = getComputedStyle(plate, '::before');
      const after = getComputedStyle(plate, '::after');
      return {
        visible: plate.closest('[data-visible]')?.getAttribute('data-visible') ?? null,
        backgroundImage: style.backgroundImage,
        backgroundColor: style.backgroundColor,
        beforeImage: before.backgroundImage,
        afterAnimation: after.animationName,
        afterDuration: after.animationDuration,
        afterRotate: after.rotate,
      };
    });
  });

  const visible = layers.filter((layer) => layer?.visible === 'true');
  expect(visible).toHaveLength(2);
  for (const layer of visible) {
    if (!layer) continue;
    // No aurora: the plate is a flat mat, no gradient on it or its ::before.
    expect(layer.backgroundImage).toBe('none');
    expect(layer.beforeImage).toBe('none');
    expect(layer.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
  }
  const wiping = visible.filter((layer) => layer?.afterAnimation.includes('atelier-sweep'));
  // Exactly one tile renders (the wipe); the queued one rests.
  expect(wiping).toHaveLength(1);
  expect(wiping[0]?.afterDuration).toBe('1.6s');
  expect(wiping[0]?.afterRotate).toBe('20deg');
});

/* Materials (design 1.2, 4.2, 5 "Batch and tiles"): a batch is a sheet on
   the feed's table, and a failed tile sits on the same plate as the queued and
   loading tiles, without the old diagonal hatch. */
for (const theme of ['light', 'dark'] as const) {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    test(`a batch is a sheet and a failed tile is the plain plate (${theme}, ${viewport.width}px)`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto('/e2e/harness/index.html?case=phone-feed&seed=4&failed=1');
      await setTheme(page, theme);
      const retry = page.getByRole('button', { name: 'Retry failed tile' });
      await retry.scrollIntoViewIfNeeded();
      await expect(retry).toBeVisible();

      const read = await page.evaluate(() => {
        // Resolve --bg-elev to a computed colour through a probe element.
        const probe = document.createElement('div');
        probe.style.background = 'var(--bg-elev)';
        document.body.append(probe);
        const sheet = getComputedStyle(probe).backgroundColor;
        probe.remove();

        const batches = Array.from(document.querySelectorAll<HTMLElement>('section[data-batch-id]'));
        const retryButton = document.querySelector<HTMLElement>('[aria-label="Retry failed tile"]');
        // The failed tile's body: the nearest ancestor of the actions that paints the plate.
        let body: HTMLElement | null = retryButton?.parentElement ?? null;
        while (body && !getComputedStyle(body).boxShadow.includes('inset')) body = body.parentElement;
        const bodyStyle = body ? getComputedStyle(body) : null;
        return {
          sheet,
          batches: batches.map((batch) => {
            const style = getComputedStyle(batch);
            return { background: style.backgroundColor, image: style.backgroundImage, shadow: style.boxShadow, padding: parseFloat(style.paddingLeft) };
          }),
          failedImage: bodyStyle?.backgroundImage ?? null,
          failedFill: bodyStyle?.backgroundColor ?? null,
        };
      });

      expect(read.sheet).not.toBe('rgba(0, 0, 0, 0)');
      expect(read.batches.length).toBeGreaterThan(0);
      for (const batch of read.batches) {
        expect(batch.background).toBe(read.sheet);
        expect(batch.image).toBe('none');
        expect(batch.shadow).not.toBe('none');
        expect(batch.padding).toBeGreaterThanOrEqual(12);
      }
      // The failed tile is the plate: a flat mat with the plate mark, no hatch.
      expect(read.failedImage).toBe('none');
      expect(read.failedFill).not.toBeNull();
      expect(read.failedFill).not.toBe('rgba(0, 0, 0, 0)');
      expect(read.failedFill).not.toBe(read.sheet);
    });
  }
}

/* State-view placement: the state centres in the space its container owns
   instead of sitting against the container's top edge. */
async function verticalSlack(page: Page, heading: string, regionTop: number, regionBottom: number): Promise<{ above: number; below: number }> {
  const state = page.getByRole('heading', { name: heading }).locator('..');
  const rect = await state.evaluate((element) => {
    // The visible content: first child (plate) to last child.
    const first = element.firstElementChild?.getBoundingClientRect();
    const last = element.lastElementChild?.getBoundingClientRect();
    return { top: first?.top ?? 0, bottom: last?.bottom ?? 0 };
  });
  return { above: rect.top - regionTop, below: regionBottom - rect.bottom };
}

test('the first-run canvas centres its state above the floating composer', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/e2e/studio/index.html?emptyHistory=1');
  await expect(page.getByRole('heading', { name: 'What would you like to make?' })).toBeVisible();
  const canvasTop = await page.getByTestId('canvas-scroller').evaluate((element) => element.getBoundingClientRect().top);
  const composerTop = await page.locator('#atelier-composer').evaluate((element) => element.getBoundingClientRect().top);
  const slack = await verticalSlack(page, 'What would you like to make?', canvasTop, composerTop);
  expect(slack.above).toBeGreaterThan(60);
  expect(Math.abs(slack.above - slack.below)).toBeLessThan(48);
});

test('an empty Archive centres its state below the header', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/e2e/harness/archive.html?count=0');
  await expect(page.getByRole('heading', { name: 'Nothing archived' })).toBeVisible();
  const headerBottom = await page.getByRole('button', { name: 'Back to feed' }).evaluate((element) =>
    element.closest('header')?.getBoundingClientRect().bottom ?? element.getBoundingClientRect().bottom);
  const slack = await verticalSlack(page, 'Nothing archived', headerBottom, 900);
  expect(slack.above).toBeGreaterThan(60);
  expect(Math.abs(slack.above - slack.below)).toBeLessThan(80);
});

test('the loading state shows the plate at rest, no glyph', async ({ page }) => {
  await page.goto('/e2e/harness/archive.html?loading=1');
  const status = page.getByRole('status').filter({ hasText: 'Loading archive' });
  await expect(status).toBeVisible();
  await expect(status.locator('svg')).toHaveCount(0);
  const plate = await status.locator('[aria-hidden="true"]').first().evaluate((element) => {
    const style = getComputedStyle(element);
    return { fill: style.backgroundColor, shadow: style.boxShadow, width: element.getBoundingClientRect().width };
  });
  expect(plate.fill).not.toBe('rgba(0, 0, 0, 0)');
  expect(plate.shadow).toContain('inset');
  expect(plate.width).toBeGreaterThan(60);
});

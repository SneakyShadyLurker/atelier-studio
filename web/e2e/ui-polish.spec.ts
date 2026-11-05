import { devices, expect, test, type Page } from '@playwright/test';
import type { CollectionsResponse, LibraryCoverageResponse, LibraryDiagnosisResponse } from '@atelier/shared';

const noHorizontalOverflow = (page: Page) => page.evaluate(() =>
  document.documentElement.scrollWidth <= window.innerWidth + 1,
);

async function templateBodyGeometry(editor: ReturnType<Page['locator']>, sixLines: boolean): Promise<void> {
  await expect.poll(() => editor.evaluate((form, minimum) => {
    const area = form.querySelector('textarea');
    const label = area?.closest('label')?.querySelector('span');
    const help = form.querySelector('[data-zone="body"] > p');
    const foot = form.querySelector('[data-zone="foot"]');
    if (!area || !label || !help || !foot) throw new Error('missing template zones');
    const areaBox = area.getBoundingClientRect();
    const footBox = foot.getBoundingClientRect();
    const style = getComputedStyle(area);
    const minimumHeight = 6 * Number.parseFloat(style.lineHeight) + 22;
    return label.getBoundingClientRect().bottom <= areaBox.top
      && areaBox.bottom <= help.getBoundingClientRect().top
      && help.getBoundingClientRect().bottom <= footBox.top
      && (!minimum || areaBox.height >= minimumHeight - 0.5);
  }, sixLines), 'body label, help and usable textarea stay above the footer').toBe(true);
}

async function withLongCollections(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let inner = window.fetch.bind(window);
    const fetchCollections = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const response = await inner(input, init);
      const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
      if (url.pathname !== '/api/collections') return response;
      const data = await response.json() as CollectionsResponse;
      const first = data.items[0];
      if (!first) throw new Error('missing collection fixture');
      return Response.json({
        ...data,
        items: Array.from({ length: 50 }, (_, index) => ({
          ...first, id: `collection-${String(index + 1)}`, name: `Collection ${String(index + 1)}`, archivedCount: 1,
        })),
      });
    };
    Object.defineProperty(window, 'fetch', {
      configurable: true,
      get: () => fetchCollections,
      set: (value: typeof fetch) => { inner = value; },
    });
  });
}

// Keep the studio's offline transport and data; vary only the two reports
// needed to expose the warning and pending-coverage controls.
async function withLibraryFindings(page: Page, pendingCoverage: boolean): Promise<void> {
  await page.addInitScript((pending) => {
    let inner = window.fetch.bind(window);
    const fetchReports = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const response = await inner(input, init);
      const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
      if (url.pathname === '/api/prompts/library-diagnosis') {
        const report = await response.json() as LibraryDiagnosisResponse;
        return Response.json({
          ...report,
          templates: report.templates.map((entry) => ({ ...entry, satisfiable: false, reason: 'Conflicting dimension choices' })),
        });
      }
      if (pending && url.pathname === '/api/prompts/library-coverage') {
        const report = await response.json() as LibraryCoverageResponse;
        return Response.json({ ...report, untaggedByList: [{ listId: 'lighting', listName: 'lighting', dim: 'Atmosphere', untaggedCount: 3 }] });
      }
      return response;
    };
    Object.defineProperty(window, 'fetch', {
      configurable: true,
      get: () => fetchReports,
      set: (value: typeof fetch) => { inner = value; },
    });
  }, pendingCoverage);
}

// Sample the real receiver across a 44px target, including the corners. The
// pending badge deliberately keeps a smaller painted box, so its sampled
// bounds include space above/below the chrome and just outside its sides.
async function libraryHitPoints(target: ReturnType<Page['locator']>, pending = false) {
  await target.scrollIntoViewIfNeeded();
  await target.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await Promise.all(document.getAnimations()
      .filter((animation) => animation.timeline === document.timeline
        && animation.playState === 'running' && animation.effect?.getTiming().iterations !== Infinity)
      .map((animation) => animation.finished.catch(() => undefined)));
  });
  await expect.poll(() => target.evaluate((element, extended) => {
    const box = element.getBoundingClientRect();
    const left = box.left + (extended ? -2 : 1);
    const right = box.right + (extended ? 2 : -1);
    const top = extended ? box.top + box.height / 2 - 21 : box.top + 1;
    const bottom = extended ? top + 42 : box.bottom - 1;
    const misses: { x: number; y: number; receiver: string | null }[] = [];
    const cornerInset = extended ? 0 : 3;
    const points = [
      { x: left + cornerInset, y: top }, { x: right - cornerInset, y: top },
      { x: left, y: (top + bottom) / 2 }, { x: right, y: (top + bottom) / 2 },
      { x: (left + right) / 2, y: (top + bottom) / 2 },
      { x: left + cornerInset, y: bottom }, { x: right - cornerInset, y: bottom },
    ];
    for (const { x, y } of points) {
      const receiver = document.elementFromPoint(x, y);
      if (receiver !== element && !element.contains(receiver)) misses.push({ x, y, receiver: receiver?.getAttribute('aria-label') ?? receiver?.tagName ?? null });
    }
    return { size: box.width >= 43.9 && (extended || box.height >= 43.9), misses };
  }, pending), 'every sampled point belongs to its intended control').toEqual({ size: true, misses: [] });
  return target.evaluate((element, extended) => {
    const box = element.getBoundingClientRect();
    const left = box.left + (extended ? -2 : 1);
    const right = box.right + (extended ? 2 : -1);
    const top = extended ? box.top + box.height / 2 - 21 : box.top + 1;
    const bottom = extended ? top + 42 : box.bottom - 1;
    const cornerInset = extended ? 0 : 3;
    return [{ x: left + cornerInset, y: top }, { x: right - cornerInset, y: top }, { x: left + cornerInset, y: bottom }, { x: right - cornerInset, y: bottom }];
  }, pending);
}

for (const viewport of [{ width: 390, height: 600 }, { width: 844, height: 390 }]) {
  test(`Prompt Library touch controls own their hit bounds at ${String(viewport.width)}×${String(viewport.height)}`, async ({ browser }) => {
    const context = await browser.newContext({ ...devices['iPhone 13'], viewport });
    try {
      const page = await context.newPage();
      await withLibraryFindings(page, true);
      await page.goto('/e2e/studio/index.html?view=prompts');
      const editor = page.getByRole('form', { name: 'Edit template Editorial portrait', exact: true });
      const title = editor.getByRole('textbox', { name: 'Template name', exact: true });
      for (let corner = 0; corner < 4; corner += 1) {
        const point = (await libraryHitPoints(title))[corner];
        if (!point) throw new Error('missing title hit point');
        await page.touchscreen.tap(point.x, point.y);
        await expect(title).toBeFocused();
        await page.keyboard.insertText('x');
        await expect(title).toHaveValue(/x/);
        await title.fill('Editorial portrait');
        await page.keyboard.press('Escape');
      }

      const disclosure = editor.getByRole('button', { name: 'Referenced lists, 1', exact: true });
      for (let corner = 0; corner < 4; corner += 1) {
        const wasOpen = await disclosure.getAttribute('aria-expanded');
        const point = (await libraryHitPoints(disclosure))[corner];
        if (!point) throw new Error('missing disclosure hit point');
        await page.touchscreen.tap(point.x, point.y);
        await expect(disclosure).toHaveAttribute('aria-expanded', wasOpen === 'true' ? 'false' : 'true');
        await templateBodyGeometry(editor, viewport.width >= 768);
      }

      const templates = page.getByRole('tab', { name: 'Templates', exact: true });
      const warning = page.getByRole('button', { name: 'Editorial portrait: unsatisfiable', exact: true });
      for (let corner = 0; corner < 4; corner += 1) {
        const point = (await libraryHitPoints(warning))[corner];
        if (!point) throw new Error('missing warning hit point');
        await page.touchscreen.tap(point.x, point.y);
        await expect(page.getByRole('tab', { name: 'Dimensions', exact: true })).toHaveAttribute('aria-selected', 'true');
        await expect(page.getByRole('heading', { name: '1 template currently unsatisfiable', exact: true })).toBeVisible();
        await templates.click();
      }

      await warning.scrollIntoViewIfNeeded();
      const resource = page.getByRole('complementary', { name: 'Templates' }).getByRole('button', { name: 'Editorial portrait', exact: true });
      const remove = page.getByRole('button', { name: 'Delete template Editorial portrait', exact: true });
      await page.getByRole('complementary', { name: 'Templates' }).getByRole('button', { name: 'Architecture study', exact: true }).click();
      await expect(resource).toHaveAttribute('aria-pressed', 'false');
      const boundary = await warning.evaluate((element) => {
        const row = element.closest('li');
        const select = row?.querySelector('button[aria-pressed]');
        const remove = row?.querySelector('button[aria-label^="Delete template"]');
        if (!select || !remove) throw new Error('missing adjacent template controls');
        const warnBox = element.getBoundingClientRect();
        const selectBox = select.getBoundingClientRect();
        const deleteBox = remove.getBoundingClientRect();
        const owns = (target: Element, x: number, y: number) => {
          const receiver = document.elementFromPoint(x, y);
          return receiver === target || target.contains(receiver);
        };
        const y = warnBox.top + warnBox.height / 2;
        return {
          separated: selectBox.right <= warnBox.left && warnBox.right <= deleteBox.left,
          selectOwns: owns(select, selectBox.right - 1, y),
          warningOwns: owns(element, warnBox.left + 1, y) && owns(element, warnBox.right - 1, y),
          deleteOwns: owns(remove, deleteBox.left + 1, y),
          selectPoint: { x: selectBox.right - 1, y },
          deletePoint: { x: deleteBox.left + 1, y },
        };
      });
      expect(boundary.separated && boundary.selectOwns && boundary.warningOwns && boundary.deleteOwns).toBe(true);
      await page.touchscreen.tap(boundary.selectPoint.x, boundary.selectPoint.y);
      await expect(resource).toHaveAttribute('aria-pressed', 'true');
      await expect(templates).toHaveAttribute('aria-selected', 'true');
      await page.touchscreen.tap(boundary.deletePoint.x, boundary.deletePoint.y);
      const confirmation = page.getByRole('dialog', { name: 'Delete template?' });
      await expect(confirmation).toBeVisible();
      await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(confirmation).toHaveCount(0);
      await expect(remove).toBeVisible();
      expect(await noHorizontalOverflow(page)).toBe(true);
    } finally {
      await context.close();
    }
  });

  for (const pending of [false, true]) {
    test(`Prompt Library ${pending ? 'pending' : 'healthy'} coverage responds across its touch target at ${String(viewport.width)}×${String(viewport.height)}`, async ({ browser }) => {
      const context = await browser.newContext({ ...devices['iPhone 13'], viewport });
      try {
        const page = await context.newPage();
        await withLibraryFindings(page, pending);
        await page.goto('/e2e/studio/index.html?view=prompts');
        await page.getByRole('tab', { name: 'Dimensions', exact: true }).click();
        const badge = page.getByRole('button', { name: /Coverage.*open coverage report/ });
        for (let corner = 0; corner < 4; corner += 1) {
          const point = (await libraryHitPoints(badge, pending))[corner];
          if (!point) throw new Error('missing coverage hit point');
          await page.touchscreen.tap(point.x, point.y);
          const report = page.getByRole('dialog', { name: 'Library coverage', exact: true });
          await expect(report).toBeVisible();
          await page.keyboard.press('Escape');
          await expect(report).toHaveCount(0);
        }
        if (pending) expect((await badge.boundingBox())?.height ?? 44, 'pending chrome stays small').toBeLessThan(44);
        expect(await noHorizontalOverflow(page)).toBe(true);
      } finally {
        await context.close();
      }
    });
  }
}

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`short landscape Template Editor scrolls without exhausting its body with ${reducedMotion} motion`, async ({ browser }) => {
    const context = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 844, height: 390 }, reducedMotion });
    try {
      const page = await context.newPage();
      await page.goto('/e2e/studio/index.html?view=prompts');
      const editor = page.getByRole('form', { name: 'Edit template Editorial portrait', exact: true });
      const toggle = editor.getByRole('button', { name: 'Referenced lists, 1', exact: true });
      await expect(editor).toBeVisible();
      for (const expanded of [true, false, true, false]) {
        await templateBodyGeometry(editor, true);
        const point = (await libraryHitPoints(toggle))[0];
        if (!point) throw new Error('missing disclosure point');
        await page.touchscreen.tap(point.x, point.y);
        await expect(toggle).toHaveAttribute('aria-expanded', String(expanded));
        await templateBodyGeometry(editor, true);
      }
      expect(await editor.evaluate((form) => form.scrollHeight > form.clientHeight)).toBe(true);
      await editor.getByRole('textbox', { name: 'Template name', exact: true }).scrollIntoViewIfNeeded();
      await expect(editor.getByRole('button', { name: 'Save template', exact: true })).toBeInViewport();
      expect(await noHorizontalOverflow(page)).toBe(true);
    } finally {
      await context.close();
    }
  });
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 1024, height: 768 }, { width: 390, height: 844 }]) {
  test(`normal Template Editor keeps its scroll composition at ${String(viewport.width)}×${String(viewport.height)}`, async ({ browser }) => {
    const context = await browser.newContext({ ...devices['iPhone 13'], viewport });
    try {
      const page = await context.newPage();
      await page.goto('/e2e/studio/index.html?view=prompts');
      const editor = page.getByRole('form', { name: 'Edit template Editorial portrait', exact: true });
      await expect(editor).toBeVisible();
      await templateBodyGeometry(editor, viewport.width >= 768);
      expect(await editor.evaluate((form) => form.scrollHeight - form.clientHeight)).toBeLessThanOrEqual(1);
      if (viewport.width < 768) {
        expect(await editor.evaluate((form) => getComputedStyle(form).overflowY)).toBe('visible');
        await editor.getByRole('button', { name: 'Referenced lists, 1', exact: true }).tap();
        await templateBodyGeometry(editor, false);
        await editor.getByRole('textbox', { name: 'Template name', exact: true }).scrollIntoViewIfNeeded();
        await expect(editor.getByRole('textbox', { name: 'Template name', exact: true })).toBeInViewport();
      }
    } finally {
      await context.close();
    }
  });
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
  for (const longCollections of [false, true]) {
    test(`Library rail ${longCollections ? 'long collections' : 'ordinary content'} stays reachable at ${String(viewport.width)}×${String(viewport.height)}`, async ({ browser }) => {
      // Visit every one of the 50 rows before exercising all navigation and
      // footer actions; allow the slower engine to finish that complete path.
      if (longCollections) test.setTimeout(60_000);
      const context = await browser.newContext({ ...devices['iPhone 13'], viewport });
      try {
        const page = await context.newPage();
        if (longCollections) await withLongCollections(page);
        await page.goto('/e2e/studio/index.html?textAdmin=1&textProvider=1');
        const aside = page.locator('#atelier-sidebar');
        const body = page.getByTestId('sidebar-rail-body');
        const phone = viewport.width < 768;
        const openRail = async () => {
          if (phone) {
            const opener = page.getByRole('button', { name: 'Open menu', exact: true });
            await libraryHitPoints(opener);
            await opener.tap();
          }
          else if (await page.getByRole('button', { name: 'Expand sidebar', exact: true }).isVisible()) {
            await page.getByRole('button', { name: 'Expand sidebar', exact: true }).tap();
          }
          if (phone) await expect(aside).toHaveAttribute('data-open', 'true');
          else await expect(aside).not.toHaveAttribute('data-collapsed', 'true');
          await expect(aside.getByRole('navigation', { name: 'Library' })).toBeVisible();
          if (phone) await libraryHitPoints(aside.getByRole('button', { name: 'Close menu', exact: true }));
        };
        await openRail();
        if (!longCollections && viewport.height > 390) {
          expect(await body.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
        } else {
          expect(await body.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
        }
        expect(await page.getByTestId('sidebar-feed').evaluate((element) => element.clientHeight)).toBeGreaterThanOrEqual(73);
        if (longCollections) {
          const rows = aside.getByRole('navigation', { name: 'Library' }).getByRole('button', { name: /^Collection \d+ \d+$/ });
          await expect(rows).toHaveCount(50);
          for (const row of await rows.all()) {
            await row.scrollIntoViewIfNeeded();
            await expect(row).toBeInViewport();
          }
          await rows.last().tap();
          await expect(page.locator('#atelier-feed-heading')).toHaveText('Collection 50');
          if (phone) await openRail();
          // The existing roving model still reveals the first row on Home.
          await rows.last().focus();
          await page.keyboard.press('Home');
          const unsorted = aside.getByRole('button', { name: /^Unsorted/ });
          await expect(unsorted).toBeFocused();
          await expect(unsorted).toBeInViewport();
          await page.keyboard.press('Enter');
          await expect(page.locator('#atelier-feed-heading')).toHaveText('Unsorted');
          if (phone) await openRail();
        }
        for (const name of ['Prompt Library', 'Text models', 'Archive']) {
          const action = aside.getByRole('button', { name, exact: true });
          await action.scrollIntoViewIfNeeded();
          await expectFloor(action, name);
          await action.tap();
          await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
          await page.getByRole('button', { name: 'Back to Unsorted', exact: true }).tap();
          await expect(page.locator('#atelier-feed-heading')).toHaveText('Unsorted');
          if (phone) await openRail();
        }
        const keys = aside.getByRole('button', { name: 'API keys', exact: true });
        await keys.scrollIntoViewIfNeeded();
        await expectFloor(keys, 'API keys');
        await keys.focus();
        await keys.press('Enter');
        await expect(page.getByRole('dialog')).toBeVisible();
        await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await expect(keys).toBeFocused();
        const theme = aside.getByRole('button', { name: /Switch to (dark|light) theme/ });
        await theme.scrollIntoViewIfNeeded();
        await expectFloor(theme, 'theme');
        const pressed = await theme.getAttribute('aria-pressed');
        await theme.tap();
        await expect(theme).toHaveAttribute('aria-pressed', pressed === 'true' ? 'false' : 'true');
        if (phone) {
          const containment = await aside.evaluate((element) => {
            const footer = element.querySelector('footer');
            if (!footer) throw new Error('missing footer');
            const style = getComputedStyle(element);
            const bounds = element.getBoundingClientRect();
            return footer.getBoundingClientRect().bottom <= bounds.bottom - Number.parseFloat(style.paddingBottom) + 1
              && bounds.left >= 0 && bounds.bottom <= innerHeight + 1;
          });
          expect(containment, 'drawer footer clears its safe-area padding').toBe(true);
          await page.keyboard.press('Escape');
          await expect(page.getByRole('button', { name: 'Open menu', exact: true })).toBeFocused();
        } else {
          await theme.focus();
          // Keep focus inside the scrolling body until the collapse owner
          // transfers it, rather than moving it to the header in the test.
          await aside.getByRole('button', { name: 'Collapse sidebar' }).evaluate((button: HTMLButtonElement) => { button.click(); });
          const expand = page.getByRole('button', { name: 'Expand sidebar', exact: true });
          await expect(expand).toBeFocused();
          expect(await aside.evaluate((element) => element.scrollLeft)).toBe(0);
          expect(await body.evaluate((element) => element.scrollLeft)).toBe(0);
          await expand.tap();
          await expect(aside.getByRole('button', { name: 'Collapse sidebar' })).toBeFocused();
          await libraryHitPoints(aside.getByRole('button', { name: 'Collapse sidebar' }));
        }
        expect(await aside.evaluate((element) => element.scrollLeft)).toBe(0);
        expect(await body.evaluate((element) => element.scrollLeft)).toBe(0);
        expect(await noHorizontalOverflow(page)).toBe(true);
      } finally {
        await context.close();
      }
    });
  }
}

test('Prompt Library finding controls keep the pointer-desktop layout contained', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await withLibraryFindings(page, true);
  await page.goto('/e2e/studio/index.html?view=prompts');
  await expect(page.getByRole('button', { name: 'Editorial portrait: unsatisfiable', exact: true })).toBeVisible();
  expect(await noHorizontalOverflow(page)).toBe(true);
  await page.getByRole('tab', { name: 'Dimensions', exact: true }).click();
  await expect(page.getByRole('button', { name: /Coverage.*open coverage report/ })).toBeVisible();
  expect(await noHorizontalOverflow(page)).toBe(true);
});

test('history Retry stays reachable above a tall expanded composer', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto('/e2e/studio/index.html?historyError=1');
  const retry = page.getByTestId('canvas-scroller').getByRole('button', { name: 'Retry', exact: true });
  await expect(retry).toBeVisible();
  await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill(Array.from({ length: 12 }, (_, index) => `Retained draft line ${index}`).join('\n'));
  const composer = page.locator('#atelier-composer');
  await expect.poll(() => composer.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(280);
  await page.getByTestId('canvas-scroller').evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => retry.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const dock = document.querySelector('#atelier-composer')?.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return dock !== undefined && box.bottom <= dock.top && (hit === element || element.contains(hit));
  })).toBe(true);
  await retry.click();
  await expect(page.getByRole('button', { name: 'Minimize composer', exact: true })).toBeVisible();
});

test('a selected library tab stays reachable when desktop shrinks to phone', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/e2e/studio/index.html?view=prompts');
  const settings = page.getByRole('tab', { name: 'Settings', exact: true });
  await settings.click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => settings.evaluate((element) => {
    const strip = element.closest('[role="tablist"]');
    if (!strip) return false;
    const box = element.getBoundingClientRect();
    const stripBox = strip.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return box.left >= stripBox.left - 1 && box.right <= stripBox.right + 1
      && (hit === element || element.contains(hit));
  })).toBe(true);
  expect(await noHorizontalOverflow(page)).toBe(true);
});

test('full studio shell remains contained on desktop and tablet', async ({ page }) => {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 834, height: 1194 }]) {
    await page.setViewportSize(viewport);
    await page.goto('/e2e/studio/index.html?view=prompts');
    await expect(page.getByRole('form', { name: /Edit template/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Back to Unsorted' })).toBeVisible();
    expect(await noHorizontalOverflow(page)).toBe(true);

    if (viewport.width === 834) {
      await page.getByRole('button', { name: 'Expand sidebar' }).click();
      const editor = await page.getByRole('form', { name: /Edit template/ }).boundingBox();
      if (!editor) throw new Error('Missing tablet template editor');
      expect(editor.width).toBeGreaterThanOrEqual(320);
      await page.getByRole('button', { name: 'Collapse sidebar' }).click();
      const back = page.getByRole('button', { name: 'Back to Unsorted' });
      const hitTarget = await back.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return hit === element || element.contains(hit);
      });
      expect(hitTarget).toBe(true);
    }

    await page.getByRole('tab', { name: 'Dimensions' }).click();
    await expect(page.getByRole('form', { name: /Edit dimension/ })).toBeVisible();
    expect(await noHorizontalOverflow(page)).toBe(true);
    if (viewport.width === 834) {
      await page.getByRole('button', { name: 'Back to Unsorted' }).click();
      await expect(page.getByTestId('feed')).toBeVisible();
    }
  }
});

test('phone studio shell stays within the visual viewport', async ({ browser }) => {
  const context = await browser.newContext({ ...devices['iPhone 13'] });
  try {
    const page = await context.newPage();
    await page.goto('/e2e/studio/index.html?view=prompts');
    await expect(page.getByRole('form', { name: /Edit template/ })).toBeVisible();
    expect(await noHorizontalOverflow(page)).toBe(true);
    await page.getByRole('button', { name: 'Back to Unsorted' }).click();
    await expect(page.getByTestId('feed')).toBeVisible();
    expect(await noHorizontalOverflow(page)).toBe(true);
  } finally {
    await context.close();
  }
});

test('a tall dialog keeps its final action reachable in short landscape', async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await page.goto('/e2e/harness/index.html?case=tall-dialog');
  const card = page.locator('dialog[open] > div');
  await expect(card).toBeVisible();
  const bounds = await card.boundingBox();
  if (!bounds) throw new Error('Missing dialog card');
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(390);
  await page.getByRole('button', { name: 'Finish' }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: 'Finish' })).toBeInViewport();
});

test('touch tile actions wrap without clipping their controls', async ({ browser }) => {
  const context = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 375, height: 667 } });
  try {
    const page = await context.newPage();
    await page.goto('/e2e/harness/index.html?case=tile-actions');
    const tile = page.locator('main > div');
    await expect(tile).toBeVisible();
    await tile.evaluate(async (element) => {
      await Promise.all(element.getAnimations({ subtree: true })
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)));
    });
    const { tileBox, buttons } = await tile.evaluate((element) => {
      const rect = (node: Element) => {
        const { x, y, width, height } = node.getBoundingClientRect();
        return { x, y, width, height };
      };
      return { tileBox: rect(element), buttons: Array.from(element.querySelectorAll('button'), rect) };
    });
    for (const box of buttons) {
      expect(box.x).toBeGreaterThanOrEqual(tileBox.x - 1);
      expect(box.x + box.width).toBeLessThanOrEqual(tileBox.x + tileBox.width + 1);
      expect(box.y).toBeGreaterThanOrEqual(tileBox.y - 1);
      expect(box.y + box.height).toBeLessThanOrEqual(tileBox.y + tileBox.height + 1);
      expect(box.height).toBeGreaterThanOrEqual(43.9);
    }
  } finally {
    await context.close();
  }
});

test('actionable toast keeps its label legible on hover', async ({ page }) => {
  await page.goto('/e2e/studio/index.html?toast=1');
  const action = page.getByRole('button', { name: 'Undo', exact: true });
  await expect(action).toBeVisible();
  await action.hover();
  const contrast = await action.evaluate((element) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Missing canvas');
    const sample = (color: string): number[] => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data);
    };
    const foreground = sample(getComputedStyle(element).color);
    const parent = element.parentElement;
    if (!parent) throw new Error('Missing toast');
    const base = sample(getComputedStyle(parent).backgroundColor);
    const overlay = sample(getComputedStyle(element).backgroundColor);
    const alpha = (overlay[3] ?? 0) / 255;
    const composite = [0, 1, 2].map((index) => (overlay[index] ?? 0) * alpha + (base[index] ?? 0) * (1 - alpha));
    const luminance = (channels: number[]) => {
      const linear = channels.slice(0, 3).map((value) => {
        const normalized = value / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return (linear[0] ?? 0) * 0.2126 + (linear[1] ?? 0) * 0.7152 + (linear[2] ?? 0) * 0.0722;
    };
    const a = luminance(foreground);
    const b = luminance(composite);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
});

test('every form factor shows one scope title and the collapsed hamburger clears it', async ({ page }) => {
  const scopeHeader = async () => page.evaluate(() => {
    const heading = document.getElementById('atelier-feed-heading');
    const activeRow = document.querySelector('nav[aria-label="Library"] button[aria-current="page"]');
    const rowLabel = activeRow ? Array.from(activeRow.children, (part) => part.textContent).find((text) => text === heading?.textContent) : undefined;
    const scroller = document.querySelector('[data-testid="canvas-scroller"]');
    const header = heading?.closest('header');
    const headings = Array.from(document.querySelectorAll('main h1, main h2, main h3, main [role="heading"]'))
      // The column's top bar: every heading in main outside the feed scroller.
      .filter((node) => node.getClientRects().length > 0 && scroller !== null && !scroller.contains(node));
    return {
      title: heading?.textContent ?? null,
      rowLabel: rowLabel ?? null,
      topBarHeadings: headings.length,
      labelledBy: scroller?.getAttribute('aria-labelledby') ?? null,
      headerBottom: header?.getBoundingClientRect().bottom ?? Number.NaN,
      headingLeft: heading?.getBoundingClientRect().left ?? Number.NaN,
      scrollerTop: scroller?.getBoundingClientRect().top ?? Number.NaN,
      scrollerLeft: scroller?.getBoundingClientRect().left ?? Number.NaN,
    };
  });

  for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 820, height: 1180 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    for (const [search, title] of [['', 'Unsorted'], ['?c=campaign', 'Campaign studies']] as const) {
      await page.goto(`/e2e/studio/index.html${search}`);
      await expect(page.locator('#atelier-feed-heading')).toHaveText(title);
      const state = await scopeHeader();
      expect(state.rowLabel).toBe(title);
      expect(state.topBarHeadings).toBe(1);
      expect(state.labelledBy).toBe('atelier-feed-heading');
    }
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/e2e/studio/index.html');
  await expect(page.locator('#atelier-feed-heading')).toHaveText('Unsorted');
  // Rail header glyphs (Search, Archive all) draw at the batch header's glyph size.
  const glyphSize = async (name: string, scope: string) => page.locator(scope)
    .getByRole('button', { name, exact: true }).first().locator('svg')
    .evaluate((svg) => { const box = svg.getBoundingClientRect(); return [box.width, box.height]; });
  const batchGlyph = await glyphSize('Archive batch', 'main');
  expect(batchGlyph).toEqual([14, 14]);
  expect(await glyphSize('Search prompts', 'aside[aria-label="Sidebar"]')).toEqual(batchGlyph);
  expect(await glyphSize('Archive all', 'aside[aria-label="Sidebar"]')).toEqual(batchGlyph);
  const expanded = await scopeHeader();
  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  const hamburger = page.getByRole('button', { name: 'Expand sidebar' });
  await expect(hamburger).toBeVisible();
  await expect.poll(async () => (await scopeHeader()).scrollerLeft).toBeLessThan(expanded.scrollerLeft - 100);
  const collapsed = await scopeHeader();
  const burger = await hamburger.boundingBox();
  if (!burger) throw new Error('Missing sidebar expand button');
  expect(burger.height).toBeGreaterThanOrEqual(43.9);
  // The title clears the 44px hamburger instead of sitting under it.
  expect(collapsed.headingLeft).toBeGreaterThanOrEqual(burger.x + burger.width);
  // No extra band: the feed starts right under the header, and collapsing
  // moves the feed horizontally only.
  expect(collapsed.scrollerTop - collapsed.headerBottom).toBeLessThan(20);
  expect(Math.abs(collapsed.scrollerTop - expanded.scrollerTop)).toBeLessThanOrEqual(1);
});

// M1 (T5): AI actions stay enabled without a text model and answer with an
// anchored note instead of a request.
test.describe('AI actions without a text model', () => {
  test('Enhance opens a note anchored below it, and Escape plays the exit and returns focus', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/e2e/studio/index.html?noTextModels=1');
    await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill('A quiet harbour at dawn');
    // includeHidden: the open note inerts and aria-hides the app beneath it.
    const enhance = page.getByRole('button', { name: 'Enhance', exact: true, includeHidden: true });
    await expect(enhance).toBeEnabled();
    await enhance.click();
    const note = page.getByRole('dialog', { name: 'Enhance needs a text model.' });
    await expect(note).toBeVisible();
    await expect(note).toContainText('Ask your admin to connect a text model.');
    await expect(note).toHaveAttribute('data-anchored', 'source');
    // Settled placement: on the button's block axis (below-start, or its
    // native flip above when the composer leaves no room below), never over
    // it, with left edges aligned.
    await expect.poll(async () => {
      const [anchor, panel] = await Promise.all([enhance.boundingBox(), note.boundingBox()]);
      if (!anchor || !panel) return false;
      const below = panel.y >= anchor.y + anchor.height;
      const above = panel.y + panel.height <= anchor.y;
      return (below || above) && Math.abs(panel.x - anchor.x) <= 1;
    }).toBe(true);
    // No request went out, so no error toast speaks (the assertive region
    // carries every non-actionable error toast).
    await expect(page.locator('[aria-live="assertive"]')).toHaveText('');

    // The exit plays on the still-mounted panel before it unmounts: record
    // the surface's exit motion as it starts, so a loaded machine that
    // finishes the short beat before a sample cannot hide it.
    await note.evaluate((element) => {
      const seen: string[] = [];
      (window as unknown as { noteExit: string[] }).noteExit = seen;
      const record = (event: Event) => { seen.push(`${event.type}:${element.getAttribute('data-closing') ?? ''}`); };
      element.addEventListener('transitionrun', record);
      element.addEventListener('animationstart', record);
    });
    await page.keyboard.press('Escape');
    await expect(note).toHaveCount(0);
    const exitEvents = await page.evaluate(() => (window as unknown as { noteExit: string[] }).noteExit);
    expect(exitEvents.some((entry) => entry.endsWith(':true'))).toBe(true);
    await expect(enhance).toBeFocused();
  });

  test('inside the picker, Escape closes only the note and the picker stays open', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/e2e/studio/index.html?noTextModels=1');
    await page.getByRole('button', { name: 'Templates', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Templates' });
    await expect(picker).toBeVisible();
    const brainstorm = picker.getByRole('button', { name: 'Brainstorm' });
    await brainstorm.click();
    const note = page.getByRole('dialog', { name: 'Brainstorm needs a text model.' });
    await expect(note).toBeVisible();
    // Pressing inside the note is inside the picker's layer: it stays open.
    await note.click();
    await expect(picker).toBeVisible();
    // The note always holds a control, so Tab stays inside it both ways and a
    // later Escape cannot reach the picker underneath.
    await page.keyboard.press('Shift+Tab');
    expect(await note.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Tab');
    expect(await note.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(note).toHaveCount(0);
    await expect(picker).toBeVisible();
    await expect(picker).not.toHaveAttribute('data-closing', 'true');
    await expect(brainstorm).toBeFocused();
  });
});

/*
 * Touch floors on capability (`(hover: none), (any-pointer: coarse)`). The iPad
 * descriptor keeps the desktop layout (810px) but is touch, which is exactly
 * what a width-only floor missed. The spec runs in the chromium and webkit-ui
 * projects, so each floor is proven in both engines.
 */
const { defaultBrowserType: _ipadEngine, ...IPAD } = devices['iPad (gen 7)'];

async function expectFloor(locator: ReturnType<Page['locator']>, label: string, min = 44): Promise<void> {
  await expect(locator, label).toBeVisible();
  const rect = await locator.boundingBox();
  if (!rect) throw new Error(`${label}: no box`);
  expect(rect.width, `${label} width`).toBeGreaterThanOrEqual(min - 0.1);
  expect(rect.height, `${label} height`).toBeGreaterThanOrEqual(min - 0.1);
}

/**
 * A glyph-sized control with an invisible 44px hit area (::before): the area
 * computes to 44×44 and takes every tap sampled across it. Sampling starts a
 * few pixels in, clear of the clipped parent's rounded corner.
 */
async function expectHitArea(locator: ReturnType<Page['locator']>, label: string): Promise<void> {
  const result = await locator.evaluate((element) => {
    const area = getComputedStyle(element, '::before');
    const glyph = element.getBoundingClientRect();
    const clip = element.parentElement?.getBoundingClientRect() ?? glyph;
    const right = Math.min(clip.right, glyph.right + 3) - 4;
    const top = Math.max(clip.top, glyph.top - 3) + 4;
    let misses = 0;
    for (let dx = 0; dx <= 38; dx += 2) {
      for (let dy = 0; dy <= 38; dy += 2) {
        const hit = document.elementFromPoint(right - dx, top + dy);
        if (!(hit === element || element.contains(hit))) misses += 1;
      }
    }
    return { width: Number.parseFloat(area.width), height: Number.parseFloat(area.height), misses };
  });
  expect(result.width, `${label} hit width`).toBeGreaterThanOrEqual(44);
  expect(result.height, `${label} hit height`).toBeGreaterThanOrEqual(44);
  expect(result.misses, `${label}: sampled points that miss it`).toBe(0);
}

test.describe('touch floors on an iPad (hover: none)', () => {
  test.use(IPAD);

  test('rail, composer, toast and viewer controls measure at least 44×44', async ({ page }) => {
    await page.goto('/e2e/studio/index.html?toast=1');
    expect(await page.evaluate(() => matchMedia('(hover: none), (any-pointer: coarse)').matches)).toBe(true);
    // Below 900px the rail starts collapsed; its floors are measured open.
    await expectFloor(page.getByRole('button', { name: 'Expand sidebar' }), 'expand sidebar');
    await page.getByRole('button', { name: 'Expand sidebar' }).click();
    const rail = page.getByRole('navigation', { name: 'Library' });
    await expectFloor(page.getByRole('button', { name: 'Collapse sidebar' }), 'collapse');
    await expectFloor(page.getByRole('button', { name: /Switch to (dark|light) theme/ }), 'theme');
    await expectFloor(page.getByRole('button', { name: 'API keys' }), 'settings');
    await expectFloor(rail.getByRole('button').first(), 'library row');
    await expectFloor(page.getByRole('button', { name: 'Archive', exact: true }), 'archive row');
    await page.getByRole('button', { name: 'Search prompts' }).click();
    await expectFloor(page.getByRole('searchbox', { name: 'Search prompts' }).or(page.getByRole('textbox', { name: 'Search prompts' })), 'search input');
    await page.keyboard.press('Escape');

    const expandComposer = page.getByRole('button', { name: 'Expand composer', exact: true });
    if (await expandComposer.isVisible()) await expandComposer.click();
    await expectFloor(page.getByRole('button', { name: 'Model', exact: true }), 'model chip');
    await expectFloor(page.getByRole('button', { name: 'Attach reference images' }), 'attach');
    await expectFloor(page.getByRole('button', { name: 'Undo', exact: true }), 'toast Undo');

    await page.getByRole('button', { name: /^Open image 1/ }).first().click();
    await expectFloor(page.getByRole('button', { name: 'Close lightbox' }), 'viewer close');
  });

  test('picker axis menu and Prompt Library controls measure at least 44×44', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?case=picker');
    await page.getByRole('button', { name: 'Harness template' }).click();
    await page.getByRole('button', { name: /^Advanced/ }).click();
    const trigger = page.getByRole('button', { name: /Choose mood value/ });
    await expectFloor(trigger, 'axis trigger', 44);
    expect((await trigger.boundingBox())?.height ?? 0, 'axis trigger height').toBeGreaterThanOrEqual(47.9);
    await expectFloor(page.getByRole('button', { name: /^Advanced/ }), 'advanced toggle');
    await trigger.click();
    const menu = page.locator('[role="dialog"][data-axis-menu="true"]');
    await expectFloor(menu.getByRole('button', { name: 'Close', exact: true }), 'axis menu close');
    await expectFloor(menu.getByRole('textbox'), 'axis menu filter');
    await expectFloor(menu.getByRole('option').or(menu.getByRole('button').filter({ hasNotText: /^$/ })).nth(1), 'axis menu row');

    await page.goto('/e2e/harness/index.html?case=library');
    await expectFloor(page.getByRole('tab', { name: 'Templates' }), 'library tab');
    await page.getByRole('tab', { name: 'Variable lists' }).click();
    const editor = page.getByRole('form', { name: 'Edit variable list mood' });
    await expectFloor(editor.getByRole('button', { name: /^Reorder / }).first(), 'option grip');
    await expectFloor(editor.getByRole('spinbutton').first(), 'option weight');
    await expectFloor(editor.getByRole('button', { name: /^Remove option / }).first(), 'option remove');
  });

  test('the composer source still clear and the motion prompt meet the touch floor', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?case=frontend-i2v&source=1');
    await expectHitArea(page.getByRole('button', { name: 'Remove source still' }), 'source clear');
    const fontSize = await page.getByRole('textbox', { name: 'Motion prompt' }).evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
    expect(fontSize).toBeGreaterThanOrEqual(16);
  });
});

test('phone drawer hides and pauses the Undo toast, then hands it back with its remaining time', async ({ browser }) => {
  const context = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage();
    await page.goto('/e2e/studio/index.html?toast=1&toastMs=1500');
    const undo = page.getByRole('button', { name: 'Undo', exact: true });
    await expect(undo).toBeVisible();
    await page.getByRole('button', { name: 'Open menu' }).click();
    const archive = page.getByRole('button', { name: 'Archive', exact: true });
    await expect(archive).toBeVisible();
    await page.waitForTimeout(400);
    // The Archive row takes its own taps; the stack fades and the toast is inert and hidden.
    expect(await archive.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return hit === element || element.contains(hit);
    })).toBe(true);
    const stack = await page.evaluate(() => {
      const button = Array.from(document.querySelectorAll('button')).find((element) => element.textContent === 'Undo');
      const toast = button?.parentElement;
      const element = toast?.parentElement;
      return toast && element ? { inert: toast.inert, hidden: toast.getAttribute('aria-hidden'), opacity: getComputedStyle(element).opacity } : null;
    });
    expect(stack).toEqual({ inert: true, hidden: 'true', opacity: '0' });
    await expect(undo).toHaveCount(0); // out of the accessibility tree
    // Outlast the toast's whole life while covered: the timer is held.
    await page.waitForTimeout(2000);
    await page.getByRole('button', { name: 'Close menu' }).click();
    await expect(undo).toBeVisible();
    await expect.poll(() => undo.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return hit === element || element.contains(hit);
    })).toBe(true);
    // The remaining time (under 1.5s) still runs out once uncovered.
    await expect(undo).toHaveCount(0, { timeout: 3000 });
  } finally {
    await context.close();
  }
});

test('the composer toolbar beside the open rail wraps to at most two rows at 820px', async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.goto('/e2e/studio/index.html');
  // Below 900px the rail starts collapsed; the audit's three-row case is with it open.
  await page.getByRole('button', { name: 'Expand sidebar' }).click();
  await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toBeInViewport();
  const expandComposer = page.getByRole('button', { name: 'Expand composer', exact: true });
  if (await expandComposer.isVisible()) await expandComposer.click();
  await expect(page.getByRole('button', { name: 'Generate', exact: true })).toBeVisible();
  await page.waitForTimeout(400);
  const tops = await page.locator('#atelier-composer').evaluate((composer) => {
    const toolbar = ['Templates', 'Enhance', 'Undo enhance', 'Model', 'Ratio', 'Count', 'Clear prompt and reference images', 'Generate'];
    const rows: number[] = [];
    for (const button of composer.querySelectorAll('button')) {
      const name = button.getAttribute('aria-label') ?? button.textContent.trim();
      if (!toolbar.includes(name)) continue;
      const box = button.getBoundingClientRect();
      if (box.width === 0) continue;
      const centre = box.top + box.height / 2;
      if (!rows.some((row) => Math.abs(row - centre) < 12)) rows.push(centre);
    }
    return rows.sort((a, b) => a - b);
  });
  expect(tops.length).toBeGreaterThan(0);
  expect(tops.length).toBeLessThanOrEqual(2);
});

// Fully loaded history has no sentinel and no Retry, so its "Start" divider
// keeps only the hairline and its label. Reserving the hidden Retry row there
// left ~45px (~60px on touch) of empty band above the feed's first batch.
const startDividerHeights = (page: Page) => Promise.all(
  [page.getByTestId('canvas-scroller'), page.getByTestId('sidebar-feed')].map(async (scope) => {
    const label = scope.getByRole('status').filter({ hasText: /^Start, \d+ batch/ });
    await expect(label).toBeVisible();
    return label.evaluate((element) => element.parentElement?.getBoundingClientRect().height ?? Infinity);
  }),
);

for (const [name, options] of [['desktop', { viewport: { width: 1440, height: 900 } }], ['iPad touch', IPAD]] as const) {
  test(`the fully loaded history Start divider stays compact on ${name}`, async ({ browser }) => {
    const context = await browser.newContext(options);
    const page = await context.newPage();
    await page.goto('/e2e/studio/index.html');
    if (name === 'iPad touch') await page.getByRole('button', { name: 'Expand sidebar' }).click();
    await page.evaluate(() => document.fonts.ready);
    for (const height of await startDividerHeights(page)) expect(height).toBeLessThanOrEqual(52);
    await context.close();
  });
}

// The divider shrinks to its end footprint in the same commit that prepends
// the last page above the reader. Both feeds must still hold the row the
// reader is looking at, in every frame, not just after the settle.
test('the last history page lands without moving the reader in either feed', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/e2e/studio/index.html?paged=1&batches=150&pageDelay=400');
  const canvas = page.getByTestId('canvas-scroller');
  const rail = page.getByTestId('sidebar-feed');
  const done = canvas.getByRole('status').filter({ hasText: /^Start, \d+ batches$/ });
  await expect(canvas.locator('[data-index]').first()).toBeAttached();
  await page.evaluate(() => document.fonts.ready);
  // Let the first older page settle, then take the Canvas over from its
  // landing pin with a real gesture, as a reader would.
  await expect(canvas.getByRole('status').filter({ hasText: 'Loading more' })).toHaveCount(0);
  await canvas.hover();
  await page.mouse.wheel(0, -200);
  await page.waitForTimeout(500);
  // Each pass scrolls both feeds to the top (the sentinel fetches the next
  // older page) and samples one row per feed every frame while it lands.
  const passes: { missing: number; spread: number }[][] = [];
  for (let pass = 0; pass < 10 && !(await done.isVisible()); pass += 1) {
    passes.push(await page.evaluate(async () => {
      const scrollers = ['canvas-scroller', 'sidebar-feed'].map((id) => {
        const scroller = document.querySelector(`[data-testid="${id}"]`);
        if (!(scroller instanceof HTMLElement)) throw new Error(`missing ${id}`);
        scroller.scrollTop = 0;
        return scroller;
      });
      // Two frames for the virtualizers to render the rows now at the top;
      // the older page is still held by `pageDelay`.
      for (let frame = 0; frame < 2; frame += 1) await new Promise((resolve) => requestAnimationFrame(resolve));
      const rows = scrollers.map((scroller) => {
        const top = scroller.getBoundingClientRect().top;
        const row = Array.from(scroller.querySelectorAll<HTMLElement>('[data-index]'))
          .find((candidate) => candidate.getBoundingClientRect().bottom > top + 40);
        if (!row) throw new Error('no visible row');
        // Virtual rows may remount and their indexes shift on a prepend, so
        // each frame re-finds the row by its batch (Canvas) or its text (rail).
        const identity = (candidate: HTMLElement) => candidate.dataset.batchId ?? candidate.textContent;
        const key = identity(row);
        const find = () => Array.from(scroller.querySelectorAll<HTMLElement>('[data-index]')).find((candidate) => identity(candidate) === key);
        return { find, samples: [] as number[], missing: 0 };
      });
      const until = performance.now() + 1200;
      while (performance.now() < until) {
        for (const entry of rows) {
          const row = entry.find();
          if (row) entry.samples.push(row.getBoundingClientRect().top);
          else entry.missing += 1;
        }
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      return rows.map(({ samples, missing }) => ({ missing, spread: Math.max(...samples) - Math.min(...samples) }));
    }));
  }
  await expect(done).toBeVisible();
  await expect(rail.getByRole('status').filter({ hasText: /^Start, \d+ batches$/ })).toBeAttached();
  expect(passes.length).toBeGreaterThan(0);
  for (const pass of passes) {
    for (const { missing, spread } of pass) {
      expect(missing, JSON.stringify(passes)).toBe(0);
      expect(spread, JSON.stringify(passes)).toBeLessThanOrEqual(2);
    }
  }
});

// A reader pinned at the end is already held by the browser's clamp when the
// divider above shrinks; the feed must not subtract that shrink again.
test('a reader at the end stays at the end when the last history page lands', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/e2e/studio/index.html?paged=1&batches=40&pageDelay=1500');
  const canvas = page.getByTestId('canvas-scroller');
  await expect(canvas.getByRole('status').filter({ hasText: 'Loading more' })).toBeAttached();
  // A real gesture ends the Canvas landing pin, so only the feed's own
  // anchoring keeps the reader at the end (then back to the end by script).
  await canvas.hover();
  await page.mouse.wheel(0, -200);
  await page.waitForTimeout(150);
  const fromEnd = () => page.evaluate(() => ['canvas-scroller', 'sidebar-feed'].map((id) => {
    const scroller = document.querySelector(`[data-testid="${id}"]`);
    if (!(scroller instanceof HTMLElement)) throw new Error(`missing ${id}`);
    return scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
  }));
  await page.evaluate(() => {
    for (const id of ['canvas-scroller', 'sidebar-feed']) {
      const scroller = document.querySelector(`[data-testid="${id}"]`);
      if (scroller instanceof HTMLElement) scroller.scrollTop = scroller.scrollHeight;
    }
  });
  await expect.poll(async () => (await fromEnd()).every((distance) => distance <= 1)).toBe(true);
  await expect(canvas.getByRole('status').filter({ hasText: /^Start, \d+ batches$/ })).toBeAttached();
  await page.waitForTimeout(400);
  for (const distance of await fromEnd()) expect(distance).toBeLessThanOrEqual(1);
});

// Archive's footer sits below its deferred grid: the end footprint must
// shrink in the commit that appends the last page, not one before it, or a
// reader at the bottom is clamped and the grid drops.
test('the Archive last page lands without moving a reader at the bottom', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/e2e/harness/archive.html?paged=1&pageDelay=500');
  const grid = page.locator('[data-virtualized="archive"]');
  await expect(grid.locator('[data-index]').first()).toBeAttached();
  await page.evaluate(() => document.fonts.ready);
  const spread = await grid.evaluate(async (element) => {
    const scroller = element.parentElement;
    if (!scroller) throw new Error('missing scroller');
    scroller.scrollTop = scroller.scrollHeight;
    for (let frame = 0; frame < 2; frame += 1) await new Promise((resolve) => requestAnimationFrame(resolve));
    const bottom = scroller.getBoundingClientRect().bottom;
    const rows = Array.from(element.querySelectorAll<HTMLElement>('[data-index]'));
    const row = rows.filter((candidate) => candidate.getBoundingClientRect().top < bottom - 40).at(-1);
    if (!row) throw new Error('no visible row');
    const index = row.dataset.index;
    const samples: number[] = [];
    const until = performance.now() + 1500;
    while (performance.now() < until) {
      const current = element.querySelector<HTMLElement>(`[data-index="${String(index)}"]`);
      if (current) samples.push(current.getBoundingClientRect().top);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return Math.max(...samples) - Math.min(...samples);
  });
  await expect(page.getByRole('status').filter({ hasText: /^End, \d+ archived$/ })).toBeAttached();
  expect(spread).toBeLessThanOrEqual(2);
});

test.describe('layout stability (T9)', () => {
  test('the viewer toolbar keeps its width and the position field stays put when the image decodes', async ({ page }) => {
    let release: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/e2e/motion-image.svg?*', async (route) => {
      await ready;
      await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="2400"><rect width="2400" height="2400" fill="#78949b"/></svg>' });
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/e2e/studio/index.html?motionMedia=1');
    await page.getByRole('button', { name: 'Expand tile 1', exact: true }).first().click();
    const dialog = page.locator('dialog[open]');
    const position = dialog.locator('li').filter({ hasText: /^\d+ of \d+$/ });
    await expect(position).toBeVisible();
    const toolbar = position.locator('xpath=ancestor::div[.//button[@aria-label="Download expanded image"]][1]');
    await page.waitForTimeout(400);
    const measure = async () => ({ toolbar: await toolbar.boundingBox(), position: await position.boundingBox() });
    const before = await measure();
    await expect(dialog.getByText('…', { exact: true })).toHaveCount(0);
    release();
    await expect(dialog.locator('img[alt^="Expanded generated image"]')).toHaveJSProperty('complete', true);
    await expect(dialog.getByRole('button', { name: 'Zoom to full resolution' })).toBeVisible();
    await page.waitForTimeout(300);
    const after = await measure();
    expect(before.toolbar && after.toolbar && before.position && after.position).toBeTruthy();
    expect(Math.abs((after.toolbar?.width ?? 0) - (before.toolbar?.width ?? 0)), 'toolbar width across decode').toBeLessThan(0.5);
    expect(Math.abs((after.position?.x ?? 0) - (before.position?.x ?? 0)), '"1 of N" x across decode').toBeLessThan(0.5);
  });

  test('a phone reference strip at the reference cap scrolls sideways above a wrapping toolbar', async ({ browser }) => {
    const context = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 } });
    try {
      const page = await context.newPage();
      await page.goto('/e2e/studio/index.html?refs=1&refCount=10');
      await page.locator('section[data-batch-id="studio-batch-4"]').getByRole('button', { name: /^Open image 1/ }).click();
      const first = page.getByRole('button', { name: 'View reference image 1 of 10' });
      await expect(first).toBeVisible();
      await page.waitForTimeout(400);
      const geometry = await first.evaluate((element) => {
        const strip = element.parentElement;
        const toolbar = document.querySelector('dialog[open] button[aria-label="Download expanded image"]')?.parentElement;
        if (!strip || !toolbar) return null;
        const stripBox = strip.getBoundingClientRect();
        const barBox = toolbar.getBoundingClientRect();
        return {
          overflow: strip.scrollWidth - strip.clientWidth,
          widths: Array.from(strip.querySelectorAll('button'), (button) => button.getBoundingClientRect().width),
          left: stripBox.left,
          right: stripBox.right,
          gap: barBox.top - stripBox.bottom,
          barRows: new Set(Array.from(toolbar.children, (child) => Math.round(child.getBoundingClientRect().top))).size,
        };
      });
      expect(geometry).not.toBeNull();
      if (!geometry) return;
      expect(geometry.widths).toHaveLength(11);
      for (const width of geometry.widths) expect(width).toBeCloseTo(44, 0);
      expect(geometry.overflow, 'the strip scrolls horizontally').toBeGreaterThan(0);
      expect(geometry.left).toBeGreaterThanOrEqual(0);
      expect(geometry.right).toBeLessThanOrEqual(390);
      expect(geometry.barRows, 'the phone toolbar wraps').toBeGreaterThan(1);
      expect(geometry.gap, 'the strip sits above the toolbar').toBeGreaterThanOrEqual(0);
    } finally {
      await context.close();
    }
  });

  test('the composer source slot is 64px tall with and without a still', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const footprint = async () => {
      const expand = page.getByRole('button', { name: 'Expand composer', exact: true });
      if (await expand.isVisible()) await expand.click();
      const slot = page.locator('#atelier-composer [data-zone="i2v"] > div').first().locator('> :first-child');
      await expect(slot).toBeVisible();
      return slot.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const row = element.parentElement?.getBoundingClientRect();
        return { width: box.width, height: box.height, row: row?.height ?? 0 };
      });
    };
    await page.goto('/e2e/harness/index.html?case=frontend-i2v');
    await expect(page.getByRole('button', { name: 'Add source still' })).toBeAttached();
    const empty = await footprint();
    await page.goto('/e2e/harness/index.html?case=frontend-i2v&source=1');
    await expect(page.getByRole('button', { name: 'Remove source still' })).toBeAttached();
    const chosen = await footprint();
    expect(empty).toEqual({ width: 64, height: 64, row: chosen.row });
    expect(chosen.width).toBe(64);
    expect(chosen.height).toBe(64);
  });

  test('the load-more row keeps one height while more can load, and the end row drops the reserve', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?case=infinite-status');
    const heights = await page.locator('[data-infinite-state]').evaluateAll((cells) => Object.fromEntries(cells.map((cell) => [
      cell.getAttribute('data-infinite-state') ?? '',
      cell.firstElementChild?.getBoundingClientRect().height ?? 0,
    ])));
    expect(Object.keys(heights)).toEqual(['idle', 'loading', 'error', 'end']);
    const { end, ...pending } = heights;
    expect(new Set(Object.values(pending).map((height) => Math.round(height * 10) / 10)).size, JSON.stringify(heights)).toBe(1);
    expect(end, JSON.stringify(heights)).toBeLessThan((pending.idle ?? 0) - 30);
  });

  test('collapsing the sidebar slides the feed sideways and re-measures it without a vertical jump', async ({ page, browserName }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto('/e2e/studio/index.html?batches=6');
    await expect(page.getByTestId('feed')).toBeVisible();
    await page.waitForTimeout(800);
    // Sampled after the feed's own ResizeObservers (this one is created
    // last), keeping each frame's final sample: an engine may run another
    // observer round in the same frame after the list corrects itself, and
    // only the last state paints.
    await page.evaluate(() => {
      const scroller = document.querySelector('[data-testid="canvas-scroller"]');
      if (!scroller) throw new Error('no feed');
      const samples: { frame: number; x: number; y: number }[] = [];
      (window as unknown as { __collapse: typeof samples }).__collapse = samples;
      // The engine's own proof that the columns interpolate, whatever its
      // frame pacing: the shell's grid-template-columns transition runs.
      const transitions: string[] = [];
      (window as unknown as { __columnsTransition: string[] }).__columnsTransition = transitions;
      document.addEventListener('transitionrun', (event) => { transitions.push(event.propertyName); });
      let frame = 0;
      const tick = () => { frame += 1; requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      new ResizeObserver(() => {
        const tiles = scroller.querySelectorAll('[data-testid="batch-grid"] > *');
        const newest = tiles[tiles.length - 1];
        if (!newest) return;
        const box = newest.getBoundingClientRect();
        if (samples.at(-1)?.frame === frame) samples.pop();
        samples.push({ frame, x: box.x, y: box.y });
      }).observe(scroller);
    });
    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
    await page.waitForTimeout(700);
    const samples = await page.evaluate(() => (window as unknown as { __collapse: { frame: number; x: number; y: number }[] }).__collapse);
    expect(await page.evaluate(() => (window as unknown as { __columnsTransition: string[] }).__columnsTransition)).toContain('grid-template-columns');
    expect(samples.length).toBeGreaterThan(3);
    const first = samples[0];
    const last = samples.at(-1);
    if (!first || !last) throw new Error('no samples');
    // One horizontal interpolation: the newest tile passes through
    // intermediate x positions on its way.
    // WebKit paints this path in ~40ms frames, so how many of the ease-out's
    // positions it samples depends on frame pacing; the transitionrun above
    // is its interpolation proof, and Chromium also counts the positions.
    const xs = new Set(samples.slice(1, -1).map((sample) => Math.round(sample.x)).filter((x) => x !== Math.round(first.x) && x !== Math.round(last.x)));
    if (browserName === 'chromium') expect(xs.size, 'intermediate x positions').toBeGreaterThanOrEqual(2);
    // Tiles resize as the column widens, so the newest one may travel
    // vertically, but only one way: a frame painted before the list
    // re-measured would throw it back against that direction.
    const direction = Math.sign(last.y - first.y) || 1;
    let reversal = 0;
    for (let index = 1; index < samples.length; index += 1) {
      const step = (samples[index]?.y ?? 0) - (samples[index - 1]?.y ?? 0);
      if (Math.sign(step) === -direction) reversal = Math.max(reversal, Math.abs(step));
    }
    expect(reversal, `largest vertical step against the travel: ${JSON.stringify(samples.map((sample) => Math.round(sample.y)))}`).toBeLessThan(48);
  });
});

// M3 (T13): phone header and empty-pane leftovers.
test.describe('consistency leftovers (T13)', () => {
  test('a phone batch header centres its actions on the meta row', async ({ browser, page }) => {
    const misalignment = (target: Page) => target.locator('main section[data-batch-id]').first().evaluate((batch) => {
      const meta = batch.querySelector('header > ul > li');
      const actions = [...batch.querySelectorAll('header button[aria-label="Archive batch"], header button[aria-label="More actions"]')];
      if (!meta || actions.length !== 2) throw new Error('missing meta row or actions');
      const box = meta.getBoundingClientRect();
      const centre = box.top + box.height / 2;
      return Math.max(...actions.map((button) => {
        const rect = button.getBoundingClientRect();
        return Math.abs(rect.top + rect.height / 2 - centre);
      }));
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/e2e/studio/index.html');
    await expect(page.getByTestId('feed')).toBeVisible();
    expect(await misalignment(page)).toBeLessThanOrEqual(1);
    // On a touch phone the actions rise to 44px; they still centre on the row.
    const context = await browser.newContext({ ...devices['iPhone 13'] });
    try {
      const phone = await context.newPage();
      await phone.goto('/e2e/studio/index.html');
      await expect(phone.getByTestId('feed')).toBeVisible();
      expect(await misalignment(phone)).toBeLessThanOrEqual(1);
    } finally {
      await context.close();
    }
  });

  test('phone managed views show Back as an arrow and keep the title on one line', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const check = async (title: string) => {
      const heading = page.getByRole('heading', { level: 2, name: title, exact: true });
      await expect(heading).toBeVisible();
      const back = page.getByRole('button', { name: 'Back to Unsorted', exact: true });
      await expect(back).toHaveAttribute('data-tip', 'Back to Unsorted');
      const box = await back.boundingBox();
      if (!box) throw new Error(`missing Back on ${title}`);
      expect(box.width, `${title} Back width`).toBeGreaterThanOrEqual(43.9);
      expect(box.height, `${title} Back height`).toBeGreaterThanOrEqual(43.9);
      expect(box.width, `${title} Back is icon-only`).toBeLessThan(48);
      const lines = await heading.evaluate((element) => {
        const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
        return Math.round(element.getBoundingClientRect().height / lineHeight);
      });
      expect(lines, `${title} title lines`).toBe(1);
      expect(await noHorizontalOverflow(page)).toBe(true);
    };
    await page.goto('/e2e/studio/index.html?view=prompts');
    await check('Prompt Library');
    await page.goto('/e2e/studio/index.html?view=text-models&textAdmin=1&textProvider=1');
    await check('Text models');
    await page.goto('/e2e/studio/index.html');
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.getByRole('button', { name: 'Archive', exact: true }).click();
    await check('Archive');
  });

  test('an empty Prompt Library tab gives its empty state the whole content area', async ({ page }) => {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.goto('/e2e/studio/index.html?view=prompts&emptyLibrary=1');
      for (const [tab, heading] of [['Templates', 'No templates yet'], ['Variable lists', 'No variable lists yet'], ['Dimensions', 'No dimensions yet']] as const) {
        await page.getByRole('tab', { name: tab, exact: true }).click();
        const panel = page.getByRole('tabpanel', { name: tab });
        await expect(panel.getByRole('heading', { name: heading })).toBeVisible();
        await expect(panel.getByRole('complementary')).toHaveCount(0);
        const [panelBox, emptyBox] = await panel.evaluate((element) => {
          const empty = element.querySelector('[data-empty-span]');
          if (!empty) throw new Error('missing empty state');
          const outer = element.getBoundingClientRect();
          const inner = empty.getBoundingClientRect();
          return [{ left: outer.left, right: outer.right }, { left: inner.left, right: inner.right }];
        });
        expect(Math.abs(emptyBox.left - panelBox.left), `${tab} left edge at ${String(viewport.width)}`).toBeLessThanOrEqual(1);
        expect(Math.abs(emptyBox.right - panelBox.right), `${tab} right edge at ${String(viewport.width)}`).toBeLessThanOrEqual(1);
      }
    }
  });
});

import { expect, test, type Locator, type Page } from '@playwright/test';
import type * as AtelierStore from '../src/store/atelier';
import type * as ErrorCopy from '../src/lib/errorCopy';
/*
 * Native CSS anchor positioning and the native popovers behind it, asserted
 * where they actually resolve: a real browser (the chromium, webkit-anchors
 * and, when installed, firefox-anchors projects in playwright.config.ts).
 * Production owners only (e2e/harness/anchors.tsx). Geometry is read from the
 * rendered boxes; nothing here mirrors the stylesheet.
 *
 * Feature detection only chooses which contract a case asserts: the anchored
 * geometry, or the documented nonanchored fallback (a centred panel, a
 * top-centre label or card, a toast off the content column's edge). A
 * supported feature still has to produce the geometry to pass.
 */

const HARNESS = '/e2e/harness/anchors.html';
const GAP = 8;
const TIP_GAP = 6;
const EDGE = 12;
const SLOP = 1.5;

test('timeout recovery clearly labels a readable queue-wide action on phones', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(HARNESS);
  await page.evaluate(async () => {
    const storeUrl = '/src/store/atelier.ts';
    const copyUrl = '/src/lib/errorCopy.ts';
    const { useAtelierStore } = await import(/* @vite-ignore */ storeUrl) as typeof AtelierStore;
    const { UNCERTAIN_SUBMISSION_NOTICE } = await import(/* @vite-ignore */ copyUrl) as typeof ErrorCopy;
    useAtelierStore.getState().addToast(UNCERTAIN_SUBMISSION_NOTICE.text, 'error', 30_000, {
      label: UNCERTAIN_SUBMISSION_NOTICE.actionLabel,
      onClick: () => { document.documentElement.dataset.queueResumed = 'true'; },
    });
  });
  const resume = page.getByRole('button', { name: 'Resume queue', exact: true });
  const notice = page.getByRole('status').filter({ has: resume });
  const message = notice.getByText(/Resuming also submits other queued prompts/);
  await expect(message).toBeVisible();
  await expect(resume).toBeInViewport({ ratio: 1 });
  expect(await overflows(notice)).toBe(false);
  expect(await message.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
  await page.screenshot({ path: `/tmp/atelier-94a2-queue-resume-${testInfo.project.name}.png` });
  await resume.click();
  await expect(page.locator('html')).toHaveAttribute('data-queue-resumed', 'true');
});

test('deferred navigation preserves sidebar focus while only stale feed actions are inert', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const chunk = Promise.withResolvers<undefined>();
  let requested = false;
  await page.route('**/src/components/PromptManager/index.tsx*', async (route) => {
    requested = true;
    await chunk.promise;
    await route.continue();
  });
  await page.goto('/e2e/studio/index.html');
  const library = page.getByRole('button', { name: 'Prompt Library', exact: true });
  await library.focus();
  await page.keyboard.press('Enter');
  try {
    await expect.poll(() => requested).toBe(true);
    await expect(library).toBeFocused();
    await expect(page.getByTestId('feed')).toHaveAttribute('inert', '');
    await expect(page.locator('main')).not.toHaveAttribute('inert');
    // Navigation stays usable even while an optional destination is loading.
    await page.getByRole('button', { name: /^Pinned \d+$/ }).click();
    await expect(page).toHaveURL(/view=pinned/);
    await expect(page.getByTestId('feed')).not.toHaveAttribute('inert');
  } finally {
    chunk.resolve(undefined);
  }
});

interface Box { top: number; right: number; bottom: number; left: number; width: number; height: number }

interface HarnessWindow {
  atelierHarness: {
    toast: (text: string) => void;
    undos: number;
    documentEscapes: number;
    growCollections: () => void;
    removeEdgeMore: () => void;
    removeEdgeTip: () => void;
    openEdgeMenu: () => void;
  };
}

interface RevealSample { elapsed: number; visibility: string }
declare global {
  interface Window { atelierRevealSample?: Promise<RevealSample> }
}

const VIEWPORTS = {
  desktop: { width: 1280, height: 900 },
  tablet: { width: 820, height: 1180 },
  phoneLandscape: { width: 844, height: 390 },
  phonePortrait: { width: 390, height: 844 },
} as const;

async function box(locator: Locator): Promise<Box> {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height };
  });
}

// Entrance animations and transitions move a surface by a few pixels;
// geometry is read once they have finished.
async function settle(locator: Locator): Promise<void> {
  await locator.evaluate((element) => Promise.all(
    element.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
  ));
}

async function frames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise((resolve) => { requestAnimationFrame(() => { requestAnimationFrame(resolve); }); }));
}

function near(actual: number, expected: number, slop = SLOP): void {
  expect(Math.abs(actual - expected), `${String(actual)} ≈ ${String(expected)}`).toBeLessThanOrEqual(slop);
}

async function cssAnchoring(page: Page): Promise<boolean> {
  return page.evaluate(() => CSS.supports('anchor-name: --a')
    && CSS.supports('position-area: top')
    && CSS.supports('position-try-fallbacks: flip-block'));
}

// The owner decided this panel has an anchor (data-anchored: the popover
// source was honoured, or a declared name) and the engine can place it.
async function anchored(page: Page, panel: Locator): Promise<boolean> {
  return await cssAnchoring(page) && await panel.getAttribute('data-anchored') !== null;
}

async function inTopLayer(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => {
    try {
      return element.matches(':popover-open');
    } catch {
      return false;
    }
  });
}

async function overflows(panel: Locator): Promise<boolean> {
  return panel.evaluate((element) => {
    const scroll = element.querySelector('[data-overlay-scroll]') ?? element;
    return scroll.scrollHeight > scroll.clientHeight;
  });
}

async function expectFocusRingInsideScroll(panel: Locator): Promise<void> {
  const evidence = await panel.evaluate((element) => {
    const focused = document.activeElement;
    const scroll = element.querySelector('[data-overlay-scroll]');
    if (!(focused instanceof HTMLElement) || !scroll) throw new Error('Missing focused control or scroll shell');
    const style = getComputedStyle(focused);
    const clearance = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
    const control = focused.getBoundingClientRect();
    const clip = scroll.getBoundingClientRect();
    return { outline: style.outlineStyle, gaps: [control.left - clip.left, clip.right - control.right, control.top - clip.top, clip.bottom - control.bottom], clearance };
  });
  expect(evidence.outline).not.toBe('none');
  for (const gap of evidence.gaps) expect(gap).toBeGreaterThanOrEqual(evidence.clearance - SLOP);
}

function expectOnScreen(page: Page, panel: Box, clearance = 0): void {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('no viewport');
  expect(panel.left).toBeGreaterThanOrEqual(clearance - SLOP);
  expect(panel.top).toBeGreaterThanOrEqual(clearance - SLOP);
  expect(panel.right).toBeLessThanOrEqual(viewport.width - clearance + SLOP);
  expect(panel.bottom).toBeLessThanOrEqual(viewport.height - clearance + SLOP);
}

function expectCentred(page: Page, panel: Box): void {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('no viewport');
  near((panel.left + panel.right) / 2, viewport.width / 2);
  near((panel.top + panel.bottom) / 2, viewport.height / 2);
}

function expectAdjacent(panel: Box, anchor: Box, gap = GAP): void {
  if (panel.top >= anchor.bottom - SLOP) near(panel.top, anchor.bottom + gap);
  else near(panel.bottom, anchor.top - gap);
}

async function topmostAt(locator: Locator, at?: { x: number; y: number }): Promise<boolean> {
  return locator.evaluate((element, point) => {
    const rect = element.getBoundingClientRect();
    const x = point?.x ?? rect.left + rect.width / 2;
    const y = point?.y ?? rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return hit === element || element.contains(hit);
  }, at ?? null);
}

async function activeLabel(page: Page): Promise<string> {
  return page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent.trim() ?? '');
}

async function raiseToast(page: Page, text: string): Promise<void> {
  await page.evaluate((message) => { (window as unknown as HarnessWindow).atelierHarness.toast(message); }, text);
}

async function undoCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as HarnessWindow).atelierHarness.undos);
}

async function documentEscapes(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as HarnessWindow).atelierHarness.documentEscapes);
}

// ── Evidence: which engine ran, and what it reports supporting ──

test('engine and feature evidence', async ({ page, browser }, testInfo) => {
  await page.goto(`${HARNESS}?case=tips`);
  const evidence = await page.evaluate(() => {
    let source = false;
    try {
      document.createElement('div').showPopover(Object.defineProperty({}, 'source', {
        get() {
          source = true;
          return undefined;
        },
      }));
    } catch {
      // NotSupportedError from the detached probe is expected.
    }
    return {
      userAgent: navigator.userAgent,
      features: {
        anchorName: CSS.supports('anchor-name: --a'),
        positionArea: CSS.supports('position-area: top'),
        positionTryFallbacks: CSS.supports('position-try-fallbacks: flip-block'),
        anchorCenter: CSS.supports('justify-self: anchor-center'),
        positionVisibility: CSS.supports('position-visibility: anchors-visible'),
        anchorScope: CSS.supports('anchor-scope: --a'),
        popover: 'showPopover' in HTMLElement.prototype,
        popoverSource: source,
        startingStyle: 'CSSStartingStyleRule' in window,
      },
    };
  });
  const line = JSON.stringify({ project: testInfo.project.name, browserVersion: browser.version(), ...evidence });
  testInfo.annotations.push({ type: 'engine', description: line });
  console.log(`[native-anchors] ${line}`);
  expect(evidence.userAgent).not.toBe('');
});

// The overlays inert and aria-hide the app root while open, so triggers are
// addressed with includeHidden.
const more = (page: Page) => page.getByRole('button', { name: 'More actions', includeHidden: true });
const menu = (page: Page) => page.getByRole('menu', { name: 'Batch actions' });
const moveDialog = (page: Page) => page.getByRole('dialog', { name: 'Move to collection' });
const scroller = (page: Page) => page.locator('[data-testid="canvas-scroller"]');

async function scrollFeedBy(page: Page, delta: number): Promise<void> {
  await scroller(page).evaluate((element, by) => { element.scrollTop += by; }, delta);
  await frames(page);
}

// The feed is virtualized: an nth() locator re-resolves to whichever row is
// rendered at that index after a scroll. Pin the trigger to its batch instead.
async function moreOf(page: Page, candidate: Locator): Promise<Locator> {
  const id = await candidate.evaluate((element) => element.closest('[data-batch-id]')?.getAttribute('data-batch-id') ?? '');
  return page.locator(`section[data-batch-id="${id}"]`).getByRole('button', { name: 'More actions', includeHidden: true });
}

// ── Batch feed: repeated headers in the virtualized, contain:strict scroller ──

test('an open menu survives desktop/sheet switches, and native close synchronizes its owner', async ({ page }) => {
  await page.setViewportSize(VIEWPORTS.desktop);
  await page.goto(`${HARNESS}?case=edges&at=top-right`);
  const trigger = page.locator('#edge-more');
  await trigger.click();
  for (const viewport of [VIEWPORTS.phonePortrait, VIEWPORTS.desktop]) {
    await page.setViewportSize(viewport);
    await expect(menu(page)).toBeVisible();
    await settle(menu(page));
    expect(await menu(page).evaluate((element) => element.contains(document.activeElement))).toBe(true);
    expectOnScreen(page, await box(menu(page)));
  }
  test.skip(!(await inTopLayer(menu(page))), 'Popover API unavailable');
  await menu(page).evaluate((element) => {
    if (element instanceof HTMLElement) element.hidePopover();
  });
  await expect(menu(page)).toHaveCount(0);
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(trigger).toBeFocused();
});

test('without the optional popover source member, panels and labels remain usable and unanchored', async ({ page }) => {
  await page.addInitScript(() => {
    const show: unknown = Reflect.get(HTMLElement.prototype, 'showPopover');
    if (typeof show !== 'function') return;
    Object.defineProperty(HTMLElement.prototype, 'showPopover', {
      configurable: true,
      value(this: HTMLElement) { Reflect.apply(show, this, []); },
    });
  });
  await page.setViewportSize(VIEWPORTS.desktop);
  await page.goto(`${HARNESS}?case=edges&at=top-left`);
  await page.locator('#edge-more').click();
  await settle(menu(page));
  await expect(menu(page)).not.toHaveAttribute('data-anchored');
  expectCentred(page, await box(menu(page)));
  await page.keyboard.press('ArrowDown');
  expect(await menu(page).evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);
  // The prompt card never needed the source member: it is anchored by the
  // name its prompt declares, in the page layer.
  const prompt = page.locator('#corner div[tabindex="0"]');
  await prompt.focus();
  await expect(card(page)).toBeVisible();
  await settle(card(page));
  await expect(card(page)).toHaveAttribute('data-anchored', 'name');
  expect(await inTopLayer(card(page))).toBe(false);
  if (await cssAnchoring(page)) {
    const host = await box(prompt);
    const shown = await box(card(page));
    near(shown.top, host.bottom + GAP);
    near(shown.left, host.left);
  }
  await page.keyboard.press('Escape');
  await expect(card(page)).toHaveCount(0);
  await page.goto(`${HARNESS}?case=tips`);
  const { shown } = await revealLabel(page, page.getByRole('button', { name: 'Tip default', exact: true }));
  await expect(tipLabel(page)).not.toHaveAttribute('data-anchored');
  expectFallbackLabel(page, shown);
  await page.keyboard.press('Escape');
  await expect(tipLabel(page)).not.toHaveAttribute('data-open');
});

test('disabled controls retain their visual tooltip', async ({ page }) => {
  await page.setViewportSize(VIEWPORTS.desktop);
  await page.goto(`${HARNESS}?case=tips`);
  const host = page.getByRole('button', { name: 'Tip default', exact: true });
  await host.evaluate((element) => { element.setAttribute('disabled', ''); });
  const { shown } = await revealLabel(page, host);
  expectOnScreen(page, shown);
  await expect(tipLabel(page)).toHaveText('Label default');
});

interface PanelSample { sourceGone: boolean; present: boolean; anchored: boolean; open: boolean; painted: boolean; left: number; top: number; right: number; bottom: number }

// Removes a source synchronously and samples `selector` on the next frames,
// on the browser's own clock: driver round trips would miss a corner frame.
async function sampleAfterRemoval(page: Page, remove: 'removeEdgeMore' | 'removeEdgeTip', sourceId: string, selector: string): Promise<PanelSample[]> {
  return page.evaluate(async ({ remove: name, sourceId: id, selector: query }) => {
    (window as unknown as HarnessWindow).atelierHarness[name]();
    const samples: PanelSample[] = [];
    for (let i = 0; i < 4; i += 1) {
      await new Promise((resolve) => { requestAnimationFrame(resolve); });
      const element = document.querySelector(query);
      let open: boolean;
      try {
        open = element?.matches(':popover-open') ?? false;
      } catch {
        open = false;
      }
      const rect = element?.getBoundingClientRect();
      const style = element ? getComputedStyle(element) : null;
      samples.push({
        sourceGone: document.getElementById(id) === null,
        present: element !== null,
        anchored: element?.hasAttribute('data-anchored') ?? false,
        open,
        painted: style !== null && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0,
        left: rect?.left ?? 0,
        top: rect?.top ?? 0,
        right: rect?.right ?? 0,
        bottom: rect?.bottom ?? 0,
      });
    }
    return samples;
  }, { remove, sourceId, selector });
}

test('a trigger removed while its menu is open never strands the menu; a menu shown without one is centred', async ({ page }) => {
  await page.setViewportSize(VIEWPORTS.desktop);
  await page.goto(`${HARNESS}?case=edges&at=bottom-right`);
  await page.locator('#edge-more').click();
  await settle(menu(page));
  const samples = await sampleAfterRemoval(page, 'removeEdgeMore', 'edge-more', '[role="menu"][aria-label="Batch actions"]');
  expect(samples.every((sample) => sample.sourceGone)).toBe(true);
  for (const sample of samples.filter((entry) => entry.present && entry.painted)) {
    // Never resolved against the removed trigger: the centred fallback
    // (within the exit's few pixels of motion), never the window's corner.
    expect(sample.anchored).toBe(false);
    near((sample.left + sample.right) / 2, VIEWPORTS.desktop.width / 2, 8);
    near((sample.top + sample.bottom) / 2, VIEWPORTS.desktop.height / 2, 8);
  }
  // Reported as a close the owner did not make: it closes, with its exit.
  await expect(menu(page)).toHaveCount(0);

  // Shown with no source at all: unanchored, centred and fully usable.
  await page.evaluate(() => { (window as unknown as HarnessWindow).atelierHarness.openEdgeMenu(); });
  await expect(menu(page)).toBeVisible();
  await settle(menu(page));
  await expect(menu(page)).not.toHaveAttribute('data-anchored');
  expectCentred(page, await box(menu(page)));
  await expect.poll(() => menu(page).evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('ArrowDown');
  expect(await menu(page).evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);
});

test('a tooltip host removed while described leaves no label painted, at its corner or anywhere', async ({ page }) => {
  await page.setViewportSize(VIEWPORTS.desktop);
  await page.goto(`${HARNESS}?case=edges&at=bottom-right`);
  await revealLabel(page, page.locator('#edge-tip'));
  const samples = await sampleAfterRemoval(page, 'removeEdgeTip', 'edge-tip', '[data-tip-label]');
  for (const sample of samples) {
    expect(sample.sourceGone).toBe(true);
    expect(sample.painted).toBe(false);
    // Out of the top layer at once, not fading against a dead source.
    expect(sample.open).toBe(false);
  }
});

for (const [name, viewport] of Object.entries({ desktop: VIEWPORTS.desktop, tablet: VIEWPORTS.tablet, phoneLandscape: VIEWPORTS.phoneLandscape })) {
  test.describe(`feed menus · ${name}`, () => {
    test.use({ viewport });

    test.beforeEach(async ({ page }) => {
      await page.goto(`${HARNESS}?case=feed`);
      await expect(more(page).first()).toBeVisible();
    });

    test('each More menu sits under its own trigger, right edges aligned', async ({ page }) => {
      for (const index of [0, 1]) {
        const trigger = await moreOf(page, more(page).nth(index));
        await trigger.scrollIntoViewIfNeeded();
        await trigger.click();
        await settle(menu(page));
        const panel = await box(menu(page));
        const anchor = await box(trigger);
        if (await anchored(page, menu(page))) {
          expect(await inTopLayer(menu(page))).toBe(true);
          expectAdjacent(panel, anchor);
          near(panel.right, anchor.right);
        } else {
          expectCentred(page, panel);
        }
        await page.keyboard.press('Escape');
        await expect(menu(page)).toHaveCount(0);
        await expect.poll(() => trigger.evaluate((element) => document.activeElement === element)).toBe(true);
      }
    });

    test('Tab and Shift+Tab stay inside, arrows rove, Escape restores the trigger', async ({ page }) => {
      const trigger = await moreOf(page, more(page).first());
      await trigger.click();
      await expect.poll(() => menu(page).evaluate((element) => element.contains(document.activeElement))).toBe(true);
      const first = await activeLabel(page);
      await page.keyboard.press('ArrowDown');
      expect(await activeLabel(page)).not.toBe(first);
      for (const key of ['Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
        await page.keyboard.press(key);
        expect(await menu(page).evaluate((element) => element.contains(document.activeElement))).toBe(true);
        await expectFocusRingInsideScroll(menu(page));
      }
      await page.keyboard.press('Escape');
      await expect(menu(page)).toHaveCount(0);
      await expect.poll(() => trigger.evaluate((element) => document.activeElement === element)).toBe(true);
    });

    test('an open menu follows its trigger when the feed scrolls', async ({ page }) => {
      const trigger = await moreOf(page, more(page).nth(1));
      await trigger.scrollIntoViewIfNeeded();
      await trigger.click();
      await settle(menu(page));
      test.skip(!(await anchored(page, menu(page))), 'no anchor in this engine: the fallback is unanchored');
      const before = await box(trigger);
      await scrollFeedBy(page, 40);
      const after = await box(trigger);
      expect(after.top).toBeLessThan(before.top);
      const panel = await box(menu(page));
      expectAdjacent(panel, after);
      near(panel.right, after.right);
    });

    test('near the viewport bottom the menu flips above its trigger', async ({ page }) => {
      const height = viewport.height;
      // Scroll into the feed first so there is room to scroll back, then park
      // a visible trigger 40px off the bottom edge.
      await scrollFeedBy(page, height);
      let trigger = await moreOf(page, more(page).first());
      for (let i = 0; i < await more(page).count(); i += 1) {
        const candidate = await box(more(page).nth(i));
        if (candidate.top > 60 && candidate.bottom < height - 60) {
          trigger = await moreOf(page, more(page).nth(i));
          break;
        }
      }
      await scrollFeedBy(page, (await box(trigger)).bottom - (height - 40));
      const anchor = await box(trigger);
      expect(anchor.bottom).toBeGreaterThan(height - 80);
      await trigger.click();
      await settle(menu(page));
      test.skip(!(await anchored(page, menu(page))), 'no anchor in this engine: the fallback is unanchored');
      const panel = await box(menu(page));
      near(panel.bottom, anchor.top - GAP);
      near(panel.right, anchor.right);
      expectOnScreen(page, panel);
    });

    test('the Move popover anchors to whichever trigger opened it, and follows its own growth', async ({ page }) => {
      const trigger = await moreOf(page, more(page).first());
      await trigger.scrollIntoViewIfNeeded();
      await trigger.click();
      const moveItem = menu(page).getByRole('menuitem', { name: /move to collection/i });
      await settle(menu(page));
      await moveItem.scrollIntoViewIfNeeded();
      await frames(page);
      expect(await topmostAt(moveItem)).toBe(true);
      await moveItem.click();
      await settle(moveDialog(page));
      const isAnchored = await anchored(page, moveDialog(page));
      let panel = await box(moveDialog(page));
      let anchor = await box(trigger);
      if (isAnchored) {
        expect(await inTopLayer(moveDialog(page))).toBe(true);
        expectAdjacent(panel, anchor);
        near(panel.right, anchor.right);
      } else {
        expectCentred(page, panel);
      }
      // An inline row changes the panel's height; CSS re-resolves on its own.
      await page.evaluate(() => { (window as unknown as HarnessWindow).atelierHarness.growCollections(); });
      await expect(moveDialog(page).getByRole('button', { name: 'Harness collection 31', exact: true })).toHaveCount(1);
      const create = moveDialog(page).getByRole('button', { name: '+ New collection' });
      await page.keyboard.press('End');
      await frames(page);
      const lastCollection = moveDialog(page).getByRole('button', { name: 'Harness collection 31', exact: true });
      await expect(lastCollection).toBeFocused();
      expect(await topmostAt(lastCollection)).toBe(true);
      await page.keyboard.press('Tab');
      await expect(create).toBeFocused();
      expect(await topmostAt(create)).toBe(true);
      await expectFocusRingInsideScroll(moveDialog(page));
      await create.click();
      await expect(moveDialog(page).getByRole('textbox')).toBeFocused();
      await frames(page);
      panel = await box(moveDialog(page));
      if (isAnchored) {
        expectAdjacent(panel, anchor);
        near(panel.right, anchor.right);
      }
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await expect(moveDialog(page)).toHaveCount(0);

      const candidate = page.getByRole('button', { name: 'Move to Logo concepts', includeHidden: true }).first();
      const batchId = await candidate.evaluate((element) => element.closest('[data-batch-id]')?.getAttribute('data-batch-id'));
      if (!batchId) throw new Error('Missing collection-chip batch');
      const chip = page.locator(`section[data-batch-id="${batchId}"]`).getByRole('button', { name: 'Move to Logo concepts', includeHidden: true });
      await chip.scrollIntoViewIfNeeded();
      await chip.click();
      await settle(moveDialog(page));
      panel = await box(moveDialog(page));
      anchor = await box(chip);
      if (isAnchored) {
        expectAdjacent(panel, anchor);
        near(panel.right, anchor.right);
      }
      await page.keyboard.press('Escape');
      await expect(moveDialog(page)).toHaveCount(0);
      await expect.poll(() => chip.evaluate((element) => document.activeElement === element)).toBe(true);
    });

    test('scrolling a trigger far out of the feed recycles its row and takes the menu with it', async ({ page }) => {
      const trigger = await moreOf(page, more(page).first());
      await trigger.click();
      await expect(menu(page)).toBeVisible();
      await scroller(page).evaluate((element) => { element.scrollTop = element.scrollTop > 0 ? 0 : element.scrollHeight; });
      await expect(trigger).toHaveCount(0);
      await expect(menu(page)).toHaveCount(0);
    });
  });
}

// ── BatchPrompt card ──

const card = (page: Page) => page.getByRole('tooltip');
const feedPrompt = (page: Page, index = 0) => page.locator('section[data-batch-id] header > div[tabindex="0"]').nth(index);

async function pinnedPrompt(page: Page, index: number): Promise<Locator> {
  const id = await feedPrompt(page, index).evaluate((element) => element.closest('section')?.getAttribute('data-batch-id') ?? '');
  return page.locator(`section[data-batch-id="${id}"] header > div[tabindex="0"]`);
}

async function visiblePrompt(page: Page): Promise<Locator> {
  const target = await pinnedPrompt(page, 0);
  await target.scrollIntoViewIfNeeded();
  return target;
}

test.describe('feed prompt card · desktop', () => {
  test.use({ viewport: VIEWPORTS.desktop });

  test.beforeEach(async ({ page }) => {
    await page.goto(`${HARNESS}?case=feed`);
    await expect(feedPrompt(page)).toBeVisible();
  });

  async function dwell(page: Page, host: Box): Promise<{ x: number; y: number }> {
    const point = { x: host.left + 40, y: host.top + host.height / 2 };
    await page.mouse.move(point.x, point.y);
    await expect(card(page)).toBeVisible({ timeout: 2000 });
    await settle(card(page));
    return point;
  }

  test('a dwell opens the card beside the pointer, which it follows; leaving closes it', async ({ page }) => {
    const host = await box(await visiblePrompt(page));
    const point = await dwell(page, host);
    const shown = await box(card(page));
    // Page layer, under the toast stack, anchored by its declared name.
    expect(await inTopLayer(card(page))).toBe(false);
    if (await anchored(page, card(page))) {
      near(shown.left, point.x + 16, 2);
      near(shown.top, point.y + 16, 2);
      await page.mouse.move(point.x + 60, point.y);
      await frames(page);
      near((await box(card(page))).left, point.x + 76, 2);
    } else {
      near(shown.top, EDGE);
    }
    expectOnScreen(page, shown);
    await page.mouse.move(4, 4);
    await expect(card(page)).toHaveCount(0);
  });

  test('the pointer can travel onto the card and read it there', async ({ page }) => {
    const host = await box(await visiblePrompt(page));
    const point = await dwell(page, host);
    test.skip(!(await anchored(page, card(page))), 'no anchor in this engine: the card rests top-centre');
    // Read the destination before leaving: driver round trips while crossing
    // the gap must not consume the product's 200ms travel grace.
    const resting = await box(card(page));
    await page.mouse.move(resting.left + resting.width / 2, resting.top + resting.height / 2);
    await page.waitForTimeout(500);
    await expect(card(page)).toBeVisible();
    expect(await topmostAt(card(page))).toBe(true);
    await page.mouse.move(point.x, point.y);
    await page.waitForTimeout(500);
    await expect(card(page)).toBeVisible();
    await page.mouse.move(4, 4);
    await expect(card(page)).toHaveCount(0);
  });

  test('Escape closes a pointer card although focus never moved, and it stays closed until the pointer leaves', async ({ page }) => {
    const target = await visiblePrompt(page);
    const host = await box(target);
    const point = await dwell(page, host);
    // A dwell never moves focus: the prompt is not the focused element.
    expect(await target.evaluate((element) => document.activeElement !== element)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(card(page)).toHaveCount(0);
    await page.mouse.move(point.x + 20, point.y);
    await page.waitForTimeout(700);
    await expect(card(page)).toHaveCount(0);
    await page.mouse.move(4, 4);
    await dwell(page, host);
  });

  test('keyboard focus anchors the card under the prompt; it follows scroll and resize', async ({ page }) => {
    // The second batch: its virtual row is offset, so a card resolved against
    // the row's untranslated box would land on the first batch instead.
    const target = await pinnedPrompt(page, 1);
    await target.focus();
    await expect(card(page)).toBeVisible();
    await settle(card(page));
    test.skip(!(await anchored(page, card(page))), 'no anchor in this engine: the card rests top-centre');
    let host = await box(target);
    let shown = await box(card(page));
    near(shown.top, host.bottom + GAP);
    near(shown.left, host.left);
    await scrollFeedBy(page, 30);
    await expect(card(page)).toBeVisible();
    host = await box(target);
    shown = await box(card(page));
    near(shown.top, host.bottom + GAP);
    await page.setViewportSize({ width: 1100, height: 760 });
    await frames(page);
    // Feed reflow can move this virtual row out of the clip. Bring the same
    // source back into view before asserting visible anchored geometry.
    await target.scrollIntoViewIfNeeded();
    await frames(page);
    host = await box(target);
    shown = await box(card(page));
    near(shown.top, host.bottom + GAP);
    expectOnScreen(page, shown, EDGE);
    await page.keyboard.press('Escape');
    await expect(card(page)).toHaveCount(0);
    await expect(target).toBeFocused();
  });

  test('a focused prompt scrolled away leaves no stranded card', async ({ page }) => {
    const target = await pinnedPrompt(page, 0);
    await target.focus();
    await expect(card(page)).toBeVisible();
    await scroller(page).evaluate((element) => { element.scrollTop = element.scrollTop > 0 ? 0 : element.scrollHeight; });
    await expect(target).toHaveCount(0);
    await expect(card(page)).toHaveCount(0);
  });

  test('a focused prompt clipped out of its retained row closes its hidden card, and Escape passes on', async ({ page }) => {
    const target = page.locator('section[data-batch-id="batch-23"] header > div[tabindex="0"]');
    await target.scrollIntoViewIfNeeded();
    await target.focus();
    await expect(card(page)).toBeVisible();
    await scrollFeedBy(page, -800);
    // The row stays mounted and focused, but its prompt is wholly clipped.
    await expect(target).toHaveCount(1);
    await expect(target).toBeFocused();
    const clip = await box(scroller(page));
    const host = await box(target);
    expect(host.top >= clip.bottom - SLOP || host.bottom <= clip.top + SLOP).toBe(true);
    // Hidden cards do not linger to own the keyboard.
    await expect(card(page)).toHaveCount(0);
    const before = await documentEscapes(page);
    await page.keyboard.press('Escape');
    expect(await documentEscapes(page)).toBe(before + 1);
    await expect(target).toBeFocused();
    // Back in view, a fresh focus opens it again.
    await target.scrollIntoViewIfNeeded();
    await target.blur();
    await target.focus();
    await expect(card(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(card(page)).toHaveCount(0);
    expect(await documentEscapes(page)).toBe(before + 1);
  });
});

// The card is in the page layer, under the global toast stack: wherever the
// two overlap, Undo is the one on top, whichever opened first.
test.describe('prompt card under a global Undo', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  for (const order of ['card first', 'toast first'] as const) {
    test(`a tall prompt card never covers the Undo, which stays clickable · ${order}`, async ({ page }) => {
      await page.goto(`${HARNESS}?case=edges&at=bottom-left&longPrompt`);
      await page.locator('#corner').evaluate((element) => { element.style.left = '300px'; });
      const host = page.locator('#corner div[tabindex="0"]');
      const openCard = async () => {
        await host.focus();
        await expect(card(page)).toBeVisible();
        await settle(card(page));
      };
      const openToast = async () => {
        await raiseToast(page, 'Review Undo reachability');
        await expect(undoButton(page)).toBeVisible();
        await settle(toastStack(page));
      };
      if (order === 'card first') {
        await openCard();
        await openToast();
      } else {
        await openToast();
        await openCard();
      }
      await expect(card(page)).toBeVisible();
      expect(await inTopLayer(card(page))).toBe(false);
      const undo = await box(undoButton(page));
      const centre = { x: undo.left + undo.width / 2, y: undo.top + undo.height / 2 };
      if (await anchored(page, card(page))) {
        // The fixture really overlaps them: the tall card spans the Undo.
        const shown = await box(card(page));
        expect(centre.x).toBeGreaterThan(shown.left);
        expect(centre.x).toBeLessThan(shown.right);
        expect(centre.y).toBeGreaterThan(shown.top);
        expect(centre.y).toBeLessThan(shown.bottom);
      }
      expect(await topmostAt(undoButton(page))).toBe(true);
      const stack = await box(toastStack(page));
      // Read the open card while the toast is present. After Undo the toast
      // still covers part of the source, which cannot be hovered through it.
      const resting = await box(card(page));
      // A reading point on the card away from the toast stack.
      const readY = (stack.top + stack.bottom) / 2 > 720 / 2 ? resting.top + 24 : resting.bottom - 24;
      const read = { x: resting.left + resting.width / 2, y: readY };
      await page.mouse.move(read.x, read.y);
      await page.waitForTimeout(500);
      await expect(card(page)).toBeVisible();
      expect(await topmostAt(card(page), read)).toBe(true);
      await card(page).evaluate((element) => { element.scrollTop = 120; });
      await expect(card(page)).toBeVisible();
      expect(await topmostAt(undoButton(page))).toBe(true);
      await page.mouse.click(centre.x, centre.y);
      expect(await undoCount(page)).toBe(1);
      await expect(card(page)).toHaveCount(0);
    });
  }
});

// ── An editable name field: it shows its own value, so no label echoes it ──

test.describe('editor name field · desktop', () => {
  test.use({ viewport: VIEWPORTS.desktop });

  test('typing shows no tooltip, and the first Escape reaches the field and blurs it', async ({ page }) => {
    await page.goto(`${HARNESS}?case=editor`);
    const field = page.getByRole('textbox', { name: 'Template name' });
    await expect(field).toHaveValue('Harness template');
    await field.hover();
    await field.click();
    await field.evaluate((element) => {
      if (!(element instanceof HTMLInputElement)) throw new Error('Expected a name input');
      element.setSelectionRange(element.value.length, element.value.length);
    });
    await page.keyboard.type(' v2');
    await expect(field).toHaveValue('Harness template v2');
    // Past the label's 360ms reveal delay, with the pointer still on it.
    await page.waitForTimeout(600);
    expect(await field.getAttribute('data-tip')).toBeNull();
    await expect(page.locator('[data-tip-label][data-open]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(field).not.toBeFocused();
    // Blur only: the draft name is kept for the explicit Save.
    await expect(field).toHaveValue('Harness template v2');
  });
});

// ── Viewport edges: every corner, desktop and a short landscape window ──

test('the focused prompt card owns Escape before an older hovered card', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1600 });
  await page.goto(`${HARNESS}?case=feed&seed=2`);
  const first = page.locator('section[data-batch-id="batch-0"] header > div[tabindex="0"]');
  const second = page.locator('section[data-batch-id="batch-1"] header > div[tabindex="0"]');
  await first.hover();
  await expect(card(page)).toHaveCount(1);
  await second.focus();
  await expect(card(page)).toHaveCount(2);
  const before = await documentEscapes(page);
  await page.keyboard.press('Escape');
  await expect(card(page)).toHaveCount(1);
  await expect(card(page)).toHaveText(/^0 · /);
  await expect(second).toBeFocused();
  expect(await documentEscapes(page)).toBe(before);
  await page.keyboard.press('Escape');
  await expect(card(page)).toHaveCount(0);
  expect(await documentEscapes(page)).toBe(before);
});

const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;

for (const corner of CORNERS) {
  test(`a very long prompt scrolls inside the short window · ${corner}`, async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.phoneLandscape);
    await page.goto(`${HARNESS}?case=edges&at=${corner}&longPrompt`);
    const host = page.locator('#corner div[tabindex="0"]');
    for (const mode of ['keyboard', 'pointer']) {
      if (mode === 'keyboard') await host.focus();
      else await host.hover();
      await expect(card(page)).toBeVisible();
      await settle(card(page));
      expectOnScreen(page, await box(card(page)), EDGE);
      expect(await card(page).evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
      await card(page).evaluate((element) => { element.scrollTop = 120; });
      await expect(card(page)).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(card(page)).toHaveCount(0);
      await host.blur();
      await page.mouse.move(4, 4);
    }
  });
}

for (const [name, viewport] of Object.entries({ desktop: VIEWPORTS.desktop, phoneLandscape: VIEWPORTS.phoneLandscape })) {
  for (const corner of CORNERS) {
    test.describe(`edges · ${name} · ${corner}`, () => {
      test.use({ viewport });

      test.beforeEach(async ({ page }) => {
        await page.goto(`${HARNESS}?case=edges&at=${corner}`);
      });

      test('the tall chip menu stays on screen, trigger-wide, mirrored and scrolling as needed', async ({ page }) => {
        const chip = page.getByRole('button', { name: 'Edge choice' });
        const anchor = await box(chip);
        await chip.click();
        const listbox = page.getByRole('listbox', { name: 'Edge choice' });
        await settle(listbox);
        const panel = await box(listbox);
        if (!(await anchored(page, listbox))) {
          expectCentred(page, panel);
          return;
        }
        // A name in the page's own layer, not the top layer.
        expect(await inTopLayer(listbox)).toBe(false);
        expectOnScreen(page, panel);
        expect(panel.width).toBeGreaterThanOrEqual(anchor.width - SLOP);
        // Vertically on the side with room, 8px off the chip.
        if (corner.startsWith('top')) near(panel.top, anchor.bottom + GAP);
        else near(panel.bottom, anchor.top - GAP);
        // Left edges align unless that would cross the right edge.
        if (corner.endsWith('left')) near(panel.left, anchor.left);
        else near(panel.right, anchor.right);
        // Thirty rows fit on neither side: the menu scrolls instead.
        expect(await listbox.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
        // Keyboard still walks the list and Escape restores the chip.
        await page.keyboard.press('End');
        const last = listbox.getByRole('option').last();
        await expect(listbox).toHaveAttribute('aria-activedescendant', await last.getAttribute('id') ?? '');
        const lastBox = await box(last);
        expect(lastBox.top).toBeGreaterThanOrEqual(panel.top - SLOP);
        expect(lastBox.bottom).toBeLessThanOrEqual(panel.bottom + SLOP);
        expect(await topmostAt(last)).toBe(true);
        await page.keyboard.press('Escape');
        await expect(listbox).toHaveCount(0);
        await expect.poll(() => chip.evaluate((element) => document.activeElement === element)).toBe(true);
      });

      test('the More menu stays on screen and next to its trigger', async ({ page }) => {
        const trigger = page.locator('#edge-more');
        const anchor = await box(trigger);
        await trigger.click();
        await settle(menu(page));
        const panel = await box(menu(page));
        if (!(await anchored(page, menu(page)))) {
          expectCentred(page, panel);
          return;
        }
        expectOnScreen(page, panel);
        const vertical = corner.startsWith('top') ? panel.top - anchor.bottom : anchor.top - panel.bottom;
        // Adjacent on the side with room, unless it fits on neither and scrolls.
        if (!(await overflows(menu(page)))) near(vertical, GAP);
        // Right edges align, or mirror to left edges against the left edge.
        if (corner.endsWith('right')) near(panel.right, anchor.right);
        else near(panel.left, anchor.left);
      });

      test('the prompt card keeps clear of the edges by keyboard and by pointer', async ({ page }) => {
        const host = page.locator('#corner div[tabindex="0"]');
        await host.focus();
        await expect(card(page)).toBeVisible();
        await settle(card(page));
        if (await anchored(page, card(page))) expectOnScreen(page, await box(card(page)), EDGE);
        await host.blur();
        await expect(card(page)).toHaveCount(0);

        const anchor = await box(host);
        await page.mouse.move(anchor.left + anchor.width / 2, anchor.top + anchor.height / 2);
        await expect(card(page)).toBeVisible({ timeout: 2000 });
        await settle(card(page));
        if (await anchored(page, card(page))) expectOnScreen(page, await box(card(page)), EDGE);
      });

      for (const place of ['', 'below', 'above-end', 'below-start'] as const) {
        test(`a long ${place || 'default'} label stays inside the window, against its host`, async ({ page }) => {
          await page.goto(`${HARNESS}?case=edges&at=${corner}${place ? `&place=${place}` : ''}`);
          const host = page.locator('#edge-tip');
          const { anchor, shown } = await revealLabel(page, host);
          expectOnScreen(page, shown);
          if (await labelsAnchored(page)) expectAdjacent(shown, anchor, TIP_GAP);
        });
      }
    });
  }
}

// The confirmed short-window regression: a trigger in the middle of a window
// too short for the panel on either side used to fail every fallback and keep
// the unconstrained panel, overflowing the bottom edge.
test.describe('edges · very short desktop window', () => {
  test.use({ viewport: { width: 1280, height: 240 } });

  for (const corner of ['top-left', 'top-right'] as const) {
    test(`${corner}: a central trigger keeps the More menu and the chip menu inside the window, scrolling`, async ({ page }) => {
      await page.goto(`${HARNESS}?case=edges&at=${corner}`);
      await page.locator('#corner').evaluate((element) => {
        element.style.top = '105px';
        element.style.bottom = 'auto';
      });
      for (const [trigger, panel] of [
        [page.locator('#edge-more'), menu(page)],
        [page.getByRole('button', { name: 'Edge choice' }), page.getByRole('listbox', { name: 'Edge choice' })],
      ] as const) {
        const anchor = await box(trigger);
        await trigger.click();
        await settle(panel);
        const shown = await box(panel);
        expectOnScreen(page, shown);
        if (await anchored(page, panel)) {
          expectAdjacent(shown, anchor);
          expect(await panel.evaluate((element) => getComputedStyle(element).maxHeight)).not.toBe('none');
          expect(shown.bottom).toBeLessThanOrEqual(240 - EDGE + SLOP);
          expect(shown.top).toBeGreaterThanOrEqual(EDGE - SLOP);
        }
        expect(await overflows(panel)).toBe(true);
        await page.keyboard.press('End');
        await page.keyboard.press('Escape');
        await expect(panel).toHaveCount(0);
        await expect.poll(() => trigger.evaluate((element) => document.activeElement === element)).toBe(true);
      }
    });
  }
});

test.describe('edges · phone portrait', () => {
  test.use({ viewport: VIEWPORTS.phonePortrait, hasTouch: true });

  test('menus are bottom sheets with no anchoring, dismissed by a backdrop tap', async ({ page }) => {
    await page.goto(`${HARNESS}?case=edges&at=top-left`);
    await page.getByRole('button', { name: 'Edge choice' }).click();
    const listbox = page.getByRole('listbox', { name: 'Edge choice' });
    await settle(listbox);
    const panel = await box(listbox);
    expect(await listbox.getAttribute('data-anchor-place')).toBeNull();
    near(panel.left, 0);
    near(panel.right, VIEWPORTS.phonePortrait.width);
    near(panel.bottom, VIEWPORTS.phonePortrait.height);
    await page.getByTestId('chipselect-backdrop').tap({ position: { x: 20, y: 20 } });
    await expect(listbox).toHaveCount(0);

    await page.locator('#edge-more').click();
    await settle(menu(page));
    expect(await menu(page).getAttribute('data-mobile')).toBe('true');
    expect(await inTopLayer(menu(page))).toBe(false);
    near((await box(menu(page))).bottom, VIEWPORTS.phonePortrait.height);
    await page.getByRole('button', { name: 'Close menu' }).tap({ position: { x: 20, y: 20 } });
    await expect(menu(page)).toHaveCount(0);
  });
});

// ── Composer, Prompt Picker, their nested menus and the toast stack ──

const picker = (page: Page) => page.getByRole('dialog', { name: 'Templates' });
const libraryChip = (page: Page) => page.getByRole('button', { name: 'Templates', exact: true });
const composerWrap = (page: Page) => page.locator('#atelier-composer');
const undoButton = (page: Page) => page.getByRole('button', { name: 'Undo', exact: true });
const toastStack = (page: Page) => undoButton(page).locator('xpath=../..');

for (const [name, viewport] of Object.entries({ desktop: VIEWPORTS.desktop, tablet: VIEWPORTS.tablet })) {
  test.describe(`composer · ${name}`, () => {
    test.use({ viewport });

    test.beforeEach(async ({ page }) => {
      await page.goto(`${HARNESS}?case=composer`);
      await expect(composerWrap(page)).toBeVisible();
    });

    test('the picker rests 10px above the Composer and follows it as the Composer grows', async ({ page }) => {
      await libraryChip(page).click();
      await settle(picker(page));
      let composer = await box(composerWrap(page));
      let panel = await box(picker(page));
      expect(await picker(page).getAttribute('data-sheet')).toBe('false');
      if (!(await cssAnchoring(page))) {
        expectOnScreen(page, panel, 24);
        return;
      }
      near(panel.bottom, composer.top - 10);
      expect(panel.top).toBeGreaterThanOrEqual(24 - SLOP);

      // The Composer grows upward (wrapped controls, a queue panel): the picker
      // re-resolves with no measurement of its own.
      await composerWrap(page).evaluate((element) => { element.style.paddingTop = '96px'; });
      await frames(page);
      composer = await box(composerWrap(page));
      panel = await box(picker(page));
      near(panel.bottom, composer.top - 10);
      expect(panel.top).toBeGreaterThanOrEqual(24 - SLOP);
    });

    test('an axis menu anchors under its trigger, survives filtering, and Escape closes only it', async ({ page }) => {
      await libraryChip(page).click();
      await picker(page).getByRole('button', { name: 'Harness template' }).click();
      await picker(page).getByRole('button', { name: 'Advanced · 2 variables', exact: true }).click();
      const trigger = picker(page).getByRole('button', { name: 'Choose mood value' });
      await trigger.click();
      const axis = page.getByRole('dialog', { name: 'mood' });
      await settle(axis);
      const isAnchored = await anchored(page, axis);
      const check = async () => {
        const panel = await box(axis);
        const anchor = await box(trigger);
        if (!isAnchored) {
          expectCentred(page, panel);
          return;
        }
        expectAdjacent(panel, anchor);
        near(panel.left, anchor.left);
        expectOnScreen(page, panel);
      };
      if (isAnchored) expect(await inTopLayer(axis)).toBe(true);
      await check();
      await axis.getByRole('textbox').fill('s');
      await check();
      await page.keyboard.press('Escape');
      await expect(axis).toHaveCount(0);
      await expect(picker(page)).toBeVisible();
      await expect.poll(() => trigger.evaluate((element) => document.activeElement === element)).toBe(true);
    });

    test('the Count chip menu opens above the chip, at least chip-wide; Escape closes only it', async ({ page }) => {
      const chip = page.getByRole('button', { name: 'Count', exact: true });
      await chip.click();
      const listbox = page.getByRole('listbox', { name: 'Count', exact: true });
      await settle(listbox);
      const panel = await box(listbox);
      const anchor = await box(chip);
      if (await anchored(page, listbox)) {
        near(panel.bottom, anchor.top - GAP);
        near(panel.left, anchor.left);
        expect(panel.width).toBeGreaterThanOrEqual(anchor.width - SLOP);
      } else {
        expectCentred(page, panel);
      }
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Escape');
      await expect(listbox).toHaveCount(0);
      await expect(composerWrap(page)).toBeVisible();
      await expect.poll(() => chip.evaluate((element) => document.activeElement === element)).toBe(true);
    });

    test('the toast stack hangs 16px above the Composer, centred on it, and follows it', async ({ page }) => {
      await raiseToast(page, 'Harness toast');
      await expect(undoButton(page)).toBeVisible();
      await settle(toastStack(page));
      let composer = await box(composerWrap(page));
      let stack = await box(toastStack(page));
      if (!(await cssAnchoring(page))) {
        near(stack.top, 16);
        return;
      }
      near(stack.bottom, composer.top - 16);
      near((stack.left + stack.right) / 2, (composer.left + composer.right) / 2);
      await composerWrap(page).evaluate((element) => { element.style.paddingTop = '96px'; });
      await frames(page);
      composer = await box(composerWrap(page));
      stack = await box(toastStack(page));
      near(stack.bottom, composer.top - 16);
    });

    test('a global Undo stays on top of an open chip menu and is reachable', async ({ page }) => {
      const chip = page.getByRole('button', { name: 'Model', exact: true });
      await chip.click();
      const listbox = page.getByRole('listbox', { name: 'Model', exact: true });
      await expect(listbox).toBeVisible();
      // A long message spans the Composer, across the menu's column.
      await raiseToast(page, `Queue cleared · ${'a long confirmation that runs across the composer '.repeat(2)}`);
      await expect(undoButton(page)).toBeVisible();
      await settle(toastStack(page));
      await expect(listbox).toBeVisible();
      expect(await topmostAt(undoButton(page))).toBe(true);
      // Wherever the toast and the menu overlap, the toast is the one on top.
      const toastBox = await box(undoButton(page).locator('xpath=..'));
      const menuBox = await box(listbox);
      const overlap = {
        left: Math.max(toastBox.left, menuBox.left),
        right: Math.min(toastBox.right, menuBox.right),
        top: Math.max(toastBox.top, menuBox.top),
        bottom: Math.min(toastBox.bottom, menuBox.bottom),
      };
      if (overlap.left < overlap.right && overlap.top < overlap.bottom) {
        const point = { x: (overlap.left + overlap.right) / 2, y: (overlap.top + overlap.bottom) / 2 };
        expect(await topmostAt(undoButton(page).locator('xpath=..'), point)).toBe(true);
      }
      await undoButton(page).click();
      expect(await undoCount(page)).toBe(1);
    });

    test('a picker-hosted Undo survives a nested choice and stays reachable', async ({ page }) => {
      await libraryChip(page).click();
      await picker(page).getByRole('button', { name: 'Harness template' }).click();
      await picker(page).getByRole('button', { name: 'Stash & roll' }).click();
      await expect(picker(page).locator('[data-zone="foot"] span').first()).toContainText('1 stashed');
      await picker(page).getByRole('button', { name: 'Clear', exact: true }).click();
      await expect(picker(page).getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
      expect(await undoButton(page).evaluate((element) => element.closest('[data-toast-host="contained"]') !== null)).toBe(true);

      // The nested axis menu takes the toast while it is open: inside its
      // panel, on top, and inside its focus trap.
      await picker(page).getByRole('button', { name: 'Advanced · 2 variables', exact: true }).click();
      await picker(page).getByRole('button', { name: 'Choose mood value' }).click();
      const axis = page.getByRole('dialog', { name: 'mood' });
      await expect(axis).toBeVisible();
      await expect(axis.getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
      expect(await topmostAt(undoButton(page))).toBe(true);
      let reached = false;
      for (let i = 0; i < 20 && !reached; i += 1) {
        await page.keyboard.press('Tab');
        reached = await undoButton(page).evaluate((element) => document.activeElement === element);
        expect(await axis.evaluate((element) => element.contains(document.activeElement))).toBe(true);
      }
      expect(reached).toBe(true);

      // The nested choice closes the axis menu and hands the toast back.
      await axis.getByRole('button', { name: 'serene' }).click();
      await expect(axis).toHaveCount(0);
      await expect(picker(page).getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
      await settle(toastStack(page));
      expect(await topmostAt(undoButton(page))).toBe(true);
      await undoButton(page).focus();
      await page.keyboard.press('Enter');
      await expect(picker(page).locator('[data-zone="foot"] span').first()).toContainText('1 stashed');
      await expect(picker(page)).toBeVisible();
    });
  });
}

test.describe('composer · phone landscape (short window)', () => {
  test.use({ viewport: VIEWPORTS.phoneLandscape });

  test('the picker becomes a sheet; the short-window geometry threshold is unchanged', async ({ page }) => {
    await page.goto(`${HARNESS}?case=composer`);
    await libraryChip(page).click();
    await settle(picker(page));
    await expect(picker(page)).toHaveAttribute('data-sheet', 'true');
    expect(await picker(page).getAttribute('data-anchor-place')).toBeNull();
    near((await box(picker(page))).bottom, VIEWPORTS.phoneLandscape.height);
    await picker(page).getByRole('button', { name: 'Close templates' }).click();
    await expect(picker(page)).toHaveCount(0);
  });
});

test.describe('settings model menus', () => {
  test.use({ viewport: VIEWPORTS.desktop });

  test('grows to fit every model when the opposite side has room', async ({ page }) => {
    await page.goto(`${HARNESS}?case=settings`);
    const trigger = page.getByRole('button', { name: /Text model for AI fill/ });
    await trigger.click();
    const listbox = page.getByRole('listbox');
    await settle(listbox);
    // "Use default" plus the harness's six models across two provider groups.
    await expect(listbox.getByRole('option')).toHaveCount(7);
    expect(await overflows(listbox)).toBe(false);
    for (const option of await listbox.getByRole('option').all()) {
      await expect(option).toBeInViewport({ ratio: 1 });
    }
    const panel = await box(listbox);
    expectOnScreen(page, panel);
    if (await anchored(page, listbox)) {
      near(panel.top, (await box(trigger)).bottom + GAP);
    }
  });
});

test.describe('toast stack without a Composer', () => {
  test.use({ viewport: VIEWPORTS.desktop });

  test('rests off the window edge, centred, and its Undo works', async ({ page }) => {
    await page.goto(`${HARNESS}?case=tips`);
    await raiseToast(page, 'Harness toast');
    await expect(undoButton(page)).toBeVisible();
    await settle(toastStack(page));
    const stack = await box(toastStack(page));
    if (await cssAnchoring(page)) near(stack.bottom, VIEWPORTS.desktop.height - 24);
    else near(stack.top, 16);
    near((stack.left + stack.right) / 2, VIEWPORTS.desktop.width / 2);
    await undoButton(page).click();
    expect(await undoCount(page)).toBe(1);
  });
});

// ── data-tip labels: one real node, in the top layer, anchored to its host ──

const tipLabel = (page: Page) => page.locator('[data-tip-label]');

async function expectDelayedReveal(page: Page, host: Locator): Promise<void> {
  // Sample on the browser's event clock. Several driver round trips can
  // otherwise consume the entire 360ms delay before a 150ms assertion runs.
  await host.evaluate((element) => {
    window.atelierRevealSample = new Promise<RevealSample>((resolve) => {
      element.addEventListener('pointerover', () => {
        const entered = performance.now();
        window.setTimeout(() => {
          const label = document.querySelector('[data-tip-label]');
          resolve({ elapsed: performance.now() - entered, visibility: label ? getComputedStyle(label).visibility : 'missing' });
        }, 150);
      }, { once: true });
    });
  });
  await host.hover();
  const sample = await page.evaluate(() => window.atelierRevealSample);
  if (!sample) throw new Error('No tooltip pointer-entry sample');
  expect(sample.elapsed).toBeLessThan(360);
  expect(sample.visibility).toBe('hidden');
}

async function labelsAnchored(page: Page): Promise<boolean> {
  return await cssAnchoring(page)
    && await page.evaluate(() => CSS.supports('justify-self: anchor-center'))
    && await tipLabel(page).getAttribute('data-anchored') !== null;
}

async function revealLabel(page: Page, host: Locator, at?: { x: number; y: number }): Promise<{ anchor: Box; shown: Box }> {
  const anchor = await box(host);
  await page.mouse.move(at?.x ?? anchor.left + anchor.width / 2, at?.y ?? anchor.top + anchor.height / 2);
  const text = await host.getAttribute('data-tip');
  await expect(tipLabel(page)).toHaveText(text ?? '');
  await expect.poll(() => tipLabel(page).evaluate((element) => getComputedStyle(element).opacity)).toBe('1');
  await settle(tipLabel(page));
  return { anchor, shown: await paintedLabelBox(page) };
}

async function paintedLabelBox(page: Page): Promise<Box> {
  // Compare painted bounds: transparent block borders are the hover bridge.
  return tipLabel(page).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const top = rect.top + parseFloat(style.borderTopWidth);
    const bottom = rect.bottom - parseFloat(style.borderBottomWidth);
    return { top, bottom, left: rect.left, right: rect.right, width: rect.width, height: bottom - top };
  });
}

// Where each placement puts the label against its host.
function expectPlaced(place: string, shown: Box, anchor: Box): void {
  if (place.startsWith('below')) near(shown.top, anchor.bottom + TIP_GAP);
  else near(shown.bottom, anchor.top - TIP_GAP);
  if (place.endsWith('-end')) near(shown.right, anchor.right);
  else if (place.endsWith('-start')) near(shown.left, anchor.left);
  else near((shown.left + shown.right) / 2, (anchor.left + anchor.right) / 2);
}

function expectFallbackLabel(page: Page, shown: Box): void {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('no viewport');
  near(shown.top, EDGE);
  near((shown.left + shown.right) / 2, viewport.width / 2);
}

for (const theme of ['light', 'dark'] as const) {
  for (const reducedMotion of ['no-preference', 'reduce'] as const) {
    test.describe(`data-tip labels · ${theme} · motion ${reducedMotion}`, () => {
      test.use({ viewport: VIEWPORTS.desktop });

      test.beforeEach(async ({ page }) => {
        await page.emulateMedia({ reducedMotion });
        await page.goto(`${HARNESS}?case=tips${theme === 'dark' ? '&theme=dark' : ''}`);
      });

      test('every placement shows on its own side of its host, visual only, after the reveal delay', async ({ page }) => {
        for (const place of ['default', 'below', 'above-end', 'above-start', 'below-end', 'below-start']) {
          const host = page.getByRole('button', { name: `Tip ${place}`, exact: true });
          const anchor = await box(host);
          await expectDelayedReveal(page, host);
          const { shown } = await revealLabel(page, host);
          expect(await tipLabel(page).getAttribute('aria-hidden')).toBe('true');
          if (await labelsAnchored(page)) {
            expect(await inTopLayer(tipLabel(page))).toBe(true);
            expectPlaced(place, shown, anchor);
          } else {
            expectFallbackLabel(page, shown);
          }
          await page.mouse.move(4, 4);
          await expect.poll(() => tipLabel(page).evaluate((element) => getComputedStyle(element).visibility)).toBe('hidden');
        }
      });

      test('a label escapes clipping and masking ancestors', async ({ page }) => {
        for (const [name, container] of [['Clipped host', '#clip'], ['Masked host', '#mask']] as const) {
          const { anchor, shown } = await revealLabel(page, page.getByRole('button', { name }));
          if (!(await labelsAnchored(page))) continue;
          expectPlaced('default', shown, anchor);
          const outer = await box(page.locator(container));
          expect(shown.top).toBeLessThan(outer.top);
          expect(await topmostAt(tipLabel(page))).toBe(true);
          await page.mouse.move(4, 4);
        }
      });

      test('moving directly between hosts restarts the reveal delay on the same label', async ({ page }) => {
        await revealLabel(page, page.getByRole('button', { name: 'Tip default', exact: true }));
        const second = page.getByRole('button', { name: 'Tip below', exact: true });
        await expectDelayedReveal(page, second);
        await expect(tipLabel(page)).toHaveText('Label below');
        await expect.poll(() => tipLabel(page).evaluate((element) => getComputedStyle(element).opacity)).toBe('1');
        expect(await tipLabel(page).count()).toBe(1);
      });

      test('a long label wraps inside the window and scrolls past its height', async ({ page }) => {
        const host = page.getByRole('button', { name: 'Long tip' });
        const { anchor, shown } = await revealLabel(page, host);
        expectOnScreen(page, shown);
        expect(shown.width).toBeLessThanOrEqual(VIEWPORTS.desktop.width - 16 + SLOP);
        expect(shown.height).toBeGreaterThan(30);
        // Live asynchronous authoring changes the existing label, not its
        // identity. Its height stays beside the anchor, with real scrolling.
        const text = (await host.getAttribute('data-tip') ?? '').repeat(30);
        await host.evaluate((element, value) => { element.setAttribute('data-tip', value); }, text);
        await expect(tipLabel(page)).toHaveText(text);
        await frames(page);
        const grown = await paintedLabelBox(page);
        expectOnScreen(page, grown);
        if (await labelsAnchored(page)) expectAdjacent(grown, anchor, TIP_GAP);
        expect(await tipLabel(page).evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
        const range = await tipLabel(page).evaluate((element) => {
          element.scrollTop = element.scrollHeight;
          return { actual: element.scrollTop, expected: element.scrollHeight - element.clientHeight };
        });
        near(range.actual, range.expected);
      });

      test('labels in a scrolled list stay on their own row', async ({ page }) => {
        await page.locator('#scroller').evaluate((element) => { element.scrollTop = 50; });
        const { anchor, shown } = await revealLabel(page, page.getByRole('button', { name: 'Row 4' }));
        if (await labelsAnchored(page)) expectPlaced('default', shown, anchor);
      });

      test('a glass tile action, transformed and filtered, keeps the label against it', async ({ page }) => {
        await page.getByRole('button', { name: /^Open image 1/ }).hover();
        const action = page.getByRole('button', { name: 'Download tile' });
        await expect(action).toBeVisible();
        const { anchor, shown } = await revealLabel(page, action);
        if (!(await labelsAnchored(page))) return;
        const place = await action.getAttribute('data-tip-place') ?? 'default';
        expectPlaced(place, shown, anchor);
        expect(await topmostAt(tipLabel(page))).toBe(true);
      });

      test('nested hosts never borrow each other’s label, and a label click never opens the chip', async ({ page }) => {
        const chip = page.getByRole('button', { name: 'Nested model' });
        const value = chip.locator('[data-tip="Value label"]');
        const inner = await revealLabel(page, value);
        if (await labelsAnchored(page)) expectPlaced('default', inner.shown, inner.anchor);

        await page.mouse.move(4, 4);
        const chipBox = await box(chip);
        // The caret end of the chip hovers the chip alone.
        const outer = await revealLabel(page, chip, { x: chipBox.right - 4, y: chipBox.top + chipBox.height / 2 });
        if (await labelsAnchored(page)) expectPlaced('default', outer.shown, outer.anchor);
        await page.mouse.click(outer.shown.left + outer.shown.width / 2, outer.shown.top + outer.shown.height / 2);
        await expect(page.getByRole('listbox', { name: 'Nested model' })).toHaveCount(0);
      });

      test('the pointer travels onto the label and keeps it; pressing it activates nothing', async ({ page }) => {
        const counter = page.getByRole('button', { name: 'Press counter' });
        const { anchor, shown } = await revealLabel(page, counter);
        test.skip(!(await labelsAnchored(page)), 'no anchor in this engine: the label rests top-centre');
        const x = (anchor.left + anchor.right) / 2;
        // Up through the 6px gap onto the label, a pixel at a time.
        await page.mouse.move(x, shown.top + shown.height / 2, { steps: Math.ceil(anchor.height / 2 + TIP_GAP + shown.height / 2) });
        await page.waitForTimeout(300);
        await expect(tipLabel(page)).toHaveAttribute('data-open', '');
        expect(await tipLabel(page).evaluate((element) => getComputedStyle(element).visibility)).toBe('visible');
        await page.mouse.click(x, shown.top + shown.height / 2);
        expect(await tipLabel(page).evaluate((element, point) => document.elementFromPoint(point.x, point.y) === element,
          { x, y: anchor.top - TIP_GAP / 2 })).toBe(true);
        await page.mouse.click(x, anchor.top - TIP_GAP / 2);
        await page.waitForTimeout(100);
        await expect(counter).toHaveText('0');
        await counter.click();
        await expect(counter).toHaveText('1');
      });

      test('a label on a chip menu option: pressing it neither picks the option nor dismisses the menu', async ({ page }) => {
        await page.getByRole('button', { name: 'Nested model' }).click();
        const listbox = page.getByRole('listbox', { name: 'Nested model' });
        await expect(listbox).toBeVisible();
        const option = listbox.getByRole('option', { name: 'Two' });
        const { shown } = await revealLabel(page, option);
        await page.mouse.click(shown.left + shown.width / 2, shown.top + shown.height / 2);
        await page.waitForTimeout(100);
        await expect(listbox).toBeVisible();
        await expect(option).toHaveAttribute('aria-selected', 'false');
        // Escape takes the label first, then the menu.
        await option.hover();
        await page.keyboard.press('Escape');
        await expect(listbox).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(listbox).toHaveCount(0);
      });

      test('keyboard focus shows the label; Escape dismisses it until focus leaves', async ({ page }) => {
        await page.locator('#counter').focus();
        await page.keyboard.press('Shift+Tab');
        await page.keyboard.press('Tab');
        await expect(tipLabel(page)).toHaveText('Counts presses');
        await expect.poll(() => tipLabel(page).evaluate((element) => getComputedStyle(element).opacity)).toBe('1');
        await page.keyboard.press('Escape');
        await expect(page.locator('#counter')).toHaveAttribute('data-tip-dismissed', '');
        await page.waitForTimeout(500);
        expect(await tipLabel(page).evaluate((element) => getComputedStyle(element).visibility)).toBe('hidden');
        await page.keyboard.press('Tab');
        await expect(page.locator('#counter')).not.toHaveAttribute('data-tip-dismissed', '');
      });

      test('inside a modal dialog: the label lives in the dialog, shows over it; Escape dismisses the label, then the dialog', async ({ page }) => {
        await page.locator('#open-dialog').click();
        const host = page.getByRole('button', { name: 'Dialog host' });
        await expect(host).toBeVisible();
        const { anchor, shown } = await revealLabel(page, host);
        expect(await tipLabel(page).evaluate((element) => element.closest('dialog') !== null)).toBe(true);
        expect(await topmostAt(tipLabel(page))).toBe(true);
        if (await labelsAnchored(page)) expectPlaced('default', shown, anchor);
        await page.keyboard.press('Escape');
        await expect(host).toHaveAttribute('data-tip-dismissed', '');
        await expect(page.locator('#dialog-state')).toHaveText('open');
        await page.keyboard.press('Escape');
        await expect(page.locator('#dialog-state')).toHaveText('closed');
      });
    });
  }
}

// Escape belongs to whatever the user can see and reach: a label CSS hides,
// or one behind the active modal, leaves it to the next owner.
test.describe('data-tip labels · Escape ownership', () => {
  test.use({ viewport: VIEWPORTS.desktop });

  test.beforeEach(async ({ page }) => {
    await page.goto(`${HARNESS}?case=tips`);
  });

  test('a focused host clipped out of its list gives up its label, and Escape passes on; back in view it shows again', async ({ page }) => {
    const list = page.locator('#scroller');
    const row = page.getByRole('button', { name: 'Row 4' });
    await page.keyboard.press('Tab');
    await row.focus();
    await expect(row).toBeFocused();
    await expect(tipLabel(page)).toHaveText('Row 4');
    await expect(tipLabel(page)).toHaveAttribute('data-open', '');
    await expect.poll(() => tipLabel(page).evaluate((element) => getComputedStyle(element).opacity)).toBe('1');

    await list.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await frames(page);
    // Still mounted and focused, but wholly outside the list's clip.
    await expect(row).toBeFocused();
    const clip = await box(list);
    const host = await box(row);
    expect(host.top >= clip.bottom - SLOP || host.bottom <= clip.top + SLOP).toBe(true);
    // Its hidden label is given up, not left to own the keyboard.
    await expect(tipLabel(page)).not.toHaveAttribute('data-open');
    await expect.poll(() => inTopLayer(tipLabel(page))).toBe(false);
    const before = await documentEscapes(page);
    await page.keyboard.press('Escape');
    expect(await documentEscapes(page)).toBe(before + 1);
    await expect(row).toBeFocused();
    await expect(row).not.toHaveAttribute('data-tip-dismissed');

    // Back in view, the retained focus shows it again, after the usual delay
    // (sampled on the browser's clock).
    const sample = await row.evaluate((element) => new Promise<{ open: boolean; visibility: string }>((resolve) => {
      element.scrollIntoView({ block: 'nearest' });
      window.setTimeout(() => {
        const node = document.querySelector('[data-tip-label]');
        resolve({ open: node?.hasAttribute('data-open') ?? false, visibility: node ? getComputedStyle(node).visibility : 'missing' });
      }, 150);
    }));
    expect(sample).toEqual({ open: true, visibility: 'hidden' });
    await expect(tipLabel(page)).toHaveText('Row 4');
    await expect.poll(() => tipLabel(page).evaluate((element) => getComputedStyle(element).opacity)).toBe('1');
    await page.keyboard.press('Escape');
    await expect(row).toHaveAttribute('data-tip-dismissed', '');
    expect(await documentEscapes(page)).toBe(before + 1);
  });

  test('a nested native modal owns Escape: the outer dialog’s label never pre-empts it', async ({ page }) => {
    await page.locator('#open-dialog').click();
    // Behind the inner modal it leaves the accessibility tree.
    const host = page.locator('[data-tip="Inside the dialog"]');
    await expect(host).toBeVisible();
    await revealLabel(page, host);
    await expect(tipLabel(page)).toHaveAttribute('data-open', '');

    const shownBehind = await page.evaluate(async () => {
      const inner = document.createElement('dialog');
      inner.id = 'inner-dialog';
      const action = document.createElement('button');
      action.type = 'button';
      action.textContent = 'Inner action';
      inner.append(action);
      document.body.append(inner);
      inner.showModal();
      // Long enough for the lifecycle's observer, far short of a leave grace.
      await new Promise((resolve) => { window.setTimeout(resolve, 0); });
      return document.querySelector('[data-tip-label]')?.hasAttribute('data-open') ?? false;
    });
    const inner = page.locator('#inner-dialog');
    await expect(inner.getByRole('button', { name: 'Inner action' })).toBeFocused();
    expect(await page.evaluate(() => document.querySelectorAll('dialog:modal').length)).toBe(2);
    expect(shownBehind).toBe(false);

    const before = await documentEscapes(page);
    await page.keyboard.press('Escape');
    expect(await documentEscapes(page)).toBe(before + 1);
    await expect.poll(() => inner.evaluate((element) => element instanceof HTMLDialogElement && element.open)).toBe(false);
    await expect(page.locator('#dialog-state')).toHaveText('open');
    await expect(host).not.toHaveAttribute('data-tip-dismissed');
  });
});

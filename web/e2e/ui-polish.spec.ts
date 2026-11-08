import { devices, expect, test, type Page } from '@playwright/test';
import type { AdminProvider, Batch, CollectionsResponse, LibraryCoverageResponse, LibraryDiagnosisResponse, PromptLibraryResponse, TextModelsResponse } from '@atelier/shared';
import { TEXT_TASKS } from '@atelier/shared';
import type * as ReactApi from 'react';
import type * as ReactDomApi from 'react-dom/client';
import type * as StateViewApi from '../src/components/StateView';
import { batches as viewerFixtureBatches, promptLibrary as reorderLibrary } from './studio/fixture';

const VIEWER_FRAME = 'dialog > div[data-media][aria-busy]';
const VIEWER_DOCK = 'dialog > div[data-media]:not([aria-busy])';
const VIEWER_BODY_MODULE = /\/src\/components\/Lightbox\/Content\.tsx(?:\?.*)?$/;

test.describe('resource reorder preserves editor:', () => {
  for (const colorScheme of ['light', 'dark'] as const) {
    for (const input of ['pointer', 'keyboard'] as const) {
      test(`${colorScheme} desktop ${input}`, async ({ browser }, testInfo) => {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme });
        try {
          for (const kind of ['templates', 'variableLists'] as const) {
            const firstTemplate = reorderLibrary.templates[0];
            const firstList = reorderLibrary.variableLists[0];
            const firstOption = firstList?.options[0];
            if (!firstTemplate || !firstList || !firstOption) throw new Error('Missing reorder fixtures');
            const seed: PromptLibraryResponse = {
              ...reorderLibrary,
              templates: [0, 1, 2].map((index) => ({ ...firstTemplate, id: `reorder-template-${index}`, name: `Reorder study ${index}`, body: `Saved body ${index}`, sortOrder: index })),
              variableLists: [0, 1, 2].map((index) => ({
                ...firstList, id: `reorder-list-${index}`, name: `reorder-axis-${index}`, sortOrder: index,
                options: [{ ...firstOption, id: `reorder-option-${index}`, listId: `reorder-list-${index}`, value: `Saved value ${index}` }],
              })),
            };
            const displayed = seed[kind][0];
            if (!displayed) throw new Error('Missing displayed resource');
            const resourceId = (index: number) => {
              const item = seed[kind][index];
              if (!item) throw new Error('Missing reorder resource');
              return item.id;
            };
            const page = await context.newPage();
            let current = seed;
            const orders: string[][] = [];
            await page.route('**/api/prompts/*/order', async (route) => {
              const { orderedIds } = route.request().postDataJSON() as { orderedIds: string[] };
              orders.push(orderedIds);
              current = { ...current, [kind]: orderedIds.map((id) => {
                const item = current[kind].find((item) => item.id === id);
                if (!item) throw new Error('Unknown reordered resource');
                return item;
              }) };
              await route.fulfill({ json: current });
            });
            // Keep the existing offline fixture for every other request. Only
            // resource reads and reorder writes use this bounded test fixture.
            await page.addInitScript((library: PromptLibraryResponse) => {
              const nativeFetch = window.fetch.bind(window);
              let inner = nativeFetch;
              const fixture = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
                const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
                if (url.pathname === '/api/prompts') return Response.json(library);
                if (/^\/api\/prompts\/(templates|lists)\/order$/.test(url.pathname)) {
                  const response = await nativeFetch(input, init);
                  if (response.ok) library = await response.clone().json() as PromptLibraryResponse;
                  return response;
                }
                return inner(input, init);
              };
              Object.defineProperty(window, 'fetch', { configurable: true, get: () => fixture, set: (value: typeof fetch) => { inner = value; } });
            }, seed);
            await page.goto('/e2e/studio/index.html?view=prompts');
            await expect(page.locator('html')).toHaveAttribute('data-theme', colorScheme);
            if (kind === 'variableLists') await page.getByRole('tab', { name: 'Variable lists', exact: true }).click();
            const rail = page.getByRole('complementary', { name: kind === 'templates' ? 'Templates' : 'Lists', exact: true });
            const rows = rail.locator('button[aria-pressed]');
            const row = (index: number) => rail.getByRole('button', { name: kind === 'templates' ? `Reorder study ${index}` : `Edit list reorder-axis-${index}, 1 option`, exact: true });
            const editor = page.getByRole('form', { name: kind === 'templates' ? 'Edit template Reorder study 0' : 'Edit variable list reorder-axis-0', exact: true });
            const field = editor.getByRole('textbox', { name: kind === 'templates' ? 'Body' : /^Option 1:/ });
            const draft = `Unsaved ${kind} draft`;
            await field.fill(draft);
            const originalField = await field.elementHandle();
            const assertEditor = async () => {
              await expect(editor).toBeVisible();
              await expect(editor.getByRole('textbox', { name: kind === 'templates' ? 'Template name' : 'Variable list name', exact: true }))
                .toHaveValue(displayed.name);
              await expect(field).toHaveValue(draft);
              await expect(row(0)).toHaveAttribute('aria-pressed', 'true');
              expect(await field.evaluate((element, original) => element === original, originalField)).toBe(true);
            };
            const names = (order: number[]) => order.map((index) => kind === 'templates' ? `Reorder study ${index}` : `reorder-axis-${index}1`);
            await expect(rows).toHaveText(names([0, 1, 2]));
            if (input === 'pointer') {
              const start = await row(0).boundingBox();
              const end = await row(2).boundingBox();
              if (!start || !end) throw new Error('Missing native drag rows');
              const x = start.x + 12;
              await page.mouse.move(x, start.y + start.height / 2);
              await page.mouse.down();
              await page.mouse.move(x, end.y + end.height - 2, { steps: 12 });
              await expect(rail.locator('[data-drag-active]')).toHaveAttribute('data-drag-active', 'true');
              await page.mouse.up();
              await expect(rows).toHaveText(names([1, 2, 0]));
              await expect.poll(() => orders).toEqual([[1, 2, 0].map(resourceId)]);
            } else {
              await row(0).press('Alt+ArrowDown');
              await expect(rows).toHaveText(names([1, 0, 2]));
              await expect.poll(() => orders).toEqual([[1, 0, 2].map(resourceId)]);
            }
            await assertEditor();
            // Reordering another focused row must not select it either.
            await row(1).press('Alt+ArrowDown');
            const finalOrder = input === 'pointer' ? [2, 1, 0] : [0, 1, 2];
            await expect(rows).toHaveText(names(finalOrder));
            await expect.poll(() => orders.length).toBe(2);
            expect(orders[1]).toEqual(finalOrder.map(resourceId));
            await assertEditor();
            await row(2).click();
            await expect(page.getByRole('textbox', { name: kind === 'templates' ? 'Body' : /^Option 1:/ }))
              .toHaveValue(kind === 'templates' ? 'Saved body 2' : 'Saved value 2');
            await row(0).click();
            await expect(field).toHaveValue(draft);
            await testInfo.attach(`${kind}-${input}-identity.json`, { body: JSON.stringify({ colorScheme, input, displayedId: displayed.id, displayedName: displayed.name, draft, orders, finalOrder, sameFieldBeforeExplicitClick: true, explicitClickChangedEditor: true }), contentType: 'application/json' });
            await page.close();
          }
        } finally { await context.close(); }
      });
    }
  }
});

function viewerHold() {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  return { held, release };
}

async function viewerFixture(page: Page, thumbs: boolean) {
  // Reuse the studio stills, with an independently held HTTP image request.
  // This distinguishes body code readiness from native image readiness.
  const first = viewerFixtureBatches.at(-1)?.tiles[0];
  if (first?.status !== 'done') throw new Error('studio still fixture required');
  const svg = decodeURIComponent(first.url.slice(first.url.indexOf(',') + 1)).replace('<svg ', '<svg width="2400" height="2400" ');
  await page.addInitScript((thumbs) => {
    let inner = window.fetch.bind(window);
    const fetchFixture = async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await inner(input, init);
      const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
      if (url.pathname !== '/api/history') return response;
      const history = await response.json() as { items: { id: string; tiles: { id: string; url: string; thumbUrl?: string }[] }[] };
      return Response.json({ ...history, items: history.items.map((batch) => batch.id !== 'studio-batch-4' ? batch : {
        ...batch, tiles: batch.tiles.map((tile) => ({ ...tile,
          ...(thumbs ? { thumbUrl: tile.url } : {}), url: `/viewer-loading-image.svg?id=${tile.id}`,
        })),
      }) });
    };
    Object.defineProperty(window, 'fetch', { configurable: true, get: () => fetchFixture as typeof fetch, set: (value: typeof fetch) => { inner = value; } });
  }, thumbs);
  return svg;
}

interface ViewerContinuityEvidence {
  stop: boolean;
  events: { target: string; property: string; duration: number; easing: string }[];
  samples: { t: number; present: boolean; frame: boolean; opacity: number; background: string; blur: string; dock: boolean }[];
};

declare global {
  interface Window { __viewerContinuity?: ViewerContinuityEvidence; __viewerExit?: { closing: string | null; t: number } }
}

async function recordViewerContinuity(page: Page) {
  await page.evaluate(({ frameSelector, dockSelector }) => {
    const evidence: ViewerContinuityEvidence = { stop: false, events: [], samples: [] };
    window.__viewerContinuity = evidence;
    document.addEventListener('transitionrun', (event) => {
      if (evidence.stop || !(event instanceof TransitionEvent) || !(event.target instanceof Element)) return;
      const element = event.target;
      const target = element.matches('dialog') ? 'dialog' : element.matches(frameSelector) ? 'frame'
        : element.matches(dockSelector) ? 'dock' : element.matches(`${frameSelector} > img`) ? 'image' : null;
      if (!target) return;
      const animation = element.getAnimations().find((animation) => animation instanceof CSSTransition && animation.transitionProperty === event.propertyName);
      const timing = animation?.effect?.getTiming();
      evidence.events.push({ target, property: event.propertyName, duration: Number(timing?.duration ?? -1), easing: timing?.easing ?? '' });
    }, true);
    const sample = () => {
      if (evidence.stop || evidence.samples.length >= 300) return;
      const dialog = document.querySelector('dialog');
      const style = dialog ? getComputedStyle(dialog) : null;
      evidence.samples.push({ t: performance.now(), present: dialog !== null,
        frame: document.querySelector(frameSelector) !== null, opacity: Number(style?.opacity ?? 0),
        background: style?.backgroundColor ?? '', blur: style?.backdropFilter ?? '', dock: document.querySelector(dockSelector) !== null });
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, { frameSelector: VIEWER_FRAME, dockSelector: VIEWER_DOCK });
}

const viewerMatrix = [
  { width: 1440, height: 900, touch: false, reduced: false },
  { width: 1440, height: 900, touch: false, reduced: true },
  { width: 390, height: 844, touch: true, reduced: false },
  { width: 390, height: 844, touch: true, reduced: true },
  { width: 844, height: 390, touch: true, reduced: false },
  { width: 2560, height: 1440, touch: false, reduced: false },
];

for (const layout of viewerMatrix) {
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`viewer loading continuity: persistent frame ${String(layout.width)}x${String(layout.height)} ${colorScheme} ${layout.reduced ? 'reduced' : 'normal'}`, async ({ browser }, testInfo) => {
      test.setTimeout(90_000);
      const context = await browser.newContext({ viewport: { width: layout.width, height: layout.height }, hasTouch: layout.touch, isMobile: layout.touch, colorScheme, reducedMotion: layout.reduced ? 'reduce' : 'no-preference' });
      const code = viewerHold();
      const image = viewerHold();
      let requestedCode = 0;
      let requestedImage = 0;
      try {
        const page = await context.newPage();
        const svg = await viewerFixture(page, colorScheme === 'dark');
        await page.route(VIEWER_BODY_MODULE, async (route) => { requestedCode++; await code.held; await route.continue(); });
        await page.route('**/viewer-loading-image.svg?*', async (route) => { requestedImage++; await image.held; await route.fulfill({ contentType: 'image/svg+xml', body: svg }); });
        await page.route('**/api/uploads/studio-ref-*', async (route) => { await route.fulfill({ contentType: 'image/svg+xml', body: svg }); });
        await page.goto('/e2e/studio/index.html?refs=1&batches=3', { waitUntil: 'domcontentloaded' });
        if (layout.height < 500) await page.getByRole('button', { name: 'Minimize composer', exact: true }).tap();
        const opener = page.locator('section[data-batch-id="studio-batch-4"]').getByRole('button', { name: /^Open image 1/ });
        await expect(opener).toBeVisible();
        await opener.focus();
        await recordViewerContinuity(page);
        if (layout.touch) await opener.tap(); else await opener.press('Enter');
        const dialog = page.getByRole('dialog');
        const close = page.getByRole('button', { name: 'Close lightbox' });
        const frame = page.locator(VIEWER_FRAME);
        await expect(close).toBeFocused();
        await expect(frame).toHaveAttribute('aria-busy', 'true');
        await expect.poll(() => requestedCode).toBe(1);
        await expect(dialog.getByRole('img', { name: /Expanded generated image/ })).toHaveCount(0);
        const dialogNode = await dialog.elementHandle();
        const frameNode = await frame.elementHandle();
        await expect(page.locator(VIEWER_DOCK)).toHaveCount(0);
        await expect(dialog.getByRole('status').filter({ hasText: /Loading/ })).toHaveCount(0);
        await expect(dialog.locator('[class*="plate"]')).toHaveCount(0);
        await expect(dialog.getByText(/Loading/)).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Previous image' })).toBeDisabled();
        const next = page.getByRole('button', { name: 'Next image' });
        if (layout.touch) await next.tap(); else await next.click();
        await expect(next).toBeDisabled();
        await expect(dialog).toHaveAccessibleName(/preview, 2 of 2/);
        const previous = page.getByRole('button', { name: 'Previous image' });
        if (layout.touch) await previous.tap(); else await previous.click();
        // Keyboard navigation shares the live store path while the body is held.
        await page.keyboard.press('ArrowRight');
        await expect(dialog).toHaveAccessibleName(/preview, 2 of 2/);
        await page.keyboard.press('ArrowLeft');
        await expect(dialog).toHaveAccessibleName(/preview, 1 of 2/);
        await previous.focus();
        // Disabled Previous cannot hold focus; keep it on enabled Next instead.
        await next.focus();
        await expect(next).toBeFocused();
        await page.waitForTimeout(450);
        code.release();
        await expect(frame).toHaveAttribute('aria-busy', 'false');
        await expect(page.locator(VIEWER_DOCK)).toBeVisible();
        await expect.poll(() => requestedImage).toBeGreaterThan(0);
        const full = dialog.getByRole('img', { name: /Expanded generated image/ });
        await expect(full).toHaveCSS('opacity', '0');
        await expect(next).toBeFocused();
        expect(await frame.evaluate((element, node) => element === node, frameNode)).toBe(true);
        expect(await dialog.evaluate((element, node) => element === node, dialogNode)).toBe(true);
        await expect(page.locator(VIEWER_DOCK)).toHaveCSS('transform', 'none');
        image.release();
        await expect(full).toHaveCSS('opacity', '1');
        const reference = page.getByRole('button', { name: 'View reference image 1 of 2' });
        await expect(reference).toBeVisible();
        if (layout.touch) await reference.tap(); else await reference.click();
        await expect(dialog).toHaveAccessibleName(/^Reference image preview/);
        const refImage = dialog.getByRole('img', { name: /Expanded reference image/ });
        await expect(refImage).toHaveCSS('opacity', '1');
        if (layout.width < 2560) {
          const zoom = dialog.getByRole('button', { name: 'Zoom to full resolution' });
          await expect(zoom).toBeVisible();
          if (layout.touch) await zoom.tap(); else await zoom.click();
          await expect(dialog.locator('[data-slot="zoom"]')).toHaveAttribute('aria-pressed', 'true');
          await next.focus();
          await page.keyboard.press('Escape');
          await expect(dialog).not.toHaveAttribute('data-closing', 'true');
          await expect(dialog.getByRole('button', { name: 'Zoom to full resolution' })).toHaveAttribute('aria-pressed', 'false');
        }
        const evidence = await page.evaluate(() => { if (window.__viewerContinuity) window.__viewerContinuity.stop = true; return window.__viewerContinuity; });
        await testInfo.attach('viewer-continuity.json', { body: JSON.stringify({ layout, colorScheme, requestedCode, requestedImage, evidence }), contentType: 'application/json' });
        if (!evidence) throw new Error('missing continuity evidence');
        const start = evidence.samples.findIndex((sample) => sample.present && sample.opacity > 0.01);
        expect(start).toBeGreaterThanOrEqual(0);
        const visible = evidence.samples.slice(start);
        expect(visible.every((sample) => sample.present && sample.frame && sample.opacity > 0)).toBe(true);
        expect(new Set(visible.map((sample) => sample.background)).size).toBe(1);
        expect(new Set(visible.map((sample) => sample.blur)).size).toBe(1);
        for (let i = 1; i < visible.length; i++) {
          const current = visible[i];
          const previous = visible[i - 1];
          if (!current || !previous) throw new Error('missing consecutive sample');
          expect(current.opacity).toBeGreaterThanOrEqual(previous.opacity - 0.01);
        }
        for (const target of ['dialog', 'frame']) {
          const enters = evidence.events.filter((event) => event.target === target && event.property === 'opacity');
          expect(enters, `${target} single actual entrance`).toHaveLength(1);
          expect(enters[0]?.duration).toBe(layout.reduced ? 80 : target === 'frame' ? 380 : 240);
          if (layout.reduced) expect(enters[0]?.easing).toBe('linear');
        }
        expect(evidence.events.filter((event) => event.target === 'dock')).toEqual([]);
        if (!layout.reduced) expect(evidence.events.some((event) => event.target === 'image' && event.property === 'opacity' && event.duration === 240)).toBe(true);
        if (layout.touch) { await expectFloor(close, 'viewer Close'); await expectFloor(next, 'viewer Next'); }
        if (layout.width < 2560) {
          const zoom = dialog.getByRole('button', { name: 'Zoom to full resolution' });
          if (layout.touch) await zoom.tap(); else await zoom.click();
          await expect(dialog.locator('[data-slot="zoom"]')).toHaveAttribute('aria-pressed', 'true');
        }
        if (layout.touch) await close.tap(); else await close.click();
        await expect(dialog).toHaveCount(0);
        await expect(opener).toBeFocused();
        // A warm open uses the cached body in the same fixture, with no hold.
        if (layout.touch) await opener.tap(); else await opener.press('Enter');
        await expect(page.locator(VIEWER_DOCK)).toBeVisible();
        expect(requestedCode).toBe(1);
        if (layout.touch) await close.tap(); else await close.click();
        await expect(dialog).toHaveCount(0);
      } finally {
        code.release(); image.release();
        await context.close();
      }
    });
  }
}

for (const control of ['frame', 'Expand'] as const) {
  test(`viewer loading continuity: native touch ${control} returns to its exact opener at 390x844`, async ({ browser }, testInfo) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    try {
      const page = await context.newPage();
      let requestedCode = 0;
      page.on('request', (request) => { if (VIEWER_BODY_MODULE.test(request.url())) requestedCode++; });
      await page.goto('/e2e/studio/index.html?batches=3');
      await expect(page.getByRole('button', { name: 'Expand composer', exact: true })).toBeVisible();
      const batch = page.locator('section[data-batch-id="studio-batch-4"]');
      const opener = batch.getByRole('button', { name: control === 'frame' ? /^Open image 1/ : 'Expand tile 1' });
      await expect(opener).toBeVisible();
      await opener.scrollIntoViewIfNeeded();
      const openerNode = await opener.elementHandle();
      const elsewhere = page.getByTestId('canvas-scroller');
      const dialog = page.getByRole('dialog');
      const close = page.getByRole('button', { name: 'Close lightbox' });
      const outcomes: { phase: string; control: string; exactOpenerFocused: boolean; requestedCode: number }[] = [];
      expect(requestedCode).toBe(0);
      for (const phase of ['cold', 'warm']) {
        await elsewhere.focus();
        await expect(elsewhere).toBeFocused();
        await expect(opener).not.toBeFocused();
        await opener.tap();
        await expect(close).toBeFocused();
        await expect(page.locator(VIEWER_DOCK)).toBeVisible();
        await expect(close).toBeFocused();
        expect(requestedCode).toBe(1);
        await close.tap();
        await expect(dialog).toHaveCount(0);
        await expect(opener).toBeFocused();
        const exactOpenerFocused = await page.evaluate((node) => document.activeElement === node, openerNode);
        expect(exactOpenerFocused).toBe(true);
        outcomes.push({ phase, control, exactOpenerFocused, requestedCode });
      }
      await testInfo.attach('native-opener-focus.json', { body: JSON.stringify(outcomes), contentType: 'application/json' });
    } finally {
      await context.close();
    }
  });
}

for (const reduced of [false, true]) {
  for (const dismissal of ['Escape', 'Close', 'backdrop'] as const) {
    test(`viewer loading continuity: pending ${dismissal} ${reduced ? 'reduced' : 'normal'}`, async ({ page }, testInfo) => {
      const code = viewerHold();
      await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
      await page.route(VIEWER_BODY_MODULE, async (route) => { await code.held; await route.continue(); });
      try {
        await page.goto('/e2e/studio/index.html');
        const opener = page.locator('section[data-batch-id="studio-batch-4"]').getByRole('button', { name: /^Open image 1/ });
        await expect(opener).toBeVisible();
        await opener.focus();
        await opener.press('Enter');
        const dialog = page.getByRole('dialog');
        await expect(page.getByRole('button', { name: 'Close lightbox' })).toBeFocused();
        await expect(page.locator(VIEWER_FRAME)).toHaveAttribute('aria-busy', 'true');
        // Observe data-closing on the mutation clock, even for the 80ms exit.
        await dialog.evaluate((element) => {
          delete window.__viewerExit;
          const observer = new MutationObserver(() => {
            if (element.getAttribute('data-closing') !== 'true') return;
            observer.disconnect(); window.__viewerExit = { closing: element.getAttribute('data-closing'), t: performance.now() };
          });
          observer.observe(element, { attributes: true, attributeFilter: ['data-closing'] });
        });
        if (dismissal === 'Escape') await page.getByRole('button', { name: 'Next image' }).focus();
        if (dismissal === 'Escape') await page.keyboard.press('Escape');
        else if (dismissal === 'Close') await page.getByRole('button', { name: 'Close lightbox' }).click();
        else await dialog.click({ position: { x: 4, y: 4 } });
        await expect.poll(() => page.evaluate(() => window.__viewerExit?.closing)).toBe('true');
        await testInfo.attach('pending-exit.json', { body: JSON.stringify(await page.evaluate(() => window.__viewerExit)), contentType: 'application/json' });
        await expect(dialog).toHaveCount(0);
        await expect(opener).toBeFocused();
        code.release();
        await page.unrouteAll({ behavior: 'wait' });
        await page.waitForTimeout(450);
        await expect(dialog).toHaveCount(0);
      } finally {
        code.release();
        await page.unrouteAll({ behavior: 'wait' });
      }
    });
  }
}

for (const failure of ['abort', 'module error'] as const) {
  test(`viewer loading continuity: ${failure} stays scoped and recovery closes`, async ({ page }, testInfo) => {
    const code = viewerHold();
    await page.route(VIEWER_BODY_MODULE, async (route) => {
      await code.held;
      if (failure === 'abort') await route.abort('failed');
      else await route.fulfill({ contentType: 'text/javascript', body: 'throw new Error("viewer body fixture failure");' });
    });
    try {
      await page.goto('/e2e/studio/index.html?batches=6');
      const prompt = page.getByRole('textbox', { name: 'Prompt', exact: true });
      await prompt.fill('Keep this draft through viewer failure');
      const opener = page.locator('section[data-batch-id="studio-batch-4"]').getByRole('button', { name: /^Open image 1/ });
      await expect(opener).toBeVisible();
      await opener.focus();
      const before = await page.getByTestId('canvas-scroller').evaluate((element) => element.scrollTop);
      await opener.press('Enter');
      const frame = await page.locator(VIEWER_FRAME).elementHandle();
      const dialog = await page.getByRole('dialog').elementHandle();
      code.release();
      const back = page.getByRole('button', { name: 'Back to Unsorted' });
      await expect(back).toBeVisible();
      await expect(page.getByRole('button', { name: 'Close lightbox' })).toBeVisible();
      expect(await page.locator(VIEWER_FRAME).evaluate((element, node) => element === node, frame)).toBe(true);
      expect(await page.getByRole('dialog').evaluate((element, node) => element === node, dialog)).toBe(true);
      await expect(page.getByText('The viewer hit an error — the rest of Atelier is unaffected.')).toBeVisible();
      await page.getByRole('button', { name: 'Next image' }).click();
      await expect(page.getByRole('dialog')).toHaveAccessibleName(/preview, 2 of 2/);
      await back.click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(opener).toBeFocused();
      await expect(prompt).toHaveValue('Keep this draft through viewer failure');
      const after = await page.getByTestId('canvas-scroller').evaluate((element) => element.scrollTop);
      expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
      await testInfo.attach('body-failure.json', { body: JSON.stringify({ failure, before, after, sameDialog: true, sameFrame: true }), contentType: 'application/json' });
    } finally {
      code.release();
      await page.unrouteAll({ behavior: 'wait' });
    }
  });
}

const noHorizontalOverflow = (page: Page) => page.evaluate(() =>
  document.documentElement.scrollWidth <= window.innerWidth + 1,
);

// Extend the public offline fixture without changing its production owners.
async function withSettingsOwnership(page: Page, holdTask?: string): Promise<void> {
  await page.addInitScript(({ tasks, holdTask }) => {
    let inner = window.fetch.bind(window);
    const models: TextModelsResponse['models'] = [
      { id: 'atlas', displayName: 'Atlas', providerName: 'Preview provider', vision: true, reasoningLevels: ['low', 'high'], status: 'available' },
      { id: 'override', displayName: 'Personal writer', providerName: 'Preview provider', vision: true, reasoningLevels: ['low', 'high'], status: 'available' },
      { id: 'fixed', displayName: 'Fixed writer', providerName: 'Preview provider', vision: true, reasoningLevels: [], status: 'available' },
      { id: 'offline', displayName: 'Offline writer', providerName: 'Preview provider', vision: true, reasoningLevels: ['low', 'high'], status: 'offline' },
    ];
    let current: TextModelsResponse = {
      models, defaults: { default: 'atlas', byTask: {} }, writers: {},
      tasks: tasks.map((task) => task === 'storytelling'
        ? { task, pick: 'offline', pickState: 'offline', effectiveModelId: 'atlas', effort: 'high' }
        : task === 'list-draft'
          ? { task, pick: 'fixed', pickState: 'active', effectiveModelId: 'fixed' }
          : { task, effectiveModelId: 'atlas' }),
    };
    const writes: { task: string; body: unknown }[] = [];
    let releaseSave: (() => void) | undefined;
    const evidence: unknown[] = [];
    const describe = (element: Element | null) => element === null ? null : {
      tag: element.tagName, role: element.getAttribute('role'), label: element.getAttribute('aria-label'),
    };
    const record = (step: string, event?: Event) => {
      const trigger = document.querySelector<HTMLButtonElement>('button[aria-label^="Text model for AI fill,"]');
      const menu = document.querySelector('[role="listbox"][aria-label^="Text model for AI fill,"]');
      evidence.push({ step, time: performance.now(), active: describe(document.activeElement),
        disabled: trigger?.disabled, menuMounted: menu !== null, closing: menu?.getAttribute('data-closing'),
        ...(event === undefined ? {} : { target: describe(event.target instanceof Element ? event.target : null),
          ...(event instanceof KeyboardEvent ? { key: event.key } : {}) }) });
    };
    if (holdTask !== undefined) {
      for (const type of ['focusin', 'focusout', 'pointerdown', 'keydown']) {
        document.addEventListener(type, (event) => { record(type, event); }, true);
      }
    }
    const fetchSettings = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
      if (url.pathname === '/settings-ownership-focus-evidence') {
        record(url.searchParams.get('step') ?? 'snapshot');
        return Response.json(evidence);
      }
      if (url.pathname === '/settings-ownership-release') {
        record('release-response');
        releaseSave?.();
        releaseSave = undefined;
        return Response.json({ released: true });
      }
      if (url.pathname === '/settings-ownership-held') return Response.json({ pending: releaseSave !== undefined });
      if (url.pathname === '/api/text-models') return Response.json(current);
      if (url.pathname.startsWith('/api/text-models/tasks/') && init?.method === 'PUT') {
        const task = url.pathname.split('/').at(-1);
        if (typeof init.body !== 'string') throw new Error('expected JSON task pick');
        const body = JSON.parse(init.body) as { modelId: string | null; effort?: 'low' | 'high' | null };
        writes.push({ task: task ?? '', body });
        if (task === holdTask) {
          record('hold-response');
          await new Promise<void>((resolve) => { releaseSave = resolve; });
        }
        current = { ...current, tasks: current.tasks.map((row) => row.task !== task ? row : body.modelId === null
          ? { task: row.task, effectiveModelId: 'atlas' }
          : { task: row.task, pick: body.modelId, pickState: 'active', effectiveModelId: body.modelId,
            ...(body.effort === undefined || body.effort === null ? {} : { effort: body.effort }) }) };
        return Response.json(current);
      }
      if (url.pathname === '/settings-ownership-writes') return Response.json(writes);
      const response = await inner(input, init);
      if (url.pathname === '/api/text-providers') {
        const data = await response.json() as { providers: AdminProvider[] };
        return Response.json({ providers: data.providers.map((provider) => {
          const template = provider.models[0];
          if (!template) throw new Error('missing public model fixture');
          return { ...provider, models: models.map((model) => ({ ...template, ...model, enabled: true })) };
        }) });
      }
      if (url.pathname === '/api/text-routing') {
        const data = await response.json() as Record<string, unknown>;
        return Response.json({ ...data, defaults: current.defaults });
      }
      return response;
    };
    Object.defineProperty(window, 'fetch', { configurable: true, get: () => fetchSettings, set: (value: typeof fetch) => { inner = value; } });
  }, { tasks: TEXT_TASKS, holdTask });
}

async function expectSettingsInk(value: ReturnType<Page['locator']>, token: '--ink' | '--ink-3'): Promise<void> {
  expect(await value.evaluate((element, ink) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${ink})`;
    element.append(probe);
    const matches = getComputedStyle(element).color === getComputedStyle(probe).color;
    probe.remove();
    return matches;
  }, token)).toBe(true);
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`settings ownership: personal choices and everyone defaults at ${String(viewport.width)}×${String(viewport.height)} in ${colorScheme}`, async ({ browser }) => {
      const { defaultBrowserType: _engine, ...device } = viewport.width === 1440 ? devices['Desktop Chrome'] : devices['iPhone 13'];
      const context = await browser.newContext({ ...device, viewport, colorScheme });
      try {
        const page = await context.newPage();
        await withSettingsOwnership(page);
        await page.goto('/e2e/studio/index.html?view=prompts&textAdmin=1&textProvider=1');
        await page.getByRole('tab', { name: 'Settings', exact: true }).click();
        const panel = page.getByRole('region', { name: 'Your text model settings', exact: true });
        await expect(panel.getByRole('heading', { level: 2, name: 'Your text models', exact: true })).toBeVisible();
        await expect(panel.getByText('Choose which model writes for you in each feature. Default follows the shared setup.', { exact: true })).toBeVisible();
        const model = panel.getByRole('button', { name: /^Text model for AI fill,/ });
        const effort = panel.locator('button[aria-label^="Reasoning effort for AI fill,"]');
        const slot = effort.locator('..');
        const mountedSlot = await slot.elementHandle();
        const inactiveBox = await slot.evaluate((element) => element.getBoundingClientRect().toJSON() as { width: number; height: number });
        expect(inactiveBox.width).toBeGreaterThan(0);
        expect(inactiveBox.height).toBeGreaterThan(0);
        // The inline-flex wrapper is blockified as a flex item by the browser.
        await expect(slot).toHaveCSS('display', 'flex');
        await expect(slot).toHaveCSS('visibility', 'hidden');
        await expect(slot).toHaveAttribute('inert', '');
        await expect(slot).toHaveAttribute('aria-hidden', 'true');
        await expect(effort).toBeDisabled();
        await expect(effort).not.toHaveAttribute('data-tip');
        await expect(page.locator('[data-tip-label]').filter({ hasText: 'Pick a model to choose its reasoning effort' })).toHaveCount(0);
        await expect(panel.getByRole('button', { name: /^Reasoning effort for AI fill,/ })).toHaveCount(0);
        await expectSettingsInk(model.locator('span').first().locator('span'), '--ink-3');
        const touch = await page.evaluate(() => matchMedia('(hover: none), (any-pointer: coarse)').matches);
        const tab = browser.browserType().name() === 'webkit' ? 'Alt+Tab' : 'Tab';
        if (touch) await expectFloor(model, 'personal model');
        await model.focus();
        await page.keyboard.press(tab);
        await expect(panel.getByRole('button', { name: /^Text model for Brainstorm,/ })).toBeFocused();
        await effort.evaluate((element) => { (element as HTMLButtonElement).focus(); });
        await expect(effort).not.toBeFocused();
        await model.focus();
        await page.keyboard.press('Enter');
        const menu = page.getByRole('listbox', { name: /^Text model for AI fill,/ });
        await expect(menu).toBeFocused();
        await expect(page.getByRole('option', { name: 'Offline writer offline', exact: true })).toHaveAttribute('aria-disabled', 'true');
        // Default (Atlas) and Personal writer have equal character counts;
        // only the visibility toggle below claims displacement invariance.
        await page.keyboard.press('Home');
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
        await expect(menu).toHaveCount(0);
        await expect(model).toHaveAccessibleName('Text model for AI fill, currently Personal writer');
        await expect(model).toBeEnabled();
        await expect(model).toBeFocused();
        await expect(effort).toBeVisible();
        await expect(effort).toBeEnabled();
        await expect(slot).not.toHaveAttribute('inert');
        await expect(slot).not.toHaveAttribute('aria-hidden');
        expect(await slot.evaluate((element, original) => element === original, mountedSlot)).toBe(true);
        await expectSettingsInk(model.locator('span').first(), '--ink');
        if (touch) await expectFloor(effort, 'personal effort');
        await page.keyboard.press(tab);
        await expect(effort).toBeFocused();
        const geometry = () => model.evaluate((element) => {
          const row = element.parentElement?.parentElement;
          const slot = element.nextElementSibling;
          if (!row || !slot) throw new Error('missing settings row');
          return [element, slot, row].map((node) => {
            const rect = node.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
          });
        });
        const liveGeometry = await geometry();
        await slot.evaluate((element) => { element.style.visibility = 'hidden'; });
        expect(await geometry(), 'hiding the same slot alone preserves geometry').toEqual(liveGeometry);
        await slot.evaluate((element) => { element.style.visibility = ''; });
        expect(await geometry(), 'revealing the same slot alone preserves geometry').toEqual(liveGeometry);
        await effort.click();
        await expect(page.getByRole('listbox')).toBeFocused();
        await page.keyboard.press('End');
        await page.keyboard.press('Enter');
        await expect(page.getByRole('listbox')).toHaveCount(0);
        await expect(effort).toHaveAccessibleName('Reasoning effort for AI fill, currently High effort');
        await expect(effort).toBeEnabled();
        await expect(effort).toBeFocused();
        await effort.click();
        await page.keyboard.press('Escape');
        await expect(page.getByRole('listbox')).toHaveCount(0);
        await expect(effort).toBeFocused();
        await model.click();
        await page.getByRole('option', { name: 'Use default (Atlas)', exact: true }).click();
        await expect(page.getByRole('listbox')).toHaveCount(0);
        await expect(model).toHaveAccessibleName('Text model for AI fill, currently Default (Atlas)');
        await expect(model).toBeEnabled();
        await expect(model).toBeFocused();
        await expect(slot).toHaveCSS('visibility', 'hidden');
        await expect(slot).toHaveAttribute('inert', '');
        await expect(slot).toHaveAttribute('aria-hidden', 'true');
        expect(await slot.evaluate((element, original) => element === original, mountedSlot)).toBe(true);
        const clearedBox = await slot.evaluate((element) => element.getBoundingClientRect().toJSON() as { width: number; height: number });
        expect(clearedBox.width).toBe(inactiveBox.width);
        expect(clearedBox.height).toBe(inactiveBox.height);
        await page.keyboard.press(tab);
        await expect(panel.getByRole('button', { name: /^Text model for Brainstorm,/ })).toBeFocused();
        await expect(panel.getByText('Offline writer is offline right now; Story planner is using the default.', { exact: true })).toHaveCount(1);
        const offline = panel.getByRole('button', { name: /^Text model for Story planner,/ });
        await expect(offline).toHaveAccessibleName('Text model for Story planner, currently Offline writer');
        await expectSettingsInk(offline.locator('span').first().locator('span'), '--ink-3');
        await expect(panel.getByText('Effort fixed by the model', { exact: true })).toHaveCount(1);
        await expect(panel.locator('button[aria-label^="Reasoning effort for List drafts,"]')).toHaveCount(0);
        expect(await noHorizontalOverflow(page)).toBe(true);
        expect(await panel.evaluate((element) => [...element.querySelectorAll('[data-zone="body"], [class*="rowControl"]')].every((node) => node.scrollWidth <= node.clientWidth + 1))).toBe(true);
        expect(await page.evaluate(async () => (await fetch('/settings-ownership-writes')).json() as Promise<unknown>)).toEqual([
          { task: 'ai-fill', body: { modelId: 'override' } },
          { task: 'ai-fill', body: { modelId: 'override', effort: 'high' } },
          { task: 'ai-fill', body: { modelId: null } },
        ]);
        await page.goto('/e2e/studio/index.html?view=text-models&textAdmin=1&textProvider=1');
        const routing = page.getByRole('region', { name: 'Routing for everyone', exact: true });
        await expect(routing.getByRole('heading', { level: 3, name: 'Routing for everyone', exact: true })).toBeVisible();
        await expect(routing.getByText('Features use these models for anyone who keeps the default.', { exact: true })).toBeVisible();
        await expect(routing.getByText('Every task uses it unless assigned below.', { exact: true })).toBeVisible();
        await expect(routing.getByRole('group', { name: 'Task assignments', exact: true })).toBeVisible();
        await expect(routing.getByRole('group', { name: 'Prompt writers', exact: true })).toBeVisible();
        if (touch) await expectFloor(routing.getByRole('button', { name: 'Default model, currently Atlas', exact: true }), 'everyone default');
        expect(await noHorizontalOverflow(page)).toBe(true);
        // A separate fresh document exercises the existing public zero-model fixture.
        const emptyPage = await context.newPage();
        await emptyPage.goto('/e2e/studio/index.html?view=prompts&noTextModels=1');
        await emptyPage.getByRole('tab', { name: 'Settings', exact: true }).click();
        const empty = emptyPage.getByRole('region', { name: 'Your text model settings', exact: true });
        await expect(empty.getByRole('heading', { name: 'Your text models', exact: true })).toBeVisible();
        await expect(empty.getByText('Ask your admin to connect a text model.', { exact: true })).toBeVisible();
        await expect(empty.getByRole('button', { name: /^Text model for / })).toHaveCount(TEXT_TASKS.length);
        await expect(empty.getByRole('button', { name: /^Reasoning effort for / })).toHaveCount(0);
        expect(await noHorizontalOverflow(emptyPage)).toBe(true);
        await test.info().attach('settings-ownership', { body: JSON.stringify({ viewport, colorScheme, touch, inactiveBox, clearedBox, liveGeometry }), contentType: 'application/json' });
      } finally {
        await context.close();
      }
    });
  }
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  for (const selection of ['keyboard', 'pointer', 'move-on'] as const) {
    test(`settings focus return: ${selection} selection during a held save at ${String(viewport.width)}×${String(viewport.height)}`, async ({ browser }) => {
      const { defaultBrowserType: _engine, ...device } = viewport.width === 1440 ? devices['Desktop Chrome'] : devices['iPhone 13'];
      const context = await browser.newContext({ ...device, viewport, colorScheme: 'dark' });
      const page = await context.newPage();
      const snapshot = (step: string) => page.evaluate(async (step) =>
        (await fetch(`/settings-ownership-focus-evidence?step=${step}`)).json() as Promise<unknown>, step);
      try {
        await withSettingsOwnership(page, 'ai-fill');
        await page.goto('/e2e/studio/index.html?view=prompts&textAdmin=1&textProvider=1');
        const settingsTab = page.getByRole('tab', { name: 'Settings', exact: true });
        await settingsTab.click();
        const panel = page.getByRole('region', { name: 'Your text model settings', exact: true });
        const model = panel.getByRole('button', { name: /^Text model for AI fill,/ });
        const menu = page.getByRole('listbox', { name: /^Text model for AI fill,/ });
        await model.click();
        await expect(menu).toBeFocused();
        await snapshot('open-menu');
        if (selection === 'pointer') {
          const option = page.getByRole('option', { name: 'Personal writer', exact: true });
          if (viewport.width < 768) await option.tap();
          else await option.click();
        } else {
          await page.keyboard.press('Home');
          await page.keyboard.press('ArrowDown');
          await page.keyboard.press('ArrowDown');
          await page.keyboard.press(viewport.width < 768 ? 'Space' : 'Enter');
        }
        await expect(model).toBeDisabled();
        expect(await page.evaluate(async () => (await fetch('/settings-ownership-held')).json() as Promise<unknown>)).toEqual({ pending: true });
        await snapshot('pending-disabled');
        await expect(menu).toHaveCount(0);
        await snapshot('menu-unmounted-while-held');
        if (selection === 'move-on') {
          // A deliberate focus move to another real enabled control revokes
          // the selection's return, even if focus later falls back to body.
          await settingsTab.focus();
          await expect(settingsTab).toBeFocused();
          await snapshot('user-moved-focus');
        }
        await page.evaluate(async () => { await fetch('/settings-ownership-release'); });
        await expect(model).toBeEnabled();
        await expect(menu).toHaveCount(0);
        await expect(model).toHaveAccessibleName('Text model for AI fill, currently Personal writer');
        expect(await page.evaluate(async () => (await fetch('/settings-ownership-writes')).json() as Promise<unknown>)).toEqual([
          { task: 'ai-fill', body: { modelId: 'override' } },
        ]);
        await snapshot('response-settled');
        if (selection === 'move-on') await expect(settingsTab).toBeFocused();
        else await expect(model).toBeFocused();
      } finally {
        await test.info().attach('settings-focus-events', { body: JSON.stringify(await snapshot('final')), contentType: 'application/json' });
        await context.close();
      }
    });
  }
}

// Use the studio's existing offline fetch seam; keep the real Enhance action
// pending so both labels can be measured without a provider or capture hook.
async function withPendingEnhance(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let inner = window.fetch.bind(window);
    const fetchEnhance = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
      if (url.pathname === '/api/enhance-prompt') {
        return Promise.resolve(new Response(new ReadableStream<Uint8Array>(), { headers: { 'Content-Type': 'text/event-stream' } }));
      }
      return inner(input, init);
    };
    Object.defineProperty(window, 'fetch', {
      configurable: true,
      get: () => fetchEnhance,
      set: (value: typeof fetch) => { inner = value; },
    });
  });
}

for (const scenario of [
  { width: 844, height: 390, touch: true, colorScheme: 'light' },
  { width: 844, height: 390, touch: true, colorScheme: 'dark' },
  { width: 1280, height: 600, touch: false, colorScheme: 'light' },
  { width: 1280, height: 800, touch: false, colorScheme: 'light' },
  { width: 390, height: 844, touch: true, colorScheme: 'light' },
] as const) {
  test(`approved short-window: image controls at ${String(scenario.width)}×${String(scenario.height)} ${scenario.touch ? 'touch' : 'pointer'} ${scenario.colorScheme}`, async ({ browser }) => {
    test.setTimeout(60_000);
    const context = await browser.newContext({
      ...(scenario.touch ? devices['iPhone 13'] : devices['Desktop Chrome']),
      viewport: { width: scenario.width, height: scenario.height }, colorScheme: scenario.colorScheme,
    });
    try {
      const page = await context.newPage();
      // The studio installs an offline fetch implementation. Extend its public
      // seam for a synthetic upload, leaving the production attach path intact.
      await page.addInitScript(() => {
        let inner = window.fetch.bind(window);
        const fetchUpload = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
          if (url.pathname === '/api/uploads') return Promise.resolve(Response.json({ id: 'public-short-window-ref', mime: 'image/png', ext: 'png', sizeBytes: 68, width: 1, height: 1, createdAt: 1 }));
          if (url.pathname === '/api/uploads/public-short-window-ref') return Promise.resolve(new Response(null, { status: 204 }));
          return inner(input, init);
        };
        Object.defineProperty(window, 'fetch', { configurable: true, get: () => fetchUpload, set: (value: typeof fetch) => { inner = value; } });
      });
      await page.goto('/e2e/studio/index.html?video=1');
      const expand = page.getByRole('button', { name: 'Expand composer', exact: true });
      if (await expand.isVisible()) await expand.click();
      const composer = page.getByTestId('composer-drop-surface');
      const prompt = composer.getByRole('textbox', { name: 'Prompt', exact: true });
      const attach = composer.getByRole('button', { name: 'Attach reference images' });
      const generate = composer.getByRole('button', { name: 'Generate', exact: true });
      const compact = scenario.width >= 768 && scenario.height <= 620;
      const settle = async () => {
        await composer.evaluate(async () => {
          await Promise.all(document.getAnimations().filter((animation) => animation.timeline === document.timeline && animation.playState === 'running' && animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => undefined)));
        });
      };
      const promptRow = async (shared: boolean) => {
        // The flex reference row stretches to the textarea's grid track;
        // its Attach button remains vertically centered as the prompt grows.
        const a = await attach.locator('..').boundingBox();
        const p = await prompt.boundingBox();
        if (!a || !p) throw new Error('missing image controls');
        if (shared) {
          expect(Math.abs(a.y - p.y), 'Attach and prompt share the first row').toBeLessThanOrEqual(1);
          expect(p.x).toBeGreaterThanOrEqual(a.x + a.width + 9);
        } else expect(p.y).toBeGreaterThanOrEqual(a.y + a.height + 9);
      };
      const reachable = async () => {
        expect(await noHorizontalOverflow(page)).toBe(true);
        expect(await composer.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
        for (const name of ['Attach reference images', 'Templates', 'Enhance', 'Undo enhance', 'Model', 'Ratio', 'Count', 'Generate', ...(scenario.width >= 768 ? ['Clear prompt and reference images', 'Minimize composer'] : ['Collapse composer'])]) {
          const control = composer.getByRole('button', { name, exact: true });
          await expect(control).toBeVisible();
          const box = await control.boundingBox();
          if (!box) throw new Error(`missing ${name}`);
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.y).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(scenario.width + 1);
          expect(box.y + box.height).toBeLessThanOrEqual(scenario.height + 1);
          if (scenario.touch && name !== 'Collapse composer') expect(box.height, `${name} touch height`).toBeGreaterThanOrEqual(43.9);
        }
      };
      const promptClearance = async (state: string) => {
        if (!compact) return;
        const minimize = await composer.getByRole('button', { name: 'Minimize composer', exact: true }).boundingBox();
        if (!minimize) throw new Error('missing Minimize');
        const measured = await prompt.evaluate((element, m) => {
          const p = element.getBoundingClientRect();
          const points = [
            { name: 'top-right', x: p.right - 1, y: p.top + 1 },
            { name: 'right-edge', x: p.right - 1, y: p.top + p.height / 2 },
            { name: 'bottom-right', x: p.right - 1, y: p.bottom - 1 },
          ];
          return {
            prompt: { x: p.x, y: p.y, width: p.width, height: p.height },
            minimize: m,
            clearance: m.x - p.right,
            intersects: p.left < m.x + m.width && p.right > m.x && p.top < m.y + m.height && p.bottom > m.y,
            hits: points.map((point) => {
              const receiver = document.elementFromPoint(point.x, point.y);
              return { ...point, owns: receiver === element, receiver: receiver?.getAttribute('aria-label') ?? receiver?.tagName ?? null };
            }),
          };
        }, minimize);
        await test.info().attach(`compact-prompt-hit-clearance-${state}`, { body: JSON.stringify(measured, null, 2), contentType: 'application/json' });
        console.log('[compact-prompt-hit-clearance]', JSON.stringify({ project: test.info().project.name, scenario, state, ...measured }));
        expect(measured.intersects, `${state}: prompt and Minimize rectangles do not intersect`).toBe(false);
        expect(measured.clearance, `${state}: measured prompt-to-Minimize gap`).toBeGreaterThan(0);
        for (const hit of measured.hits) expect(hit.owns, `${state}: ${hit.name} resolves to textarea (${hit.receiver ?? 'none'})`).toBe(true);
        if (scenario.touch && state === 'empty') {
          const edge = measured.hits[1];
          if (!edge) throw new Error('missing textarea edge');
          await attach.focus();
          await page.touchscreen.tap(edge.x, edge.y);
          await expect(prompt).toBeFocused();
          await expect(prompt).toBeVisible();
          await test.info().attach('compact-prompt-edge-touch-focus', { body: JSON.stringify({ point: edge, focused: true }), contentType: 'application/json' });
        }
      };
      await expect(prompt).toHaveValue('');
      await expect(generate).toBeDisabled();
      await expect(composer).toHaveCSS('display', compact ? 'grid' : 'flex');
      await expect(composer).toHaveCSS('padding-top', compact ? '10px' : scenario.width < 768 ? '12px' : '14px');
      await expect(prompt).toHaveCSS('min-height', compact ? scenario.touch ? '44px' : '32px' : scenario.width < 768 ? '40px' : '48px');
      await settle();
      await promptRow(compact);
      await reachable();
      await promptClearance('empty');
      const initial = await generate.boundingBox();
      const anchored = async () => {
        await settle();
        const box = await generate.boundingBox();
        if (!initial || !box) throw new Error('missing Generate');
        expect(Math.max(Math.abs(box.x - initial.x), Math.abs(box.y - initial.y), Math.abs(box.width - initial.width), Math.abs(box.height - initial.height)), 'Generate bounds stay invariant').toBeLessThanOrEqual(1);
        await reachable();
      };
      await prompt.fill(Array.from({ length: 12 }, (_, index) => `Public coastal observatory line ${String(index + 1)}`).join('\n'));
      await expect(generate).toBeEnabled();
      await anchored();
      await promptClearance('long');
      if (compact) {
        const sizes = await prompt.evaluate((element) => ({ height: element.getBoundingClientRect().height, line: Number.parseFloat(getComputedStyle(element).lineHeight), scroll: element.scrollHeight, client: element.clientHeight }));
        expect(sizes.height).toBeLessThanOrEqual(3 * sizes.line + 10.1);
        expect(sizes.scroll).toBeGreaterThan(sizes.client);
        await expect(prompt).toHaveCSS('overflow-y', 'auto');
        await prompt.evaluate((element) => { element.scrollTop = element.scrollHeight; });
        expect(await prompt.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      }
      const chooser = page.waitForEvent('filechooser');
      await attach.click();
      await (await chooser).setFiles({ name: 'public-reference.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64') });
      const remove = composer.getByRole('button', { name: 'Remove reference image 1' });
      await expect(remove).toBeEnabled();
      await anchored();
      const contentWidth = await composer.evaluate((element) => {
        const style = getComputedStyle(element);
        if (!style.containerName.split(/\s+/).includes('composer')) throw new Error('missing named Composer container');
        return element.getBoundingClientRect().width - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight) - Number.parseFloat(style.borderLeftWidth) - Number.parseFloat(style.borderRightWidth);
      });
      const sharedReferenceRow = compact && contentWidth >= 640;
      await promptRow(sharedReferenceRow);
      if (sharedReferenceRow) await promptClearance('reference');
      await remove.click();
      await expect(remove).toHaveCount(0);
      await anchored();
      await promptRow(compact);
      await promptClearance('reference-removed');
      await composer.getByRole('button', { name: scenario.width >= 768 ? 'Minimize composer' : 'Collapse composer', exact: true }).click();
      await expect(expand).toBeVisible();
      await expand.click();
      await expect(prompt).toHaveValue(/Public coastal observatory/);
      await anchored();
      await promptClearance('re-expanded');
      await prompt.fill('');
      await expect(generate).toBeDisabled();
      await anchored();
      await promptClearance('cleared');
      if (compact) {
        await composer.getByRole('button', { name: 'Model', exact: true }).click();
        await page.getByRole('option', { name: /Studio Motion/ }).click();
        await expect(composer.getByRole('textbox', { name: 'Motion prompt' })).toBeVisible();
        await expect(composer).toHaveCSS('display', 'flex');
        await expect(composer).toHaveCSS('padding-top', '14px');
        await expect(composer.getByRole('button', { name: 'Animate', exact: true })).toBeVisible();
        await composer.getByRole('button', { name: 'Back to image generation' }).click();
        await expect(prompt).toBeVisible();
        await expect(composer).toHaveCSS('display', 'grid');
        await anchored();
      }
    } finally {
      await context.close();
    }
  });
}

for (const viewport of [
  { width: 320, height: 844 }, { width: 360, height: 844 }, { width: 390, height: 844 },
  { width: 844, height: 390 }, { width: 820, height: 1180 }, { width: 1440, height: 900 },
]) {
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`presentation fixes: model token and Enhance at ${String(viewport.width)}×${String(viewport.height)} in ${colorScheme}`, async ({ browser }) => {
      test.setTimeout(60_000);
      const context = await browser.newContext({
        ...(viewport.width === 1440 ? devices['Desktop Chrome'] : devices['iPhone 13']), viewport, colorScheme,
      });
      try {
        const page = await context.newPage();
        await withPendingEnhance(page);
        await page.goto('/e2e/studio/index.html');
        const expand = page.getByRole('button', { name: 'Expand composer', exact: true });
        if (await expand.isVisible()) await expand.click();
        const composer = page.locator('#atelier-composer');
        const model = composer.getByRole('button', { name: 'Model', exact: true });
        const enhance = composer.getByRole('button', { name: 'Enhance', exact: true });
        const generate = composer.getByRole('button', { name: 'Generate', exact: true });
        const undo = composer.getByRole('button', { name: 'Undo enhance', exact: true });
        const checkGeometry = async (token: string) => {
          await expect(model).toContainText(token);
          const value = model.locator('[data-tip]');
          expect(await value.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), 'full short family token is visible').toBe(true);
          await expect(enhance.locator('span')).toBeVisible();
          expect(await noHorizontalOverflow(page)).toBe(true);
          expect(await composer.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), 'composer has no internal horizontal overflow').toBe(true);
          const selects = await Promise.all(['Model', 'Ratio', 'Count'].map((name) => composer.getByRole('button', { name, exact: true }).boundingBox()));
          const [first, ratio, count] = selects;
          if (!first || !ratio || !count) throw new Error('missing generation selects');
          expect(Math.abs(first.y + first.height / 2 - ratio.y - ratio.height / 2)).toBeLessThanOrEqual(1);
          expect(Math.abs(first.y + first.height / 2 - count.y - count.height / 2)).toBeLessThanOrEqual(1);
          expect(first.x + first.width).toBeLessThanOrEqual(ratio.x);
          expect(ratio.x + ratio.width).toBeLessThanOrEqual(count.x);
          expect(count.x + count.width).toBeLessThanOrEqual(viewport.width);
          if (viewport.width !== 1440) {
            for (const target of [model, composer.getByRole('button', { name: 'Ratio', exact: true }), composer.getByRole('button', { name: 'Count', exact: true }), enhance, undo, generate]) {
              const box = await target.boundingBox();
              if (!box) throw new Error('missing touch control');
              expect(box.height).toBeGreaterThanOrEqual(43.9);
              expect(box.width).toBeGreaterThanOrEqual(43.9);
            }
          }
          const enhanceBox = await enhance.boundingBox();
          if (!enhanceBox) throw new Error('missing Enhance');
          expect(enhanceBox.width).toBeGreaterThanOrEqual(104);
        };
        await checkGeometry('GPT');
        // Keep the local model's token and health dot independently visible.
        await model.click();
        await page.getByRole('option', { name: /Test Alpha/ }).click();
        await expect(model).toContainText('Test');
        const local = model.locator('[data-tip] > span');
        await expect(local.locator('> span').first()).toHaveText('Test');
        await expect(local.locator('[data-state="online"]')).toBeVisible();
        await checkGeometry('Test');
        await model.click();
        await page.getByRole('option', { name: /GPT Image/ }).click();
        await composer.getByRole('textbox', { name: 'Prompt', exact: true }).fill('A quiet coastal observatory');
        await expect(enhance).toBeEnabled();
        // Let the existing finite surface/footprint transitions finish before
        // comparing the live controls, without changing their motion.
        await enhance.evaluate(async () => {
          await Promise.all(document.getAnimations().filter((animation) => animation.timeline === document.timeline && animation.playState === 'running' && animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => undefined)));
        });
        const ordering = () => composer.getByRole('button').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label') ?? button.textContent.trim()));
        const beforeOrder = await ordering();
        const beforeGenerate = await generate.boundingBox();
        const beforeEnhance = await enhance.boundingBox();
        await enhance.click();
        await expect(enhance).toHaveText('Enhancing…');
        await expect(enhance).toBeDisabled();
        await checkGeometry('GPT');
        expect(await ordering()).toEqual(beforeOrder);
        await expect.poll(async () => {
          const after = await generate.boundingBox();
          if (!beforeGenerate || !after) return Infinity;
          return Math.max(Math.abs(after.x - beforeGenerate.x), Math.abs(after.y - beforeGenerate.y), Math.abs(after.width - beforeGenerate.width));
        }, 'Generate stays anchored during Enhance').toBeLessThanOrEqual(1);
        const afterEnhance = await enhance.boundingBox();
        if (!beforeEnhance || !afterEnhance) throw new Error('missing Enhance bounds');
        expect(Math.abs(afterEnhance.width - beforeEnhance.width), 'Enhance reserves its working label width').toBeLessThanOrEqual(1);
      } finally {
        await context.close();
      }
    });
  }
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`presentation fixes: disabled provider preserves offline danger and live controls in ${colorScheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.addInitScript(() => {
      let inner = window.fetch.bind(window);
      const fetchProviders = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const response = await inner(input, init);
        const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
        if (url.pathname !== '/api/text-providers') return response;
        const { providers } = await response.json() as { providers: AdminProvider[] };
        return Response.json({ providers: providers.map((provider) => {
          const model = provider.models[0];
          if (!model) throw new Error('missing public model fixture');
          return {
            ...provider, enabled: false,
            models: ['available', 'offline', 'unknown'].map((status) => ({
              ...model, id: `preview-${status}`, displayName: `Preview ${status}`, enabled: true, status,
            })),
          };
        }) });
      };
      Object.defineProperty(window, 'fetch', {
        configurable: true, get: () => fetchProviders, set: (value: typeof fetch) => { inner = value; },
      });
    });
    await page.goto('/e2e/studio/index.html?view=text-models&textAdmin=1&textProvider=1');
    const provider = page.getByRole('region', { name: 'Preview provider', exact: true });
    await expect(provider).toHaveAttribute('data-enabled', 'false');
    for (const status of ['available', 'offline', 'unknown']) {
      const row = provider.getByRole('listitem', { name: `Preview ${status}`, exact: true });
      const word = row.locator(`[data-status="${status}"]`);
      await expect(word).toHaveText(status);
      expect(await row.getByText(`Preview ${status}`, { exact: true }).evaluate((element) => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--ink-2)';
        element.append(probe);
        const matches = getComputedStyle(element).color === getComputedStyle(probe).color;
        probe.remove();
        return matches;
      })).toBe(true);
      // Resolve token colours through a native CSS property rather than
      // comparing engine-specific token serialization (hex vs rgb).
      expect(await word.evaluate((element, offline) => {
        const probe = document.createElement('span');
        probe.style.color = offline ? 'var(--danger)' : 'var(--ink-3)';
        element.append(probe);
        const matches = getComputedStyle(element).color === getComputedStyle(probe).color;
        probe.remove();
        return matches;
      }, status === 'offline')).toBe(true);
      if (status === 'available') {
        expect(await word.evaluate((element) => {
          const dot = element.firstElementChild;
          return dot !== null && getComputedStyle(dot).backgroundColor === getComputedStyle(element).color
            && getComputedStyle(dot).borderTopColor === getComputedStyle(element).color;
        })).toBe(true);
      }
      await expect(row.getByRole('switch', { name: `Use Preview ${status}`, exact: true })).toBeEnabled();
      await row.getByRole('button', { name: `More actions for Preview ${status}`, exact: true }).click();
      await expect(page.getByRole('menuitem', { name: 'Test', exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menu')).toHaveCount(0);
    }
  });
}

// Pair the local container boundary with phone and desktop input/theme samples,
// rather than multiplying every axis into a full Cartesian matrix.
for (const scenario of [
  { label: '320 phone', width: 320, touch: true, colorScheme: 'light', containerWidth: null },
  { label: '390 phone', width: 390, touch: true, colorScheme: 'dark', containerWidth: null },
  { label: '599 container', width: 720, touch: false, colorScheme: 'light', containerWidth: 599 },
  { label: '600 container', width: 720, touch: false, colorScheme: 'dark', containerWidth: 600 },
  { label: 'standard desktop', width: 1440, touch: false, colorScheme: 'light', containerWidth: null },
  { label: 'touch desktop', width: 1280, touch: true, colorScheme: 'dark', containerWidth: null },
] as const) {
  test(`model row hierarchy: ${scenario.label}, ${scenario.touch ? 'coarse' : 'fine'}, ${scenario.colorScheme}`, async ({ browser }) => {
    test.setTimeout(60_000);
    const context = await browser.newContext({
      ...(scenario.touch ? devices['iPhone 13'] : devices['Desktop Chrome']),
      viewport: { width: scenario.width, height: 900 }, colorScheme: scenario.colorScheme,
    });
    try {
      const page = await context.newPage();
      // Extend the same public fetch fixture as the existing provider test.
      // A fresh provider exercises the real first-poll checking state.
      await page.addInitScript(() => {
        let inner = window.fetch.bind(window);
        const fetchProviders = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          const response = await inner(input, init);
          const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
          if (url.pathname !== '/api/text-providers') return response;
          const { providers } = await response.json() as { providers: AdminProvider[] };
          const provider = providers[0];
          const model = provider?.models[0];
          if (!provider || !model) throw new Error('missing public model fixture');
          const noUsage = { isDefault: false, tasks: [], writers: [], userPicks: 0 } as const;
          const base = { ...model, enabled: true, structuredOutput: 'none', usage: noUsage } as const;
          const rows: AdminProvider['models'] = [
            { ...base, id: 'hierarchy-long', displayName: 'ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMN', modelId: `public/provider/${'long-provider-path/'.repeat(5)}writer` },
            { ...base, id: 'hierarchy-json', displayName: 'Preview JSON', modelId: 'public/json-writer', enabled: false, status: 'offline', structuredOutput: 'json_object', usage: { ...noUsage, isDefault: true }, lastTest: { checks: [{ id: 'text', status: 'fail', message: 'Preview probe failed' }], proposed: {}, advertised: {}, wireNotes: [] } },
            { ...base, id: 'hierarchy-complete', displayName: 'Preview complete', modelId: 'public/complete-writer', status: 'unknown', verifiedAt: 1, vision: true, structuredOutput: 'json_schema', reasoningLevels: ['high'], usage: { ...noUsage, tasks: ['ai-fill'] } },
            { ...base, id: 'hierarchy-image', displayName: 'Preview image', modelId: 'public/image-writer', enabled: false, verifiedAt: 1, vision: true },
          ];
          const checkingId = 'provider-checking';
          return Response.json({ providers: [
            { ...provider, models: rows },
            { ...provider, id: checkingId, name: 'Checking provider', createdAt: Date.now(), models: [{ ...base, id: 'hierarchy-checking', providerId: checkingId, displayName: 'Preview checking', modelId: 'public/checking-writer', status: 'unknown', verifiedAt: 1 }] },
          ] });
        };
        Object.defineProperty(window, 'fetch', { configurable: true, get: () => fetchProviders, set: (value: typeof fetch) => { inner = value; } });
      });
      await page.goto('/e2e/studio/index.html?view=text-models&textAdmin=1&textProvider=1');
      const provider = page.getByRole('region', { name: 'Preview provider', exact: true });
      await expect(page.getByRole('listitem', { name: 'Preview checking', exact: true }).locator('[data-status="unknown"]')).toHaveText('checking…');
      const rowNames = ['ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMN', 'Preview JSON', 'Preview complete', 'Preview image'] as const;
      const first = provider.getByRole('listitem', { name: rowNames[0], exact: true });
      const contentWidth = () => first.evaluate((element) => {
        let container = element.parentElement;
        while (container && getComputedStyle(container).containerName !== 'text-models') container = container.parentElement;
        if (!container) throw new Error('missing text-models container');
        const style = getComputedStyle(container);
        return container.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
      });
      if (scenario.containerWidth !== null) {
        // Resize by the measured content-width delta; sidebar, gutters and
        // managed-view padding are intentionally not guessed from the viewport.
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const delta = scenario.containerWidth - await contentWidth();
          if (Math.abs(delta) <= 0.1) break;
          const viewport = page.viewportSize();
          if (!viewport) throw new Error('missing viewport');
          await page.setViewportSize({ ...viewport, width: Math.round(viewport.width + delta) });
        }
        expect(await contentWidth(), 'measured container content boundary').toBeCloseTo(scenario.containerWidth, 1);
      }
      const narrow = await contentWidth() < 600;
      const tab = browser.browserType().name() === 'webkit' ? 'Alt+Tab' : 'Tab';
      expect(await page.evaluate(() => matchMedia('(hover: none), (any-pointer: coarse)').matches)).toBe(scenario.touch);
      const evidence = [];
      for (const [index, name] of rowNames.entries()) {
        const row = provider.getByRole('listitem', { name, exact: true });
        await row.scrollIntoViewIfNeeded();
        const toggle = row.getByRole('switch', { name: `Use ${name}`, exact: true });
        const more = row.getByRole('button', { name: `More actions for ${name}`, exact: true });
        await expect(toggle).toHaveAttribute('aria-checked', index === 1 || index === 3 ? 'false' : 'true');
        await expect(toggle).toHaveAttribute('data-tip', index === 1 || index === 3 ? 'Off' : 'On');
        await expect(more).toHaveAttribute('data-tip', 'More');
        await expect(more).toBeEnabled();
        const status = row.locator('[data-status]');
        await expect(status).toHaveText(index === 1 ? 'offline' : index === 2 ? 'unknown' : 'available');
        await expect(row.getByText('Off', { exact: true })).toHaveCount(index === 1 || index === 3 ? 1 : 0);
        await expect(row.getByText(/^Default/)).toHaveCount(index === 1 ? 1 : 0);
        await expect(row.getByText(/^In use/)).toHaveCount(index === 2 ? 1 : 0);
        const testButton = row.getByRole('button', { name: index === 1 ? 'Test failed: test again' : 'Untested: test to confirm capabilities', exact: true });
        await expect(testButton).toHaveCount(index < 2 ? 1 : 0);
        const capabilities = index === 1 ? ['JSON output'] : index === 2 ? ['Image input', 'JSON output', 'Reasoning: High'] : index === 3 ? ['Image input'] : [];
        await expect(row.getByRole('img')).toHaveCount(capabilities.length);
        for (const label of capabilities) {
          const capability = row.getByRole('img', { name: label, exact: true });
          await expect(capability).toHaveAttribute('data-tip', label);
          expect(await capability.evaluate((element) => element.tabIndex)).toBe(-1);
        }
        const geometry = await row.evaluate((element) => {
          const [identity, meta, controls] = element.querySelectorAll(':scope > div');
          const caps = meta?.firstElementChild;
          const status = meta?.querySelector('[data-status]');
          if (!identity || !meta || !controls || !caps || !status) throw new Error('missing row anatomy');
          const rect = (node: Element) => {
            const box = node.getBoundingClientRect();
            return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height, center: box.y + box.height / 2 };
          };
          return { identity: rect(identity), meta: rect(meta), controls: rect(controls), caps: rect(caps), status: rect(status), slots: Array.from(caps.children, (slot) => ({ ...rect(slot), role: slot.getAttribute('role'), label: slot.getAttribute('aria-label'), hidden: slot.getAttribute('aria-hidden') })), overflow: element.scrollWidth > element.clientWidth + 1 };
        });
        evidence.push({ name, ...geometry });
        expect(geometry.overflow, `${name}: no row overflow`).toBe(false);
        expect(Math.abs(geometry.controls.center - geometry.identity.center), `${name}: controls align with identity`).toBeLessThanOrEqual(1);
        expect(geometry.controls.x).toBeGreaterThanOrEqual(geometry.identity.right);
        if (narrow) {
          expect(Math.abs(geometry.meta.x - geometry.identity.x), 'meta starts at identity edge').toBeLessThanOrEqual(1);
          expect(Math.abs(geometry.meta.right - geometry.controls.right), 'meta spans both columns').toBeLessThanOrEqual(1);
          expect(geometry.meta.y).toBeGreaterThanOrEqual(Math.max(geometry.identity.bottom, geometry.controls.bottom) + 5);
          expect(geometry.status.right).toBeLessThanOrEqual(geometry.caps.x);
        } else {
          expect(Math.abs(geometry.meta.center - geometry.identity.center), 'desktop metadata shares the row').toBeLessThanOrEqual(1);
          expect(geometry.caps.right).toBeLessThanOrEqual(geometry.status.x);
        }
        expect(geometry.status.width).toBeGreaterThanOrEqual(76);
        expect(geometry.slots).toHaveLength(3);
        for (const [slotIndex, slot] of geometry.slots.entries()) {
          expect(slot.width).toBeCloseTo(16, 1);
          expect(slot.x - geometry.caps.x).toBeCloseTo(slotIndex * 24, 1);
          expect(slot.role).toBe(slot.label === null ? null : 'img');
          if (slot.label === null) expect(slot.hidden).toBe('true');
        }
        if (index === 1) expect(geometry.slots.map((slot) => slot.label)).toEqual([null, 'JSON output', null]);
        const nameText = row.getByText(name, { exact: true });
        expect(await nameText.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), 'display name is contained').toBe(true);
        for (const control of [toggle, more, ...(index < 2 ? [testButton] : [])]) {
          await expect(control).toBeEnabled();
          expect(await control.evaluate((element) => {
            const box = element.getBoundingClientRect();
            return box.left >= 0 && box.right <= innerWidth + 1 && box.top >= 0 && box.bottom <= innerHeight
              && [0.1, 0.5, 0.9].every((fraction) => {
                const hit = document.elementFromPoint(box.left + box.width * fraction, box.top + box.height / 2);
                return hit === element || (hit !== null && element.contains(hit));
              });
          }), 'interactive control is unclipped and owns its hit points').toBe(true);
        }
        if (scenario.touch) {
          await expectHitArea(toggle, `${name} switch`, true);
          await expectFloor(more, `${name} More`);
          if (index < 2) await expectHitArea(testButton, `${name} test`, true);
        }
        if (index < 2) {
          await testButton.focus();
          await page.keyboard.press(tab);
          await expect(toggle).toBeFocused();
        } else await toggle.focus();
        await page.keyboard.press(tab);
        await expect(more).toBeFocused();
        await more.press('Enter');
        const menu = page.getByRole('menu', { name: `${name} actions`, exact: true });
        await expect(menu).toBeVisible();
        for (const action of ['Edit', 'Test', 'Remove']) await expect(menu.getByRole('menuitem', { name: action, exact: true })).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(menu).toHaveCount(0);
        await expect(more).toBeFocused();
        expect(await noHorizontalOverflow(page)).toBe(true);
      }
      await test.info().attach('model-row-hierarchy', { body: JSON.stringify({ scenario, viewport: page.viewportSize(), containerContentWidth: await contentWidth(), narrow, rows: evidence }, null, 2), contentType: 'application/json' });
    } finally {
      await context.close();
    }
  });
}

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`presentation fixes: native Advanced cues and input with ${reducedMotion} motion`, async ({ browser }) => {
    const context = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, reducedMotion });
    try {
      const page = await context.newPage();
      await page.goto('/e2e/studio/index.html?view=text-models&textAdmin=1&textProvider=1');
      for (const kind of ['provider', 'model'] as const) {
        if (kind === 'provider') await page.getByRole('button', { name: 'Add provider', exact: true }).click();
        else {
          await page.getByRole('button', { name: 'More actions for Preview writer', exact: true }).click();
          await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
        }
        const dialog = page.getByRole('dialog', { name: kind === 'provider' ? 'Add a provider' : 'Edit model', exact: true });
        const summary = dialog.locator('summary').filter({ hasText: /^Advanced$/ });
        const details = summary.locator('..');
        const caret = summary.locator('svg');
        await expect(summary).toBeVisible();
        await expect(caret).toHaveCount(1);
        await expect(caret).toHaveAttribute('aria-hidden', 'true');
        await expect(details).not.toHaveAttribute('open');
        const box = await summary.boundingBox();
        if (!box) throw new Error('missing native summary');
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.width).toBeGreaterThanOrEqual(44);
        await expect(summary).toHaveCSS('list-style-type', 'none');
        // Engines do not expose a useful computed style for the legacy
        // WebKit marker pseudo. Check the rendered content's leading edge:
        // there is no native marker slot before the label or beside the caret.
        const labelBox = await summary.locator('span').boundingBox();
        const caretBox = await caret.boundingBox();
        if (!labelBox || !caretBox) throw new Error('missing Advanced content');
        expect(Math.abs(labelBox.x - box.x), 'no leading native disclosure marker').toBeLessThanOrEqual(1);
        expect(Math.abs(caretBox.x - labelBox.x - labelBox.width - 6), 'one caret beside the label').toBeLessThanOrEqual(1);
        if (reducedMotion === 'reduce') await expect(caret).toHaveCSS('transition-duration', '0s');
        await expect(caret).toHaveCSS('transform', 'none');
        await summary.click();
        await expect(details).toHaveAttribute('open', '');
        await expect(caret).toHaveCSS('transform', 'matrix(-1, 0, 0, -1, 0, 0)');
        await summary.focus();
        await summary.press('Enter');
        await expect(details).not.toHaveAttribute('open');
        await expect(caret).toHaveCSS('transform', 'none');
        await summary.press('Space');
        await expect(details).toHaveAttribute('open', '');
        await expect(caret).toHaveCSS('transform', 'matrix(-1, 0, 0, -1, 0, 0)');
        await expect(summary).toBeFocused();
        if (kind === 'model') {
          await dialog.getByLabel('Temperature', { exact: true }).fill('3');
          await expect(dialog.getByText('Temperature must be a number from 0 to 2.')).toBeVisible();
          await expect(details).toHaveAttribute('open', '');
          await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
        }
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(dialog).toHaveCount(0);
      }
    } finally {
      await context.close();
    }
  });
}

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

// Extend only existing public library fixtures through their existing route.
async function withLongEditorRows(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let inner = window.fetch.bind(window);
    const fetchLibrary = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const response = await inner(input, init);
      const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
      if (url.pathname !== '/api/prompts') return response;
      const library = await response.json() as PromptLibraryResponse;
      return Response.json({
        ...library,
        variableLists: library.variableLists.map((list) => ({
          ...list,
          options: Array.from({ length: 40 }, (_, index) => {
            const option = list.options[index % list.options.length];
            if (!option) throw new Error('missing option fixture');
            return { ...option, id: `long-option-${String(index)}`, value: `Option ${String(index + 1)}`, sortOrder: index };
          }),
        })),
        dimensions: library.dimensions.map((dimension) => ({
          ...dimension,
          tags: Array.from({ length: 40 }, (_, index) => {
            const tag = dimension.tags[index % dimension.tags.length];
            if (!tag) throw new Error('missing tag fixture');
            return { ...tag, id: `long-tag-${String(index)}`, label: `Tag ${String(index + 1)}`, parentId: null, sortOrder: index };
          }),
        })),
      });
    };
    Object.defineProperty(window, 'fetch', {
      configurable: true,
      get: () => fetchLibrary,
      set: (value: typeof fetch) => { inner = value; },
    });
  });
}

async function rowEditorScrollGeometry(editor: ReturnType<Page['locator']>, phone: boolean, short: boolean): Promise<void> {
  const geometry = await editor.evaluate((form) => {
    const body = form.querySelector('[data-zone="body"]');
    if (!body) throw new Error('missing editor body');
    return {
      overflow: getComputedStyle(form).overflowY,
      bodyOverflow: getComputedStyle(body).overflowY,
      overscroll: getComputedStyle(form).overscrollBehaviorY,
      excess: form.scrollHeight - form.clientHeight,
      bodyHeight: body.getBoundingClientRect().height,
      mask: getComputedStyle(body).maskImage,
      scrollPadding: getComputedStyle(body).scrollPaddingBlockStart,
      minimumExcess: [...form.querySelectorAll('[data-zone="head"], [data-zone="entry"]')]
        .reduce((height, zone) => height + zone.getBoundingClientRect().height, 72) - form.clientHeight,
    };
  });
  if (phone) {
    expect(geometry.overflow).toBe('visible');
    expect(geometry.bodyOverflow).toBe('visible');
    expect(geometry.mask).toBe('none');
    expect(geometry.scrollPadding).toBe('auto');
  } else {
    expect(geometry.overflow).toBe('auto');
    expect(geometry.bodyOverflow).toBe('auto');
    expect(geometry.overscroll).toBe('contain');
    expect(geometry.bodyHeight).toBeGreaterThanOrEqual(72);
    expect(geometry.mask).not.toBe('none');
    expect(geometry.scrollPadding).toBe('14px');
    if (short && geometry.minimumExcess > 1) expect(geometry.excess).toBeGreaterThan(1);
    else expect(geometry.excess, 'normal-height panel does not scroll unnecessarily').toBeLessThanOrEqual(1);
  }
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

async function placeholderInk(target: ReturnType<Page['locator']>): Promise<void> {
  const result = await target.evaluate((element) => {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) throw new Error('missing input');
    // A field without placeholder text has no rendered ::placeholder. Exercise
    // the shared rule with text present, then restore the live draft unchanged.
    const originalPlaceholder = element.getAttribute('placeholder');
    const originalValue = element.value;
    element.setAttribute('placeholder', originalPlaceholder ?? 'Placeholder');
    element.value = '';
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('missing color sampler');
    const sample = (color: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data);
    };
    const style = getComputedStyle(element);
    const placeholder = getComputedStyle(element, '::placeholder');
    const foreground = sample(placeholder.color);
    let surface: Element | null = element;
    let background = sample(style.backgroundColor);
    while (background[3] === 0 && surface.parentElement) {
      surface = surface.parentElement;
      background = sample(getComputedStyle(surface).backgroundColor);
    }
    const luminance = (channels: number[]) => {
      const linear = channels.slice(0, 3).map((value) => {
        const channel = value / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return (linear[0] ?? 0) * 0.2126 + (linear[1] ?? 0) * 0.7152 + (linear[2] ?? 0) * 0.0722;
    };
    const a = luminance(foreground);
    const b = luminance(background);
    const result = {
      foreground, ink: sample(style.getPropertyValue('--ink-3')),
      opacity: placeholder.opacity, backgroundAlpha: background[3],
      contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
    };
    element.value = originalValue;
    if (originalPlaceholder === null) element.removeAttribute('placeholder');
    else element.setAttribute('placeholder', originalPlaceholder);
    return result;
  });
  expect(result.foreground).toEqual(result.ink);
  expect(result.opacity).toBe('1');
  expect(result.backgroundAlpha, 'contrast uses an opaque input or containing sheet').toBe(255);
  expect(result.contrast).toBeGreaterThanOrEqual(4.5);
}

for (const viewport of [
  { width: 1440, height: 900 }, { width: 844, height: 390 },
  { width: 820, height: 1180 }, { width: 390, height: 844 },
]) {
  for (const colorScheme of ['light', 'dark'] as const) {
    const touch = viewport.width !== 1440;
    const phone = viewport.width < 768;
    const managedTest = (name: string, check: (page: Page, writes: string[], tabKey: string) => Promise<void>, longRows = false) => {
      test(`${name} at ${String(viewport.width)}×${String(viewport.height)} in ${colorScheme}`, async ({ browser }) => {
        if (longRows) test.setTimeout(60_000);
        const context = await browser.newContext({
          ...(touch ? devices['iPhone 13'] : devices['Desktop Chrome']), viewport, colorScheme,
        });
        try {
          const page = await context.newPage();
          const writes: string[] = [];
          page.on('request', (request) => {
            if (request.method() === 'PUT' && request.url().includes('/prompts/')) writes.push(request.url());
          });
          if (longRows) await withLongEditorRows(page);
          await page.goto('/e2e/studio/index.html?view=prompts');
          await expect(page.locator('html')).toHaveAttribute('data-theme', colorScheme);
          // macOS WebKit includes buttons in native traversal with Option+Tab.
          await check(page, writes, browser.browserType().name() === 'webkit' ? 'Alt+Tab' : 'Tab');
        } finally {
          await context.close();
        }
      });
    };

    managedTest('managed editor dimension layout, touch bounds and local reorder', async (page, writes, tabKey) => {
      await page.getByRole('tab', { name: 'Dimensions', exact: true }).click();
      const dimension = page.getByRole('form', { name: 'Edit dimension Atmosphere', exact: true });
      await expect(dimension.locator('[data-zone="body"] > p').first()).toHaveText(
        'Tags are the values of this dimension. Options tagged on the same dimension that share no tag cannot be rolled or picked together.',
      );
      const grip = dimension.getByRole('button', { name: 'Reorder Quiet', exact: true });
      const name = dimension.getByRole('textbox', { name: 'Tag 1: Quiet', exact: true });
      const parent = dimension.getByRole('combobox', { name: 'Parent of Quiet', exact: true });
      const remove = dimension.getByRole('button', { name: 'Remove tag Quiet', exact: true });
      await name.scrollIntoViewIfNeeded();
      await expect.poll(() => name.evaluate((element, isPhone) => {
        const row = element.parentElement;
        if (!row) throw new Error('missing tag row');
        const controls = [...row.querySelectorAll('button, input, select')];
        const boxes = controls.map((control) => {
          const box = control.getBoundingClientRect();
          return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, cy: box.y + box.height / 2 };
        });
        const [grip, label, parent, remove] = boxes;
        if (!grip || !label || !parent || !remove) throw new Error('missing tag controls');
        const parentLabel = row.querySelector('label')?.getBoundingClientRect();
        const sameCenter = (a: typeof grip, b: typeof grip) => Math.abs(a.cy - b.cy) < 1;
        const separated = boxes.every((a, i) => boxes.every((b, j) => i === j
          || a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y));
        const aligned = sameCenter(grip, label) && sameCenter(label, remove)
          && (isPhone
            ? !!parentLabel && Math.abs(parentLabel.left - label.x) < 1 && parent.y >= label.bottom
            : sameCenter(label, parent) && remove.x >= parent.right);
        const rowBox = row.getBoundingClientRect();
        const contained = boxes.every((box) => box.width > 0 && box.x >= Math.max(0, rowBox.left)
          && box.right <= Math.min(innerWidth, rowBox.right) + 0.5);
        return { aligned, separated, contained, geometry: aligned && separated && contained ? null : boxes,
          order: controls.map((control) => control.tagName) };
      }, phone), `dimension controls at ${String(viewport.width)}×${String(viewport.height)}`).toEqual({
        aligned: true, separated: true, contained: true, geometry: null, order: ['BUTTON', 'INPUT', 'SELECT', 'BUTTON'],
      });
      await expect(remove).toHaveAttribute('data-tip', 'Remove tag');
      if (touch) for (const control of [grip, name, parent, remove]) await libraryHitPoints(control);
      await grip.focus();
      await page.keyboard.press(tabKey);
      await expect(name).toBeFocused();
      await page.keyboard.press(tabKey);
      await expect(parent).toBeFocused();
      await page.keyboard.press(tabKey);
      await expect(remove).toBeFocused();
      await grip.press('Alt+ArrowDown');
      await expect(dimension.getByRole('textbox', { name: 'Tag 2: Quiet', exact: true })).toHaveValue('Quiet');
      await expect(dimension.getByRole('button', { name: 'Save dimension', exact: true })).toBeEnabled();
      expect(await dimension.locator('[data-zone]').evaluateAll((zones) => zones.map((zone) => zone.getAttribute('data-zone')))).toEqual(['head', 'entry', 'body']);
      expect(await noHorizontalOverflow(page)).toBe(true);
      expect(writes, 'reorder remains a local draft').toEqual([]);
      await rowEditorScrollGeometry(dimension, phone, viewport.height === 390);
      await dimension.getByRole('button', { name: 'Save dimension', exact: true }).scrollIntoViewIfNeeded();
      if (touch) await libraryHitPoints(dimension.getByRole('button', { name: 'Save dimension', exact: true }));
      await dimension.getByRole('button', { name: '+ Add tag', exact: true }).scrollIntoViewIfNeeded();
      if (touch) await libraryHitPoints(dimension.getByRole('button', { name: '+ Add tag', exact: true }));
    });

    managedTest('managed variable controls and local reorder', async (page, writes) => {
      await page.getByRole('tab', { name: 'Variable lists', exact: true }).click();
      const list = page.getByRole('form', { name: 'Edit variable list lighting', exact: true });
      await expect(list.locator('[data-zone="body"] > p').first()).toHaveText(phone
        ? 'The number beside each option is its weight: how often it is rolled (0 pin only, 1 default). Tags are under ⋯.'
        : 'The number beside each option is its weight: how often it is rolled. 0 means pin only; 1 is the default.');
      const option = list.getByRole('textbox', { name: 'Option 1: soft window light', exact: true });
      await expect(list.getByRole('spinbutton').first()).toHaveAttribute('aria-describedby', /weight-help-/);
      if (touch) {
        await libraryHitPoints(list.getByRole('button', { name: 'Reorder soft window light', exact: true }));
        await libraryHitPoints(option);
        await libraryHitPoints(list.getByRole('spinbutton').first());
        if (phone) await libraryHitPoints(list.getByRole('button', { name: 'More actions for soft window light', exact: true }));
        else {
          await libraryHitPoints(list.getByRole('button', { name: 'Show tags for soft window light', exact: true }));
          await libraryHitPoints(list.getByRole('button', { name: 'Remove option soft window light', exact: true }));
        }
      }
      if (phone) await expect(list.getByRole('button', { name: /^Remove option / })).toHaveCount(0);
      else await expect(list.getByRole('button', { name: 'Remove option soft window light', exact: true })).toHaveAttribute('data-tip', 'Remove option');
      await option.press('Alt+ArrowDown');
      await expect(list.getByRole('textbox', { name: 'Option 2: soft window light', exact: true })).toHaveValue('soft window light');
      expect(writes, 'reorder remains a local draft').toEqual([]);
      expect(await noHorizontalOverflow(page)).toBe(true);
      await rowEditorScrollGeometry(list, phone, viewport.height === 390);
      await list.getByRole('button', { name: 'Save list', exact: true }).scrollIntoViewIfNeeded();
      if (touch) await libraryHitPoints(list.getByRole('button', { name: 'Save list', exact: true }));
      await list.getByRole('button', { name: '+ Add option', exact: true }).scrollIntoViewIfNeeded();
      if (touch) await libraryHitPoints(list.getByRole('button', { name: '+ Add option', exact: true }));
    });

    managedTest('managed editor long lists preserve body scrolling and native row reveals', async (page, writes) => {
      for (const [tab, formName, rowName, saveName, addName] of [
        ['Variable lists', 'Edit variable list lighting', 'Option 40: Option 40', 'Save list', '+ Add option'],
        ['Dimensions', 'Edit dimension Atmosphere', 'Tag 40: Tag 40', 'Save dimension', '+ Add tag'],
      ]) {
        if (!tab || !formName || !rowName || !saveName || !addName) throw new Error('missing editor case');
        await page.getByRole('tab', { name: tab, exact: true }).click();
        const editor = page.getByRole('form', { name: formName, exact: true });
        await rowEditorScrollGeometry(editor, phone, viewport.height === 390);
        const body = editor.locator('[data-zone="body"]');
        const row = editor.getByRole('textbox', { name: rowName, exact: true });
        await expect(row).toHaveCount(1);
        const before = await editor.evaluate((form) => ({
          head: form.querySelector('[data-zone="head"]')?.getBoundingClientRect().top,
          entry: form.querySelector('[data-zone="entry"]')?.getBoundingClientRect().top,
        }));
        // Native start alignment exercises scroll-padding against the mask;
        // subsequent focus must leave the complete control reachable.
        await row.evaluate((element) => { element.scrollIntoView({ block: 'start' }); });
        await row.focus();
        await expect(row).toBeFocused();
        if (touch) await libraryHitPoints(row);
        else await expect(row).toBeInViewport({ ratio: 1 });
        const rowLayout = await row.evaluate((element) => {
          const row = element.parentElement;
          if (!row) throw new Error('missing editor row');
          const boxes = [...row.querySelectorAll('button, input, select')].map((control) => control.getBoundingClientRect());
          return boxes.every((a, i) => boxes.every((b, j) => i === j
            || a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top));
        });
        expect(rowLayout, 'long-list row controls do not overlap').toBe(true);
        if (!phone) {
          expect(await body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
          expect(await body.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(1);
          if (viewport.height !== 390) {
            expect(await editor.evaluate((form) => ({
              head: form.querySelector('[data-zone="head"]')?.getBoundingClientRect().top,
              entry: form.querySelector('[data-zone="entry"]')?.getBoundingClientRect().top,
            }))).toEqual(before);
            expect(await editor.evaluate((form) => form.scrollTop)).toBe(0);
          }
        }
        // Make Save enabled through the existing local draft owner, then
        // reveal header and toolbar through native scrolling without saving.
        await row.fill('Changed locally');
        const save = editor.getByRole('button', { name: saveName, exact: true });
        await expect(save).toBeEnabled();
        await save.scrollIntoViewIfNeeded();
        if (touch) await libraryHitPoints(save);
        else await expect(save).toBeInViewport({ ratio: 1 });
        const add = editor.getByRole('button', { name: addName, exact: true });
        await add.scrollIntoViewIfNeeded();
        if (touch) await libraryHitPoints(add);
        else await expect(add).toBeInViewport({ ratio: 1 });
        await rowEditorScrollGeometry(editor, phone, viewport.height === 390);
        expect(await noHorizontalOverflow(page)).toBe(true);
      }
      expect(writes, 'native scrolling and edits remain local drafts').toEqual([]);
    }, true);

    managedTest('managed placeholder ink and resource deletion bounds', async (page) => {
      const template = page.getByRole('form', { name: 'Edit template Editorial portrait', exact: true });
      await placeholderInk(template.getByRole('textbox', { name: 'Template name', exact: true }));
      await placeholderInk(template.getByRole('textbox', { name: 'Body', exact: true }));

      const templates = page.getByRole('complementary', { name: 'Templates', exact: true });
      if (touch) {
        const remove = templates.getByRole('button', { name: 'Delete template Editorial portrait', exact: true });
        await libraryHitPoints(remove);
        expect(await remove.evaluate((element) => {
          const pane = element.closest('aside')?.getBoundingClientRect();
          const box = element.getBoundingClientRect();
          return !!pane && box.left >= pane.left && box.right <= pane.right;
        }), 'resource delete fits within its pane').toBe(true);
      }
      await templates.getByRole('button', { name: 'New', exact: true }).click();
      const newName = templates.getByRole('textbox', { name: 'Template name', exact: true });
      await placeholderInk(newName);
      await newName.press('Escape');

      await page.getByRole('tab', { name: 'Dimensions', exact: true }).click();
      const dimension = page.getByRole('form', { name: 'Edit dimension Atmosphere', exact: true });
      await placeholderInk(dimension.getByRole('textbox', { name: 'Dimension description', exact: true }));
      await page.getByRole('tab', { name: 'Variable lists', exact: true }).click();
      const list = page.getByRole('form', { name: 'Edit variable list lighting', exact: true });
      await placeholderInk(list.getByRole('textbox', { name: 'Option 1: soft window light', exact: true }));
      await page.getByRole('button', { name: 'Back to Unsorted', exact: true }).click();
      if (phone) await page.getByRole('button', { name: 'Expand composer', exact: true }).click();
      await page.getByRole('button', { name: 'Templates', exact: true }).click();
      await placeholderInk(page.getByRole('searchbox', { name: 'Search templates', exact: true }));
    });
  }
}

for (const viewport of [{ width: 390, height: 600 }, { width: 844, height: 390 }]) {
  test(`Prompt Library touch controls own their hit bounds at ${String(viewport.width)}×${String(viewport.height)}`, async ({ browser }) => {
    test.setTimeout(60_000);
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
    test(`Library rail ${longCollections ? 'long collections' : 'ordinary content'} stays reachable at ${String(viewport.width)}×${String(viewport.height)}`, async ({ browser }, testInfo) => {
      // Visit every one of the 50 rows before exercising all navigation and
      // footer actions; allow the slower engine to finish that complete path.
      test.setTimeout(longCollections ? 180_000 : 60_000);
      const context = await browser.newContext({ ...devices['iPhone 13'], viewport });
      try {
        const page = await context.newPage();
        if (longCollections) await withLongCollections(page);
        await page.goto('/e2e/studio/index.html?textAdmin=1&textProvider=1');
        // Exercise rail navigation after the fixture history has rendered.
        await expect(page.getByTestId('canvas-scroller').locator('section[data-batch-id]').first()).toBeVisible();
        await expect(page.getByTestId('sidebar-virtual-list')).toBeAttached();
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
        const history = page.getByTestId('sidebar-feed');
        const historySize = await history.evaluate((element) => {
          const style = getComputedStyle(element);
          const paddingTop = Number.parseFloat(style.paddingTop);
          const paddingBottom = Number.parseFloat(style.paddingBottom);
          return { clientHeight: element.clientHeight, paddingTop, paddingBottom, contentHeight: element.clientHeight - paddingTop - paddingBottom };
        });
        expect(historySize.contentHeight).toBeGreaterThanOrEqual(73);
        const historyRow = history.locator('[data-index]').first();
        await expect(historyRow).toBeAttached();
        await historyRow.evaluate((element) => { element.scrollIntoView({ block: 'nearest' }); });
        const measureHistoryRow = () => historyRow.evaluate((element) => {
          const scroller = element.closest<HTMLElement>('[data-testid="sidebar-feed"]');
          if (!scroller) throw new Error('missing history scroller');
          const bounds = scroller.getBoundingClientRect();
          const row = element.getBoundingClientRect();
          const top = bounds.top + scroller.clientTop;
          const bottom = top + scroller.clientHeight;
          return { rowHeight: row.height, rowTop: row.top, rowBottom: row.bottom, scrollerTop: top, scrollerBottom: bottom, fits: row.top >= top && row.bottom <= bottom };
        });
        await expect.poll(async () => (await measureHistoryRow()).fits, 'one actual history row fits after native reveal').toBe(true);
        const historyRowSize = await measureHistoryRow();
        expect(historyRowSize.rowHeight).toBeLessThanOrEqual(historySize.contentHeight);
        await testInfo.attach('rail-history-geometry', {
          body: JSON.stringify({ ...historySize, ...historyRowSize }), contentType: 'application/json',
        });
        console.info('rail-history-geometry', JSON.stringify({ project: testInfo.project.name, viewport, longCollections, ...historySize, ...historyRowSize }));
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

test('approved short-window: history Retry stays reachable above compact and tall expanded composers', async ({ page }) => {
  for (const height of [600, 800]) {
    await page.setViewportSize({ width: 1280, height });
    await page.goto('/e2e/studio/index.html?historyError=1');
    const retry = page.getByTestId('canvas-scroller').getByRole('button', { name: 'Retry', exact: true });
    await expect(retry).toBeVisible();
    const prompt = page.getByRole('textbox', { name: 'Prompt', exact: true });
    await prompt.fill(Array.from({ length: 12 }, (_, index) => `Retained draft line ${index}`).join('\n'));
    const composer = page.locator('#atelier-composer');
    if (height === 600) {
      await expect.poll(() => prompt.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
      const size = await prompt.evaluate((element) => ({ height: element.getBoundingClientRect().height, line: Number.parseFloat(getComputedStyle(element).lineHeight) }));
      expect(size.height).toBeGreaterThan(2 * size.line);
      expect(size.height).toBeLessThanOrEqual(3 * size.line + 10.1);
    } else {
      // Preserve the original tall-composer regression at normal height;
      // 600px now deliberately selects the approved three-line compact body.
      await expect.poll(() => composer.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(280);
    }
    await page.getByTestId('canvas-scroller').evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect.poll(() => retry.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const dock = document.querySelector('#atelier-composer')?.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return dock !== undefined && box.bottom <= dock.top && (hit === element || element.contains(hit));
    })).toBe(true);
    await retry.click();
    await expect(page.getByRole('button', { name: 'Minimize composer', exact: true })).toBeVisible();
  }
});

for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 820, height: 1180 }]) {
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`in-contract control access: collection token ${String(viewport.width)}×${String(viewport.height)} ${colorScheme}`, async ({ browser }, testInfo) => {
      const context = await browser.newContext({ ...devices['iPhone 13'], viewport, colorScheme });
      try {
        const page = await context.newPage();
        const name = 'Campaign studies: editorial portraits and coastal observatory references '.repeat(3).trim();
        await approvedStudio(page, { longName: name });
        await page.goto('/e2e/studio/index.html?c=campaign');
        const token = page.locator('section[data-batch-id="studio-batch-2"]').getByRole('button', { name: `${name}, move to collection`, exact: true, includeHidden: true });
        await expect(token).toBeVisible();
        if (viewport.height === 390) await page.getByRole('button', { name: 'Minimize composer', exact: true }).click();
        await token.evaluate((element) => { element.scrollIntoView({ block: 'start' }); });
        await approvedSettle(page);
        expect(await page.evaluate(() => matchMedia('(hover: none), (any-pointer: coarse)').matches)).toBe(true);
        const corners = await libraryHitPoints(token);
        const geometry = await token.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const text = element.querySelector('span');
          if (!text) throw new Error('missing collection text');
          const style = getComputedStyle(text);
          return { box: { x: box.x, y: box.y, width: box.width, height: box.height }, text: { client: text.clientWidth, scroll: text.scrollWidth, overflow: style.overflow, ellipsis: style.textOverflow, whiteSpace: style.whiteSpace } };
        });
        expect(geometry.text.overflow).toBe('hidden');
        expect(geometry.text.ellipsis).toBe('ellipsis');
        expect(geometry.text.whiteSpace).toBe('nowrap');
        expect(geometry.text.scroll).toBeGreaterThan(geometry.text.client);
        expect(await noHorizontalOverflow(page)).toBe(true);
        const panel = page.getByRole('dialog', { name: 'Move to collection', exact: true });
        for (let corner = 0; corner < corners.length; corner++) {
          await token.focus();
          const point = (await libraryHitPoints(token))[corner];
          if (!point) throw new Error('missing token corner');
          await page.touchscreen.tap(point.x, point.y);
          await expect(panel).toBeVisible();
          await expect(token).toHaveAttribute('aria-expanded', 'true');
          await expect(panel.getByRole('button', { name: '(Unsorted)', exact: true })).toBeVisible();
          await expect(panel.getByRole('button', { name, exact: true })).toHaveAttribute('data-current', 'true');
          await approvedSettle(page);
          if (corner % 2 === 0) {
            await page.keyboard.press('Escape');
          } else if (viewport.width < 768) {
            const backdrop = page.getByRole('button', { name: 'Close move popover', exact: true });
            await expect(backdrop).toBeVisible();
            await page.touchscreen.tap(viewport.width / 2, 20);
          } else {
            // Desktop-width touch uses the existing anchored popover's
            // outside-pointer dismissal rather than the phone backdrop.
            await page.touchscreen.tap(10, 20);
          }
          await expect(panel).toHaveCount(0);
          await expect(token).toBeFocused();
          await expect(token).toHaveAttribute('aria-expanded', 'false');
        }
        await testInfo.attach('collection-token-control-access', { body: JSON.stringify({ viewport, colorScheme, geometry, corners, dismissals: ['Escape', viewport.width < 768 ? 'backdrop tap' : 'outside tap'], focusReturnedToActualToken: true }), contentType: 'application/json' });
      } finally {
        await context.close();
      }
    });
  }
}

declare global { interface Window { __controlAccess?: { holdHistory: boolean; heldRequests: number } } }

for (const colorScheme of ['light', 'dark'] as const) {
  test(`in-contract control access: history focus clearance narrow feed 844×390 ${colorScheme}`, async ({ browser }, testInfo) => {
    const context = await browser.newContext({ ...devices['Desktop Chrome'], viewport: { width: 844, height: 390 }, colorScheme });
    try {
      const page = await context.newPage();
      await page.addInitScript(() => {
        const state = { holdHistory: false, heldRequests: 0 };
        window.__controlAccess = state;
        let inner = window.fetch.bind(window);
        const fetchHistory = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
          if (url.pathname === '/api/history' && state.holdHistory) {
            state.heldRequests++;
            return new Promise<Response>(() => undefined);
          }
          return inner(input, init);
        };
        Object.defineProperty(window, 'fetch', { configurable: true, get: () => fetchHistory, set: (value: typeof fetch) => { inner = value; } });
      });
      await page.goto('/e2e/studio/index.html?historyError=1');
      // Keep this scroll-reveal regression stacked: the approved compact
      // row has no vertical overflow. An expanded rail leaves <560px here.
      const expandRail = page.getByRole('button', { name: 'Expand sidebar', exact: true });
      if (await expandRail.isVisible()) await expandRail.click();
      const canvas = page.getByTestId('canvas-scroller');
      const retry = canvas.getByRole('button', { name: 'Retry', exact: true });
      await expect(retry).toBeVisible();
      await approvedSettle(page);
      await canvas.evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await expect.poll(() => canvas.evaluate((element) => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop))).toBeLessThanOrEqual(1);
      const before = await retry.boundingBox();
      await retry.focus();
      await expect(retry).toBeFocused();
      const clearance = () => retry.evaluate((element) => {
        const target = element.getBoundingClientRect();
        const scroll = element.closest('[data-testid="canvas-scroller"]');
        const composer = document.querySelector('#atelier-composer');
        if (!scroll || !composer) throw new Error('missing history geometry owner');
        const clip = scroll.getBoundingClientRect();
        const dock = composer.getBoundingClientRect();
        const hit = document.elementFromPoint(target.x + target.width / 2, target.y + target.height / 2);
        const rect = (box: DOMRect) => ({ top: box.top, bottom: box.bottom, left: box.left, right: box.right, width: box.width, height: box.height });
        return { target: rect(target), clip: rect(clip), composer: rect(dock), topClearance: target.top - clip.top, bottomClearance: dock.top - target.bottom, scrollPaddingTop: getComputedStyle(scroll).scrollPaddingTop, hit: hit === element || element.contains(hit) };
      });
      await expect.poll(async () => {
        const proof = await clearance();
        return proof.topClearance >= 13.9 && proof.bottomClearance >= -0.1 && proof.target.bottom <= proof.clip.bottom + 0.1 && proof.hit;
      }).toBe(true);
      const proof = await clearance();
      expect(proof.scrollPaddingTop).toBe('14px');
      await page.evaluate(() => { if (window.__controlAccess) window.__controlAccess.holdHistory = true; });
      await page.keyboard.press('Enter');
      await expect.poll(() => page.evaluate(() => window.__controlAccess?.heldRequests ?? 0)).toBeGreaterThan(0);
      await expect(canvas.getByRole('status')).toContainText('Loading');
      await testInfo.attach('history-native-focus-clearance', { body: JSON.stringify({ colorScheme, before, proof, nativeFocus: true, nativeActivation: 'Enter', loading: true }), contentType: 'application/json' });
    } finally {
      await context.close();
    }
  });
}

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

// Extend the same offline fetch seam as settings ownership. Only the existing
// admin model update changes availability; production query refresh owns the UI.
async function withPrerequisiteReadiness(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let inner = window.fetch.bind(window);
    let enabled = false;
    let provider: AdminProvider | undefined;
    const fixture = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
      if (url.pathname === '/api/text-providers/provider-preview/models/text-model-preview' && init?.method === 'PATCH') {
        const model = provider?.models[0];
        if (!model) throw new Error('missing existing public writer fixture');
        if (typeof init.body !== 'string') throw new Error('expected JSON model update');
        const patch = JSON.parse(init.body) as { enabled: boolean };
        enabled = patch.enabled;
        return Response.json({ ...model, enabled });
      }
      if (url.pathname === '/api/text-models' && enabled) return Response.json({
        models: [{ id: 'text-model-preview', displayName: 'Preview writer', providerName: 'Preview provider', vision: false, reasoningLevels: [], status: 'available' }],
        tasks: [], defaults: { byTask: {} }, writers: {},
      } satisfies TextModelsResponse);
      const response = await inner(input, init);
      if (url.pathname === '/api/text-providers' && response.ok) {
        const data = await response.json() as { providers: AdminProvider[] };
        provider = data.providers[0];
        return Response.json({ providers: data.providers.map((item) => ({ ...item, models: item.models.map((model) => ({ ...model, enabled })) })) });
      }
      if (url.pathname === '/api/prompts' && response.ok) {
        const data = await response.json() as PromptLibraryResponse;
        return Response.json({ ...data, templates: data.templates.map((template, index) => index === 0
          ? { ...template, body: 'A harbour with {{ai-fill: a color}} sails' } : template) });
      }
      return response;
    };
    Object.defineProperty(window, 'fetch', { configurable: true, get: () => fixture, set: (value: typeof fetch) => { inner = value; } });
  });
}

test.describe('prerequisite readiness:', () => {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    for (const colorScheme of ['light', 'dark'] as const) {
      for (const admin of [false, true]) {
        test(`${viewport.width}×${viewport.height} ${colorScheme} ${admin ? 'admin' : 'non-admin'} copy and existing actions`, async ({ browser }) => {
          const { defaultBrowserType: _engine, ...device } = viewport.width === 1440 ? devices['Desktop Chrome'] : devices['iPhone 13'];
          const context = await browser.newContext({ ...device, viewport, colorScheme });
          try {
            const page = await context.newPage();
            await withPrerequisiteReadiness(page);
            await page.goto(`/e2e/studio/index.html?view=prompts&noTextModels=1${admin ? '&textAdmin=1&textProvider=1' : ''}`);
            await page.getByRole('tab', { name: 'Settings', exact: true }).click();
            const panel = page.getByRole('region', { name: 'Your text model settings' });
            await expect(panel.getByText(admin
              ? 'No text models are connected yet. Add one in Text models.'
              : 'Ask your admin to connect a text model.', { exact: true })).toBeVisible();
            await expect(panel.getByRole('button', { name: /^Text model for / })).toHaveCount(TEXT_TASKS.length);
            await expect(panel.getByRole('link')).toHaveCount(0);
            await page.getByRole('button', { name: 'Back to Unsorted', exact: true }).click();
            const composer = await approvedExpand(page);
            await composer.getByRole('textbox', { name: 'Prompt', exact: true }).fill('A harbour with {{ai-fill: a color}} sails');
            const status = composer.getByText('AI fills need a text model, 1 live token, re-rolled at Generate', { exact: true });
            await expect(status).toBeVisible();
            await expect(status).toHaveAttribute('data-tone', 'info');
            const generate = composer.getByRole('button', { name: 'Generate', exact: true });
            await expect(generate).toBeEnabled();
            await expect(generate).not.toHaveAttribute('aria-disabled', 'true');
            const enhance = page.getByRole('button', { name: 'Enhance', exact: true, includeHidden: true });
            await expect(enhance).toHaveAttribute('data-tip', 'Needs a text model');
            await expect(enhance).toBeEnabled();
            await enhance.click();
            const note = page.getByRole('dialog', { name: 'Enhance needs a text model.' });
            await expect(note).toBeVisible();
            if (admin) await expect(note.getByRole('button', { name: 'Set up text models' })).toBeVisible();
            else await expect(note).toContainText('Ask your admin to connect a text model.');
            await page.keyboard.press('Escape');
            await expect(note).toHaveCount(0);
            await expect(enhance).toBeFocused();
            await composer.getByRole('button', { name: 'Templates', exact: true }).click();
            const picker = page.getByRole('dialog', { name: 'Templates', exact: true });
            const brainstorm = picker.getByRole('button', { name: 'Brainstorm', exact: true });
            await expect(brainstorm).toHaveAttribute('data-tip', 'Needs a text model');
            await brainstorm.click();
            const brainstormNote = page.getByRole('dialog', { name: 'Brainstorm needs a text model.' });
            await expect(brainstormNote).toBeVisible();
            await page.keyboard.press('Escape');
            await expect(brainstormNote).toHaveCount(0);
            await expect(brainstorm).toBeFocused();
            await expect(picker).toBeVisible();
            await picker.getByRole('button', { name: /Editorial portrait/ }).click();
            const simulate = page.getByRole('button', { name: 'Simulate this prompt' });
            await expect(simulate).toHaveAttribute('data-tip', 'Preview the final prompt here. AI fills need a text model.');
            await expect(simulate).toBeEnabled();
            await expect(page.getByLabel('Prompt preview', { exact: true })).toBeVisible();
            await expect(page.getByRole('button', { name: 'Use prompt', exact: true })).toBeEnabled();
            await page.getByRole('dialog').getByRole('button', { name: 'Close templates', exact: true }).click();
            await expect(page.getByRole('button', { name: 'Simulate this prompt' })).toHaveCount(0);
            if (admin) {
              await enhance.click();
              await page.getByRole('button', { name: 'Set up text models', exact: true }).click();
              const toggle = page.getByRole('switch', { name: 'Use Preview writer', exact: true });
              await toggle.click();
              await expect(toggle).toHaveAttribute('aria-checked', 'true');
              await page.getByRole('button', { name: 'Back to Unsorted', exact: true }).click();
              await approvedExpand(page);
              await expect(status).toHaveCount(0);
              await expect(enhance).toHaveAttribute('data-tip', 'Rewrite prompt');
              await expect(generate).not.toHaveAttribute('aria-disabled', 'true');
              await composer.getByRole('button', { name: 'Templates', exact: true }).click();
              await expect(page.getByRole('dialog', { name: 'Editorial portrait', exact: true })).toBeVisible();
              await expect(simulate).toHaveAttribute('data-tip', "Preview the final prompt here — resolves AI fills too. Doesn't fill the composer.");
              await expect(page.getByText('AI fills need a text model', { exact: true })).toHaveCount(0);
            }
            await test.info().attach('readiness.png', { body: await page.screenshot(), contentType: 'image/png' });
          } finally {
            await context.close();
          }
        });
      }
    }
  }
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
async function expectHitArea(locator: ReturnType<Page['locator']>, label: string, centered = false): Promise<void> {
  const result = await locator.evaluate((element, sampleCenter) => {
    const area = getComputedStyle(element, '::before');
    const glyph = element.getBoundingClientRect();
    const clip = element.parentElement?.getBoundingClientRect() ?? glyph;
    const right = sampleCenter ? glyph.x + glyph.width / 2 + 19 : Math.min(clip.right, glyph.right + 3) - 4;
    const top = sampleCenter ? glyph.y + glyph.height / 2 - 19 : Math.max(clip.top, glyph.top - 3) + 4;
    let misses = 0;
    for (let dx = 0; dx <= 38; dx += 2) {
      for (let dy = 0; dy <= 38; dy += 2) {
        const hit = document.elementFromPoint(right - dx, top + dy);
        if (!(hit === element || element.contains(hit))) misses += 1;
      }
    }
    return { width: Number.parseFloat(area.width), height: Number.parseFloat(area.height), misses };
  }, centered);
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
      const meta = batch.querySelector('header > div > ul');
      const actions = [...batch.querySelectorAll('header > div > div > button')];
      if (!meta || actions.length < 2) throw new Error('missing meta row or actions');
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

// Approved reference, Move and copy behavior uses production components and
// extends only the studio's existing offline fetch seam inside this spec.
interface ApprovedOperations {
  creates: string[];
  moves: string[];
  deletes: number;
  holdCreate: boolean;
  holdMove: boolean;
  failCreate: boolean;
  failMove: boolean;
  pins: string[];
  holdPin: boolean;
  uploadMode: 'ready' | 'held' | 'error';
  releaseCreate?: () => void;
  releaseMove?: () => void;
  releasePin?: () => void;
  releaseUpload?: () => void;
}
declare global { interface Window { __approved?: ApprovedOperations } }

async function approvedStudio(page: Page, options: { many?: boolean; longName?: string; uniqueCollections?: boolean; noPrompts?: boolean } = {}) {
  await page.addInitScript(({ options, batch }) => {
    const state: ApprovedOperations = { creates: [], moves: [], deletes: 0, holdCreate: false, holdMove: false, failCreate: false, failMove: false, pins: [], holdPin: false, uploadMode: 'ready' };
    window.__approved = state;
    let inner = window.fetch.bind(window);
    let uploads = 0;
    const createdNames = new Map<string, string>();
    const pinned = new Set<string>();
    const fetchApproved = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      if (options.noPrompts && url.pathname === '/api/prompts') return Response.json({ error: 'Unavailable' }, { status: 404 });
      if (url.pathname === '/api/uploads' && method === 'POST') {
        uploads++;
        if (state.uploadMode === 'held') await new Promise<void>((resolve) => { state.releaseUpload = resolve; });
        if (state.uploadMode === 'error') return Response.json({ error: 'Reference upload rejected' }, { status: 400 });
        return Response.json({ id: `approved-ref-${String(uploads)}`, mime: 'image/png', ext: 'png', sizeBytes: 68, width: 1, height: 1, createdAt: 1 });
      }
      if (url.pathname.startsWith('/api/uploads/')) return new Response(null, { status: 204 });
      if (url.pathname === '/api/collections' && method === 'POST') {
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { name: string };
        state.creates.push(body.name);
        if (state.holdCreate) await new Promise<void>((resolve) => { state.releaseCreate = resolve; });
        if (options.uniqueCollections && createdNames.has(body.name)) return Response.json({ error: 'Collection name is already used' }, { status: 409 });
        if (state.failCreate) return Response.json({ error: 'Collection name is already used' }, { status: 400 });
        const id = options.uniqueCollections ? `created-${String(createdNames.size + 1)}` : 'approved-created';
        createdNames.set(body.name, id);
        return Response.json({ id, name: body.name, count: 0, archivedCount: 0, createdAt: 3 });
      }
      if (url.pathname.startsWith('/api/history/') && method === 'PATCH') {
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { collectionId: string; pinned?: boolean };
        if (body.pinned !== undefined) {
          const id = url.pathname.split('/').at(-1) ?? '';
          state.pins.push(id);
          if (state.holdPin) await new Promise<void>((resolve) => { state.releasePin = resolve; });
          if (body.pinned) pinned.add(id); else pinned.delete(id);
          return Response.json({ ...batch, id, pinned: body.pinned });
        }
        state.moves.push(body.collectionId);
        if (state.holdMove) await new Promise<void>((resolve) => { state.releaseMove = resolve; });
        if (state.failMove) return Response.json({ error: 'Collection move refused' }, { status: 400 });
        return Response.json({ ...batch, id: url.pathname.split('/').at(-1), collectionId: body.collectionId });
      }
      if (url.pathname.startsWith('/api/collections/') && method === 'DELETE') {
        state.deletes++;
        return new Response(null, { status: 204 });
      }
      const response = location.pathname.includes('/harness/anchors.html') && url.pathname === '/api/collections' && method === 'GET'
        ? Response.json({ items: [{ id: 'collection-logo', name: 'Logo concepts', count: 3, archivedCount: 0, createdAt: 1 }, { id: 'collection-studio', name: 'Studio refs', count: 1, archivedCount: 0, createdAt: 2 }], summary: { totalCount: 4, pinnedCount: 0, unsortedCount: 1, archivedTotalCount: 0, archivedPinnedCount: 0, archivedUnsortedCount: 0 } })
        : await inner(input, init);
      if (options.noPrompts && url.pathname === '/api/history' && method === 'GET') {
        const data = await response.json() as { items: Batch[]; nextCursor: string | null };
        return Response.json({ ...data, items: data.items.map((item) => pinned.has(item.id) ? { ...item, pinned: true } : item) });
      }
      if (url.pathname === '/api/collections' && method === 'GET') {
        const data = await response.json() as CollectionsResponse;
        const first = data.items[0];
        let items = options.longName && first ? [{ ...first, name: options.longName }, ...data.items.slice(1)] : data.items;
        if (options.many) items = [...items, ...Array.from({ length: 31 }, (_, index) => ({ id: `approved-${String(index)}`, name: `Approved collection ${String(index)}`, count: 1, archivedCount: 0, createdAt: 4 + index }))];
        return Response.json({ ...data, items });
      }
      return response;
    };
    Object.defineProperty(window, 'fetch', { configurable: true, get: () => fetchApproved, set: (value: typeof fetch) => { inner = value; } });
  }, { options, batch: viewerFixtureBatches.at(-1) });
}

async function approvedSettle(page: Page) {
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().filter((animation) => animation.timeline === document.timeline && animation.playState === 'running' && animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => undefined)));
  });
}

async function approvedExpand(page: Page) {
  const expand = page.getByRole('button', { name: 'Expand composer', exact: true });
  if (await expand.isVisible()) await expand.click();
  return page.getByTestId('composer-drop-surface');
}

async function approvedAttach(page: Page, count: number) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Attach reference images' }).click();
  await (await chooser).setFiles(Array.from({ length: count }, (_, index) => ({ name: `approved-${String(index)}.png`, mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64') })));
}

async function approvedOpenMove(page: Page) {
  const trigger = page.url().includes('/harness/anchors.html')
    ? page.locator('section[data-batch-id]').getByRole('button', { name: 'Move to collection', exact: true }).last()
    : page.locator('section[data-batch-id="studio-batch-4"]').getByRole('button', { name: 'Move to collection', exact: true });
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();
  const panel = page.getByRole('dialog', { name: 'Move to collection' });
  await expect(panel).toBeVisible();
  await approvedSettle(page);
  return panel;
}

const releaseLayouts = [
  { name: 'desktop', device: devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, phone: false },
  { name: 'phone', device: devices['iPhone 13'], viewport: { width: 390, height: 844 }, phone: true },
] as const;

for (const layout of releaseLayouts) {
  for (const stage of ['create', 'move'] as const) {
    for (const submit of ['keyboard', 'pointer'] as const) {
    test(`release retry and focus: ${layout.name} deferred ${stage} failure and deliberate retry via ${submit}`, async ({ browser }, testInfo) => {
      const context = await browser.newContext({ ...layout.device, viewport: layout.viewport });
      try {
        const page = await context.newPage();
        await approvedStudio(page, { uniqueCollections: true });
        await page.goto('/e2e/harness/anchors.html?case=feed&seed=6');
        const touch = await page.evaluate(() => matchMedia('(hover: none) and (pointer: coarse)').matches);
        const panel = await approvedOpenMove(page);
        await expect(panel).toHaveAttribute('data-mobile', String(layout.phone));
        const create = panel.getByRole('button', { name: 'New collection' });
        if (touch) await create.tap(); else await create.click();
        const input = panel.getByRole('textbox', { name: 'Collection name' });
        const move = panel.getByRole('button', { name: 'Move', exact: true });
        await input.fill('  Retry collection  ');
        await page.evaluate((stage) => {
          const state = window.__approved;
          if (!state) throw new Error('missing operations');
          state.holdCreate = stage === 'create';
          state.holdMove = stage === 'move';
          state.failCreate = stage === 'create';
          state.failMove = stage === 'move';
        }, stage);
        await input.focus();
        if (submit === 'keyboard') {
          await page.keyboard.press('Tab');
          await expect(move).toBeFocused();
          await page.keyboard.press('Enter');
        } else if (touch) await move.tap();
        else await move.click();
        await expect.poll(() => page.evaluate(() => window.__approved?.creates)).toEqual(['Retry collection']);
        if (stage === 'move') await expect.poll(() => page.evaluate(() => window.__approved?.moves)).toEqual(['created-1']);
        await expect(input).toHaveValue('  Retry collection  ');
        await expect(input).toHaveAttribute('readonly', '');
        await expect(move).toBeDisabled();
        // Repeated native Enter and a hit on the disabled control do not submit.
        await page.keyboard.press('Enter');
        const box = await move.boundingBox();
        if (!box) throw new Error('missing Move');
        if (touch) await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
        else await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        expect(await page.evaluate(() => window.__approved?.creates.length)).toBe(1);
        expect(await page.evaluate(() => window.__approved?.moves.length)).toBe(stage === 'move' ? 1 : 0);
        await page.evaluate((stage) => {
          if (stage === 'create') window.__approved?.releaseCreate?.(); else window.__approved?.releaseMove?.();
        }, stage);
        await expect(move).toBeEnabled();
        await expect(input).toBeFocused();
        await expect(panel.getByText(stage === 'create' ? 'Collection name is already used' : 'Collection move refused', { exact: true }).first()).toBeVisible();
        await page.evaluate(() => {
          if (!window.__approved) throw new Error('missing operations');
          Object.assign(window.__approved, { holdCreate: false, holdMove: false, failCreate: false, failMove: false });
        });
        await input.fill('Retry collection ');
        await page.keyboard.press('Enter');
        await expect(panel).toHaveCount(0);
        const operations = await page.evaluate(() => ({ creates: window.__approved?.creates, moves: window.__approved?.moves }));
        expect(operations).toEqual({ creates: stage === 'create' ? ['Retry collection', 'Retry collection'] : ['Retry collection'],
          moves: stage === 'create' ? ['created-1'] : ['created-1', 'created-1'] });
        await testInfo.attach('release-retry-counts.json', { body: JSON.stringify({ layout: layout.name, stage, submit, operations, recoveredInputFocus: true }), contentType: 'application/json' });
      } finally { await context.close(); }
    });
    }

    for (const leave of ['Tab', 'pointer', 'Escape', 'dismiss'] as const) {
      test(`release retry and focus: ${layout.name} pending ${stage} ${leave} cancellation keeps moved focus`, async ({ browser }, testInfo) => {
        const context = await browser.newContext({ ...layout.device, viewport: layout.viewport });
        try {
          const page = await context.newPage();
          await approvedStudio(page, { uniqueCollections: true });
          await page.goto('/e2e/harness/anchors.html?case=feed&seed=6');
          const touch = await page.evaluate(() => matchMedia('(hover: none) and (pointer: coarse)').matches);
          const panel = await approvedOpenMove(page);
          const create = panel.getByRole('button', { name: 'New collection' });
          if (touch) await create.tap(); else await create.click();
          const input = panel.getByRole('textbox', { name: 'Collection name' });
          await input.fill('Cancelled collection');
          await page.evaluate((stage) => {
            const state = window.__approved;
            if (!state) throw new Error('missing operations');
            Object.assign(state, { holdCreate: stage === 'create', holdMove: stage === 'move', failCreate: stage === 'create', failMove: stage === 'move' });
          }, stage);
          await input.press('Enter');
          await expect.poll(() => page.evaluate(() => window.__approved?.creates.length)).toBe(1);
          if (stage === 'move') await expect.poll(() => page.evaluate(() => window.__approved?.moves.length)).toBe(1);
          const other = panel.getByRole('button', { name: '(Unsorted)', exact: true });
          if (leave === 'Tab') {
            await expect(input).toBeFocused();
            await page.keyboard.press('Tab');
            await expect(other).toBeFocused();
          } else if (leave === 'pointer') {
            // A pointer on a non-action label leaves the request untouched.
            const label = panel.getByText('Move to collection', { exact: true });
            if (touch) await label.tap(); else await label.click();
            await other.focus();
          } else if (leave === 'Escape') {
            await page.keyboard.press('Escape');
            await expect(create).toBeFocused();
            await expect(create).toHaveAttribute('aria-disabled', 'true');
            await expect(create).toHaveAttribute('aria-busy', 'true');
            await page.keyboard.press('Enter');
            await expect(input).toHaveCount(0);
          } else {
            if (layout.phone) {
              const backdrop = page.getByRole('button', { name: 'Close move popover' });
              await backdrop.tap({ position: { x: 10, y: 10 } });
            } else await page.mouse.click(10, 20);
            await expect(panel).toHaveCount(0);
          }
          await expect(input).toHaveCount(0);
          const focused = await page.evaluateHandle(() => document.activeElement);
          await page.evaluate((stage) => {
            if (stage === 'create') window.__approved?.releaseCreate?.(); else window.__approved?.releaseMove?.();
          }, stage);
          await expect(page.getByText(stage === 'create' ? 'Collection name is already used' : 'Collection move refused', { exact: true }).first()).toBeVisible();
          await expect(input).toHaveCount(0);
          expect(await focused.evaluate((element) => element === document.activeElement && element?.isConnected)).toBe(true);
          if (leave === 'Escape') {
            await expect(create).toHaveAttribute('aria-disabled', 'false');
            await expect(create).toHaveAttribute('aria-busy', 'false');
            await page.keyboard.press('Escape');
            await expect(panel).toHaveCount(0);
          } else if (leave !== 'dismiss') await expect(panel).toBeVisible();
          const operations = await page.evaluate(() => ({ creates: window.__approved?.creates, moves: window.__approved?.moves }));
          expect(operations).toEqual({ creates: ['Cancelled collection'], moves: stage === 'move' ? ['created-1'] : [] });
          await testInfo.attach('release-cancellation-focus.json', { body: JSON.stringify({ layout: layout.name, stage, leave, operations, retainedConnectedFocus: true }), contentType: 'application/json' });
        } finally { await context.close(); }
      });
    }
  }
}

test('release retry and focus: desktop keyboard Pin removes final More and preserves adjacent navigation', async ({ page, browser }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await approvedStudio(page, { noPrompts: true });
  await page.goto('/e2e/studio/index.html');
  const row = page.locator('section[data-batch-id="studio-batch-4"]');
  const more = row.getByRole('button', { name: 'More actions', exact: true });
  await more.scrollIntoViewIfNeeded();
  await more.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu', { name: 'Batch actions' });
  await expect(menu.getByRole('menuitem')).toHaveCount(1);
  await expect(menu.getByRole('menuitem', { name: 'Pin batch' })).toBeFocused();
  await page.evaluate(() => { if (window.__approved) window.__approved.holdPin = true; });
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__approved?.pins)).toEqual(['studio-batch-4']);
  await expect(more).toHaveCount(0);
  const move = row.getByRole('button', { name: 'Move to collection', exact: true });
  await expect(move).toBeFocused();
  expect(await move.evaluate((element) => element.isConnected)).toBe(true);
  const tab = browser.browserType().name() === 'webkit' ? 'Alt+Tab' : 'Tab';
  await page.keyboard.press(tab);
  await expect(row.getByRole('button', { name: 'Archive batch' })).toBeFocused();
  await page.keyboard.press(`Shift+${tab}`);
  await expect(move).toBeFocused();
  // Move on deliberately while the mutation is still deferred. Settlement
  // and passive cleanup must not take focus back to the adjacent fallback.
  const copy = row.getByRole('button', { name: 'Copy prompt' });
  await copy.focus();
  await page.evaluate(() => { window.__approved?.releasePin?.(); });
  await expect(row.getByRole('button', { name: 'Unpin batch' })).toBeVisible();
  await approvedSettle(page);
  await expect(copy).toBeFocused();
  await expect(more).toHaveCount(0);
  await testInfo.attach('release-final-more-focus.json', { body: JSON.stringify({ pins: ['studio-batch-4'], moreAbsentBeforeResponse: true, fallback: 'Move to collection', nextTab: 'Archive batch', settlementFocus: 'Copy prompt' }), contentType: 'application/json' });
});

async function recoveryFeedBox(page: Page) {
  return page.getByTestId('canvas-scroller').evaluate(async (element) => {
    const content = await new Promise<{ width: number; height: number }>((resolve) => {
      const observer = new ResizeObserver(([entry]) => {
        if (!entry) return;
        observer.disconnect();
        resolve({ width: entry.contentRect.width, height: entry.contentRect.height });
      });
      observer.observe(element);
    });
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return { ...content, top: box.top + parseFloat(style.paddingTop), reserve: parseFloat(style.paddingBottom), containerType: style.containerType, contain: style.contain };
  });
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`approved recovery and batch actions: initial landscape recovery ${colorScheme}`, async ({ browser }, testInfo) => {
    const context = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 844, height: 390 }, colorScheme });
    try {
      const page = await context.newPage();
      await page.goto('/e2e/studio/index.html?historyError=1');
      const canvas = page.getByTestId('canvas-scroller');
      const retry = canvas.getByRole('button', { name: 'Retry', exact: true });
      await expect(retry).toBeVisible();
      await expect(page.getByRole('button', { name: 'Minimize composer', exact: true })).toBeVisible();
      await approvedSettle(page);
      const content = await recoveryFeedBox(page);
      expect(content.width).toBeGreaterThanOrEqual(560);
      expect(content.height).toBeLessThan(440);
      expect(content.containerType).toBe('size');
      expect(content.contain).toBe('strict');
      const state = retry.locator('..');
      await expect(state).toHaveCSS('display', 'grid');
      const geometry = await state.evaluate((element) => {
        const rect = (node: Element | null) => {
          if (!node) throw new Error('missing recovery child');
          const box = node.getBoundingClientRect();
          return { x: box.x, top: box.top, bottom: box.bottom, right: box.right, width: box.width, height: box.height };
        };
        return { state: rect(element), plate: rect(element.firstElementChild), art: rect(element.querySelector('[data-etching]')), title: rect(element.querySelector('h2')), body: rect(element.querySelector('p')), action: rect(element.querySelector('button')), composer: rect(document.querySelector('#atelier-composer')) };
      });
      expect(geometry.plate.width).toBe(64);
      expect(geometry.plate.height).toBe(64);
      expect(geometry.art.width).toBe(48);
      expect(geometry.state.top).toBeCloseTo(content.top, 1);
      expect(geometry.title.bottom + 4).toBeCloseTo(geometry.body.top, 1);
      expect(geometry.plate.right + 18).toBeCloseTo(geometry.title.x, 1);
      for (const box of [geometry.plate, geometry.title, geometry.body, geometry.action]) expect(box.bottom).toBeLessThanOrEqual(geometry.composer.top);
      await libraryHitPoints(retry);
      expect(await canvas.evaluate((element) => element.scrollTop)).toBe(0);
      await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Keep this recovery draft');
      await retry.tap();
      await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue('Keep this recovery draft');
      await testInfo.attach('initial-recovery-geometry', { body: JSON.stringify({ content, geometry, nativeHits: true, composerExpanded: true, draftRetained: true }), contentType: 'application/json' });
    } finally { await context.close(); }
  });
}

test('approved recovery and batch actions: exact feed content boundaries and long error reachability', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto('/e2e/studio/index.html?historyError=1');
  const canvas = page.getByTestId('canvas-scroller');
  const retry = canvas.getByRole('button', { name: 'Retry', exact: true });
  await expect(retry).toBeVisible();
  const state = retry.locator('..');
  const evidence: unknown[] = [];
  for (const boundary of [{ width: 559, height: 439, grid: false }, { width: 560, height: 439, grid: true }, { width: 560, height: 440, grid: false }]) {
    await canvas.evaluate((element, size) => {
      Object.assign(element.style, { boxSizing: 'content-box', flex: 'none', width: `${String(size.width)}px`, height: `${String(size.height)}px` });
    }, boundary);
    // Stable scrollbar gutters belong to the feed. Correct the test's CSS
    // width using its measured content box, not a viewport subtraction.
    const first = await recoveryFeedBox(page);
    await canvas.evaluate((element, correction) => { element.style.width = `${String(parseFloat(element.style.width) + correction)}px`; }, boundary.width - first.width);
    const content = await recoveryFeedBox(page);
    expect(content.width).toBe(boundary.width);
    expect(content.height).toBe(boundary.height);
    await expect(state).toHaveCSS('display', boundary.grid ? 'grid' : 'flex');
    evidence.push({ boundary, content });
  }
  // A long response grows naturally. Check separation and the native scroll
  // path to Retry rather than promising that arbitrary text fits one plate.
  await canvas.evaluate((element) => { element.style.height = '180px'; });
  await state.locator('p').evaluate((element) => { element.textContent = 'A longer service error with recovery detail. '.repeat(36); });
  const separation = await state.evaluate((element) => {
    const text = element.querySelector('p')?.getBoundingClientRect();
    const action = element.querySelector('button')?.getBoundingClientRect();
    if (!text || !action) throw new Error('missing error content');
    return { textRight: text.right, actionLeft: action.left, textHeight: text.height };
  });
  expect(separation.textRight).toBeLessThanOrEqual(separation.actionLeft);
  expect(separation.textHeight).toBeGreaterThan(64);
  await retry.focus();
  await expect(retry).toBeFocused();
  await retry.scrollIntoViewIfNeeded();
  expect(await retry.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return hit === element || element.contains(hit);
  })).toBe(true);
  await testInfo.attach('feed-query-boundaries', { body: JSON.stringify({ evidence, separation, longTextRetryReachable: true }), contentType: 'application/json' });
});

test('approved recovery and batch actions: tall phone and passive states retain their stacked owner', async ({ page }, testInfo) => {
  const evidence: unknown[] = [];
  for (const layout of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(layout);
    await page.goto('/e2e/studio/index.html?historyError=1');
    const canvas = page.getByTestId('canvas-scroller');
    const retry = canvas.getByRole('button', { name: 'Retry', exact: true });
    await expect(retry).toBeVisible();
    const state = retry.locator('..');
    await expect(state).toHaveCSS('display', 'flex');
    evidence.push({ layout, content: await recoveryFeedBox(page), artWidth: await state.locator('[data-etching]').evaluate((element) => element.getBoundingClientRect().width) });
  }
  await page.setViewportSize({ width: 844, height: 390 });
  await page.goto('/e2e/studio/index.html?emptyHistory=1');
  const canvas = page.getByTestId('canvas-scroller');
  const empty = canvas.locator('[data-etching]').locator('../..');
  await expect(empty).toHaveCSS('display', 'flex');
  await page.reload();
  await canvas.evaluate(async (element) => {
    // Existing production exports, mounted only in the browser spec, exercise
    // the shared owner without adding a product fixture or capture hook.
    const reactUrl = '/node_modules/.vite/deps/react.js';
    const domUrl = '/node_modules/.vite/deps/react-dom_client.js';
    const stateUrl = '/src/components/StateView/index.tsx';
    const { default: React } = await import(/* @vite-ignore */ reactUrl) as { default: typeof ReactApi };
    const { default: ReactDom } = await import(/* @vite-ignore */ domUrl) as { default: typeof ReactDomApi };
    const { StateView, LoadingState } = await import(/* @vite-ignore */ stateUrl) as typeof StateViewApi;
    const host = document.createElement('div');
    element.replaceChildren(host);
    ReactDom.createRoot(host).render(React.createElement(React.Fragment, null,
      React.createElement(LoadingState, { label: 'Loading history…' }),
      React.createElement(StateView, { glyph: '!', title: 'View error', action: { label: 'Recover view', onClick: () => undefined } }),
      React.createElement(StateView, { art: 'state-error', title: 'Error without body', action: { label: 'Try again', onClick: () => undefined } }),
    ));
  });
  await expect(canvas.getByRole('status')).toHaveCSS('display', 'flex');
  await expect(canvas.getByRole('button', { name: 'Recover view', exact: true }).locator('..')).toHaveCSS('display', 'flex');
  const noBody = canvas.getByRole('heading', { name: 'Error without body' }).locator('..');
  await expect(noBody).toHaveCSS('display', 'grid');
  expect(await noBody.locator('h2').evaluate((element) => getComputedStyle(element).alignSelf)).toBe('center');
  await testInfo.attach('unchanged-state-layouts', { body: JSON.stringify(evidence), contentType: 'application/json' });
});

async function approvedBatchFixture(page: Page, rich: boolean) {
  await page.addInitScript(({ rich }) => {
    let inner = window.fetch.bind(window);
    const fixture = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const response = await inner(input, init);
      const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
      if (url.pathname !== '/api/history' || !rich) return response;
      const history = await response.json() as { items: Batch[]; nextCursor: null };
      return Response.json({ ...history, items: history.items.map((batch) => batch.id !== 'studio-batch-4' ? batch : {
        ...batch, pinned: true, collectionId: 'campaign',
        provenance: { templateId: 'editorial', templateName: 'An unusually long editorial provenance label', rollSeed: 7, pins: {} },
        sequenceIndex: 1, sequence: { id: 'approved-sequence', segmentCount: 2, totalDurationFrames: 248, masterStatus: 'ready', createdAt: 1, updatedAt: 1 },
      }) });
    };
    Object.defineProperty(window, 'fetch', { configurable: true, get: () => fixture, set: (value: typeof fetch) => { inner = value; } });
  }, { rich });
}

test('approved recovery and batch actions: one-click Copy and Re-roll and token-to-Move focus fallback', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const copies: string[] = [];
  await page.exposeFunction('recordApprovedCopy', (text: string) => { copies.push(text); });
  const seed = viewerFixtureBatches[0];
  if (!seed) throw new Error('missing pinned studio fixture');
  await approvedStudio(page);
  await page.addInitScript((seed) => {
    let batch = { ...seed, pinned: true };
    let inner = window.fetch.bind(window);
    const fixture = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
      if (url.pathname === '/api/history') return Response.json({ items: [batch], nextCursor: null });
      if (url.pathname === `/api/history/${batch.id}` && init?.method === 'PATCH') {
        const patch = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as { collectionId: string | null };
        batch = { ...batch, collectionId: patch.collectionId };
        return Response.json(batch);
      }
      return inner(input, init);
    };
    Object.defineProperty(window, 'fetch', { configurable: true, get: () => fixture, set: (value: typeof fetch) => { inner = value; } });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => {
      const record = Reflect.get(window, 'recordApprovedCopy') as (value: string) => Promise<void>;
      await record(text);
    } } });
  }, seed);
  await page.goto('/e2e/studio/index.html?view=pinned&generate=1');
  const row = page.locator(`section[data-batch-id="${seed.id}"]`);
  await expect(row.locator('header')).toBeVisible();
  await approvedSettle(page);
  await row.locator('header').evaluate((element) => { element.scrollIntoView({ block: 'start' }); });
  const copy = row.getByRole('button', { name: 'Copy prompt', exact: true });
  await copy.click();
  await expect.poll(() => copies).toEqual([seed.prompt]);
  await expect(page.getByRole('status').filter({ hasText: 'Prompt copied' })).toBeVisible();
  await row.getByRole('button', { name: 'Re-roll', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as Window & { __studioGenerated?: number }).__studioGenerated)).toBe(1);
  // Re-roll deliberately navigates to Unsorted. Return to Pinned so the
  // assigned batch legitimately stays mounted after a move to Unsorted.
  await page.getByRole('button', { name: /^Pinned \d+$/ }).click();
  await expect(row).toBeVisible();
  await approvedSettle(page);
  const move = row.getByRole('button', { name: 'Move to collection', exact: true, includeHidden: true });
  const token = row.getByRole('button', { name: 'Campaign studies, move to collection', exact: true, includeHidden: true });
  await token.scrollIntoViewIfNeeded();
  await token.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Move to collection', exact: true });
  await expect(dialog).toBeVisible();
  await approvedSettle(page);
  const anchor = await token.boundingBox();
  const panel = await dialog.boundingBox();
  if (await dialog.getAttribute('data-anchored')) {
    if (!anchor || !panel) throw new Error('missing token anchor geometry');
    expect(Math.abs(panel.x + panel.width - anchor.x - anchor.width)).toBeLessThanOrEqual(1.5);
  }
  await dialog.getByRole('button', { name: '(Unsorted)', exact: true }).click();
  await expect(token).toHaveCount(0);
  await expect(dialog).toHaveCount(0);
  await expect(move).toBeFocused();
  await move.press('Enter');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: '(Unsorted)', exact: true })).toHaveAttribute('data-current', 'true');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(move).toBeFocused();
  await testInfo.attach('direct-action-paths', { body: JSON.stringify({ copies, rerolls: 1, tokenAnchor: anchor, panel, tokenRemoved: true, fallback: 'Move to collection' }), contentType: 'application/json' });
});

test('approved recovery and batch actions: stale read-only rows keep Copy enabled', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    let inner = window.fetch.bind(window);
    const fixture = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
      if (url.pathname === '/api/history' && url.searchParams.get('pinned') === 'true') return new Promise<Response>(() => undefined);
      return inner(input, init);
    };
    Object.defineProperty(window, 'fetch', { configurable: true, get: () => fixture, set: (value: typeof fetch) => { inner = value; } });
  });
  await page.goto('/e2e/studio/index.html');
  const row = page.locator('section[data-batch-id="studio-batch-4"]');
  await expect(row).toBeVisible();
  await page.getByRole('button', { name: /^Pinned \d+$/ }).click();
  await expect(row.getByRole('button', { name: 'Re-roll', exact: true })).toBeDisabled();
  await expect(row.getByRole('button', { name: 'Move to collection', exact: true })).toBeDisabled();
  await expect(row.getByRole('button', { name: 'Archive batch', exact: true })).toBeDisabled();
  await expect(row.getByRole('button', { name: 'Copy prompt', exact: true })).toBeEnabled();
});

for (const layout of [
  { width: 320, height: 844, touch: true, colorScheme: 'light', rich: false },
  { width: 360, height: 844, touch: true, colorScheme: 'dark', rich: false },
  { width: 390, height: 844, touch: true, colorScheme: 'light', rich: false },
  { width: 768, height: 1024, touch: true, colorScheme: 'dark', rich: false },
  { width: 844, height: 390, touch: true, colorScheme: 'dark', rich: false },
  { width: 1440, height: 900, touch: false, colorScheme: 'light', rich: false },
  { width: 390, height: 844, touch: true, colorScheme: 'dark', rich: true },
  { width: 1440, height: 900, touch: false, colorScheme: 'dark', rich: true },
] as const) {
  test(`approved recovery and batch actions: header ${String(layout.width)} ${layout.touch ? 'coarse' : 'fine'} ${layout.colorScheme} ${layout.rich ? 'pin master provenance' : 'plain'}`, async ({ browser }, testInfo) => {
    const context = await browser.newContext({ ...(layout.touch ? devices['iPhone 13'] : devices['Desktop Chrome']), viewport: { width: layout.width, height: layout.height }, colorScheme: layout.colorScheme });
    try {
      const page = await context.newPage();
      await approvedBatchFixture(page, layout.rich);
      await page.goto('/e2e/studio/index.html?video=1');
      if (layout.width === 768) {
        const expand = page.getByRole('button', { name: 'Expand sidebar', exact: true });
        if (await expand.isVisible()) await expand.click();
      }
      const row = page.locator('section[data-batch-id="studio-batch-4"]');
      const header = row.locator('header');
      await expect(header).toBeVisible();
      await header.evaluate((element) => { element.scrollIntoView({ block: 'start' }); });
      await approvedSettle(page);
      const cluster = row.getByRole('button', { name: 'Archive batch', exact: true, includeHidden: true }).locator('..');
      const expected = [...(layout.rich ? ['Unpin batch', 'Play master'] : []), ...(layout.width >= 768 ? ['Copy prompt'] : []), 'Re-roll', 'Move to collection', 'Archive batch', 'More actions'];
      expect(await cluster.locator('button').evaluateAll((elements) => elements.map((element) => element.getAttribute('aria-label')))).toEqual(expected);
      const geometry = await header.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const rect = (node: Element) => { const box = node.getBoundingClientRect(); return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height }; };
        const controls = element.querySelector('[class*="headerControls"]');
        const meta = controls?.querySelector('ul');
        const prompt = element.firstElementChild;
        if (!meta || !prompt) throw new Error('missing header owners');
        return { width: bounds.width, left: bounds.left, right: bounds.right, prompt: rect(prompt), meta: rect(meta), buttons: [...element.querySelectorAll('button')].map((button) => ({ label: button.getAttribute('aria-label'), ...rect(button) })) };
      });
      for (const box of geometry.buttons) {
        expect(box.x).toBeGreaterThanOrEqual(geometry.left - 0.1);
        expect(box.right).toBeLessThanOrEqual(geometry.right + 0.1);
      }
      if (!layout.rich && layout.width < 768) {
        const first = geometry.buttons[0];
        if (!first) throw new Error('missing action');
        expect(geometry.meta.width).toBeGreaterThanOrEqual(96);
        if (layout.width === 320) expect(first.y).toBeGreaterThanOrEqual(geometry.meta.bottom);
        else expect(first.y + first.height / 2).toBeCloseTo(geometry.meta.y + geometry.meta.height / 2, 1);
      }
      if (layout.width === 768) expect(geometry.meta.y).toBeGreaterThanOrEqual(geometry.prompt.bottom);
      if (layout.width >= 768 && geometry.meta.y < geometry.prompt.bottom) expect(geometry.prompt.width).toBeGreaterThanOrEqual(240);
      for (let i = 0; i < geometry.buttons.length; i++) {
        const a = geometry.buttons[i];
        if (!a) continue;
        for (const b of geometry.buttons.slice(i + 1)) expect(a.right <= b.x + 0.1 || b.right <= a.x + 0.1 || a.bottom <= b.y + 0.1 || b.bottom <= a.y + 0.1).toBe(true);
      }
      for (const label of expected) {
        const button = cluster.getByRole('button', { name: label, exact: true });
        if (layout.touch) await libraryHitPoints(button);
        await expect(button).toHaveAttribute('data-tip', label === 'More actions' ? 'More' : label);
      }
      await cluster.getByRole('button').first().focus();
      const tab = browser.browserType().name() === 'webkit' ? 'Alt+Tab' : 'Tab';
      for (const label of expected.slice(1)) { await page.keyboard.press(tab); await expect(cluster.getByRole('button', { name: label, exact: true })).toBeFocused(); }
      await cluster.getByRole('button', { name: 'More actions' }).press('Enter');
      const menu = page.getByRole('menu', { name: 'Batch actions' });
      await expect(menu).toBeVisible();
      await expect(menu.getByRole('menuitem', { name: 'Re-roll', exact: true })).toHaveCount(0);
      await expect(menu.getByRole('menuitem', { name: 'Move to collection', exact: true })).toHaveCount(0);
      await expect(menu.getByRole('menuitem', { name: 'Copy prompt', exact: true })).toHaveCount(layout.width < 768 ? 1 : 0);
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      const move = cluster.getByRole('button', { name: 'Move to collection', exact: true, includeHidden: true });
      await move.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Move to collection', exact: true });
      await expect(dialog).toBeVisible();
      await expect(move).toHaveAttribute('aria-expanded', 'true');
      await approvedSettle(page);
      const anchor = await move.boundingBox();
      const panel = await dialog.boundingBox();
      if (layout.width >= 768 && await dialog.getAttribute('data-anchored')) {
        if (!anchor || !panel) throw new Error('missing native anchor geometry');
        expect(Math.abs(panel.x + panel.width - anchor.x - anchor.width)).toBeLessThanOrEqual(1.5);
        expect(Math.min(Math.abs(panel.y - anchor.y - anchor.height - 8), Math.abs(anchor.y - panel.y - panel.height - 8))).toBeLessThanOrEqual(1.5);
      }
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(move).toBeFocused();
      expect(await noHorizontalOverflow(page)).toBe(true);
      await testInfo.attach('approved-batch-header', { body: JSON.stringify({ layout, geometry, expected, anchor, panel, tabOrder: expected, tab, nativeFocusReturned: true }), contentType: 'application/json' });
    } finally { await context.close(); }
  });
}

for (const scenario of [
  { touch: true, colorScheme: 'light' },
  { touch: true, colorScheme: 'dark' },
  { touch: false, colorScheme: 'light' },
] as const) {
  test(`approved reference move copy: reference rows and native hits ${scenario.touch ? 'touch' : 'fine'} ${scenario.colorScheme}`, async ({ browser }, testInfo) => {
    test.setTimeout(90_000);
    const context = await browser.newContext({ ...(scenario.touch ? devices['iPhone 13'] : devices['Desktop Chrome']), viewport: { width: 844, height: 390 }, colorScheme: scenario.colorScheme });
    try {
      const page = await context.newPage();
      await approvedStudio(page);
      await page.goto('/e2e/studio/index.html?generate=1');
      const collapseRail = page.getByRole('button', { name: 'Collapse sidebar' });
      if (await collapseRail.isVisible()) await collapseRail.click();
      const composer = await approvedExpand(page);
      const prompt = composer.getByRole('textbox', { name: 'Prompt', exact: true });
      const attach = composer.getByRole('button', { name: 'Attach reference images' });
      const generate = composer.getByRole('button', { name: 'Generate', exact: true });
      await prompt.fill('Coastal study');
      await approvedSettle(page);
      const initial = await composer.boundingBox();
      const generateInitial = await generate.boundingBox();
      const metrics: unknown[] = [];
      // The selected shared image model's native maximum and fallback are 4.
      for (const count of [1, 3, 4]) {
        await approvedAttach(page, count === 1 ? 1 : count === 3 ? 2 : 1);
        await expect(composer.getByRole('button', { name: /^Remove reference image/ })).toHaveCount(count);
        await expect(composer.getByRole('button', { name: `Remove reference image ${String(count)}`, exact: true })).toBeEnabled();
        await approvedSettle(page);
        const geometry = await composer.evaluate((element) => {
          const prompt = element.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]');
          const refs = element.querySelector('[aria-label="Reference images"]');
          const minimize = element.querySelector('[aria-label="Minimize composer"]');
          if (!prompt || !refs || !minimize) throw new Error('missing composer controls');
          const p = prompt.getBoundingClientRect();
          const r = refs.getBoundingClientRect();
          const m = minimize.getBoundingClientRect();
          const style = getComputedStyle(element);
          const width = element.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth);
          const removes = Array.from(refs.querySelectorAll('button[aria-label^="Remove"]')).map((button) => {
            const b = button.getBoundingClientRect();
            const pseudo = getComputedStyle(button, '::before');
            const size = pseudo.content === 'none' ? b.width : parseFloat(pseudo.width);
            const height = pseudo.content === 'none' ? b.height : parseFloat(pseudo.height);
            const region = { left: b.x + b.width / 2 - size / 2, right: b.x + b.width / 2 + size / 2, top: b.y + b.height / 2 - height / 2, bottom: b.y + b.height / 2 + height / 2 };
            const overlaps = (rect: DOMRect) => region.left < rect.right && region.right > rect.left && region.top < rect.bottom && region.bottom > rect.top;
            // Adjacent 32px chips retain their existing 8px spacing. Sample
            // each target's owned interior; the last target's outer extension
            // is also activated natively below, next to the prompt.
            const hits = [b.x + b.width / 2, region.right - 6].map((x) => { const hit = document.elementFromPoint(x, b.y + b.height / 2); return hit === button || button.contains(hit); });
            return { region, hits, overlapsPrompt: overlaps(p), overlapsMinimize: overlaps(m), chipWidth: button.parentElement?.getBoundingClientRect().width };
          });
          const hits = [p.top + 1, p.top + p.height / 2, p.bottom - 1].map((y) => document.elementFromPoint(p.right - 1, y) === prompt);
          return { contentWidth: width, refWidth: r.width, rowDelta: p.y - r.y, promptLeft: p.left, refRight: r.right, promptRight: p.right, minimizeLeft: m.left, removes, hits, height: element.getBoundingClientRect().height };
        });
        expect(geometry.contentWidth).toBeGreaterThanOrEqual(640);
        expect(Math.abs(geometry.rowDelta)).toBeLessThanOrEqual(1);
        expect(geometry.refWidth).toBeLessThanOrEqual(geometry.contentWidth * .4 + 1);
        expect(geometry.promptLeft - geometry.refRight).toBeGreaterThanOrEqual(9);
        expect(geometry.minimizeLeft - geometry.promptRight).toBeGreaterThan(0);
        expect(geometry.hits.every(Boolean)).toBe(true);
        for (const remove of geometry.removes) {
          expect(remove.chipWidth).toBe(32);
          expect(remove.overlapsPrompt || remove.overlapsMinimize).toBe(false);
          expect(remove.hits.every(Boolean)).toBe(true);
          if (scenario.touch) expect(remove.region.right - remove.region.left).toBe(44);
        }
        const box = await composer.boundingBox();
        const g = await generate.boundingBox();
        if (!initial || !box || !g || !generateInitial) throw new Error('missing composer geometry');
        expect(Math.abs(box.height - initial.height), 'first ref and one-line counts add no frame row').toBeLessThanOrEqual(1);
        expect(Math.abs(g.y - generateInitial.y)).toBeLessThanOrEqual(1);
        // Compare against the same production layout with only the approved
        // first-row placement removed, then restore the actual stylesheet.
        const stacked = await page.addStyleTag({ content: '[data-testid="composer-drop-surface"] > [aria-label="Reference images"] { grid-column: 1 / -1 !important; grid-row: auto !important; max-width: none !important; padding-right: 0 !important; } [data-testid="composer-drop-surface"] > textarea { grid-column: 1 / -1 !important; grid-row: auto !important; width: 100% !important; }' });
        const stackedBox = await composer.boundingBox();
        await stacked.evaluate((element) => { element.parentNode?.removeChild(element); });
        if (!stackedBox) throw new Error('missing stacked comparison');
        const saved = stackedBox.height - box.height;
        expect(saved).toBeCloseTo(scenario.touch ? 54 : 42, 0);
        metrics.push({ count, saved, ...geometry });
      }
      await expect(attach).toBeDisabled();
      await prompt.fill('First line\nSecond line\nThird line');
      await approvedSettle(page);
      const top = await attach.locator('..').boundingBox();
      const promptBox = await prompt.boundingBox();
      if (!top || !promptBox) throw new Error('missing three-line layout');
      expect(Math.abs(top.y - promptBox.y)).toBeLessThanOrEqual(1);
      await prompt.fill('First line\nSecond line\nThird line\nFourth line');
      const scroll = await prompt.evaluate((element) => ({ height: element.getBoundingClientRect().height, line: parseFloat(getComputedStyle(element).lineHeight), client: element.clientHeight, scroll: element.scrollHeight }));
      expect(scroll.height).toBeLessThanOrEqual(3 * scroll.line + 10.1);
      expect(scroll.scroll).toBeGreaterThan(scroll.client);
      await prompt.evaluate((element) => { element.scrollTop = element.scrollHeight; });
      expect(await prompt.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      // Native edge tap proves the prompt owns its effective region.
      const edge = await prompt.boundingBox();
      if (!edge) throw new Error('missing prompt');
      if (scenario.touch) await page.touchscreen.tap(edge.x + edge.width - 2, edge.y + 10);
      else await page.mouse.click(edge.x + edge.width - 2, edge.y + 10);
      await expect(prompt).toBeFocused();
      const remove = composer.getByRole('button', { name: 'Remove reference image 4', exact: true });
      const removeBox = await remove.boundingBox();
      if (!removeBox) throw new Error('missing remove');
      if (scenario.touch) await page.touchscreen.tap(removeBox.x + removeBox.width + 10, removeBox.y + 8);
      else await remove.click();
      await expect(composer.getByRole('button', { name: /^Remove reference image/ })).toHaveCount(3);
      await expect(generate).toBeEnabled();
      if (scenario.touch) await generate.tap(); else await generate.click();
      await expect.poll(() => page.evaluate(() => (window as Window & { __studioGenerated?: number }).__studioGenerated)).toBe(1);
      await testInfo.attach('approved-reference-metrics.json', { body: JSON.stringify({ scenario, metrics, scroll }), contentType: 'application/json' });
    } finally { await context.close(); }
  });
}

test('approved reference move copy: exact content, viewport and height boundaries', async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const context = await browser.newContext({ ...devices['Desktop Chrome'] });
  const metrics: unknown[] = [];
  try {
    const page = await context.newPage();
    await approvedStudio(page);
    for (const boundary of [
      { width: 844, height: 390, content: 639, shared: false },
      { width: 844, height: 390, content: 640, shared: true },
      { width: 767, height: 620, content: 640, shared: false },
      { width: 768, height: 620, content: 640, shared: true },
      { width: 844, height: 620, content: 640, shared: true },
      { width: 844, height: 621, content: 640, shared: false },
      { width: 390, height: 844, content: null, shared: false },
    ]) {
      await page.setViewportSize({ width: boundary.width, height: boundary.height });
      await page.goto('/e2e/studio/index.html?video=1');
      const collapse = page.getByRole('button', { name: 'Collapse sidebar' });
      if (await collapse.isVisible()) await collapse.click();
      const composer = await approvedExpand(page);
      if (boundary.content !== null) await composer.evaluate((element, width) => {
        const style = getComputedStyle(element);
        const inset = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
        element.style.boxSizing = 'border-box'; element.style.width = `${String(width + inset)}px`;
      }, boundary.content);
      await approvedAttach(page, 1);
      await expect(composer.getByRole('button', { name: 'Remove reference image 1' })).toBeEnabled();
      await approvedSettle(page);
      const measured = await composer.evaluate((element) => {
        const style = getComputedStyle(element);
        const content = element.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth);
        const refs = element.querySelector('[aria-label="Reference images"]')?.getBoundingClientRect();
        const prompt = element.querySelector('textarea[aria-label="Prompt"]')?.getBoundingClientRect();
        if (!refs || !prompt) throw new Error('missing boundary controls');
        return { content, refs: { y: refs.y, bottom: refs.bottom }, prompt: { y: prompt.y } };
      });
      if (boundary.content !== null) expect(measured.content).toBeCloseTo(boundary.content, 1);
      if (boundary.shared) expect(Math.abs(measured.prompt.y - measured.refs.y)).toBeLessThanOrEqual(1);
      else expect(measured.prompt.y - measured.refs.bottom).toBeGreaterThanOrEqual(9);
      metrics.push({ boundary, measured });
      // Collapse remains its original mounted form / compact bar transition.
      await composer.getByRole('button', { name: boundary.width < 768 ? 'Collapse composer' : 'Minimize composer', exact: true }).click();
      await expect(page.getByRole('button', { name: /^Expand composer/ })).toBeVisible();
    }
    await testInfo.attach('approved-boundaries.json', { body: JSON.stringify(metrics), contentType: 'application/json' });
  } finally { await context.close(); }
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`approved reference move copy: native Move and pending chain ${String(viewport.width)} ${colorScheme}`, async ({ browser }, testInfo) => {
      test.setTimeout(90_000);
      const touch = viewport.width < 768;
      const context = await browser.newContext({ ...(touch ? devices['iPhone 13'] : devices['Desktop Chrome']), viewport, colorScheme });
      try {
        const page = await context.newPage();
        await approvedStudio(page);
        // This existing harness keeps the invoking batch mounted while the
        // real mutations settle, unlike the studio's optimistic Unsorted feed.
        await page.goto(`/e2e/harness/anchors.html?case=feed&seed=6&theme=${colorScheme}`);
        let panel = await approvedOpenMove(page);
        const create = panel.getByRole('button', { name: 'New collection', exact: true });
        if (touch) await create.tap(); else await create.click();
        let input = panel.getByRole('textbox', { name: 'Collection name' });
        let move = panel.getByRole('button', { name: 'Move', exact: true });
        await expect(move).toBeDisabled();
        await input.fill('   ');
        await expect(move).toBeDisabled();
        await input.fill('Draft collection');
        await page.keyboard.press('Tab');
        await expect(move).toBeFocused();
        await expect(input).toHaveValue('Draft collection');
        await page.keyboard.press('Shift+Tab');
        await expect(input).toBeFocused();
        await page.keyboard.press('Tab');
        await page.keyboard.press('Tab');
        await expect(panel.getByRole('button', { name: '(Unsorted)', exact: true })).toBeFocused();
        await expect(input).toHaveCount(0);
        await create.click();
        input = panel.getByRole('textbox', { name: 'Collection name' });
        await input.fill('Candidate');
        for (const key of ['Enter', 'Escape']) {
          await input.dispatchEvent('keydown', { key, isComposing: true });
          await input.dispatchEvent('keydown', { key, keyCode: 229 });
          await expect(input).toBeFocused();
        }
        await page.keyboard.press('Escape');
        await expect(create).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(panel).toHaveCount(0);
        panel = await approvedOpenMove(page);
        await panel.getByRole('button', { name: 'New collection' }).click();
        input = panel.getByRole('textbox', { name: 'Collection name' });
        move = panel.getByRole('button', { name: 'Move', exact: true });
        await input.fill('  Native collection  ');
        if (touch) { await expectFloor(input, 'create input'); await expectFloor(move, 'Move'); }
        await page.evaluate(() => { if (window.__approved) { window.__approved.holdCreate = true; window.__approved.holdMove = true; } });
        if (touch) await move.tap(); else await move.click();
        await expect.poll(() => page.evaluate(() => window.__approved?.creates.length)).toBe(1);
        await expect(input).toHaveValue('  Native collection  ');
        await expect(input).toHaveAttribute('readonly', '');
        await expect(move).toBeDisabled();
        await expect(move).toHaveAttribute('aria-busy', 'true');
        await input.press('Enter');
        // A real second tap at the now-disabled button must remain inert.
        const b = await move.boundingBox();
        if (!b) throw new Error('missing pending Move');
        if (touch) await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
        else await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
        await page.evaluate(() => { window.__approved?.releaseCreate?.(); });
        await expect.poll(() => page.evaluate(() => window.__approved?.moves.length)).toBe(1);
        await input.press('Enter');
        await expect(move).toBeDisabled();
        expect(await page.evaluate(() => window.__approved?.creates)).toEqual(['Native collection']);
        await page.evaluate(() => { window.__approved?.releaseMove?.(); });
        await expect(panel).toHaveCount(0);
        // Rejection retains the service reason and waits for deliberate Enter.
        panel = await approvedOpenMove(page);
        await panel.getByRole('button', { name: 'New collection' }).click();
        input = panel.getByRole('textbox', { name: 'Collection name' });
        move = panel.getByRole('button', { name: 'Move', exact: true });
        await page.evaluate(() => { if (window.__approved) { window.__approved.holdCreate = false; window.__approved.holdMove = false; window.__approved.failCreate = true; } });
        await input.fill('Retry collection');
        await input.press('Enter');
        await expect(move).toBeEnabled();
        await expect(panel.getByText('Collection name is already used', { exact: true }).first()).toBeVisible();
        await expect(input).toHaveValue('Retry collection');
        expect(await page.evaluate(() => window.__approved?.creates.length)).toBe(2);
        expect(await page.evaluate(() => window.__approved?.moves.length)).toBe(1);
        await page.evaluate(() => { if (window.__approved) window.__approved.failCreate = false; });
        await input.press('Enter');
        await expect(panel).toHaveCount(0);
        const operations = await page.evaluate(() => ({ creates: window.__approved?.creates, moves: window.__approved?.moves }));
        expect(operations.creates).toEqual(['Native collection', 'Retry collection', 'Retry collection']);
        expect(operations.moves).toEqual(['approved-created', 'approved-created']);
        await testInfo.attach('approved-operation-counts.json', { body: JSON.stringify({ viewport, colorScheme, operations }), contentType: 'application/json' });
      } finally { await context.close(); }
    });
  }
}

test('approved reference move copy: short landscape final create row stays reachable', async ({ browser }, testInfo) => {
  const context = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 844, height: 390 } });
  try {
    const page = await context.newPage();
    await approvedStudio(page, { many: true });
    await page.goto('/e2e/studio/index.html?batches=3');
    const panel = await approvedOpenMove(page);
    await page.keyboard.press('End');
    await expect(panel.getByRole('button', { name: 'Approved collection 30', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    const create = panel.getByRole('button', { name: 'New collection' });
    await expect(create).toBeFocused();
    await create.tap();
    const input = panel.getByRole('textbox', { name: 'Collection name' });
    await input.fill('Landscape');
    await page.keyboard.press('Tab');
    const move = panel.getByRole('button', { name: 'Move', exact: true });
    await expect(move).toBeFocused();
    // Check native hit ownership directly: WebKit's IntersectionObserver can
    // round a fully revealed fractional box below a ratio of exactly one.
    const reachable = await move.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const hits = [box.left + 2, box.right - 2].flatMap((x) => [box.top + 2, box.bottom - 2].map((y) => {
        const hit = document.elementFromPoint(x, y);
        return hit === element || element.contains(hit);
      }));
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: innerWidth, height: innerHeight, hits };
    });
    expect(reachable.left).toBeGreaterThanOrEqual(0);
    expect(reachable.right).toBeLessThanOrEqual(reachable.width);
    expect(reachable.top).toBeGreaterThanOrEqual(0);
    expect(reachable.bottom).toBeLessThanOrEqual(reachable.height);
    expect(reachable.hits.every(Boolean)).toBe(true);
    await expectFloor(input, 'landscape input');
    await expectFloor(move, 'landscape Move');
    const scroll = await panel.locator('[data-overlay-scroll]').evaluate((element) => ({ top: element.scrollTop, client: element.clientHeight, scroll: element.scrollHeight }));
    expect(scroll.top).toBeGreaterThan(0);
    expect(scroll.scroll).toBeGreaterThan(scroll.client);
    await move.tap();
    await expect(panel).toHaveCount(0);
    await testInfo.attach('approved-last-row.json', { body: JSON.stringify({ scroll, reachable }), contentType: 'application/json' });
  } finally { await context.close(); }
});

for (const scenario of [
  { width: 390, touch: true, colorScheme: 'light' },
  { width: 390, touch: false, colorScheme: 'dark' },
  { width: 1440, touch: true, colorScheme: 'dark' },
  { width: 1440, touch: false, colorScheme: 'light' },
] as const) {
  test(`approved reference move copy: accessible copy and quoted delete ${String(scenario.width)} ${scenario.touch ? 'touch' : 'fine'} ${scenario.colorScheme}`, async ({ browser }, testInfo) => {
    test.setTimeout(90_000);
    const context = await browser.newContext({ ...(scenario.touch ? devices['iPhone 13'] : devices['Desktop Chrome']), viewport: { width: scenario.width, height: 844 }, colorScheme: scenario.colorScheme });
    try {
      const page = await context.newPage();
      const longName = scenario.width === 390 ? 'UnbrokenCollectionName'.repeat(12) : undefined;
      await approvedStudio(page, longName ? { longName } : {});
      await page.goto('/e2e/studio/index.html?emptyHistory=1');
      expect(await page.evaluate(() => matchMedia('(hover: none) and (pointer: coarse)').matches)).toBe(scenario.touch);
      const body = scenario.touch ? 'Write a prompt, pick a model, tap Generate.' : 'Write a prompt, pick a model, press ⌘ ↵.';
      const hidden = scenario.touch ? 'Write a prompt, pick a model, press ⌘ ↵.' : 'Write a prompt, pick a model, tap Generate.';
      const canvas = page.getByTestId('canvas-scroller');
      await expect(canvas.getByText(body, { exact: true })).toBeVisible();
      await expect(canvas.getByText(hidden, { exact: true })).toBeHidden();
      const accessibility = await canvas.ariaSnapshot();
      expect(accessibility).toContain(body);
      expect(accessibility).not.toContain(hidden);
      const expand = page.getByRole('button', { name: scenario.width < 768 ? 'Open menu' : 'Expand sidebar', exact: true });
      if (scenario.width < 768 || await expand.isVisible()) await expand.click();
      const sidebar = page.getByRole('complementary');
      const name = longName ?? 'Campaign studies';
      const destination = sidebar.getByRole('button', { name: new RegExp(`^${name}`) }).filter({ has: page.getByText(name, { exact: true }) }).first();
      await destination.click();
      await expect(page.getByRole('main').getByRole('heading', { name, exact: true })).toBeVisible();
      await expect(canvas.getByText(body, { exact: true })).toBeVisible();
      if (await expand.isVisible()) await expand.click();
      const remove = sidebar.getByRole('button', { name: `Delete collection ${name}`, exact: true });
      await remove.focus();
      // Preserve an actual invoking focus target on WebKit, whose native
      // pointer activation does not focus these existing rail buttons.
      await remove.press('Enter');
      const dialog = page.getByRole('dialog');
      const heading = dialog.getByRole('heading', { name: `Delete “${name}”?`, exact: true });
      await expect(heading).toBeVisible();
      await expect(dialog.getByText('Batches will return to Unsorted.', { exact: true })).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Delete collection', exact: true })).toBeVisible();
      const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
      await expect(cancel).toBeFocused();
      const wrap = await heading.evaluate((element) => ({ scroll: element.scrollWidth, client: element.clientWidth, height: element.getBoundingClientRect().height, line: parseFloat(getComputedStyle(element).lineHeight), text: element.textContent }));
      expect(wrap.scroll).toBeLessThanOrEqual(wrap.client + 1);
      if (longName) expect(wrap.height).toBeGreaterThan(wrap.line * 2);
      await cancel.click();
      await expect(dialog).toHaveCount(0);
      await expect(remove).toBeFocused();
      expect(await page.evaluate(() => window.__approved?.deletes)).toBe(0);
      await remove.press('Enter');
      await dialog.getByRole('button', { name: 'Delete collection', exact: true }).click();
      await expect.poll(() => page.evaluate(() => window.__approved?.deletes)).toBe(1);
      await testInfo.attach('approved-copy.json', { body: JSON.stringify({ scenario, accessibility, wrap }), contentType: 'application/json' });
    } finally { await context.close(); }
  });
}

test('approved reference move copy: pending and failed refs retain layout and video ownership', async ({ browser }, testInfo) => {
  const context = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 844, height: 390 }, colorScheme: 'dark' });
  try {
    const page = await context.newPage();
    await approvedStudio(page);
    await page.goto('/e2e/studio/index.html?video=1');
    const collapse = page.getByRole('button', { name: 'Collapse sidebar' });
    if (await collapse.isVisible()) await collapse.click();
    const composer = await approvedExpand(page);
    const initial = await composer.boundingBox();
    await page.evaluate(() => { if (window.__approved) window.__approved.uploadMode = 'held'; });
    await approvedAttach(page, 1);
    const remove = composer.getByRole('button', { name: 'Remove reference image 1' });
    await expect(remove).toBeDisabled();
    await approvedSettle(page);
    const pending = await composer.boundingBox();
    const row = await composer.locator('[aria-label="Reference images"]').boundingBox();
    const prompt = await composer.getByRole('textbox', { name: 'Prompt', exact: true }).boundingBox();
    if (!initial || !pending || !row || !prompt) throw new Error('missing pending layout');
    expect(Math.abs(pending.height - initial.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(row.y - prompt.y)).toBeLessThanOrEqual(1);
    await page.evaluate(() => { if (window.__approved) { window.__approved.uploadMode = 'error'; window.__approved.releaseUpload?.(); } });
    await expect(remove).toBeEnabled();
    await expect(composer.getByRole('img', { name: 'Reference image 1', exact: true })).toHaveAccessibleDescription('Reference upload rejected');
    await expect(remove.locator('..')).toHaveAttribute('data-tip', 'Reference upload rejected');
    const failed = await composer.boundingBox();
    expect(failed?.height).toBeCloseTo(initial.height, 0);
    await remove.tap();
    await expect(remove).toHaveCount(0);
    await composer.getByRole('button', { name: 'Model', exact: true }).click();
    await page.getByRole('option', { name: /Studio Motion/ }).click();
    await expect(composer.getByRole('textbox', { name: 'Motion prompt' })).toBeVisible();
    await expect(composer).toHaveCSS('display', 'flex');
    await expect(composer).toHaveCSS('padding-top', '14px');
    await expect(composer.getByRole('button', { name: 'Animate', exact: true })).toBeVisible();
    await composer.getByRole('button', { name: 'Back to image generation' }).click();
    await expect(composer).toHaveCSS('display', 'grid');
    await testInfo.attach('approved-reference-states.json', { body: JSON.stringify({ initial, pending, failed, row, prompt }), contentType: 'application/json' });
  } finally { await context.close(); }
});

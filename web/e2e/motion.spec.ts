import { expect, test, type Page } from '@playwright/test';
import type { useAtelierStore as AtelierStore } from '../src/store/atelier';

/*
 * The motion system (styles/motion.css): one reduced-motion rule set, exits
 * that play before an overlay unmounts, and the view stage's
 * <ViewTransition>. happy-dom computes no animations, no frames and no view
 * transitions, so all three are pinned here, sampled on the page's own
 * animation-frame clock rather than through driver round trips.
 */

interface Frame {
  t: number;
  present: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  transform: string;
  opacity: number;
  closing: string | null;
  edgeWidth?: number;
  edgeHeight?: number;
  edgeRadius?: number;
  edgeBorder?: number;
}

interface ComposerSnapshot {
  name: string;
  opacity: number;
  transform: string;
  groupTransform: string;
  width: number;
  height: number;
  stageAnimating: boolean;
  geometryAnimated: boolean;
}

declare global {
  interface Window {
    __motionFrames?: Frame[];
    __motionDone?: boolean;
    __composerSnapshots?: ComposerSnapshot[];
    __composerSnapshotsDone?: boolean;
  }
}

/** Records `selector` on every animation frame for `ms`, starting now. */
async function startRecording(page: Page, selector: string, ms: number): Promise<void> {
  await page.evaluate(({ selector: target, ms: duration }) => {
    const frames: Frame[] = [];
    window.__motionFrames = frames;
    window.__motionDone = false;
    const start = performance.now();
    const tick = (now: number) => {
      const element = document.querySelector(target);
      if (element) {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const edge = element.id === 'atelier-composer' ? getComputedStyle(element, '::before') : null;
        frames.push({
          t: now - start,
          present: true,
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height,
          transform: style.transform,
          opacity: Number(style.opacity),
          closing: element.getAttribute('data-closing'),
          ...(edge ? {
            edgeWidth: Number.parseFloat(edge.width),
            edgeHeight: Number.parseFloat(edge.height),
            edgeRadius: Number.parseFloat(edge.borderTopLeftRadius),
            edgeBorder: Number.parseFloat(edge.borderTopWidth),
          } : {}),
        });
      } else {
        frames.push({ t: now - start, present: false, x: 0, y: 0, width: 0, height: 0, transform: 'none', opacity: 0, closing: null });
      }
      if (now - start < duration) requestAnimationFrame(tick);
      else window.__motionDone = true;
    };
    requestAnimationFrame(tick);
  }, { selector, ms });
}

async function recordedFrames(page: Page): Promise<Frame[]> {
  await page.waitForFunction(() => window.__motionDone === true);
  return page.evaluate(() => window.__motionFrames ?? []);
}

async function recordComposerSnapshots(page: Page, duration = 650): Promise<void> {
  await page.evaluate((ms) => {
    window.__composerSnapshots = [];
    window.__composerSnapshotsDone = false;
    const start = performance.now();
    const tick = (now: number) => {
      const animations = document.getAnimations();
      const stageAnimating = animations.some((animation) => 'animationName' in animation
        && String(animation.animationName).startsWith('atelier-view-in-'));
      for (const animation of animations) {
        const name = 'animationName' in animation ? String(animation.animationName) : '';
        if (name !== 'atelier-composer-in' && name !== 'atelier-composer-out') continue;
        const effect = animation.effect as KeyframeEffect | null;
        if (!effect?.pseudoElement) continue;
        const style = getComputedStyle(document.documentElement, effect.pseudoElement);
        const group = getComputedStyle(document.documentElement, effect.pseudoElement.replace(/^::view-transition-(?:new|old)/, '::view-transition-group'));
        window.__composerSnapshots?.push({
          name,
          opacity: Number(style.opacity),
          transform: style.transform,
          groupTransform: group.transform,
          width: Number.parseFloat(group.width),
          height: Number.parseFloat(group.height),
          stageAnimating,
          geometryAnimated: effect.getKeyframes().some((frame) => 'transform' in frame || 'width' in frame || 'height' in frame),
        });
      }
      if (now - start < ms) requestAnimationFrame(tick);
      else window.__composerSnapshotsDone = true;
    };
    requestAnimationFrame(tick);
  }, duration);
}

async function composerSnapshots(page: Page): Promise<ComposerSnapshot[]> {
  await page.waitForFunction(() => window.__composerSnapshotsDone === true);
  return page.evaluate(() => window.__composerSnapshots ?? []);
}

function isIdentity(transform: string): boolean {
  if (transform === 'none') return true;
  const values = /^matrix(?:3d)?\(([^)]+)\)$/.exec(transform)?.[1]?.split(',').map(Number);
  if (!values) return false;
  const identity = values.length === 16
    ? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    : [1, 0, 0, 1, 0, 0];
  return values.length === identity.length && values.every((value, index) => Math.abs(value - (identity[index] ?? 0)) < 1e-3);
}

/** No frame moved: identity transform throughout and one stable box. */
function expectStill(frames: Frame[], label: string): void {
  const shown = frames.filter((frame) => frame.present);
  expect(shown.length, `${label}: never rendered`).toBeGreaterThan(2);
  for (const frame of shown) {
    expect(isIdentity(frame.transform), `${label}: transform ${frame.transform} at ${frame.t.toFixed(0)}ms`).toBe(true);
  }
  const first = shown[0];
  if (!first) throw new Error(`${label}: no frames`);
  for (const frame of shown) {
    expect(Math.abs(frame.x - first.x), `${label}: x shifted at ${frame.t.toFixed(0)}ms`).toBeLessThan(0.5);
    expect(Math.abs(frame.y - first.y), `${label}: y shifted at ${frame.t.toFixed(0)}ms`).toBeLessThan(0.5);
    expect(Math.abs(frame.width - first.width), `${label}: width changed at ${frame.t.toFixed(0)}ms`).toBeLessThan(0.5);
    expect(Math.abs(frame.height - first.height), `${label}: height changed at ${frame.t.toFixed(0)}ms`).toBeLessThan(0.5);
  }
}

async function openPicker(page: Page): Promise<void> {
  await page.goto('/e2e/harness/index.html?case=picker');
  await page.getByRole('button', { name: 'Harness template' }).click();
  await expect(page.getByRole('button', { name: /^Advanced/ })).toBeVisible();
}

const AXIS_MENU = '[role="dialog"][data-axis-menu="true"]';
// The lazy Archive view's module request on the Vite dev server.
const ARCHIVE_CHUNK = /\/src\/components\/Archive\/index\.tsx(?:\?.*)?$/;

test.describe('motion polish continuity', () => {
  test('Advanced disclosure passes through intermediate geometry and reverses without remounting', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await openPicker(page);
    const toggle = page.getByRole('button', { name: /^Advanced/ });
    const panel = page.locator('[role="group"][aria-label="Advanced variables"]');
    await panel.evaluate((element) => { element.setAttribute('data-original-advanced', ''); });
    await startRecording(page, '[data-original-advanced]', 600);
    await toggle.click();
    const opening = await recordedFrames(page);
    const expandedHeight = opening.at(-1)?.height ?? 0;
    expect(expandedHeight).toBeGreaterThan(20);
    expect(opening.some((frame) => frame.height > 1 && frame.height < expandedHeight - 1)).toBe(true);
    await startRecording(page, '[data-original-advanced]', 700);
    await toggle.click();
    await page.waitForTimeout(60);
    await toggle.click();
    const reversing = await recordedFrames(page);
    expect(reversing.every((frame) => frame.present)).toBe(true);
    expect(reversing.some((frame) => frame.height > 1 && frame.height < expandedHeight - 1)).toBe(true);
    expect(Math.abs((reversing.at(-1)?.height ?? 0) - expandedHeight)).toBeLessThan(1);
    await toggle.click();
    await expect(panel).toHaveAttribute('inert', '');
    await expect(panel).toHaveAttribute('aria-hidden', 'true');
    await expect(page.getByRole('group', { name: 'Advanced variables' })).toHaveCount(0);
  });

  test('reduced motion changes Advanced geometry immediately without a translated entrance', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openPicker(page);
    await startRecording(page, '[role="group"][aria-label="Advanced variables"]', 250);
    await page.getByRole('button', { name: /^Advanced/ }).click();
    const frames = await recordedFrames(page);
    const expandedHeight = frames.at(-1)?.height ?? 0;
    expect(expandedHeight).toBeGreaterThan(20);
    for (const frame of frames) {
      expect(isIdentity(frame.transform)).toBe(true);
      expect(frame.height < 0.5 || Math.abs(frame.height - expandedHeight) < 0.5).toBe(true);
    }
  });

  // M2 (T10): the shared disclosure owner (styles/disclosure.module.css).
  test('Template editor Referenced lists interpolate and reverse without remounting', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/e2e/studio/index.html?view=prompts');
    const editor = page.getByRole('form', { name: /Edit template/ });
    const toggle = editor.getByRole('button', { name: /^Referenced lists, / });
    await expect(toggle).toBeVisible();
    const panelId = await toggle.getAttribute('aria-controls');
    if (!panelId) throw new Error('Referenced lists toggle names no panel');
    const panel = page.locator(`[id="${panelId}"]`);
    await expect(panel).toHaveAttribute('inert', '');
    await expect(panel).toHaveAttribute('aria-hidden', 'true');
    await panel.evaluate((element) => { element.setAttribute('data-original-refs', ''); });
    await startRecording(page, '[data-original-refs]', 600);
    await toggle.click();
    const opening = await recordedFrames(page);
    const expandedHeight = opening.at(-1)?.height ?? 0;
    expect(expandedHeight).toBeGreaterThan(20);
    expect(opening.some((frame) => frame.height > 1 && frame.height < expandedHeight - 1)).toBe(true);
    await startRecording(page, '[data-original-refs]', 700);
    await toggle.click();
    await page.waitForTimeout(60);
    await toggle.click();
    const reversing = await recordedFrames(page);
    // The same node throughout: the panel was never remounted.
    expect(reversing.every((frame) => frame.present)).toBe(true);
    expect(reversing.some((frame) => frame.height > 1 && frame.height < expandedHeight - 1)).toBe(true);
    expect(Math.abs((reversing.at(-1)?.height ?? 0) - expandedHeight)).toBeLessThan(1);
    await toggle.click();
    await expect(panel).toHaveAttribute('inert', '');
    await expect(panel).toHaveAttribute('aria-hidden', 'true');
  });

  test('Add provider preset hints grow the centred dialog through intermediate heights', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/e2e/studio/index.html?view=text-models&textAdmin=1&textProvider=1');
    await page.getByRole('button', { name: 'Add provider', exact: true }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Add a provider' });
    await expect(dialog).toBeVisible();
    // Let the card's own entrance settle before sampling.
    await page.waitForTimeout(400);
    await startRecording(page, 'dialog[open] > div', 600);
    // The radio is visually hidden inside its chip; the chip label takes the click.
    await dialog.getByText('Custom OpenAI-compatible', { exact: true }).click();
    await expect(dialog.getByRole('radio', { name: 'Custom OpenAI-compatible' })).toBeChecked();
    const frames = (await recordedFrames(page)).filter((frame) => frame.present);
    const first = frames[0];
    const last = frames.at(-1);
    if (!first || !last) throw new Error('no dialog frames');
    expect(last.height - first.height, 'the hints add height').toBeGreaterThan(20);
    // Before the disclosure the whole growth landed in one frame. The ease-out
    // disclosure (the house curve, steepest at its start) spreads it over
    // several frames: no single step carries most of it.
    const growth = last.height - first.height;
    const intermediate = new Set(frames
      .filter((frame) => frame.height > first.height + 1 && frame.height < last.height - 1)
      .map((frame) => Math.round(frame.height)));
    expect(intermediate.size, 'distinct intermediate heights').toBeGreaterThanOrEqual(3);
    // Measured in time, not frames, so a dropped frame on a loaded machine
    // cannot fail it: the height keeps changing for a real share of the
    // 240ms disclosure instead of landing at once.
    const moving = frames.filter((frame) => frame.height > first.height + 1 && frame.height < last.height - 1);
    const span = (moving.at(-1)?.t ?? 0) - (moving[0]?.t ?? 0);
    expect(growth, 'the hints add height').toBeGreaterThan(20);
    expect(span, 'ms spent between the closed and open heights').toBeGreaterThanOrEqual(80);
    // The centred card re-centres with its height on every frame, never in one step.
    for (const frame of frames) {
      expect(Math.abs((frame.y - first.y) + (frame.height - first.height) / 2)).toBeLessThan(1.5);
    }
  });

  for (const phone of [false, true]) {
    test(`empty artwork stays anchored while the ${phone ? 'phone' : 'desktop'} composer resizes`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1280, height: 800 });
      await page.goto('/e2e/studio/index.html?emptyHistory=1');
      const art = page.locator('[data-etching="empty-canvas"]');
      await expect(art).toBeVisible();
      if (phone) await page.getByRole('button', { name: 'Expand composer', exact: true }).click();
      await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill('A retained draft');
      await page.waitForTimeout(300);
      await startRecording(page, '[data-etching="empty-canvas"]', 600);
      await page.getByRole('button', { name: phone ? 'Collapse composer' : 'Minimize composer', exact: true }).click();
      expectStill(await recordedFrames(page), 'artwork during collapse');
      await startRecording(page, '[data-etching="empty-canvas"]', 600);
      await page.getByRole('button', { name: 'Expand composer', exact: true }).click();
      expectStill(await recordedFrames(page), 'artwork during expansion');
    });

    test(`the ${phone ? 'phone' : 'desktop'} composer edge follows its live footprint through reversal`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1280, height: 800 });
      await page.goto('/e2e/studio/index.html');
      if (phone) await page.getByRole('button', { name: 'Expand composer', exact: true }).click();
      await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill('A retained draft');
      await page.waitForTimeout(300);
      const expandedHeight = (await page.locator('#atelier-composer').boundingBox())?.height ?? 0;
      await startRecording(page, '#atelier-composer', 700);
      await page.getByRole('button', { name: phone ? 'Collapse composer' : 'Minimize composer', exact: true }).click();
      await page.waitForTimeout(60);
      await page.getByRole('button', { name: 'Expand composer', exact: true }).click();
      const frames = (await recordedFrames(page)).filter((frame) => frame.present);
      expect(frames.some((frame) => frame.height > 60 && frame.height < expandedHeight - 2)).toBe(true);
      for (const frame of frames) {
        expect(Math.abs((frame.edgeWidth ?? Number.NaN) - frame.width), `edge width at ${frame.t}ms`).toBeLessThan(1);
        expect(Math.abs((frame.edgeHeight ?? Number.NaN) - frame.height), `edge height at ${frame.t}ms`).toBeLessThan(1);
        expect(frame.edgeRadius).toBeGreaterThan(0);
        expect(frame.edgeBorder).toBeGreaterThan(0);
      }
      await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue('A retained draft');
    });
  }

  test('returning from managed views never repositions the empty artwork', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/e2e/studio/index.html?emptyHistory=1&textAdmin=1');
    const art = page.locator('[data-etching="empty-canvas"]');
    await expect(art).toBeVisible();
    const originalY = (await art.boundingBox())?.y ?? -1;
    for (const name of ['Archive', 'Prompt Library', 'Text models']) {
      await page.getByRole('button', { name, exact: true }).click();
      const back = page.getByRole('button', { name: 'Back to Unsorted', exact: true });
      await expect(back).toBeVisible();
      await startRecording(page, '[data-etching="empty-canvas"]', 700);
      await back.click();
      const frames = await recordedFrames(page);
      expectStill(frames, `artwork returning from ${name}`);
      for (const frame of frames.filter((candidate) => candidate.present)) {
        expect(Math.abs(frame.y - originalY)).toBeLessThan(0.5);
      }
    }
  });

  test('reduced motion switches phone composer geometry without a sheet slide', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/e2e/studio/index.html');
    await page.getByRole('button', { name: 'Expand composer', exact: true }).click();
    const prompt = page.getByRole('textbox', { name: 'Prompt', exact: true });
    await prompt.fill('A retained phone draft');
    await startRecording(page, '#atelier-composer', 200);
    await page.getByRole('button', { name: 'Collapse composer', exact: true }).click();
    const frames = (await recordedFrames(page)).filter((frame) => frame.present);
    expect(frames.every((frame) => isIdentity(frame.transform))).toBe(true);
    await expect(page.getByRole('button', { name: 'Expand composer', exact: true })).toBeFocused();
    expect(await page.locator('#atelier-composer textarea[aria-label="Prompt"]').inputValue()).toBe('A retained phone draft');
  });

  test('toast entrance approaches its final position monotonically', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/e2e/studio/index.html');
    await expect(page.getByTestId('feed')).toBeVisible();
    await page.waitForTimeout(500);
    await startRecording(page, '[data-monotonic-toast]', 600);
    await page.evaluate(async () => {
      const path = '/src/store/atelier.ts';
      const { useAtelierStore } = await import(/* @vite-ignore */ path) as { useAtelierStore: typeof AtelierStore };
      const observer = new MutationObserver(() => {
        const toast = Array.from(document.querySelectorAll('[role="status"]')).find((element) => element.textContent.includes('Monotonic landing'));
        if (toast) { toast.setAttribute('data-monotonic-toast', ''); observer.disconnect(); }
      });
      observer.observe(document.body, { subtree: true, childList: true });
      useAtelierStore.getState().addToast('Monotonic landing', 'success', 60_000, { label: 'Undo', onClick: () => undefined });
    });
    const frames = (await recordedFrames(page)).filter((frame) => frame.present);
    expect(frames.length).toBeGreaterThan(2);
    const finalY = frames.at(-1)?.y ?? 0;
    for (let index = 0; index < frames.length; index += 1) {
      expect(frames[index]?.y ?? 0).toBeGreaterThanOrEqual(finalY - 0.1);
      if (index > 0) expect((frames[index]?.y ?? 0) - (frames[index - 1]?.y ?? 0)).toBeLessThan(0.1);
    }
  });

  test('sidebar allocation and composer size pass through intermediate geometry and reverse', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/e2e/studio/index.html');
    await expect(page.getByTestId('feed')).toBeVisible();
    await startRecording(page, 'main', 600);
    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    const mainFrames = (await recordedFrames(page)).filter((frame) => frame.present);
    expect(mainFrames.some((frame) => frame.x > 2 && frame.x < 238)).toBe(true);
    expect(mainFrames.at(-1)?.x).toBeLessThan(1);
    await page.getByRole('button', { name: 'Expand sidebar' }).click();
    await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toBeVisible();

    // The sidebar press intentionally minimizes an empty desktop composer.
    const expandComposer = page.getByRole('button', { name: 'Expand composer', exact: true });
    if (await expandComposer.isVisible()) await expandComposer.click();
    const prompt = page.getByRole('textbox', { name: 'Prompt' });
    await prompt.fill('Keep the local form alive');
    await prompt.evaluate((element) => { element.setAttribute('data-original-prompt', ''); });
    const expandedHeight = await page.locator('#atelier-composer').evaluate((element) => element.getBoundingClientRect().height);
    await startRecording(page, '#atelier-composer', 700);
    await page.getByRole('button', { name: 'Minimize composer' }).click();
    const collapseFrames = (await recordedFrames(page)).filter((frame) => frame.present);
    expect(collapseFrames.some((frame) => frame.height > 58 && frame.height < expandedHeight - 2)).toBe(true);
    await expect(page.locator('[data-original-prompt]')).toHaveCount(1);
    expect(await page.locator('[data-original-prompt]').evaluate((element) => element.closest('[inert][aria-hidden="true"]') !== null)).toBe(true);
    await startRecording(page, '#atelier-composer', 650);
    await page.getByRole('button', { name: 'Expand composer', exact: true }).click();
    await page.waitForTimeout(60);
    await page.keyboard.press('Escape');
    const reversing = (await recordedFrames(page)).filter((frame) => frame.present);
    expect(reversing.some((frame) => frame.height > 58 && frame.height < expandedHeight - 2)).toBe(true);
    await expect(page.getByRole('button', { name: 'Expand composer', exact: true })).toBeFocused();
    expect(await page.locator('[data-original-prompt]').inputValue()).toBe('Keep the local form alive');
  });

  for (const phone of [false, true]) {
    test(`pending inventory reserves the ${phone ? 'phone compact' : 'desktop'} composer footprint`, async ({ page }) => {
      if (phone) await page.setViewportSize({ width: 390, height: 844 });
      await page.goto('/e2e/studio/index.html?modelsDelay=1200');
      await expect(page.getByRole('status').filter({ hasText: 'Loading models' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Retry loading models' })).toHaveCount(0);
      const pendingHeight = await page.locator('#atelier-composer').evaluate((element) => element.getBoundingClientRect().height);
      await expect(page.getByText('Loading models…', { exact: true })).toHaveCount(0);
      const settledHeight = await page.locator('#atelier-composer').evaluate((element) => element.getBoundingClientRect().height);
      expect(Math.abs(settledHeight - pendingHeight)).toBeLessThan(2);
    });
  }

  test('delayed images retain their mat and the viewer reserves its fitted frame', async ({ page }) => {
    let release: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/e2e/motion-image.svg?*', async (route) => {
      await ready;
      await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="960"><rect width="960" height="960" fill="#78949b"/></svg>' });
    });
    await page.goto('/e2e/studio/index.html?motionMedia=1');
    const image = page.locator('img[alt^="Generated image 1"]').first();
    await expect(image).toBeAttached();
    expect(await image.evaluate((element) => ({ complete: element instanceof HTMLImageElement && element.complete, opacity: Number(getComputedStyle(element).opacity) }))).toEqual({ complete: false, opacity: 0 });
    await page.getByRole('button', { name: 'Expand tile 1', exact: true }).first().click();
    const frame = page.locator('dialog [data-media="image"]').first();
    await expect(frame).toBeVisible();
    const viewerImage = page.locator('dialog img[alt^="Expanded generated image"]');
    await expect(viewerImage).toHaveCSS('opacity', '0');
    await page.waitForTimeout(450);
    const before = await frame.boundingBox();
    expect(before?.width).toBeGreaterThan(100);
    expect(before?.height).toBeGreaterThan(100);
    release();
    await expect(page.locator('dialog img[alt^="Expanded generated image"]')).toHaveJSProperty('complete', true);
    await page.waitForTimeout(550);
    const after = await frame.boundingBox();
    expect(Math.abs((after?.width ?? 0) - (before?.width ?? 0))).toBeLessThan(1);
    expect(Math.abs((after?.height ?? 0) - (before?.height ?? 0))).toBeLessThan(1);
    await expect(image).toHaveCSS('opacity', '1');
    await expect(viewerImage).toHaveCSS('opacity', '1');
  });

  test('Archive restore does not replay survivor entrances', async ({ page }) => {
    await page.goto('/e2e/harness/archive.html?count=18');
    await page.waitForTimeout(600);
    await page.evaluate(() => {
      document.body.dataset.survivorEntrances = '';
      document.addEventListener('animationstart', (event) => {
        if (/atelier-(tile|img)-in/.test(event.animationName)) document.body.dataset.survivorEntrances = (document.body.dataset.survivorEntrances ?? '') + event.animationName;
      });
    });
    await page.getByRole('button', { name: 'Restore', exact: true }).first().click();
    await page.waitForTimeout(700);
    expect(await page.locator('body').getAttribute('data-survivor-entrances')).toBe('');
    await expect(page.getByRole('button', { name: 'Open archived image: Archive fixture 1', exact: true })).toHaveCount(0);
    const opacities = await page.locator('img').evaluateAll((images) => images.map((image) => Number(getComputedStyle(image).opacity)));
    expect(opacities.every((opacity) => opacity === 1)).toBe(true);
  });

  for (const phone of [false, true]) {
    test(`an interrupted ${phone ? 'phone sheet' : 'dialog'} continues from its current pose`, async ({ page }) => {
      if (phone) await page.setViewportSize({ width: 390, height: 844 });
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.goto('/e2e/harness/index.html?case=motion-dialog');
      await startRecording(page, '[data-testid="motion-card"]', 700);
      const interruptions = await page.evaluate(async () => {
        interface Pose { opacity: number; scaleX: number; scaleY: number; x: number; y: number }
        const samples: { before: Pose; after: Pose; closing: boolean; pinnedAnimations: number }[] = [];
        const sample = async (button: string) => {
          const panel = document.querySelector<HTMLElement>('[data-testid="motion-card"]');
          if (!panel) throw new Error('missing motion card');
          const pose = (): Pose => {
            const style = getComputedStyle(panel);
            const matrix = new DOMMatrix(style.transform);
            return { opacity: Number(style.opacity), scaleX: matrix.a, scaleY: matrix.d, x: matrix.e, y: matrix.f };
          };
          const finiteAnimations = () => panel.getAnimations().filter((animation) => {
            const duration = Number(animation.effect?.getComputedTiming().activeDuration ?? 0);
            return animation.playState !== 'idle' && animation.playState !== 'finished' && Number.isFinite(duration) && duration > 0;
          });
          const running = finiteAnimations();
          const pinnedTimes = new Map<Animation, number>();
          for (const animation of running) {
            const duration = Number(animation.effect?.getComputedTiming().activeDuration ?? 0);
            const time = Math.min(50, duration / 4);
            animation.pause();
            animation.currentTime = time;
            pinnedTimes.set(animation, time);
          }
          await Promise.all(running.map((animation) => animation.ready));
          for (const [animation, time] of pinnedTimes) animation.currentTime = time;
          const before = pose();
          document.querySelector<HTMLButtonElement>(button)?.click();
          await Promise.resolve();
          // Flush the production retarget, then pin newly created transitions
          // at their starting pose. WebKit can otherwise advance compositor
          // time during style reads even within the same JavaScript tick.
          pose();
          const retargeted = finiteAnimations();
          for (const animation of retargeted) {
            animation.pause();
            animation.currentTime = pinnedTimes.get(animation) ?? 0;
          }
          await Promise.all(retargeted.map((animation) => animation.ready));
          for (const animation of retargeted) animation.currentTime = pinnedTimes.get(animation) ?? 0;
          samples.push({ before, after: pose(), closing: panel.dataset.closing === 'true', pinnedAnimations: running.length });
          for (const animation of new Set([...running, ...retargeted])) {
            if (animation.playState === 'paused') animation.play();
          }
        };
        const nextFrame = () => new Promise<void>((resolve) => { requestAnimationFrame(() => { resolve(); }); });
        document.querySelector<HTMLButtonElement>('#motion-open')?.click();
        await nextFrame();
        await sample('#motion-close');
        await nextFrame();
        await sample('#motion-reopen');
        return samples;
      });
      const frames = (await recordedFrames(page)).filter((frame) => frame.present);
      expect(interruptions).toHaveLength(2);
      expect(interruptions[0]?.closing).toBe(true);
      expect(interruptions[1]?.closing).toBe(false);
      for (const { before, after, pinnedAnimations } of interruptions) {
        expect(pinnedAnimations).toBeGreaterThan(0);
        expect(before.opacity).toBeGreaterThan(0);
        expect(before.opacity).toBeLessThan(0.98);
        expect(Math.abs(after.opacity - before.opacity), 'opacity must not reset on interruption').toBeLessThan(0.015);
        expect(Math.abs(after.scaleX - before.scaleX)).toBeLessThan(0.01);
        expect(Math.abs(after.scaleY - before.scaleY)).toBeLessThan(0.01);
        expect(Math.abs(after.x - before.x)).toBeLessThan(0.5);
        expect(Math.abs(after.y - before.y)).toBeLessThan(0.5);
      }
      await expect(page.getByRole('dialog', { name: 'Motion dialog' })).toBeVisible();
      expect(frames.at(-1)?.opacity).toBeGreaterThan(0.99);
    });
  }

  for (const fallback of [false, true]) {
    test(`toast host changes preserve DOM identity and settled motion${fallback ? ' through appendChild fallback' : ''}`, async ({ page }) => {
      if (fallback) await page.addInitScript(() => { Object.defineProperty(Element.prototype, 'moveBefore', { configurable: true, value: undefined }); });
      await page.goto('/e2e/studio/index.html?toast=1');
      const toast = page.getByRole('status').filter({ hasText: 'Preview ready' });
      await expect(toast).toBeVisible();
      await page.waitForTimeout(500);
      const original = await toast.elementHandle();
      await page.getByRole('button', { name: 'Templates', exact: true }).click();
      await expect(page.locator('[data-toast-host="contained"]')).toBeAttached();
      expect(await toast.evaluate((element, saved) => element === saved, original)).toBe(true);
      expect(isIdentity(await toast.evaluate((element) => getComputedStyle(element).transform))).toBe(true);
      await page.keyboard.press('Escape');
      await expect(page.locator('[data-toast-host="contained"]')).toHaveCount(0);
      expect(await toast.evaluate((element, saved) => element === saved, original)).toBe(true);
      expect(isIdentity(await toast.evaluate((element) => getComputedStyle(element).transform))).toBe(true);
    });
  }

  for (const fallback of [false, true]) {
  test(`a leaving toast retains exit progress when its modal host closes${fallback ? ' through appendChild fallback' : ''}`, async ({ page }) => {
    if (fallback) await page.addInitScript(() => { Object.defineProperty(Element.prototype, 'moveBefore', { configurable: true, value: undefined }); });
    await page.goto('/e2e/studio/index.html?toast=1');
    await page.getByRole('button', { name: 'Templates', exact: true }).click();
    await expect(page.locator('[data-toast-host="contained"]')).toBeAttached();
    const toast = page.getByRole('status').filter({ hasText: 'Preview ready' });
    await page.waitForTimeout(500);
    await expect(toast).toHaveCSS('opacity', '1');
    await toast.evaluate((element) => { element.setAttribute('data-motion-toast', ''); });
    await startRecording(page, '[data-motion-toast]', 500);
    await page.evaluate(async () => {
      const path = '/src/store/atelier.ts';
      const { useAtelierStore } = await import(/* @vite-ignore */ path) as { useAtelierStore: typeof AtelierStore };
      // Close the picker first. Begin the toast exit just before the picker's
      // delayed unmount, so reparenting happens halfway through the toast exit.
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      setTimeout(() => {
        const message = useAtelierStore.getState().toasts.find((item) => item.text === 'Preview ready');
        if (message) useAtelierStore.setState((state) => ({ toasts: state.toasts.map((item) => item.id === message.id ? { ...item, leaving: true } : item) }));
      }, 80);
    });
    const frames = (await recordedFrames(page)).filter((frame) => frame.present && frame.closing === 'true');
    expect(frames.length).toBeGreaterThan(2);
    for (let index = 2; index < frames.length; index += 1) {
      expect((frames[index]?.opacity ?? 0) - (frames[index - 1]?.opacity ?? 0), 'exit must not restart on host release').toBeLessThan(0.08);
    }
    expect(frames.at(-1)?.opacity).toBeLessThan(0.01);
  });
  }

  test('managed views retain the shared Back position', async ({ page }) => {
    const positions: number[] = [];
    for (const view of ['archive', 'prompts']) {
      await page.goto(`/e2e/studio/index.html?view=${view}`);
      const back = page.getByRole('button', { name: /Back/ }).first();
      await expect(back).toBeVisible();
      positions.push((await back.boundingBox())?.x ?? -1);
    }
    expect(Math.abs((positions[0] ?? -1) - (positions[1] ?? -1))).toBeLessThan(1);
  });
});

test('trusted touch dismissal retains its terminal image pose through exit', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'CDP trusted touch dispatch is Chromium-only; the remaining native motion matrix runs on WebKit.');
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    await page.goto('http://localhost:5173/e2e/harness/index.html?case=edit');
    await page.getByRole('button', { name: 'Expand tile 1', exact: true }).click();
    const image = page.locator('dialog img[alt^="Expanded generated image"]');
    await expect(image).toHaveJSProperty('complete', true);
    await page.waitForTimeout(450);
    const box = await image.boundingBox();
    if (!box) throw new Error('missing viewer image');
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 3;
    const cdp = await context.newCDPSession(page);
    await image.evaluate((element) => {
      element.addEventListener('pointerdown', (event) => { element.setAttribute('data-trusted-pointer', String(event.isTrusted)); }, { once: true });
    });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + 40, id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    await page.waitForTimeout(250);
    expect(isIdentity(await image.evaluate((element) => getComputedStyle(element).transform))).toBe(true);
    await expect(image).toHaveAttribute('data-trusted-pointer', 'true');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + 150, id: 1 }] });
    await page.waitForTimeout(30);
    await startRecording(page, 'dialog img[alt^="Expanded generated image"]', 350);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const frames = (await recordedFrames(page)).filter((frame) => frame.present);
    expect(frames.length).toBeGreaterThan(2);
    const translations = frames.map((frame) => {
      const values = /matrix(?:3d)?\(([^)]+)\)/.exec(frame.transform)?.[1]?.split(',').map(Number) ?? [];
      return values.length === 16 ? values[13] ?? 0 : values[5] ?? 0;
    });
    expect(Math.min(...translations)).toBeGreaterThan(140);
    await expect(page.getByRole('button', { name: 'Close lightbox' })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('pressed controls scale and ease back on release', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/e2e/studio/index.html');
  await expect(page.getByTestId('feed')).toBeVisible();
  // The press transition rests on each control, so the release animates too.
  const controls = [
    page.getByRole('button', { name: 'Collapse sidebar' }),
    page.getByRole('button', { name: 'Archive', exact: true }),
    page.getByRole('button', { name: 'API keys' }),
    page.getByRole('button', { name: /^Open batch:/ }).first(),
    page.getByRole('button', { name: 'Switch to dark theme' }),
    page.getByRole('button', { name: /^Pinned/ }),
    page.getByRole('button', { name: 'Expand composer' }),
  ];
  for (const control of controls) {
    const label = await control.getAttribute('aria-label') ?? '';
    const box = await control.boundingBox();
    if (!box) throw new Error(`missing ${label}`);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    // Let the press settle, then release away from the control so no click lands.
    await expect.poll(() => control.evaluate((element) => getComputedStyle(element).transform), { message: `${label} press` }).not.toBe('none');
    const pressed = await control.evaluate((element) => getComputedStyle(element).transform);
    expect(isIdentity(pressed), `${label} scales on press`).toBe(false);
    // Listen before releasing: a transitionrun for transform proves the
    // release animates, however late the check runs on a loaded machine.
    await control.evaluate((element) => {
      const target = element as HTMLElement & { releaseRan?: boolean };
      target.releaseRan = false;
      element.addEventListener('transitionrun', (event) => {
        if ((event as TransitionEvent).propertyName === 'transform') target.releaseRan = true;
      });
    });
    await page.mouse.move(1, 1);
    await page.mouse.up();
    await expect.poll(
      () => control.evaluate((element) => (element as HTMLElement & { releaseRan?: boolean }).releaseRan === true),
      { message: `${label} eases back on release` },
    ).toBe(true);
  }
});

test.describe('reduced motion holds every leak site still', () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
  });

  test('the menuShell popover fades in place', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?case=menu');
    await startRecording(page, '[role="menu"]', 300);
    await page.locator('#trigger').click();
    expectStill(await recordedFrames(page), 'menu popover');
  });

  test('the axis menu and its selection mark fade in place', async ({ page }) => {
    await openPicker(page);
    await page.getByRole('button', { name: /^Advanced/ }).click();
    await startRecording(page, `${AXIS_MENU} button[aria-pressed="true"] > span:last-child`, 300);
    await page.getByRole('button', { name: /Choose mood value/ }).click();
    expectStill(await recordedFrames(page), 'axis menu check');

    await page.keyboard.press('Escape');
    await expect(page.locator(AXIS_MENU)).toHaveCount(0);
    await startRecording(page, AXIS_MENU, 300);
    await page.getByRole('button', { name: /Choose mood value/ }).click();
    expectStill(await recordedFrames(page), 'axis menu');
  });

  test('the Advanced caret flips without rotating', async ({ page }) => {
    await openPicker(page);
    const toggle = page.getByRole('button', { name: /^Advanced/ });
    const before = await toggle.locator('svg').evaluate((svg) => getComputedStyle(svg).transform);
    await startRecording(page, '[aria-expanded] > svg', 300);
    await toggle.click();
    const frames = (await recordedFrames(page)).filter((frame) => frame.present);
    const after = await toggle.locator('svg').evaluate((svg) => getComputedStyle(svg).transform);
    expect(after).not.toBe(before);
    // Every frame shows either the resting or the flipped caret, never a
    // rotation in between.
    for (const frame of frames) expect([before, after]).toContain(frame.transform);
  });

  test('a button press does not scale', async ({ page }) => {
    await openPicker(page);
    const use = page.getByRole('button', { name: 'Use prompt' });
    const box = await use.boundingBox();
    if (!box) throw new Error('missing Use prompt');
    await use.evaluate((element) => { element.id = 'motion-press'; });
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await startRecording(page, '#motion-press', 200);
    await page.mouse.down();
    const frames = await recordedFrames(page);
    await page.mouse.move(0, 0);
    await page.mouse.up();
    expectStill(frames, 'pressed button');
  });

  test('the phone axis sheet fades instead of sliding', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openPicker(page);
    await page.getByRole('button', { name: /^Advanced/ }).click();
    await startRecording(page, AXIS_MENU, 300);
    await page.getByRole('button', { name: /Choose mood value/ }).click();
    expectStill(await recordedFrames(page), 'axis sheet');
  });

  test('a toast lands in place', async ({ page }) => {
    await page.goto('/e2e/studio/index.html');
    await expect(page.getByTestId('feed')).toBeVisible();
    // Raised after the shell settles, so only the toast's own motion counts.
    await page.waitForTimeout(500);
    await startRecording(page, '[data-motion-toast]', 300);
    await page.evaluate(async () => {
      const storePath = '/src/store/atelier.ts';
      const { useAtelierStore } = await import(/* @vite-ignore */ storePath) as { useAtelierStore: typeof AtelierStore };
      useAtelierStore.getState().addToast('Motion check', 'success', 60_000, { label: 'Undo', onClick: () => undefined });
      const mark = () => {
        const toast = Array.from(document.querySelectorAll('[role="status"]')).find((element) => element.textContent.includes('Motion check'));
        if (toast) toast.setAttribute('data-motion-toast', '');
        else requestAnimationFrame(mark);
      };
      mark();
    });
    expectStill(await recordedFrames(page), 'toast');
  });

  test('the Text models switch thumb jumps without travel', async ({ page }) => {
    await page.goto('/e2e/studio/index.html?view=text-models&textAdmin=1&textProvider=1');
    const toggle = page.getByRole('switch', { name: 'Use Preview writer' });
    await expect(toggle).toBeVisible();
    await toggle.evaluate((element) => { element.querySelector('span')?.setAttribute('id', 'motion-thumb'); });
    const rest = await page.locator('#motion-thumb').boundingBox();
    if (!rest) throw new Error('missing switch thumb');
    await startRecording(page, '#motion-thumb', 300);
    // The fixture is read only, so flip the checked state the thumb styles read.
    await toggle.evaluate((element) => { element.setAttribute('aria-checked', 'true'); });
    const frames = (await recordedFrames(page)).filter((frame) => frame.present);
    const landed = frames.at(-1);
    if (!landed) throw new Error('no thumb frames');
    expect(landed.x - rest.x).toBeGreaterThan(8);
    // Every frame is either the resting or the landed position, never travel.
    for (const frame of frames) {
      const atRest = Math.abs(frame.x - rest.x) < 0.5;
      const atEnd = Math.abs(frame.x - landed.x) < 0.5;
      expect(atRest || atEnd, `thumb travelled through x=${frame.x.toFixed(1)} at ${frame.t.toFixed(0)}ms`).toBe(true);
    }
  });

  test('the composer source still is not blurred while composing', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?case=frontend-i2v');
    await page.evaluate(async () => {
      const storePath = '/src/store/atelier.ts';
      const { useAtelierStore } = await import(/* @vite-ignore */ storePath) as { useAtelierStore: typeof AtelierStore };
      const state = useAtelierStore.getState();
      state.setComposerExpanded(true);
      state.setDraft({ i2vSourceUploadId: '00000000-0000-4000-8000-0000000000aa' });
      state.beginResolving();
    });
    const still = page.locator('[data-composing="true"] img');
    await expect(still).toHaveCount(1);
    const filter = await still.evaluate((element) => getComputedStyle(element).filter);
    expect(filter === 'none' || /^blur\(0(?:px)?\)$/.test(filter), `source still filter ${filter}`).toBe(true);
  });

  test('the lazy loader pulses instead of spinning', async ({ page }) => {
    // Hold the Lightbox chunk so its loader stays up long enough to sample.
    await page.route(/\/src\/components\/Lightbox\/index\.tsx(?:\?.*)?$/, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue();
    });
    await page.goto('/e2e/studio/index.html');
    await page.getByRole('button', { name: 'Expand tile 1' }).first().click();
    const loader = page.getByRole('status').filter({ hasText: 'Loading image viewer' });
    await expect(loader).toBeVisible();
    await loader.locator('span').first().evaluate((spinner) => { spinner.id = 'motion-spinner'; });
    await startRecording(page, '#motion-spinner', 400);
    const frames = await recordedFrames(page);
    expectStill(frames, 'loader');
    // It still signals progress: the pulse changes its opacity.
    const opacities = new Set(frames.filter((frame) => frame.present).map((frame) => frame.opacity.toFixed(2)));
    expect(opacities.size).toBeGreaterThan(1);
  });
});

test.describe('overlays play their exit before unmounting', () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  });

  /** The overlay stays mounted with data-closing for about --dur-overlay. */
  function expectExit(frames: Frame[], label: string): void {
    const closingAt = frames.find((frame) => frame.present && frame.closing === 'true')?.t;
    expect(closingAt, `${label}: never stamped data-closing`).toBeDefined();
    const goneAt = frames.find((frame) => closingAt !== undefined && frame.t > closingAt && !frame.present)?.t;
    expect(goneAt, `${label}: never unmounted`).toBeDefined();
    if (closingAt === undefined || goneAt === undefined) return;
    // 160ms token; one frame of slack on either side.
    expect(goneAt - closingAt, `${label}: exit too short`).toBeGreaterThan(120);
    expect(goneAt - closingAt, `${label}: exit too long`).toBeLessThan(400);
    // The panel fades as it leaves.
    const fading = frames.filter((frame) => frame.present && frame.closing === 'true');
    expect(Math.min(...fading.map((frame) => frame.opacity)), `${label}: did not fade`).toBeLessThan(1);
  }

  test('the axis menu', async ({ page }) => {
    await openPicker(page);
    await page.getByRole('button', { name: /^Advanced/ }).click();
    await page.getByRole('button', { name: /Choose mood value/ }).click();
    await expect(page.locator(AXIS_MENU)).toBeVisible();
    await page.waitForTimeout(300);
    await startRecording(page, AXIS_MENU, 700);
    await page.keyboard.press('Escape');
    expectExit(await recordedFrames(page), 'axis menu');
    // Only the axis menu closed; the picker stays.
    await expect(page.getByRole('button', { name: 'Use prompt' })).toBeVisible();
  });

  test('the prompt library help panel', async ({ page }) => {
    await page.goto('/e2e/studio/index.html?view=prompts');
    await page.getByRole('button', { name: 'How the Prompt Library works' }).click();
    const panel = page.getByRole('dialog', { name: 'How the Prompt Library works' });
    await expect(panel).toBeVisible();
    await page.waitForTimeout(300);
    await startRecording(page, '[role="dialog"][data-mobile]', 700);
    await page.keyboard.press('Escape');
    expectExit(await recordedFrames(page), 'help panel');
  });

  test('the phone help scrim fades out with the sheet', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/e2e/studio/index.html?view=prompts');
    await page.getByRole('button', { name: 'How the Prompt Library works' }).click();
    await expect(page.getByRole('dialog', { name: 'How the Prompt Library works' })).toBeVisible();
    await page.waitForTimeout(400);
    const scrim = page.getByRole('button', { name: 'Close help' }).first();
    await scrim.evaluate((element) => { element.id = 'motion-scrim'; });
    await startRecording(page, '#motion-scrim', 700);
    await page.mouse.click(195, 40);
    expectExit(await recordedFrames(page), 'help scrim');
  });
});

test.describe('view navigation', () => {
  test('the composer independently fades on managed navigation and stays live during edits and feed swaps', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/e2e/studio/index.html');
    const prompt = page.getByRole('textbox', { name: 'Prompt', exact: true });
    await prompt.fill('A retained navigation draft');
    await page.waitForTimeout(300);
    const supported = await page.evaluate(() => 'startViewTransition' in document);
    const before = await page.locator('#atelier-composer').boundingBox();
    if (!before) throw new Error('Missing composer before navigation');

    await recordComposerSnapshots(page);
    await page.getByRole('button', { name: 'Archive', exact: true }).click();
    const leaving = await composerSnapshots(page);
    await expect(page.locator('#atelier-composer')).toHaveCount(0);
    await recordComposerSnapshots(page);
    await page.getByRole('button', { name: 'Back to Unsorted', exact: true }).click();
    const entering = await composerSnapshots(page);
    await expect(prompt).toHaveValue('A retained navigation draft');

    if (supported) {
      for (const [frames, name] of [[leaving, 'atelier-composer-out'], [entering, 'atelier-composer-in']] as const) {
        expect(frames.length, name).toBeGreaterThan(2);
        expect(frames.some((frame) => frame.opacity > 0.05 && frame.opacity < 0.95), `${name} intermediate opacity`).toBe(true);
        expect(frames.some((frame) => frame.stageAnimating), `${name} alongside view stage`).toBe(true);
        for (const frame of frames) {
          expect(frame.name).toBe(name);
          expect(isIdentity(frame.transform)).toBe(true);
          expect(frame.geometryAnimated).toBe(false);
          expect(frame.groupTransform).toBe(frames[0]?.groupTransform);
          expect(Math.abs(frame.width - before.width)).toBeLessThan(1);
          expect(Math.abs(frame.height - before.height)).toBeLessThan(1);
        }
      }
    }

    await recordComposerSnapshots(page);
    await prompt.fill('An ordinary prompt edit');
    expect(await composerSnapshots(page)).toEqual([]);
    await recordComposerSnapshots(page);
    await page.getByRole('button', { name: /^Pinned \d/ }).click();
    expect(await composerSnapshots(page)).toEqual([]);
    await expect(prompt).toHaveValue('An ordinary prompt edit');
  });

  test('the stage dims at once and the next view enters through the view transition', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    // An artificially slow destination: the Archive chunk is held, so the
    // deferred stage stays pending long enough to observe.
    await page.route(ARCHIVE_CHUNK, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      await route.continue();
    });
    await page.goto('/e2e/studio/index.html');
    await expect(page.getByTestId('feed')).toBeVisible();
    const supported = await page.evaluate(() => 'startViewTransition' in document);

    await page.evaluate(() => {
      interface NavFrame { t: number; requested: boolean; pending: boolean; stageOpacity: number | null; viewAnimations: string[] }
      const frames: NavFrame[] = [];
      (window as unknown as { __navFrames: NavFrame[] }).__navFrames = frames;
      const archive = document.querySelector('button[aria-label="Archive"]');
      if (!archive) throw new Error('missing Archive nav');
      let clickedAt: number | null = null;
      archive.addEventListener('click', () => { clickedAt = performance.now(); }, { capture: true, once: true });
      const tick = (now: number) => {
        if (clickedAt !== null) {
          const stage = document.querySelector('[data-testid="feed"]');
          frames.push({
            t: now - clickedAt,
            requested: archive.getAttribute('aria-current') === 'page',
            pending: document.querySelector('[data-view-pending="true"]') !== null,
            stageOpacity: stage ? Number(getComputedStyle(stage).opacity) : null,
            viewAnimations: document.getAnimations()
              .map((animation) => {
                const effect = animation.effect as KeyframeEffect | null;
                const name = 'animationName' in animation ? (animation as CSSAnimation).animationName : '';
                return effect?.pseudoElement ? `${effect.pseudoElement} ${name}` : '';
              })
              .filter(Boolean),
          });
        }
        if (clickedAt === null || now - clickedAt < 1500) requestAnimationFrame(tick);
        else (window as unknown as { __navDone: boolean }).__navDone = true;
      };
      requestAnimationFrame(tick);
    });

    await page.getByRole('button', { name: 'Archive', exact: true }).click();
    // Navigation stays usable while the stage is pending.
    await expect(page.getByRole('button', { name: 'Archive', exact: true })).toHaveAttribute('aria-current', 'page');
    await page.waitForFunction(() => (window as unknown as { __navDone?: boolean }).__navDone === true);
    const frames = await page.evaluate(() => (window as unknown as { __navFrames: { t: number; requested: boolean; pending: boolean; stageOpacity: number | null; viewAnimations: string[] }[] }).__navFrames);

    // The nav selection moves at once and the pending treatment shows in the
    // first frame after the click.
    const first = frames[0];
    expect(first?.requested).toBe(true);
    expect(first?.pending).toBe(true);
    expect(first?.stageOpacity ?? 1).toBeLessThan(1);
    // It really was pending for a while (the held chunk), and no frame after
    // the nav change showed the old stage undimmed.
    expect(frames.filter((frame) => frame.pending).length).toBeGreaterThan(5);
    for (const frame of frames.filter((candidate) => candidate.pending)) {
      expect(frame.stageOpacity ?? 0, `undimmed stale stage at ${frame.t.toFixed(0)}ms`).toBeLessThan(1);
    }
    // The destination mounted.
    await expect(page.getByTestId('feed').getByTestId('canvas-scroller')).toHaveCount(0);
    expect(frames.some((frame) => !frame.pending)).toBe(true);

    if (supported) {
      const animations = frames.flatMap((frame) => frame.viewAnimations);
      expect(animations.some((entry) => entry.startsWith('::view-transition-new') && entry.includes('atelier-view-in-deeper'))).toBe(true);
      expect(animations.some((entry) => entry.startsWith('::view-transition-old') && entry.includes('atelier-fade-out'))).toBe(true);
    }
  });
});

test.describe('scroll-edge fades and rail entrance gating', () => {
  const RAIL = '[data-testid="sidebar-feed"]';
  const CANVAS = '[data-virtualized="canvas"]';

  /** The first opaque stop of the scroller's computed mask, and whether the bottom edge fades. */
  async function maskStops(page: Page, selector: string): Promise<{ top: string; bottomFades: boolean }> {
    return page.evaluate((target) => {
      const node = document.querySelector(target);
      const element = node?.matches('[data-virtualized="canvas"]') ? node.closest('[role="region"]') : node;
      if (!element) throw new Error(`missing ${target}`);
      const style = getComputedStyle(element);
      const mask = style.maskImage || style.getPropertyValue('-webkit-mask-image');
      const top = /rgb\(0, 0, 0\) ([^,)]+(?:\))?)/.exec(mask)?.[1] ?? mask;
      return { top: top.trim(), bottomFades: mask.includes('calc(100% - 14px)') && /transparent 100%|rgba\(0, 0, 0, 0\) 100%/.test(mask) };
    }, selector);
  }

  async function scrollTo(page: Page, selector: string, top: number): Promise<void> {
    await page.evaluate(({ target, value }) => new Promise<void>((resolve) => {
      const node = document.querySelector(target);
      const element = node?.matches('[data-virtualized="canvas"]') ? node.closest('[role="region"]') : node;
      if (!element) throw new Error(`missing ${target}`);
      element.scrollTop = value;
      requestAnimationFrame(() => { requestAnimationFrame(() => { resolve(); }); });
    }), { target: selector, value: top });
  }

  /** Walks the scroller to `top` in viewport-sized steps so every row in between mounts. */
  async function walk(page: Page, selector: string, to: 'top' | 'bottom'): Promise<void> {
    const { height, max, start } = await page.evaluate((target) => {
      const element = document.querySelector(target);
      if (!element) throw new Error(`missing ${target}`);
      return { height: element.clientHeight, max: element.scrollHeight - element.clientHeight, start: element.scrollTop };
    }, selector);
    expect(max, `${selector} overflows`).toBeGreaterThan(height);
    const end = to === 'top' ? 0 : max;
    const step = (to === 'top' ? -1 : 1) * Math.max(80, Math.floor(height / 2));
    for (let top = start; to === 'top' ? top > end : top < end; top += step) await scrollTo(page, selector, top);
    await scrollTo(page, selector, end);
  }

  test('scrolling the rail up and down replays no row entrance', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/e2e/studio/index.html?batches=40');
    await expect(page.locator(`${RAIL} button[aria-label^="Open batch"]`).first()).toBeVisible();
    // First pass mounts every row once (each plays its one entrance).
    await walk(page, RAIL, 'top');
    await walk(page, RAIL, 'bottom');
    await page.waitForTimeout(600);
    await page.evaluate(() => {
      document.body.dataset.railEntrances = '';
      document.addEventListener('animationstart', (event) => {
        if (event.animationName === 'atelier-drop-in' && (event.target as Element).closest('[data-testid="sidebar-feed"]')) {
          document.body.dataset.railEntrances = `${document.body.dataset.railEntrances ?? ''}|${event.animationName}`;
        }
      });
    });
    await walk(page, RAIL, 'top');
    await walk(page, RAIL, 'bottom');
    expect(await page.locator('body').getAttribute('data-rail-entrances')).toBe('');
    const running = await page.locator(`${RAIL} button[aria-label^="Open batch"]`).evaluateAll((rows) => rows.flatMap((row) => row.getAnimations()).length);
    expect(running).toBe(0);
    const seen = await page.locator(`${RAIL} button[aria-label^="Open batch"]`).evaluateAll((rows) => rows.every((row) => row.getAttribute('data-seen') === 'true'));
    expect(seen).toBe(true);
  });

  test('the rail and feed masks open the top edge at rest and fade it once scrolled', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/e2e/studio/index.html?batches=40');
    await expect(page.locator(`${RAIL} button[aria-label^="Open batch"]`).first()).toBeVisible();
    await expect(page.locator(`${CANVAS} section[data-batch-id]`).first()).toBeVisible();
    for (const selector of [RAIL, CANVAS]) {
      await scrollTo(page, selector, 0);
      const rest = await maskStops(page, selector);
      expect(rest.top, `${selector} at rest`).toBe('0px');
      expect(rest.bottomFades, `${selector} bottom edge fades`).toBe(true);
      await scrollTo(page, selector, 14);
      const partway = Number.parseFloat((await maskStops(page, selector)).top);
      expect(partway, `${selector} halfway through the range`).toBeGreaterThan(0);
      expect(partway, `${selector} halfway through the range`).toBeLessThan(14);
      await scrollTo(page, selector, 40);
      const scrolled = await maskStops(page, selector);
      expect(scrolled.top, `${selector} scrolled`).toBe('14px');
      expect(scrolled.bottomFades, `${selector} bottom edge fades when scrolled`).toBe(true);
    }
  });
});

/*
 * T8a: grid reflow, batch removal and tile exits run through React
 * <ViewTransition> (motion.css .tile-move / .tile-exit / .tile-enter). Motion
 * is read on the view-transition pseudo-elements, sampled per animation
 * frame on the page's own clock; live boxes give the final geometry and are
 * asserted separately. Feed tiles and batch rows carry React's own names, so
 * a tracked element's name is read off the inline `view-transition-name`
 * React stamps on it while the transition captures; Archive tiles are named
 * `tile-<id>`.
 */
type VtTarget = { name: string } | { selector: string; img?: string };

interface VtFrame {
  t: number;
  /** `<pseudo> <animationName>` per running view-transition animation; tracked names read as `{key}`. */
  animations: string[];
  /** Computed transform of each tracked key's `::view-transition-group`. */
  groups: Record<string, string>;
  /** Live boxes of `live` selectors (null when absent). */
  live: Record<string, { x: number; y: number; width: number; height: number } | null>;
}

declare global {
  interface Window {
    __vtFrames?: VtFrame[];
    __vtDone?: boolean;
  }
}

async function recordVt(page: Page, track: Record<string, VtTarget>, live: Record<string, string> = {}, ms = 900): Promise<void> {
  await page.evaluate(({ track: targets, live: selectors, ms: duration }) => {
    const names: Record<string, string> = {};
    for (const [key, target] of Object.entries(targets)) if ('name' in target) names[key] = target.name;
    const matches = (element: Element, target: VtTarget) => 'selector' in target
      && element.matches(target.selector)
      && (target.img === undefined || element.querySelector('img')?.getAttribute('src') === target.img);
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const element = record.target;
        if (!(element instanceof HTMLElement)) continue;
        const name = element.style.viewTransitionName;
        if (!name || name === 'none') continue;
        for (const [key, target] of Object.entries(targets)) if (matches(element, target)) names[key] = name;
      }
    });
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['style'] });
    const raw: { t: number; animations: string[]; transforms: Record<string, string>; live: VtFrame['live'] }[] = [];
    window.__vtDone = false;
    const start = performance.now();
    const tick = (now: number) => {
      const animations = document.getAnimations().flatMap((animation) => {
        const effect = animation.effect as KeyframeEffect | null;
        const pseudo = effect?.pseudoElement ?? '';
        // React parks a boundary it decided not to animate with a 0ms
        // opacity-0 animation of its own; that is not motion.
        if (!pseudo.startsWith('::view-transition') || effect?.getComputedTiming().duration === 0) return [];
        const name = 'animationName' in animation ? (animation as CSSAnimation).animationName : '';
        return [`${pseudo} ${name}`];
      });
      const transforms: Record<string, string> = {};
      for (const name of new Set(animations.map((entry) => /^::view-transition-group\(([^)]+)\)/.exec(entry)?.[1]).filter((name): name is string => !!name))) {
        transforms[name] = getComputedStyle(document.documentElement, `::view-transition-group(${name})`).transform;
      }
      const boxes: VtFrame['live'] = {};
      for (const [key, selector] of Object.entries(selectors)) {
        const element = document.querySelector(selector);
        if (!element) { boxes[key] = null; continue; }
        const { x, y, width, height } = element.getBoundingClientRect();
        boxes[key] = { x, y, width, height };
      }
      raw.push({ t: now - start, animations, transforms, live: boxes });
      if (now - start < duration) { requestAnimationFrame(tick); return; }
      observer.disconnect();
      const byName = new Map(Object.entries(names).map(([key, name]) => [name, key]));
      window.__vtFrames = raw.map((frame) => ({
        t: frame.t,
        animations: frame.animations.map((entry) => entry.replace(/\(([^)]+)\)/, (whole, name: string) => (byName.has(name) ? `({${byName.get(name) ?? ''}})` : whole))),
        groups: Object.fromEntries(Object.entries(names).map(([key, name]) => [key, frame.transforms[name] ?? 'none'])),
        live: frame.live,
      }));
      window.__vtDone = true;
    };
    requestAnimationFrame(tick);
  }, { track, live, ms });
}

async function vtFrames(page: Page): Promise<VtFrame[]> {
  await page.waitForFunction(() => window.__vtDone === true);
  return page.evaluate(() => window.__vtFrames ?? []);
}

/** Frames in which the tracked key's group is animating. */
function groupFrames(frames: readonly VtFrame[], key: string): VtFrame[] {
  return frames.filter((frame) => frame.animations.some((entry) => entry.startsWith(`::view-transition-group({${key}}) `)));
}

/** Distinct group transforms while it animates, excluding its final value. */
function intermediateTransforms(frames: readonly VtFrame[], key: string): string[] {
  const values = groupFrames(frames, key).map((frame) => frame.groups[key] ?? 'none');
  const final = values[values.length - 1];
  return [...new Set(values)].filter((value) => value !== final && value !== 'none');
}

/** Whether `::view-transition-<part>({key})` ran `animationName`. */
function ran(frames: readonly VtFrame[], part: 'group' | 'old' | 'new', key: string, animationName: string): boolean {
  return frames.some((frame) => frame.animations.includes(`::view-transition-${part}({${key}}) ${animationName}`));
}

const FEED_BATCH = (id: string) => `[data-testid="canvas-scroller"] section[data-batch-id="${id}"]`;
const FEED_ROW = (id: string) => `[data-testid="canvas-scroller"] [data-index][data-batch-id="${id}"]`;
const GRID = (id: string) => `${FEED_BATCH(id)} [data-testid="batch-grid"]`;

async function tileImages(page: Page, batchId: string): Promise<string[]> {
  return page.locator(`${GRID(batchId)} > * img`).evaluateAll((images) => images.map((image) => image.getAttribute('src') ?? ''));
}

/** The studio feed with an in-memory archive, opened twice so its batches are seen at mount. */
async function openWritableFeed(page: Page, extra = 2): Promise<void> {
  await page.setViewportSize({ width: 1024, height: 768 });
  // Twice: the app rewrites the URL, so a reload would drop the fixture flags.
  const url = `/e2e/studio/index.html?writable=1&batches=${String(extra)}`;
  await page.goto(url);
  await expect(page.locator(FEED_BATCH('studio-batch-4'))).toBeVisible();
  await page.waitForTimeout(500);
  await page.goto(url);
  await expect(page.locator(FEED_BATCH('studio-batch-4'))).toBeVisible();
  // Settle the composer first: a pointerdown outside it minimizes it, and
  // that resize scrolls the feed between a later click's down and up.
  await page.getByTestId('canvas-scroller').click({ position: { x: 4, y: 4 } });
  await page.waitForTimeout(700);
}

test.describe('grid reflow and tile exits (React ViewTransition)', () => {
  test('archiving one of two tiles moves the survivor through its group and Undo reverses it', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await openWritableFeed(page);
    const supported = await page.evaluate(() => 'startViewTransition' in document);
    const batch = page.locator(FEED_BATCH('studio-batch-4'));
    const [removedImg, survivorImg] = await tileImages(page, 'studio-batch-4');
    const tiles = {
      removed: { selector: `${GRID('studio-batch-4')} > *`, img: removedImg ?? '' },
      survivor: { selector: `${GRID('studio-batch-4')} > *`, img: survivorImg ?? '' },
    };
    await batch.locator('[data-testid="batch-grid"] > :first-child').hover();

    await recordVt(page, tiles, { survivor: `${GRID('studio-batch-4')} > :first-child` });
    await batch.getByRole('button', { name: 'Archive tile' }).first().click();
    const archive = await vtFrames(page);
    await expect(page.locator(GRID('studio-batch-4'))).toHaveAttribute('data-tile-count', '1');
    const settled = await page.locator(`${GRID('studio-batch-4')} > :first-child`).boundingBox();
    if (!settled) throw new Error('survivor missing');

    if (supported) {
      expect(ran(archive, 'old', 'removed', 'atelier-shrink-out')).toBe(true);
      const moving = groupFrames(archive, 'survivor');
      expect(moving.length).toBeGreaterThan(3);
      expect(intermediateTransforms(archive, 'survivor').length).toBeGreaterThanOrEqual(3);
      // The live element already holds the final grid while its group moves.
      const firstMoving = moving[0]?.live.survivor;
      expect(firstMoving).toBeTruthy();
      expect(Math.abs((firstMoving?.x ?? 0) - settled.x)).toBeLessThan(1);
      expect(Math.abs((firstMoving?.width ?? 0) - settled.width)).toBeLessThan(1);
    }

    await page.waitForTimeout(300);
    await recordVt(page, tiles, {}, 1400);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.locator(GRID('studio-batch-4'))).toHaveAttribute('data-tile-count', '2');
    const undo = await vtFrames(page);
    if (supported) {
      expect(ran(undo, 'new', 'removed', 'atelier-tile-in')).toBe(true);
      expect(intermediateTransforms(undo, 'survivor').length).toBeGreaterThanOrEqual(3);
    }
  });

  for (const action of ['Restore', 'Delete permanently'] as const) {
    test(`Archive ${action} across a virtual-row boundary moves the next row's first tile as one shared group`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.setViewportSize({ width: 1024, height: 768 });
      await page.goto('/e2e/harness/archive.html?count=18');
      await page.waitForTimeout(600);
      const supported = await page.evaluate(() => 'startViewTransition' in document);
      // Columns per virtual row, read from the rendered grid.
      const columns = await page.locator('[data-virtualized="archive"] > [data-index="0"]').evaluate((row) => row.children.length);
      expect(columns).toBeGreaterThanOrEqual(2);
      const moverFrame = `Open archived image: Archive fixture ${String(columns + 1)}`;
      const before = await page.getByRole('button', { name: moverFrame, exact: true }).boundingBox();

      await recordVt(page, { removed: { name: 'tile-archive-0' }, mover: { name: `tile-archive-${String(columns)}` } });
      if (action === 'Restore') {
        await page.getByRole('button', { name: 'Restore', exact: true }).first().click();
      } else {
        await page.getByRole('button', { name: 'Delete permanently', exact: true }).first().click();
        await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
      }
      const frames = await vtFrames(page);
      await expect(page.getByRole('button', { name: 'Open archived image: Archive fixture 1', exact: true })).toHaveCount(0);
      const after = await page.getByRole('button', { name: moverFrame, exact: true }).boundingBox();
      // It really changed rows: up one row, into the last column.
      expect(after?.y ?? 0).toBeLessThan((before?.y ?? 0) - 10);
      expect(after?.x ?? 0).toBeGreaterThan((before?.x ?? 0) + 10);

      if (supported) {
        expect(ran(frames, 'old', 'removed', 'atelier-shrink-out')).toBe(true);
        // One group carried old and new across the row change (share), never
        // an exit plus an enter.
        expect(intermediateTransforms(frames, 'mover').length).toBeGreaterThanOrEqual(3);
        expect(ran(frames, 'old', 'mover', 'atelier-shrink-out')).toBe(false);
        expect(frames.some((frame) => frame.animations.some((entry) => entry.includes('atelier-tile-in')))).toBe(false);
      }
    });
  }

  test('archiving a whole batch and the last tile of another removes their rows and moves the rows below up', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await openWritableFeed(page, 3);
    const supported = await page.evaluate(() => 'startViewTransition' in document);

    // Whole-batch archive of a middle row: the rows after it move up.
    const middle = page.locator(FEED_BATCH('studio-extra-2'));
    await middle.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const belowBefore = await page.locator(FEED_BATCH('studio-extra-3')).boundingBox();
    await recordVt(page, { removed: { selector: FEED_ROW('studio-extra-2') }, below: { selector: FEED_ROW('studio-extra-3') } });
    await middle.getByRole('button', { name: 'Archive batch' }).click();
    const batchFrames = await vtFrames(page);
    await expect(page.locator(FEED_BATCH('studio-extra-2'))).toHaveCount(0);
    const belowAfter = await page.locator(FEED_BATCH('studio-extra-3')).boundingBox();
    expect(belowAfter?.y ?? 0).toBeLessThan((belowBefore?.y ?? 0) - 50);
    if (supported) {
      expect(ran(batchFrames, 'old', 'removed', 'atelier-shrink-out')).toBe(true);
      expect(intermediateTransforms(batchFrames, 'below').length).toBeGreaterThanOrEqual(3);
    }
    await page.waitForTimeout(600);

    // Archiving both tiles of another batch: the second is its last tile, so
    // the batch row itself exits and the row below moves up.
    const target = page.locator(FEED_BATCH('studio-extra-1'));
    await target.scrollIntoViewIfNeeded();
    await target.locator('[data-testid="batch-grid"] > :first-child').hover();
    await target.getByRole('button', { name: 'Archive tile' }).first().click();
    await expect(target.locator('[data-testid="batch-grid"]')).toHaveAttribute('data-tile-count', '1');
    await page.waitForTimeout(800);
    await target.locator('[data-testid="batch-grid"] > :first-child').hover();
    await recordVt(page, { removed: { selector: FEED_ROW('studio-extra-1') }, below: { selector: FEED_ROW('studio-extra-3') } });
    await target.getByRole('button', { name: 'Archive tile' }).first().click();
    const lastTileFrames = await vtFrames(page);
    await expect(page.locator(FEED_BATCH('studio-extra-1'))).toHaveCount(0);
    if (supported) {
      expect(ran(lastTileFrames, 'old', 'removed', 'atelier-shrink-out')).toBe(true);
      expect(intermediateTransforms(lastTileFrames, 'below').length).toBeGreaterThanOrEqual(3);
    }
  });

  test('archiving the last batch of a scope plays the feed exit, then the empty state enters', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await openWritableFeed(page);
    const supported = await page.evaluate(() => 'startViewTransition' in document);
    // Moodboards holds one batch.
    await page.getByRole('button', { name: /^Moodboards/ }).click();
    const only = page.locator(FEED_BATCH('studio-batch-3'));
    await expect(only).toBeVisible();
    await page.waitForTimeout(800);
    await recordVt(page, {
      column: { selector: '[data-testid="canvas-scroller"] > :has([data-virtualized="canvas"])' },
      empty: { selector: '[data-testid="canvas-scroller"] > :not(:has([data-virtualized="canvas"]))' },
    });
    await only.getByRole('button', { name: 'Archive batch' }).click();
    const frames = await vtFrames(page);
    await expect(page.getByText('What would you like to make?')).toBeVisible();
    await expect(page.locator(FEED_BATCH('studio-batch-3'))).toHaveCount(0);
    if (supported) {
      expect(ran(frames, 'old', 'column', 'atelier-shrink-out'), anyVt(frames).join('\n')).toBe(true);
      expect(ran(frames, 'new', 'empty', 'atelier-drop-in'), anyVt(frames).join('\n')).toBe(true);
    }
  });

  test('rapid archives queue behind the running transition and the next view swap still plays', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const errors: string[] = [];
    page.on('pageerror', (error) => { errors.push(error.message); });
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await openWritableFeed(page, 2);
    const supported = await page.evaluate(() => 'startViewTransition' in document);
    const first = page.locator(FEED_BATCH('studio-batch-4'));
    const second = page.locator(FEED_BATCH('studio-extra-2'));
    const [firstImg] = await tileImages(page, 'studio-batch-4');
    const [secondImg] = await tileImages(page, 'studio-extra-2');
    await recordVt(page, {
      a: { selector: `${GRID('studio-batch-4')} > *`, img: firstImg ?? '' },
      b: { selector: `${GRID('studio-extra-2')} > *`, img: secondImg ?? '' },
    }, {}, 1400);
    // Two archives 50ms apart on the page's own clock, then a view switch.
    await page.evaluate(() => {
      const button = (batchId: string) => document.querySelector<HTMLButtonElement>(`[data-testid="canvas-scroller"] section[data-batch-id="${batchId}"] button[aria-label="Archive tile"]`);
      const a = button('studio-batch-4');
      const b = button('studio-extra-2');
      if (!a || !b) throw new Error('missing tile actions');
      a.click();
      window.setTimeout(() => { b.click(); }, 50);
    });
    await page.waitForTimeout(80);
    await page.getByRole('button', { name: 'Archive', exact: true }).click();
    const frames = await vtFrames(page);
    await expect(page.getByTestId('feed').getByTestId('canvas-scroller')).toHaveCount(0);
    expect(errors).toEqual([]);
    await page.getByRole('button', { name: 'Back to Unsorted', exact: true }).click();
    await expect(first.locator('[data-testid="batch-grid"]')).toHaveAttribute('data-tile-count', '1');
    await expect(second.locator('[data-testid="batch-grid"]')).toHaveAttribute('data-tile-count', '1');

    if (supported) {
      const exitTimes = (key: string) => frames
        .filter((frame) => frame.animations.includes(`::view-transition-old({${key}}) atelier-shrink-out`))
        .map((frame) => frame.t);
      const a = exitTimes('a');
      const b = exitTimes('b');
      expect(a.length).toBeGreaterThan(0);
      // The second removal waited for the first transition (React's queue)
      // or joined it before it started; the two never overlap.
      if (b.length > 0 && Math.min(...b) !== Math.min(...a)) {
        expect(Math.min(...b)).toBeGreaterThan(Math.max(...a));
      }
      expect(frames.some((frame) => frame.animations.some((entry) => entry.includes('atelier-view-in-deeper')))).toBe(true);
    }
  });

  for (const lastOfAll of [false, true]) {
    test(`Archive: removing ${lastOfAll ? 'the very last tile' : 'the sole tile of the last virtual row'} plays its exit`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.setViewportSize({ width: 1024, height: 768 });
      let count = 1;
      if (!lastOfAll) {
        await page.goto('/e2e/harness/archive.html?count=18');
        const columns = await page.locator('[data-virtualized="archive"] > [data-index="0"]').evaluate((row) => row.children.length);
        expect(columns).toBeGreaterThanOrEqual(2);
        count = columns + 1;
      }
      await page.goto(`/e2e/harness/archive.html?count=${String(count)}`);
      await page.waitForTimeout(600);
      const supported = await page.evaluate(() => 'startViewTransition' in document);
      const lastRow = `[data-virtualized="archive"] > [data-index="${String(lastOfAll ? 0 : 1)}"]`;
      await expect(page.locator(`${lastRow} > *`)).toHaveCount(1);
      await recordVt(page, { row: { selector: lastRow } });
      await page.getByRole('button', { name: 'Restore', exact: true }).last().click();
      const frames = await vtFrames(page);
      await expect(page.getByRole('button', { name: `Open archived image: Archive fixture ${String(count)}`, exact: true })).toHaveCount(0);
      await expect(page.locator(lastRow)).toHaveCount(0);
      if (supported) expect(ran(frames, 'old', 'row', 'atelier-shrink-out'), anyVt(frames).join('\n')).toBe(true);
    });
  }

  test('a feed scope swap carries a batch shown in both scopes with the stage, not as its own group', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto('/e2e/studio/index.html');
    await page.getByRole('button', { name: /^Campaign studies/ }).click();
    await expect(page.locator(FEED_BATCH('studio-batch-1'))).toBeVisible();
    await page.waitForTimeout(500);
    const supported = await page.evaluate(() => 'startViewTransition' in document);
    // The press outside the empty composer minimizes it for a moment, so its
    // frame boundary may carry that footprint change (T8b, composer-frame);
    // it is tracked here only to be told apart from the feed.
    await recordVt(page, { composer: { selector: '#atelier-composer' } });
    await page.getByRole('button', { name: /^Pinned/ }).click();
    const frames = await vtFrames(page);
    await expect(page.locator(FEED_BATCH('studio-batch-1'))).toBeVisible();
    if (supported) {
      // The swap's own transition: the frames in which the old stage fades.
      const swap = frames.filter((frame) => frame.animations.some((entry) => entry.includes('atelier-fade-out')));
      expect(swap.length).toBeGreaterThan(2);
      // Only the stage (old and new) and the root are captured in it.
      const entries = [...new Set(swap.flatMap((frame) => frame.animations))];
      const captured = new Set(entries.map((entry) => /\(([^)]+)\)/.exec(entry)?.[1]).filter((name) => name !== undefined && name !== 'root' && name !== '{composer}'));
      expect(captured.size, entries.join('\n')).toBeLessThanOrEqual(2);
    }
  });

  test('reduced motion: no group interpolates and the tile exit is an 80ms fade', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openWritableFeed(page);
    const supported = await page.evaluate(() => 'startViewTransition' in document);
    const batch = page.locator(FEED_BATCH('studio-batch-4'));
    const [removedImg] = await tileImages(page, 'studio-batch-4');
    await batch.locator('[data-testid="batch-grid"] > :first-child').hover();
    await recordVt(page, { removed: { selector: `${GRID('studio-batch-4')} > *`, img: removedImg ?? '' } }, {}, 700);
    await batch.getByRole('button', { name: 'Archive tile' }).first().click();
    const frames = await vtFrames(page);
    await expect(batch.locator('[data-testid="batch-grid"]')).toHaveAttribute('data-tile-count', '1');
    if (supported) {
      const entries = [...new Set(frames.flatMap((frame) => frame.animations))];
      expect(entries.filter((entry) => entry.startsWith('::view-transition-group'))).toEqual([]);
      expect(ran(frames, 'old', 'removed', 'atelier-shrink-out')).toBe(true);
      const exitMs = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--dur-overlay').trim());
      expect(exitMs).toBe('80ms');
      // The exit lasts no longer than the reduced duration plus a frame.
      const exitFrames = frames.filter((frame) => frame.animations.includes('::view-transition-old({removed}) atelier-shrink-out')).map((frame) => frame.t);
      expect(Math.max(...exitFrames) - Math.min(...exitFrames)).toBeLessThan(80 + 34);
      // --m-scale collapses to 1: the exit only fades.
      const scale = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--m-scale').trim());
      expect(scale).toBe('1');
    }
  });
});

/*
 * T8b: conditional parts enter and exit through unnamed part boundaries
 * (motion.css .part-enter / .part-exit), each fed by its surface's deferred
 * snapshot; the Composer frame interpolates its footprint (.composer-frame).
 * Motion is read on the pseudo-elements, as above.
 */
/** Seeds the Composer's ready reference chips through the page's own store. */
async function seedRefChips(page: Page, previews: readonly string[]): Promise<void> {
  await page.evaluate(async (urls) => {
    const storeUrl = '/src/store/atelier.ts';
    const { useAtelierStore } = await import(/* @vite-ignore */ storeUrl) as { useAtelierStore: typeof AtelierStore };
    useAtelierStore.getState().setDraft({
      refImages: urls.map((previewUrl, index) => ({ clientId: `ref-${String(index)}`, status: 'ready' as const, mime: 'image/svg+xml', sizeBytes: 1, previewUrl })),
    });
  }, previews);
}

/** Any running view-transition animation, per sampled frame. */
function anyVt(frames: readonly VtFrame[]): string[] {
  return [...new Set(frames.flatMap((frame) => frame.animations))];
}

test.describe('conditional parts enter and exit (React ViewTransition)', () => {
  test('an image to video mode swap cross-fades the body while the composer frame resizes through its group', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/e2e/studio/index.html?video=1');
    const prompt = page.getByRole('textbox', { name: 'Prompt', exact: true });
    await prompt.fill('A retained image draft');
    await page.waitForTimeout(400);
    const supported = await page.evaluate(() => 'startViewTransition' in document);
    const before = await page.locator('#atelier-composer').boundingBox();
    await recordVt(page, { frame: { selector: '#atelier-composer' }, body: { selector: '#atelier-composer [data-zone="i2v"]' } }, { frame: '#atelier-composer' }, 900);
    await page.getByRole('button', { name: 'Model', exact: true }).click();
    await page.getByRole('option', { name: /Studio Motion/ }).click();
    const frames = await vtFrames(page);
    await expect(page.getByRole('textbox', { name: 'Motion prompt' })).toBeVisible();
    const after = await page.locator('#atelier-composer').boundingBox();
    if (!before || !after) throw new Error('composer missing');
    expect(Math.abs(after.height - before.height), 'the video body changes the footprint').toBeGreaterThan(20);
    if (supported) {
      expect(groupFrames(frames, 'frame').length).toBeGreaterThan(3);
      expect(intermediateTransforms(frames, 'frame').length).toBeGreaterThanOrEqual(3);
      expect(groupFrames(frames, 'body').length).toBeGreaterThan(3);
      // Live geometry is final at once; the group carries the motion.
      const live = frames.find((frame) => frame.animations.some((entry) => entry.startsWith('::view-transition-group({frame})')))?.live.frame;
      expect(Math.abs((live?.height ?? 0) - after.height)).toBeLessThan(1);
    }
    // The toast stack's anchor survives the swap.
    expect(await page.locator('#atelier-composer').evaluate((element) => getComputedStyle(element).getPropertyValue('anchor-name'))).toBe('--atelier-composer');
  });

  test('the model banner lifts out when Retry brings the inventory back', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/e2e/studio/index.html?modelsFail=3');
    const banner = page.locator('#atelier-composer [role="alert"]');
    // The inventory query retries twice (with backoff) before it errors.
    await expect(page.getByRole('button', { name: 'Retry loading models' })).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(400);
    const supported = await page.evaluate(() => 'startViewTransition' in document);
    await recordVt(page, { banner: { selector: '#atelier-composer [role="alert"]' } });
    await page.getByRole('button', { name: 'Retry loading models' }).click();
    const frames = await vtFrames(page);
    await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toBeVisible();
    await expect(banner).toHaveCount(0);
    if (supported) expect(ran(frames, 'old', 'banner', 'atelier-drop-out')).toBe(true);
  });

  test('a removed reference chip lifts out and the chip that slides into its place takes the next click', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/e2e/studio/index.html');
    await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill('A draft with references');
    const preview = (color: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="${color}"/></svg>`)}`;
    await seedRefChips(page, [preview('#a4876c'), preview('#364a48')]);
    await expect(page.getByRole('button', { name: 'Remove reference image 2' })).toBeVisible();
    await page.waitForTimeout(500);
    const supported = await page.evaluate(() => 'startViewTransition' in document);
    await recordVt(page, { chip: { selector: '#atelier-composer [data-tip], #atelier-composer div:has(> button[aria-label^="Remove reference image"])', img: preview('#a4876c') } }, {}, 500);
    await page.getByRole('button', { name: 'Remove reference image 1' }).click();
    // Clicked while the first chip's exit still plays: the pseudo image is
    // not interactive, so the click reaches the live survivor.
    await page.getByRole('button', { name: 'Remove reference image 1' }).click();
    const frames = await vtFrames(page);
    await expect(page.getByRole('button', { name: /^Remove reference image/ })).toHaveCount(0);
    if (supported) expect(ran(frames, 'old', 'chip', 'atelier-drop-out')).toBe(true);
  });

  test('picker phases cross-fade list, refine and brainstorm bodies', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/e2e/studio/index.html');
    await page.getByRole('button', { name: 'Templates', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Templates' });
    await expect(dialog.getByRole('searchbox', { name: 'Search templates' })).toBeVisible();
    await page.waitForTimeout(500);
    const supported = await page.evaluate(() => 'startViewTransition' in document);
    const phases = {
      list: { selector: '[role="dialog"] > * > :has(input[type="search"])' },
      refine: { selector: '[role="dialog"] > * > :has([aria-label="Resolved prompt preview"])' },
    };

    await recordVt(page, phases);
    await dialog.getByRole('button', { name: /^Editorial portrait/ }).click();
    const toRefine = await vtFrames(page);
    await expect(page.getByLabel('Resolved prompt preview')).toBeVisible();

    await page.waitForTimeout(300);
    await recordVt(page, phases);
    await page.getByRole('button', { name: 'Back to template list' }).click();
    const toList = await vtFrames(page);
    await expect(page.getByRole('searchbox', { name: 'Search templates' })).toBeVisible();

    await page.waitForTimeout(300);
    await recordVt(page, phases);
    await page.getByRole('button', { name: 'Brainstorm', exact: true }).click();
    const toBrainstorm = await vtFrames(page);
    await expect(page.getByRole('heading', { name: 'Brainstorm' })).toBeVisible();

    if (supported) {
      expect(ran(toRefine, 'old', 'list', 'atelier-drop-out')).toBe(true);
      expect(ran(toRefine, 'new', 'refine', 'atelier-drop-in')).toBe(true);
      expect(ran(toList, 'old', 'refine', 'atelier-drop-out')).toBe(true);
      expect(ran(toList, 'new', 'list', 'atelier-drop-in')).toBe(true);
      expect(ran(toBrainstorm, 'old', 'list', 'atelier-drop-out')).toBe(true);
      expect(anyVt(toBrainstorm).some((entry) => entry.startsWith('::view-transition-new(') && entry.endsWith(' atelier-drop-in'))).toBe(true);
      // The Composer under the picker is not captured by a phase change.
      for (const frames of [toRefine, toList, toBrainstorm]) {
        expect(anyVt(frames).filter((entry) => / composer-|atelier-composer/.test(entry))).toEqual([]);
      }
    }
  });

  test('the Lightbox reference strip lifts out when the next image has no references', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/e2e/studio/index.html?refs=1');
    await page.locator('section[data-batch-id="studio-batch-4"]').getByRole('button', { name: /^Open image 1/ }).click();
    const strip = page.getByRole('button', { name: 'View reference image 1 of 2' });
    await expect(strip).toBeVisible();
    await page.waitForTimeout(500);
    const supported = await page.evaluate(() => 'startViewTransition' in document);
    await recordVt(page, { strip: { selector: 'dialog div:has(> button[aria-label^="View reference image"])' } });
    await page.keyboard.press('ArrowRight');
    const frames = await vtFrames(page);
    await expect(strip).toHaveCount(0);
    if (supported) expect(ran(frames, 'old', 'strip', 'atelier-drop-out')).toBe(true);
  });

  test('typing in the prompt starts no view transition', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/e2e/studio/index.html');
    const prompt = page.getByRole('textbox', { name: 'Prompt', exact: true });
    await prompt.click();
    await page.waitForTimeout(400);
    await recordVt(page, {}, {}, 1200);
    await page.keyboard.type('A quiet harbour at first light, {{var::lighting}}', { delay: 15 });
    const frames = await vtFrames(page);
    expect(anyVt(frames)).toEqual([]);
    await expect(prompt).toHaveValue('A quiet harbour at first light, {{var::lighting}}');
  });
});

interface MotionEvent {
  kind: 'transition' | 'animation';
  name: string;
  target: string;
  t: number;
  duration: number;
  easing: string;
}

declare global {
  interface Window {
    __motionEvents?: MotionEvent[];
  }
}

/*
 * Records every transition and animation that starts on an element matching
 * one of `targets` (label → selector), with the duration and easing read off
 * its live Animation at transitionrun / animationstart. Timing comes from the
 * effect itself, not from sampling, so it does not depend on frame pacing.
 */
async function recordMotionEvents(page: Page, targets: Record<string, string>): Promise<void> {
  await page.evaluate((entries) => {
    const events: MotionEvent[] = [];
    window.__motionEvents = events;
    const label = (element: EventTarget | null): string | null => {
      if (!(element instanceof Element)) return null;
      return Object.entries(entries).find(([, selector]) => element.matches(selector))?.[0] ?? null;
    };
    const timing = (animation: Animation): { duration: number; easing: string } => {
      const effect = animation.effect as KeyframeEffect | null;
      const computed = effect?.getComputedTiming();
      const timingEasing = effect?.getTiming().easing ?? 'linear';
      // CSS transitions carry their timing function on the effect; CSS
      // animations on each keyframe.
      const keyframeEasing = effect?.getKeyframes().map((frame) => frame.easing).find((easing) => easing && easing !== 'linear');
      return { duration: Number(computed?.duration ?? 0), easing: timingEasing !== 'linear' ? timingEasing : keyframeEasing ?? 'linear' };
    };
    document.addEventListener('transitionrun', (event) => {
      const target = label(event.target);
      if (!target || !(event.target instanceof Element)) return;
      const animation = event.target.getAnimations().find((entry) => 'transitionProperty' in entry && (entry as CSSTransition).transitionProperty === event.propertyName);
      if (!animation) return;
      events.push({ kind: 'transition', name: event.propertyName, target, t: performance.now(), ...timing(animation) });
    }, true);
    document.addEventListener('animationstart', (event) => {
      const target = label(event.target);
      if (!target || !(event.target instanceof Element)) return;
      const animation = event.target.getAnimations().find((entry) => 'animationName' in entry && (entry as CSSAnimation).animationName === event.animationName);
      if (!animation) return;
      events.push({ kind: 'animation', name: event.animationName, target, t: performance.now(), ...timing(animation) });
    }, true);
  }, targets);
}

async function motionEvents(page: Page): Promise<MotionEvent[]> {
  return page.evaluate(() => window.__motionEvents ?? []);
}

/** Parses a cubic-bezier() string, tolerant of each engine's spacing. */
function bezier(easing: string): number[] {
  return /cubic-bezier\(([^)]+)\)/.exec(easing)?.[1]?.split(',').map(Number) ?? [];
}

function expectCurve(easing: string, expected: number[], label: string): void {
  const actual = bezier(easing);
  expect(actual, `${label}: easing ${easing}`).toHaveLength(4);
  actual.forEach((value, index) => { expect(Math.abs(value - (expected[index] ?? 0)), `${label}: easing ${easing}`).toBeLessThan(1e-3); });
}

const EASE_EXIT = [0.4, 0, 1, 1];
const EASE_OUT = [0.2, 0.8, 0.2, 1];

test.describe('overlay exits keep the overlay grammar and its timing', () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  });

  test('Undo fades the Archived toast over --dur-overlay and unmounts it once', async ({ page }) => {
    await openWritableFeed(page);
    const batch = page.locator(FEED_BATCH('studio-batch-4'));
    await batch.locator('[data-testid="batch-grid"] > :first-child').hover();
    await batch.getByRole('button', { name: 'Archive tile' }).first().click();
    const undo = page.getByRole('button', { name: 'Undo', exact: true });
    await expect(undo).toBeVisible();
    await page.waitForTimeout(400);
    await undo.evaluate((element) => { element.parentElement?.setAttribute('data-undo-toast', ''); });
    await recordMotionEvents(page, { toast: '[data-undo-toast]' });
    // Store-level record of the toast's life: leaving once, removed once.
    await page.evaluate(async () => {
      const path = '/src/store/atelier.ts';
      const { useAtelierStore } = await import(/* @vite-ignore */ path) as { useAtelierStore: typeof AtelierStore };
      const id = useAtelierStore.getState().toasts.find((toast) => toast.text === 'Archived')?.id;
      const log: { event: string; t: number }[] = [];
      Reflect.set(window, '__undoLog', log);
      useAtelierStore.subscribe((next, prev) => {
        const before = prev.toasts.find((toast) => toast.id === id);
        const after = next.toasts.find((toast) => toast.id === id);
        if (after?.leaving && !before?.leaving) log.push({ event: 'leaving', t: performance.now() });
        if (before && !after) log.push({ event: 'removed', t: performance.now() });
        if (!before && after) log.push({ event: 'returned', t: performance.now() });
      });
    });
    await undo.click();
    await expect(page.locator('[data-undo-toast]')).toHaveCount(0);
    await page.waitForTimeout(800);
    const exit = (await motionEvents(page)).find((event) => event.kind === 'animation' && event.name === 'atelier-popover-out');
    expect(exit, 'the toast never played atelier-popover-out').toBeDefined();
    expect(exit?.duration).toBe(160);
    expectCurve(exit?.easing ?? '', EASE_EXIT, 'toast exit');
    const log = await page.evaluate(() => Reflect.get(window, '__undoLog') as { event: string; t: number }[]);
    expect(log.map((entry) => entry.event)).toEqual(['leaving', 'removed']);
    const [leaving, removed] = log;
    // The unmount waits for the fade (one frame of slack either side).
    expect((removed?.t ?? 0) - (leaving?.t ?? 0)).toBeGreaterThan(140);
    expect((removed?.t ?? 0) - (leaving?.t ?? 0)).toBeLessThan(400);
  });

  test('the Lightbox frame exits on the exit curve', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/e2e/studio/index.html?refs=1');
    await page.locator('section[data-batch-id="studio-batch-4"]').getByRole('button', { name: /^Open image 1/ }).click();
    await expect(page.getByRole('button', { name: 'Close lightbox' })).toBeVisible();
    await page.waitForTimeout(700);
    await recordMotionEvents(page, { frame: 'dialog [data-media]' });
    await page.getByRole('button', { name: 'Close lightbox' }).click();
    await expect(page.getByRole('button', { name: 'Close lightbox' })).toHaveCount(0);
    const exits = (await motionEvents(page)).filter((event) => event.kind === 'transition' && (event.name === 'opacity' || event.name === 'transform'));
    expect(exits.map((event) => event.name).sort()).toEqual(['opacity', 'transform']);
    for (const event of exits) {
      expect(event.duration, `frame ${event.name}`).toBe(160);
      expectCurve(event.easing, EASE_EXIT, `frame ${event.name}`);
    }
  });

  test('the phone drawer opens over --dur-sheet on the entry curve and closes over --dur-overlay on the exit curve', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/e2e/studio/index.html');
    await expect(page.getByTestId('feed')).toBeVisible();
    await page.waitForTimeout(400);
    const targets = { drawer: 'aside[aria-label="Sidebar"]', backdrop: 'button[aria-hidden][data-open]' };
    await recordMotionEvents(page, targets);
    await page.getByRole('button', { name: 'Open menu' }).click();
    await expect(page.getByRole('button', { name: 'Close menu' })).toBeVisible();
    await page.waitForTimeout(400);
    const opened = await motionEvents(page);
    await recordMotionEvents(page, targets);
    await page.getByRole('button', { name: 'Close menu' }).click();
    await page.waitForTimeout(400);
    const closed = await motionEvents(page);

    const find = (events: MotionEvent[], target: string, name: string) => events.find((event) => event.target === target && event.name === name);
    for (const [target, name] of [['drawer', 'transform'], ['backdrop', 'opacity']] as const) {
      const open = find(opened, target, name);
      expect(open, `${target} open never transitioned`).toBeDefined();
      expect(open?.duration, `${target} open`).toBe(240);
      expectCurve(open?.easing ?? '', EASE_OUT, `${target} open`);
      const close = find(closed, target, name);
      expect(close, `${target} close never transitioned`).toBeDefined();
      expect(close?.duration, `${target} close`).toBe(160);
      expectCurve(close?.easing ?? '', EASE_EXIT, `${target} close`);
    }
  });

  test('the BatchPrompt card fades out before it unmounts', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1600 });
    await page.goto('/e2e/harness/anchors.html?case=feed&seed=2');
    const prompt = page.locator('section[data-batch-id="batch-0"] header > div[tabindex="0"]');
    await expect(prompt).toBeVisible();
    // The reader takes over the feed first, as native-anchors' focusPrompt does.
    await page.getByTestId('canvas-scroller').dispatchEvent('wheel');
    await expect(prompt).toBeInViewport({ ratio: 1 });
    await prompt.focus();
    await expect(page.getByRole('tooltip')).toBeVisible();
    await page.waitForTimeout(300);
    await recordMotionEvents(page, { card: '[id][data-anchored="name"]' });
    await page.keyboard.press('Escape');
    // Closed for assistive tech at once; the card itself stays through the fade.
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await expect(page.locator('[data-anchored="name"]')).toHaveCount(0);
    const fade = (await motionEvents(page)).find((event) => event.kind === 'transition' && event.name === 'opacity');
    expect(fade, 'the card never faded').toBeDefined();
    expect(fade?.duration).toBe(160);
    expectCurve(fade?.easing ?? '', EASE_EXIT, 'card exit');
  });

  test('the phone chip sheet enters over --dur-sheet', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/e2e/studio/index.html');
    await expect(page.getByTestId('feed')).toBeVisible();
    const expand = page.getByRole('button', { name: 'Expand composer' });
    if (await expand.count() > 0) await expand.click();
    await page.waitForTimeout(400);
    await recordMotionEvents(page, { sheet: '[role="listbox"]' });
    await page.getByRole('button', { name: 'Model' }).click();
    await expect(page.getByRole('listbox', { name: 'Model' })).toBeVisible();
    await page.waitForTimeout(400);
    const enter = (await motionEvents(page)).filter((event) => event.kind === 'transition' && (event.name === 'opacity' || event.name === 'transform'));
    expect(enter.map((event) => event.name).sort()).toEqual(['opacity', 'transform']);
    for (const event of enter) {
      expect(event.duration, `sheet ${event.name}`).toBe(240);
      expectCurve(event.easing, EASE_OUT, `sheet ${event.name}`);
    }
  });
});

test.describe('layout stability (T9)', () => {
  test('choosing a variable template settles the picker within the sheet duration and never shifts afterwards', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/e2e/studio/index.html');
    await page.getByRole('button', { name: 'Templates', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Templates' });
    const template = dialog.getByRole('button', { name: /^Editorial portrait/ });
    await expect(template).toBeVisible();
    await page.waitForTimeout(600);
    await page.evaluate(() => {
      const record = { shifts: [] as { t: number; value: number }[], heights: [] as { t: number; h: number }[], clickedAt: 0 };
      (window as unknown as { __picker: typeof record }).__picker = record;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as unknown as { startTime: number; value: number; hadRecentInput: boolean }[]) {
          if (!entry.hadRecentInput) record.shifts.push({ t: entry.startTime, value: entry.value });
        }
      }).observe({ type: 'layout-shift' });
      document.addEventListener('click', () => { record.clickedAt = performance.now(); }, { capture: true, once: true });
      const tick = (now: number) => {
        const panel = document.querySelector('[role="dialog"][data-sheet]');
        if (panel && record.clickedAt > 0) record.heights.push({ t: now - record.clickedAt, h: panel.getBoundingClientRect().height });
        if (record.clickedAt === 0 || now - record.clickedAt < 1800) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await template.click();
    // The dialog's name follows the phase, so the refine body is found by its own control.
    await expect(page.getByRole('button', { name: /^Advanced/ })).toBeVisible();
    await page.waitForTimeout(1900);
    const record = await page.evaluate(() => (window as unknown as { __picker: { shifts: { t: number; value: number }[]; heights: { t: number; h: number }[]; clickedAt: number } }).__picker);
    // No shift without recent input: the 500ms input window covers the
    // intended phase change; anything later is a rebound.
    expect(record.shifts.filter((shift) => shift.t > record.clickedAt), 'layout shifts without recent input').toEqual([]);
    // The panel's height may change with the phase swap (intended), then
    // stays put: every sample from the first change plus --dur-sheet on, over
    // the rest of the window, has the final height.
    const final = record.heights.at(-1)?.h ?? 0;
    const firstChange = record.heights.find((sample) => Math.abs(sample.h - (record.heights[0]?.h ?? 0)) > 0.5)?.t ?? 0;
    const late = record.heights.filter((sample) => sample.t > firstChange + 240);
    expect(late.at(-1)?.t ?? 0).toBeGreaterThan(1500);
    for (const sample of late) expect(Math.abs(sample.h - final), `height at ${sample.t.toFixed(0)}ms`).toBeLessThan(0.5);
  });

  test('switching between two preset hints interpolates the open hint height', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/e2e/studio/index.html?view=text-models&textAdmin=1&textProvider=1');
    await page.getByRole('button', { name: 'Add provider', exact: true }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Add a provider' });
    await expect(dialog).toBeVisible();
    // Groq's hint is one line and OpenRouter's two; both need a key, so only
    // the URL hint changes.
    await dialog.getByText('Groq', { exact: true }).click();
    await page.waitForTimeout(500);
    await startRecording(page, 'dialog[open] > div', 600);
    await dialog.getByText('OpenRouter', { exact: true }).click();
    const frames = (await recordedFrames(page)).filter((frame) => frame.present);
    const first = frames[0];
    const last = frames.at(-1);
    if (!first || !last) throw new Error('no dialog frames');
    expect(last.height - first.height, 'the longer hint adds a line').toBeGreaterThan(10);
    const moving = frames.filter((frame) => frame.height > first.height + 0.5 && frame.height < last.height - 0.5);
    expect(new Set(moving.map((frame) => Math.round(frame.height))).size, 'distinct intermediate heights').toBeGreaterThanOrEqual(2);
    expect((moving.at(-1)?.t ?? 0) - (moving[0]?.t ?? 0), 'ms spent between the two heights').toBeGreaterThanOrEqual(80);
  });

  test('a tile removal that shrinks its phone batch moves the rows below through their group', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.setViewportSize({ width: 390, height: 844 });
    // Twice, so every batch is seen at mount (the app rewrites the URL).
    const url = '/e2e/studio/index.html?writable=1&batches=2';
    await page.goto(url);
    await expect(page.locator(FEED_ROW('studio-batch-4'))).toBeVisible();
    await page.waitForTimeout(500);
    await page.goto(url);
    await expect(page.locator(FEED_ROW('studio-batch-4'))).toBeVisible();
    await page.waitForTimeout(800);
    // The shrinking batch's lower tile and the next row's top in view.
    await page.locator(FEED_ROW('studio-extra-2')).evaluate((element) => {
      element.scrollIntoView({ block: 'end' });
      const scroller = document.querySelector('[data-testid="canvas-scroller"]');
      if (scroller) scroller.scrollTop += 380;
    });
    await page.waitForTimeout(600);
    const supported = await page.evaluate(() => 'startViewTransition' in document);
    await recordVt(page, { below: { selector: FEED_ROW('studio-batch-4') } }, { below: FEED_ROW('studio-batch-4') });
    await page.locator(FEED_BATCH('studio-extra-2')).getByRole('button', { name: 'Archive tile' }).first().click({ force: true });
    const frames = await vtFrames(page);
    await expect(page.locator(GRID('studio-extra-2'))).toHaveAttribute('data-tile-count', '1');
    const settled = await page.locator(FEED_ROW('studio-batch-4')).boundingBox();
    if (!settled) throw new Error('row below missing');
    if (supported) {
      const moving = groupFrames(frames, 'below');
      expect(moving.length, 'the row below runs a group').toBeGreaterThan(3);
      expect(intermediateTransforms(frames, 'below').length).toBeGreaterThanOrEqual(3);
      // The live row is already at its final place while its group moves.
      expect(Math.abs((moving[0]?.live.below?.y ?? 0) - settled.y)).toBeLessThan(1);
    }
  });

  test('a scope switch replaces placeholder rows without tile exits or entrances', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.setViewportSize({ width: 1280, height: 800 });
    // The collection's history answers late, so the new stage first shows
    // the previous scope's rows as placeholder data.
    await page.addInitScript(() => {
      let inner: typeof fetch | undefined;
      Object.defineProperty(window, 'fetch', {
        configurable: true,
        get: () => async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = input instanceof Request ? input.url : String(input);
          if (url.includes('/api/history') && url.includes('collectionId=campaign')) await new Promise((resolve) => { setTimeout(resolve, 400); });
          if (!inner) throw new Error('fetch not installed');
          return inner(input, init);
        },
        set: (value: typeof fetch) => { inner = value; },
      });
    });
    await page.goto('/e2e/studio/index.html');
    await expect(page.locator(FEED_ROW('studio-batch-4'))).toBeVisible();
    await page.waitForTimeout(800);
    const supported = await page.evaluate(() => 'startViewTransition' in document);
    await recordVt(page, {}, {}, 1600);
    await page.getByRole('button', { name: /^Campaign studies/ }).click();
    const frames = await vtFrames(page);
    await expect(page.locator(FEED_ROW('studio-batch-1'))).toBeVisible();
    await expect(page.locator(FEED_ROW('studio-batch-4'))).toHaveCount(0);
    const names = new Set(frames.flatMap((frame) => frame.animations.map((entry) => entry.split(' ')[1] ?? '')));
    if (supported) expect(names.has('atelier-fade-in'), [...names].join(', ')).toBe(true);
    expect(names.has('atelier-shrink-out'), 'a placeholder row played a tile exit').toBe(false);
    expect(names.has('atelier-tile-in'), 'a real row played a tile entrance').toBe(false);
  });
});

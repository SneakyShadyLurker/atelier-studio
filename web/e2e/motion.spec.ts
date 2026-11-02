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
      const back = page.getByRole('button', { name: 'Back to feed', exact: true });
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
    await page.getByRole('button', { name: 'How the prompt library works' }).click();
    const panel = page.getByRole('dialog', { name: 'How the prompt library works' });
    await expect(panel).toBeVisible();
    await page.waitForTimeout(300);
    await startRecording(page, '[role="dialog"][data-mobile]', 700);
    await page.keyboard.press('Escape');
    expectExit(await recordedFrames(page), 'help panel');
  });

  test('the phone help scrim fades out with the sheet', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/e2e/studio/index.html?view=prompts');
    await page.getByRole('button', { name: 'How the prompt library works' }).click();
    await expect(page.getByRole('dialog', { name: 'How the prompt library works' })).toBeVisible();
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
    await page.getByRole('button', { name: 'Back to feed', exact: true }).click();
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

import { expect, test } from '@playwright/test';
import type { useAtelierStore as AtelierStore } from '../src/store/atelier';

test('queued generations keep the existing feed opaque while new batches animate', async ({ page }) => {
  test.setTimeout(60_000);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route('**/e2e/motion-image.svg?*', (route) => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="960"><rect width="960" height="960" fill="#78949b"/></svg>' }));
  await page.goto('/e2e/studio/index.html?generate=1&generateDelay=300&generateFinish=500&aiFillDelay=900&motionMedia=1', { waitUntil: 'domcontentloaded' });
  const scroller = page.getByTestId('canvas-scroller');
  const existing = scroller.locator('section[data-batch-id="studio-batch-4"]');
  await expect(existing).toBeVisible();
  const expand = page.getByRole('button', { name: 'Expand composer', exact: true });
  if (await expand.isVisible()) await expand.click();
  await page.evaluate(async () => {
    const storeUrl = '/src/store/atelier.ts';
    const { useAtelierStore } = await import(/* @vite-ignore */ storeUrl) as { useAtelierStore: typeof AtelierStore };
    useAtelierStore.getState().setDraft({ prompt: '', rollQueue: Array.from({ length: 3 }, (_, index) => ({
      id: `flicker-roll-${String(index)}`, seed: index + 1, source: 'composer' as const,
      text: `A lighthouse ${String(index)} in {{ai-fill:describe lighting}}`,
    })) });
  });
  await page.waitForTimeout(700);
  const probe = await scroller.evaluateHandle((element) => {
    const row = element.querySelector('section[data-batch-id="studio-batch-4"]');
    if (!row) throw new Error('Missing existing row');
    const images = [...row.querySelectorAll('img')];
    const evidence = {
      starts: 0, ready: 0, feedGroupCaptures: 0, minimumOpacity: 1, oldMaximumOpacity: 0,
      removedRows: 0, imageLoads: 0, unloads: 0, entrances: 0,
      scrollBeforeAcceptance: 0, scrollAtStart: element.scrollTop,
      captures: [] as string[],
    };
    const removed = new MutationObserver((records) => {
      for (const record of records) for (const node of record.removedNodes) {
        if (node === row || node.contains(row)) evidence.removedRows += 1;
      }
    });
    removed.observe(element, { subtree: true, childList: true });
    const imageLoad = () => { evidence.imageLoads += 1; };
    for (const image of images) image.addEventListener('load', imageLoad);
    const unload = () => { evidence.unloads += 1; };
    window.addEventListener('beforeunload', unload);
    const original = document.startViewTransition.bind(document);
    document.startViewTransition = (...args) => {
      evidence.starts += 1;
      const transition = original(...args);
      void transition.ready.then(() => {
        evidence.ready += 1;
        const old = getComputedStyle(document.documentElement, '::view-transition-old(atelier-feed)');
        const next = getComputedStyle(document.documentElement, '::view-transition-new(atelier-feed)');
        evidence.captures.push(`${old.animationName} / ${next.animationName}`);
        // Sample the actual painted opacity halfway through each native
        // animation, independent of machine speed or driver round trips.
        const animations = document.getAnimations().filter((animation) =>
          animation.effect instanceof KeyframeEffect && (animation.effect.pseudoElement ?? '').startsWith('::view-transition'));
        // The opacity samples below mean something only while the scroller
        // really is a captured group in this transition.
        if (animations.some((animation) => (animation.effect as KeyframeEffect).pseudoElement === '::view-transition-group(atelier-feed)')) evidence.feedGroupCaptures += 1;
        const resumeAt = animations.map((animation) => animation.currentTime);
        for (const animation of animations) {
          animation.pause();
          animation.currentTime = Number(animation.effect?.getComputedTiming().duration ?? 0) / 2;
        }
        evidence.minimumOpacity = Math.min(evidence.minimumOpacity, Number(next.opacity));
        evidence.oldMaximumOpacity = Math.max(evidence.oldMaximumOpacity, Number(old.opacity));
        // Hand each animation back at its own time, so the drain keeps its
        // real transition lengths for the checks below.
        animations.forEach((animation, index) => {
          animation.currentTime = resumeAt[index] ?? 0;
          animation.play();
        });
      }, () => undefined);
      return transition;
    };
    const onAnimation = (event: Event) => {
      if (event instanceof AnimationEvent && event.animationName === 'atelier-rise-in' && event.target instanceof Element && event.target.closest('section[data-batch-id^="studio-generated-"]')) evidence.entrances += 1;
    };
    element.addEventListener('animationstart', onAnimation);
    const onScroll = () => {
      if (!element.querySelector('section[data-batch-id^="studio-generated-"]')) {
        evidence.scrollBeforeAcceptance = Math.max(evidence.scrollBeforeAcceptance, Math.abs(element.scrollTop - evidence.scrollAtStart));
      }
    };
    element.addEventListener('scroll', onScroll);
    return {
      finish: () => {
        removed.disconnect();
        for (const image of images) image.removeEventListener('load', imageLoad);
        window.removeEventListener('beforeunload', unload);
        element.removeEventListener('animationstart', onAnimation);
        element.removeEventListener('scroll', onScroll);
        document.startViewTransition = original;
        return { ...evidence, captures: [...new Set(evidence.captures)], sameRow: row === element.querySelector('section[data-batch-id="studio-batch-4"]'), sameImages: images.every((image) => image.isConnected), navigationCount: performance.getEntriesByType('navigation').length };
      },
    };
  });
  await page.getByRole('button', { name: /^Generate/ }).click();
  await expect(scroller.locator('section[data-batch-id="studio-generated-3"]')).toBeVisible();
  await expect(scroller.locator('section[data-batch-id="studio-generated-3"] img[alt^="Generated image"]')).toHaveCount(1);
  await page.waitForTimeout(700);
  const result = await probe.evaluate((state) => state.finish());
  const prompts = await page.evaluate(async () => {
    const history = await fetch('/api/history').then((response) => response.json()) as { items: { id: string; prompt: string }[] };
    return history.items.filter((batch) => batch.id.startsWith('studio-generated-')).map((batch) => batch.prompt).sort();
  });
  expect(prompts).toEqual(Array.from({ length: 3 }, (_, index) => `A lighthouse ${String(index)} in warm dusk light`));
  await test.info().attach('feed-transition-evidence', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
  expect(result.ready).toBeGreaterThan(0);
  expect(result.feedGroupCaptures, 'the feed scroller must be a captured group').toBeGreaterThan(0);
  expect(result.entrances).toBe(3);
  expect(result.sameRow).toBe(true);
  expect(result.sameImages).toBe(true);
  expect(result.removedRows).toBe(0);
  expect(result.imageLoads).toBe(0);
  expect(result.unloads).toBe(0);
  expect(result.navigationCount).toBe(1);
  expect(result.scrollBeforeAcceptance).toBeLessThanOrEqual(1);
  expect.soft(result.minimumOpacity, 'the existing feed must stay opaque').toBe(1);
  expect.soft(result.oldMaximumOpacity, 'the stale feed snapshot must stay hidden').toBe(0);
});

import { expect, test, type Page } from '@playwright/test';
import type { useAtelierStore as AtelierStore } from '../src/store/atelier';

// Spamming Generate queues one generation per click. Each accepted press
// enters the feed with the batch sheet's CSS entrance (and any Transition the
// feed commits around it), and a captured element is not hit-testable while a
// view transition runs, so the Composer must stay out of transitions it does
// not own: a press during a batch's entrance has to reach Generate.

const batchEntering = (page: Page, batchNumber: number) => page.evaluate(async (number) => {
  // A batch's CSS entrance can start in the native transition's update
  // callback, before capture preparation releases document-wide hit testing.
  // Wait only for readiness, never for the animation to finish. A skipped
  // native transition can still leave the batch's CSS entrance playing.
  await document.activeViewTransition?.ready.catch(() => undefined);
  return document.getAnimations().some((animation) => {
    if (!(animation instanceof CSSAnimation) || animation.animationName !== 'atelier-rise-in' || animation.playState !== 'running') return false;
    const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null;
    return target instanceof Element && target.closest(`section[data-batch-id="studio-generated-${String(number)}"]`) !== null;
  });
}, batchNumber);

const generated = (page: Page) => page.evaluate(() => (window as Window & { __studioGenerated?: number }).__studioGenerated ?? 0);

const hitAt = (page: Page, point: { x: number; y: number }) => page.evaluate(({ x, y }) => {
  const hit = document.elementFromPoint(x, y);
  return hit?.closest('button')?.textContent.trim() ?? hit?.tagName ?? null;
}, point);

const centre = async (page: Page, name: 'Generate' | 'Prompt') => {
  const locator = name === 'Generate'
    ? page.getByRole('button', { name: 'Generate', exact: true })
    : page.getByRole('textbox', { name: 'Prompt', exact: true });
  const box = await locator.boundingBox();
  if (!box) throw new Error(`Missing ${name}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

test('every Generate press queues a generation, including presses while a batch enters the feed', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/e2e/studio/index.html?generate=1');
  const expand = page.getByRole('button', { name: 'Expand composer', exact: true });
  if (await expand.isVisible()) await expand.click();
  await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill('a lighthouse at dusk');
  const generate = await centre(page, 'Generate');
  const prompt = await centre(page, 'Prompt');

  const presses = 6;
  await page.mouse.click(generate.x, generate.y);
  for (let press = 2; press <= presses; press += 1) {
    // Wait for the previous press's batch to start entering the feed, then
    // press while that transition is still running.
    await expect.poll(() => batchEntering(page, press - 1), { intervals: [10], timeout: 5000 }).toBe(true);
    expect(await hitAt(page, generate)).toBe('Generate');
    expect(await hitAt(page, prompt)).toBe('TEXTAREA');
    await page.mouse.click(generate.x, generate.y);
  }
  await expect.poll(() => generated(page)).toBe(presses);
  // Accepted running batches must survive the same history reads the real
  // app performs, rather than disappearing until their streams finish.
  const acceptedIds = Array.from({ length: presses }, (_, index) => `studio-generated-${String(index + 1)}`);
  const reconciled = await page.evaluate(async (batchIds) => {
    const history = await fetch('/api/history').then((response) => response.json()) as { items: { id: string }[] };
    const refresh = await fetch('/api/history/refresh', { method: 'POST', body: JSON.stringify({ batchIds }) }).then((response) => response.json()) as { items: { id: string }[]; missingBatchIds: string[] };
    return { history: history.items.map((batch) => batch.id).filter((id) => batchIds.includes(id)).sort(), refresh: refresh.items.map((batch) => batch.id).sort(), missing: refresh.missingBatchIds };
  }, acceptedIds);
  expect(reconciled).toEqual({ history: acceptedIds, refresh: acceptedIds, missing: [] });
});

// The server caps each user's queued batches (MAX_QUEUED_BATCHES_PER_USER), so
// a long spam answers QUEUE_FULL and the rest wait in the roll queue while a
// drain retries them. Generate must stay on screen and pressable for that whole
// drain: every press joins the queue, and a press bumping the queue count must
// not capture the Composer frame and swallow the next one.
test('Generate keeps queueing presses while the server is at capacity', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/e2e/studio/index.html?generate=1&generateCap=2&generateDelay=50');
  const expand = page.getByRole('button', { name: 'Expand composer', exact: true });
  if (await expand.isVisible()) await expand.click();
  await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill('a lighthouse at dusk');
  const generateButton = page.getByRole('button', { name: /^Generate/ });
  const firstPress = await centre(page, 'Generate');
  for (let press = 1; press <= 2; press += 1) {
    await page.mouse.click(firstPress.x, firstPress.y);
    await expect.poll(() => generated(page)).toBe(press);
    await expect.poll(() => batchEntering(page, press), { intervals: [10], timeout: 5000 }).toBe(true);
  }
  // Record React's capture names, including a removed chip's exit name.
  // Queue admission and a drain pass taking/restoring rolls are bookkeeping,
  // not user-owned part transitions. Checking names catches this even when
  // the hit-test assertions happen to miss the capture window.
  const queueCaptures = await page.evaluateHandle(() => {
    const captures = new Set<string>();
    const observer = new MutationObserver((records) => {
      for (const { target } of records) {
        if (!(target instanceof HTMLElement) || !target.matches('button[aria-label^="Roll queue,"]')) continue;
        const name = getComputedStyle(target).viewTransitionName;
        if (name && name !== 'none') captures.add(`${name} ${target.style.getPropertyValue('view-transition-class')}`);
      }
    });
    const composer = document.querySelector('#atelier-composer');
    if (!composer) throw new Error('Missing Composer');
    observer.observe(composer, { subtree: true, attributes: true, attributeFilter: ['style'] });
    return { captures, observer };
  });
  // At the cap: this press is held back and a drain starts working the queue.
  await page.mouse.click(firstPress.x, firstPress.y);
  await expect(page.getByRole('button', { name: 'Stop working through the queue', exact: true })).toBeVisible();
  await expect(generateButton).toBeVisible();

  const box = await generateButton.boundingBox();
  if (!box) throw new Error('Missing Generate');
  const generate = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const queued = async () => Number((await generateButton.textContent())?.match(/\d+/)?.[0] ?? 0);
  await expect.poll(queued).toBeGreaterThan(0);
  const before = await queued();
  const presses = 6;
  for (let press = 1; press <= presses; press += 1) {
    expect(await hitAt(page, generate)).toMatch(/^Generate/);
    await page.mouse.click(generate.x, generate.y);
    // The press lands, and right after its commit Generate is still hit-tested.
    await expect.poll(queued, { intervals: [10] }).toBe(before + press);
    expect(await hitAt(page, generate)).toMatch(/^Generate/);
  }
  expect(await generated(page)).toBe(2);
  expect(await queueCaptures.evaluate(({ captures, observer }) => {
    observer.disconnect();
    return [...captures];
  }), 'draining queue parts must not be captured').toEqual([]);

  // Names alone miss an empty native transition: React can start one for a
  // mounted boundary whose enter class is "none". Observe a real retry's
  // take/restore cycle and require it to start no document capture at all.
  const retry = await page.evaluateHandle(async () => {
    const storeUrl = '/src/store/atelier.ts';
    const { useAtelierStore } = await import(/* @vite-ignore */ storeUrl) as { useAtelierStore: typeof AtelierStore };
    let taken = false;
    let restored = false;
    let starts = 0;
    const original = document.startViewTransition.bind(document);
    document.startViewTransition = (...args) => {
      starts += 1;
      return original(...args);
    };
    const unsubscribe = useAtelierStore.subscribe((state, previous) => {
      if (!state.draining) return;
      if (previous.draft.rollQueue.length > 0 && state.draft.rollQueue.length === 0) taken = true;
      if (taken && state.draft.rollQueue.length > 0) restored = true;
    });
    return {
      done: () => restored,
      finish: () => {
        unsubscribe();
        document.startViewTransition = original;
        return starts;
      },
    };
  });
  await expect.poll(() => retry.evaluate((state) => state.done()), { intervals: [10], timeout: 10_000 }).toBe(true);
  // Allow the restored parts' passive/deferred work to commit too.
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => { resolve(); });
    });
  }));
  expect(await retry.evaluate((state) => state.finish()), 'a drain retry must not start an empty native transition').toBe(0);
});

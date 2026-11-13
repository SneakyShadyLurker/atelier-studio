import { expect, test, type Page } from '@playwright/test';
import {
  bar, beginFeed, beginResolving, evidence, field, finishFrozen, focusLosses, instrument,
  openComposer, releaseFeed, state, transitionCount, writeFeed,
} from './harness/composerTyping';

// Typing in the Composer while the feed changes underneath it. Two rules are
// pinned here: work arriving in the background starts no view transition at
// all (lib/feedMotion), and a transition the reader did start (a batch
// leaving) never costs an input event, a focus move or a press
// (lib/viewTransitionGuard). `beginFeed` holds such a transition in its
// preparation window, where React handles no event and hit-testing targets
// the root, so each test below acts inside that window.

// Trace action snapshots themselves wait for paint during capture preparation,
// outlasting Chromium's native update deadline. Keep the independent JSON log.
test.use({ trace: 'off' });

const PROMPT = 'TEXTAREA#atelier-composer-prompt[Prompt]';

const generated = (page: Page) => page.evaluate(() => (window as Window & { __studioGenerated?: number }).__studioGenerated ?? 0);

async function placeCaret(page: Page, start: number, end = start) {
  await field(page).focus();
  await field(page).evaluate((input, range) => {
    if (input instanceof HTMLTextAreaElement) input.setSelectionRange(range.start, range.end);
  }, { start, end });
}

async function promptBox(page: Page) {
  const box = await field(page).boundingBox();
  if (!box) throw new Error('Missing prompt');
  return box;
}

test.afterEach(async ({ page }, info) => {
  if (!page.isClosed()) await evidence(page, info);
});

test('background batches and finished tiles start no view transition', async ({ page }) => {
  await openComposer(page);
  await instrument(page);
  await placeCaret(page, 6);
  const before = await transitionCount(page);
  await writeFeed(page, 'insert', 'typing-background');
  await page.keyboard.type('XY');
  await writeFeed(page, 'complete', 'typing-background');
  await page.keyboard.type('Z');
  expect(await transitionCount(page), 'a background write must not start a view transition').toBe(before);
  expect(await state(page)).toMatchObject({ dom: 'alpha XYZomega', store: 'alpha XYZomega', start: 9, end: 9, active: PROMPT });
});

// The feed follows a batch that enters at its newest end, which pushes every
// row up. With no view transition to interpolate them, lib/feedFollow eases
// that distance: the row that was newest travels over several frames and
// never moves back down.
test('rows ease up as a batch enters, with no view transition', async ({ page }) => {
  await openComposer(page);
  await instrument(page);
  const before = await transitionCount(page);
  const { frames: tops, margins } = await page.evaluate(async () => {
    const rows = document.querySelectorAll<HTMLElement>('[data-testid="canvas-scroller"] section[data-batch-id]');
    const row = rows[rows.length - 1];
    if (!row || !window.__studioMotion) throw new Error('Missing feed row or motion fixture');
    const scroller = document.querySelector<HTMLElement>('[data-testid="canvas-scroller"]');
    const list = document.querySelector<HTMLElement>('[data-virtualized="canvas"]');
    if (!scroller || !list) throw new Error('Missing feed scroller or list');
    const frames: number[] = [];
    const margins: number[] = [];
    let sampling = true;
    const sample = () => {
      if (!sampling) return;
      frames.push(Math.round(row.getBoundingClientRect().top));
      // Where the list starts inside the scroller: what Canvas measures as
      // the virtualizer's scroll margin.
      margins.push(Math.round(list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop));
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    await new Promise((resolve) => { setTimeout(resolve, 100); });
    window.__studioMotion.insert('typing-follow');
    // The eased steps, short of a late estimate correction by the virtualizer.
    await new Promise((resolve) => { setTimeout(resolve, 250); });
    sampling = false;
    return { frames, margins };
  });
  expect(await transitionCount(page), 'a batch entering must not start a view transition').toBe(before);
  // The ease moves the rows, never the list the scroll margin is measured from.
  expect(new Set(margins).size, `the list's scroll margin holds still: ${margins.join(',')}`).toBe(1);
  const start = tops[0] ?? 0;
  const moving = tops.findIndex((top) => top < start - 4);
  expect(moving, `the feed followed the new batch: ${tops.join(',')}`).toBeGreaterThan(0);
  // The eased motion: the 150 ms after the first step. (WebKit's virtualizer
  // may still correct an estimate later, a single step this does not ease.)
  const eased = tops.slice(moving - 1, moving + 9);
  expect(start - (eased[eased.length - 1] ?? start), 'the rows travelled').toBeGreaterThan(100);
  expect(new Set(eased).size, `the row travels through intermediate positions: ${tops.join(',')}`).toBeGreaterThanOrEqual(5);
  // An estimate correction eased on top of the follow can overlap it by a
  // pixel or two; a jump to the end and back (tens of pixels) must not happen.
  for (let index = 1; index < eased.length; index += 1) {
    expect((eased[index] ?? 0) <= (eased[index - 1] ?? 0) + 6, `the row never jumps back down: ${tops.join(',')}`).toBe(true);
  }
});

test('mid-text typing during feed preparation reaches the draft and keeps the caret', async ({ page }) => {
  await openComposer(page);
  await instrument(page);
  await placeCaret(page, 6);
  await beginFeed(page);
  await page.keyboard.type('XYZ');
  const during = await state(page);
  await releaseFeed(page);
  expect.soft(await focusLosses(page, PROMPT), 'the prompt must keep focus throughout typing').toBe(0);
  expect.soft(during.store, 'every native input must reach draft.prompt during preparation').toBe('alpha XYZomega');
  expect.soft(await state(page)).toMatchObject({ dom: 'alpha XYZomega', store: 'alpha XYZomega', start: 9, end: 9, active: PROMPT });
});

test('the submit shortcut during feed preparation submits once', async ({ page }) => {
  await openComposer(page);
  await instrument(page);
  await field(page).focus();
  await beginFeed(page);
  await page.keyboard.press('ControlOrMeta+Enter');
  await releaseFeed(page);
  await expect.poll(() => generated(page), { message: 'the React submit shortcut must survive preparation' }).toBe(1);
});

test('a later background update keeps text typed during preparation', async ({ page }) => {
  await openComposer(page);
  await instrument(page);
  await placeCaret(page, 6);
  await beginFeed(page);
  await page.keyboard.type('XYZ');
  await releaseFeed(page);
  // Any Composer re-render rewrites the field from the draft: a draft that
  // missed the keystrokes used to erase them and throw the caret to the end.
  await beginResolving(page);
  await expect(field(page)).toHaveValue('alpha XYZomega');
  expect(await state(page)).toMatchObject({ store: 'alpha XYZomega', start: 9, end: 9 });
});

test('Generate after preparation submits the text visible in the field', async ({ page }) => {
  await openComposer(page);
  await instrument(page);
  await placeCaret(page, 6);
  await beginFeed(page);
  await page.keyboard.type('XYZ');
  await releaseFeed(page);
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect.poll(() => generated(page)).toBe(1);
  const sent = await page.evaluate(async () => {
    const history = await (await fetch('/api/history')).json() as { items: { id: string; prompt: string }[] };
    return history.items.find(item => item.id === 'studio-generated-1')?.prompt;
  });
  expect(sent, 'Generate must submit every visible edit').toBe('alpha XYZomega');
});

for (const path of ['programmatic', 'keyboard'] as const) {
  test(`${path} focus entering the prompt during preparation survives the commit`, async ({ page }) => {
    await openComposer(page);
    await instrument(page);
    // React records the focused element when the commit begins and restores
    // it afterwards: start from Generate (or the prompt's Tab predecessor).
    await page.getByRole('button', { name: 'Generate', exact: true }).focus();
    if (path === 'keyboard') {
      await field(page).focus();
      await page.keyboard.press('Shift+Tab');
    }
    await beginFeed(page);
    if (path === 'programmatic') await field(page).focus();
    else await page.keyboard.press('Tab');
    await expect(field(page), 'focus entered the prompt before the mutation').toBeFocused();
    await releaseFeed(page);
    expect((await state(page)).active).toBe(PROMPT);
  });
}

test('a caret press during preparation keeps prompt focus and moves the caret', async ({ page }) => {
  await openComposer(page);
  await instrument(page);
  for (const text of ['alpha omega', '']) {
    await field(page).fill(text);
    await page.waitForTimeout(700);
    await placeCaret(page, text.length);
    const box = await promptBox(page);
    await beginFeed(page);
    // On the first text line: a press below the last line puts the caret at
    // the end of the text in WebKit.
    await page.mouse.click(box.x + 10, box.y + 12);
    const during = await state(page);
    await releaseFeed(page);
    expect.soft(during.active, 'focus must stay in the prompt even during preparation').toBe(PROMPT);
    if (text !== '') expect.soft(during.start, 'the press must move the caret to the pressed position').toBeLessThan(3);
    expect.soft((await state(page)).collapsed, 'a root-targeted inside press must not minimize even an empty draft').toBeNull();
    await expect(field(page)).toBeFocused();
  }
});

test('a press on another control during preparation activates it once', async ({ page }) => {
  await openComposer(page);
  await instrument(page);
  await field(page).focus();
  const box = await page.getByRole('button', { name: 'Generate', exact: true }).boundingBox();
  if (!box) throw new Error('Missing Generate');
  await beginFeed(page);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await releaseFeed(page);
  await expect.poll(() => generated(page), { message: 'the press must reach Generate' }).toBe(1);
  await page.waitForTimeout(300);
  expect(await generated(page), 'and activate it only once').toBe(1);
});

test('a prompt press while the dock is captured reaches the prompt', async ({ page, browserName }) => {
  test.skip(browserName !== 'webkit', 'Only engines without nested groups capture the dock in a feed transition.');
  await openComposer(page);
  await instrument(page);
  await placeCaret(page, 'alpha omega'.length);
  const box = await promptBox(page);
  await beginFeed(page, true);
  await releaseFeed(page, true);
  await page.mouse.click(box.x + 20, box.y + 12);
  const result = await state(page);
  await finishFrozen(page);
  expect(result.active, 'a press during the dock snapshot must reach the prompt').toBe(PROMPT);
  expect(result.start, 'a delivered press must reposition the caret').toBeLessThan('alpha omega'.length);
});

test('focused unsent edits prevent idle yield while work runs', async ({ page }) => {
  await openComposer(page);
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect.poll(() => generated(page)).toBe(1);
  await page.waitForTimeout(700);
  await instrument(page);
  await page.clock.install();
  await field(page).focus();
  await page.keyboard.type(' and more');
  await page.mouse.move(800, 250);
  await page.clock.runFor(6100);
  expect((await state(page)).collapsed, 'a focused prompt holding unsent edits must not idle-yield').toBeNull();
  await expect(field(page)).toBeFocused();
  // Submitting ends the composition: with no further edits the Composer
  // yields after the idle delay, as before.
  await page.keyboard.press('ControlOrMeta+Enter');
  await page.clock.runFor(6100);
  expect((await state(page)).collapsed, 'after a submit with no further edits the Composer yields').toBe('true');
});

test('text edited back to what was submitted no longer holds the Composer open', async ({ page }) => {
  await openComposer(page);
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect.poll(() => generated(page)).toBe(1);
  await page.waitForTimeout(700);
  await instrument(page);
  await page.clock.install();
  await placeCaret(page, 'alpha omega'.length);
  await page.keyboard.type('xy');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.mouse.move(800, 250);
  await page.clock.runFor(6100);
  expect((await state(page)).collapsed, 'the field holds only what was sent').toBe('true');
});

test('typing after a yield resumes at the caret the field had', async ({ page }) => {
  await openComposer(page);
  await instrument(page);
  await placeCaret(page, 6, 11);
  await page.keyboard.press('Escape');
  await expect(bar(page)).toBeFocused();
  await page.keyboard.type('X');
  await expect(field(page)).toBeFocused();
  expect(await state(page)).toMatchObject({ dom: 'alpha X', store: 'alpha X', start: 7, end: 7 });
});

// The Composer unmounts on a managed view; the field it comes back with has
// never held the reader's caret and reports its selection at 0.
test('typing on the bar after returning from another view appends at the end', async ({ page }) => {
  await openComposer(page);
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(field(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Back to Unsorted' }).click();
  await expect(page.getByTestId('canvas-scroller')).toBeVisible();
  await instrument(page);
  if (!(await bar(page).isVisible())) await page.getByRole('button', { name: 'Minimize composer' }).click();
  await bar(page).focus();
  await page.keyboard.type('X');
  await expect(field(page)).toBeFocused();
  expect(await state(page)).toMatchObject({ dom: 'alpha omegaX', store: 'alpha omegaX', start: 12, end: 12 });
});

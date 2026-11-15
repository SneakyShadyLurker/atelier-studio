import type { Locator, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

/*
 * Text models (`?view=text-models`) against the offline studio fixture's
 * populated setup (`textModels=1`): Atlas (low/medium/high effort) is the
 * default at High effort, Enhance is assigned to Quill (fixed effort), Test
 * Alpha is always written by Atlas at Low effort, and the signed-in person
 * picked Quill for Story planner. `textAdmin=1` makes them a text admin;
 * without it the admin probe 404s.
 */

const ADMIN = '/e2e/studio/index.html?view=text-models&textAdmin=1&textModels=1';
const PERSON = '/e2e/studio/index.html?view=text-models&textModels=1';

interface TextWrite {
  readonly path: string;
  readonly body: unknown;
}

const textWrites = (page: Page) => page.evaluate(() =>
  (window as Window & { __studioTextWrites?: TextWrite[] }).__studioTextWrites ?? []);

const noHorizontalOverflow = (page: Page) => page.evaluate(() =>
  document.documentElement.scrollWidth <= window.innerWidth + 1);

const view = (page: Page) => page.getByRole('region', { name: 'Text models', exact: true });

async function box(locator: Locator) {
  const rect = await locator.boundingBox();
  if (!rect) throw new Error('element has no box');
  return rect;
}

/** Every feature row of Shared setup puts its controls under the label, full width, with nothing scrolling sideways. */
async function expectStackedRows(page: Page) {
  await page.goto(ADMIN);
  const features = page.getByRole('region', { name: 'Features', exact: true });
  await expect(features.getByRole('button', { name: 'Default model, currently Atlas', exact: true })).toBeVisible();
  const triggers = page.getByRole('tabpanel').getByRole('button', { name: /^(Default model|Model for .+|Prompt writer for .+), currently / });
  // Default model, eleven features and two image models.
  await expect(triggers).toHaveCount(14);
  const rows = await triggers.evaluateAll((buttons) => buttons.map((button) => {
    // Model chip → its slot → the controls grid → the feature row.
    const controls = button.parentElement?.parentElement;
    const row = controls?.parentElement;
    const main = row?.firstElementChild;
    if (!controls || !row || !main || main === controls) throw new Error('missing feature row');
    const label = button.getAttribute('aria-label') ?? '';
    const [controlsBox, mainBox, rowBox] = [controls, main, row].map((node) => node.getBoundingClientRect());
    if (!controlsBox || !mainBox || !rowBox) throw new Error('missing feature row box');
    return {
      label,
      below: controlsBox.top >= mainBox.bottom - 0.5,
      fullWidth: Math.abs(controlsBox.width - rowBox.width) <= 1,
      inside: controlsBox.right <= rowBox.right + 0.5 && controls.scrollWidth <= controls.clientWidth + 1,
    };
  }));
  for (const row of rows) {
    expect(row, row.label).toEqual({ label: row.label, below: true, fullWidth: true, inside: true });
  }
  expect(await noHorizontalOverflow(page)).toBe(true);
  expect(await view(page).evaluate((element) => [...element.querySelectorAll('[data-zone]')]
    .every((node) => node.scrollWidth <= node.clientWidth + 1))).toBe(true);
}

test.describe('Text models for someone who is not a text admin', () => {
  test('shows Your picks alone, without tabs, and leaves out a gated Prompt Library', async ({ page }) => {
    await page.goto(`${PERSON}&libraryGated=1`);
    await expect(view(page).getByRole('heading', { level: 2, name: 'Text models', exact: true })).toBeVisible();
    const picks = page.getByRole('region', { name: 'Your picks', exact: true });
    await expect(picks.getByRole('heading', { level: 3, name: 'Your picks', exact: true })).toBeVisible();
    await expect(page.getByRole('tablist')).toHaveCount(0);
    await expect(page.getByRole('tab')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Features', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add provider', exact: true })).toHaveCount(0);
    await expect(picks.getByRole('group', { name: 'Composer', exact: true })).toBeVisible();
    await expect(picks.getByRole('group', { name: 'Stories', exact: true })).toBeVisible();
    await expect(picks.getByRole('group', { name: 'Prompt Library', exact: true })).toHaveCount(0);
    await expect(picks.getByRole('button', { name: /^Text model for AI fill,/ })).toHaveCount(0);
    // The locked prompt writer is named above the rows.
    await expect(view(page).getByRole('note')).toHaveText('Test Alpha is always written by Atlas, whichever model you pick.');
    // An unset row follows the shared setup: ↳ and the model it inherits.
    const motion = picks.getByRole('button', { name: /^Text model for Motion writer,/ });
    await expect(motion).toHaveAccessibleName('Text model for Motion writer, currently Shared setup (Atlas)');
    await expect(motion.locator('span').first()).toHaveText('↳ Atlas');
    await expect(picks.getByRole('button', { name: 'Text model for Enhance, currently Shared setup (Quill)', exact: true })).toBeVisible();
    await expect(picks.getByRole('button', { name: 'Text model for Story planner, currently Quill', exact: true })).toBeVisible();
    await motion.click();
    const menu = page.getByRole('listbox', { name: /^Text model for Motion writer,/ });
    await expect(menu.getByRole('option').first()).toHaveAccessibleName('Shared setup (Atlas)');
    await menu.getByRole('option', { name: 'Atlas', exact: true }).click();
    await expect(menu).toHaveCount(0);
    await expect(motion).toHaveAccessibleName('Text model for Motion writer, currently Atlas');
    const effort = picks.getByRole('button', { name: /^Reasoning effort for Motion writer,/ });
    await expect(effort).toHaveAccessibleName('Reasoning effort for Motion writer, currently Default effort');
    expect(await textWrites(page)).toEqual([{ path: '/api/text-models/tasks/motion', body: { modelId: 'text-model-atlas' } }]);
  });

  test('lists the Prompt Library features once the Library answers', async ({ page }) => {
    await page.goto(PERSON);
    const picks = page.getByRole('region', { name: 'Your picks', exact: true });
    await expect(picks.getByRole('group', { name: 'Prompt Library', exact: true })).toBeVisible();
    await expect(picks.getByRole('button', { name: 'Text model for AI fill, currently Shared setup (Atlas)', exact: true })).toBeVisible();
    await expect(page.getByRole('tablist')).toHaveCount(0);
  });
});

test.describe('Text models for a text admin', () => {
  test('lands on Shared setup and the three tabs rove with the arrow keys', async ({ page }) => {
    await page.goto(ADMIN);
    const strip = page.getByRole('tablist', { name: 'Text models sections', exact: true });
    await expect(strip.getByRole('tab')).toHaveText(['Shared setup', 'Your picks', 'Providers']);
    const shared = strip.getByRole('tab', { name: 'Shared setup', exact: true });
    const picks = strip.getByRole('tab', { name: 'Your picks', exact: true });
    const providers = strip.getByRole('tab', { name: 'Providers', exact: true });
    await expect(shared).toHaveAttribute('aria-selected', 'true');
    await expect(picks).toHaveAttribute('aria-selected', 'false');
    await expect(providers).toHaveAttribute('aria-selected', 'false');
    const panel = page.getByRole('tabpanel');
    await expect(panel).toHaveCount(1);
    await expect(panel).toHaveAccessibleName('Shared setup');
    await expect(panel.getByRole('region', { name: 'Features', exact: true })).toBeVisible();
    await expect(panel.getByRole('region', { name: 'Image models', exact: true })).toBeVisible();

    await shared.focus();
    await page.keyboard.press('ArrowRight');
    await expect(picks).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(picks).toHaveAttribute('aria-selected', 'true');
    await expect(picks).toHaveAttribute('tabindex', '0');
    await expect(shared).toHaveAttribute('tabindex', '-1');
    await expect(panel).toHaveAccessibleName('Your picks');
    await expect(panel.getByRole('region', { name: 'Your picks', exact: true })).toBeVisible();
    await expect(panel.getByRole('region', { name: 'Features', exact: true })).toHaveCount(0);

    await page.keyboard.press('ArrowRight');
    await expect(providers).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(providers).toHaveAttribute('aria-selected', 'true');
    await expect(panel).toHaveAccessibleName('Providers');
    // Add provider is the tab's first row, above the inventory.
    const add = panel.getByRole('button', { name: 'Add provider', exact: true });
    await expect(add).toBeVisible();
    const provider = panel.getByRole('region', { name: 'Preview provider', exact: true });
    await expect(provider).toBeVisible();
    expect((await box(add)).y).toBeLessThan((await box(provider)).y);

    // Arrows wrap at both ends.
    await page.keyboard.press('ArrowRight');
    await expect(shared).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(providers).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(picks).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(panel).toHaveAccessibleName('Your picks');
    await page.keyboard.press('ArrowLeft');
    await expect(shared).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(shared).toHaveAttribute('aria-selected', 'true');
    await expect(panel).toHaveAccessibleName('Shared setup');
  });

  test('lands on Providers while no provider exists', async ({ page }) => {
    await page.goto('/e2e/studio/index.html?view=text-models&textAdmin=1');
    const providers = page.getByRole('tab', { name: 'Providers', exact: true });
    await expect(providers).toHaveAttribute('aria-selected', 'true');
    const panel = page.getByRole('tabpanel');
    await expect(panel).toHaveAccessibleName('Providers');
    await expect(panel.getByRole('heading', { name: 'No text model yet', exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Add provider', exact: true })).toBeVisible();
  });

  test('Shared setup shows each assignment with its effort and the writer with its mode', async ({ page }) => {
    await page.goto(ADMIN);
    const features = page.getByRole('region', { name: 'Features', exact: true });
    await expect(features.getByRole('button', { name: 'Default model, currently Atlas', exact: true })).toBeVisible();
    await expect(features.getByRole('button', { name: 'Reasoning effort for Default model, currently High effort', exact: true })).toBeVisible();
    for (const group of ['Composer', 'Stories', 'Prompt Library']) {
      await expect(features.getByRole('group', { name: group, exact: true })).toBeVisible();
    }
    await expect(features.getByRole('button', { name: 'Model for Enhance, currently Quill', exact: true })).toBeVisible();
    await expect(features.getByText('Effort fixed by the model', { exact: true })).toHaveCount(1);
    // An unassigned feature follows the default model and offers no effort of its own.
    await expect(features.getByRole('button', { name: 'Model for Motion writer, currently Default model (Atlas)', exact: true })).toBeVisible();
    await expect(features.getByRole('button', { name: /^Reasoning effort for Motion writer,/ })).toHaveCount(0);
    const writers = page.getByRole('region', { name: 'Image models', exact: true });
    await expect(writers.getByRole('button', { name: 'Prompt writer for Test Alpha, currently Atlas', exact: true })).toBeVisible();
    await expect(writers.getByRole('button', { name: 'Reasoning effort for Test Alpha, currently Low effort', exact: true })).toBeVisible();
    const modes = writers.getByRole('radiogroup', { name: 'When Test Alpha uses Atlas', exact: true });
    await expect(modes.getByRole('radio', { name: 'Always', exact: true })).toBeChecked();
    await expect(modes.getByRole('radio', { name: 'Unless someone picked their own', exact: true })).not.toBeChecked();
    await expect(writers.getByRole('button', { name: 'Prompt writer for GPT Image, currently No writer', exact: true })).toBeVisible();
    await expect(writers.getByRole('radiogroup')).toHaveCount(1);
  });

  test('saving an effort on the Default model sends the model and the effort', async ({ page }) => {
    await page.goto(ADMIN);
    const effort = page.getByRole('button', { name: /^Reasoning effort for Default model,/ });
    await expect(effort).toHaveAccessibleName('Reasoning effort for Default model, currently High effort');
    await effort.click();
    const menu = page.getByRole('listbox', { name: /^Reasoning effort for Default model,/ });
    await expect(menu.getByRole('option')).toHaveText(['Default effort', 'Low', 'Medium', 'High']);
    await menu.getByRole('option', { name: 'Low', exact: true }).click();
    await expect(menu).toHaveCount(0);
    await expect(effort).toHaveAccessibleName('Reasoning effort for Default model, currently Low effort');
    expect(await textWrites(page)).toEqual([
      { path: '/api/text-routing/defaults/default', body: { modelId: 'text-model-atlas', effort: 'low' } },
    ]);
    await effort.click();
    await page.getByRole('option', { name: 'Default effort', exact: true }).click();
    await expect(effort).toHaveAccessibleName('Reasoning effort for Default model, currently Default effort');
    expect((await textWrites(page)).at(-1)).toEqual({ path: '/api/text-routing/defaults/default', body: { modelId: 'text-model-atlas', effort: null } });
  });

  test('"Use the shared model" clears the admin’s own pick', async ({ page }) => {
    await page.goto(ADMIN);
    const features = page.getByRole('region', { name: 'Features', exact: true });
    const note = features.getByText('Your own pick here is Quill.', { exact: false });
    await expect(note).toHaveCount(1);
    const stories = features.getByRole('group', { name: 'Stories', exact: true });
    await expect(stories.getByText('Your own pick here is Quill.', { exact: false })).toBeVisible();
    await stories.getByRole('button', { name: 'Use the shared model', exact: true }).click();
    await expect(note).toHaveCount(0);
    await expect(features.getByRole('button', { name: 'Use the shared model', exact: true })).toHaveCount(0);
    expect(await textWrites(page)).toEqual([{ path: '/api/text-models/tasks/storytelling', body: { modelId: null } }]);
    // Your picks now shows Story planner following the shared setup.
    await page.getByRole('tab', { name: 'Your picks', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Text model for Story planner, currently Shared setup (Atlas)', exact: true })).toBeVisible();
  });

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test('Shared setup stacks each row with its controls below the label and never scrolls sideways', async ({ page }) => {
      await expectStackedRows(page);
    });
  });

  test.describe('in a narrow content column', () => {
    // Just past the phone breakpoint: the phone rules do not apply, and the
    // view's own column is under 720px with or without the sidebar.
    test.use({ viewport: { width: 780, height: 1000 } });

    test('Shared setup stacks its rows by the space the view has, not by the viewport', async ({ page }) => {
      await expectStackedRows(page);
    });
  });

  test.describe('on a wide window', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('Shared setup keeps label and controls on one line, the chips in one column', async ({ page }) => {
      await page.goto(ADMIN);
      const features = page.getByRole('region', { name: 'Features', exact: true });
      const defaultChip = features.getByRole('button', { name: 'Default model, currently Atlas', exact: true });
      await expect(defaultChip).toBeVisible();
      const chips = features.getByRole('button', { name: /^(Default model|Model for .+), currently / });
      await expect(chips).toHaveCount(12);
      const geometry = await chips.evaluateAll((buttons) => buttons.map((button) => {
        const controls = button.parentElement?.parentElement;
        const main = controls?.parentElement?.firstElementChild;
        if (!controls || !main) throw new Error('missing feature row');
        const chipBox = button.getBoundingClientRect();
        const mainBox = main.getBoundingClientRect();
        return { left: Math.round(chipBox.left), width: Math.round(chipBox.width), beside: chipBox.left >= mainBox.right - 0.5 };
      }));
      const first = geometry[0];
      if (!first) throw new Error('no chips');
      for (const chip of geometry) expect(chip).toEqual({ left: first.left, width: first.width, beside: true });
      // Wide enough for a long model name behind the inherited-value arrow.
      expect(first.width).toBeGreaterThanOrEqual(220);
    });
  });
});

import type { Locator, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

/*
 * Prompt Library editors on a phone (design 5, audit 11): the editor head is
 * one row (title, Save, More) so the body gets the space, the tab strip
 * scrolls with an edge fade and keeps the active tab in view, and an option
 * row is name + weight + More. Layout is asserted through the scroll-surface
 * zones ([data-zone]) and bounding boxes; happy-dom cannot see either.
 */
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });

async function openLibrary(page: Page): Promise<void> {
  await page.goto('/e2e/harness/index.html?case=library');
  await expect(page.getByRole('form', { name: /template/i })).toBeVisible();
}

async function box(locator: Locator) {
  const rect = await locator.boundingBox();
  if (!rect) throw new Error('element has no box');
  return rect;
}

function centreY(rect: { y: number; height: number }): number {
  return rect.y + rect.height / 2;
}

test.describe('phone prompt library editors', () => {
  test('template head is one row: title, Save and More, with Draft and Delete behind More', async ({ page }) => {
    await openLibrary(page);
    const editor = page.getByRole('form', { name: /template/i });
    const head = editor.locator('[data-zone="head"]');
    const body = editor.locator('[data-zone="body"]');
    const name = head.getByRole('textbox', { name: 'Template name' });
    const save = head.getByRole('button', { name: 'Save template' });
    const more = head.getByRole('button', { name: 'More template actions' });

    await expect(head.getByRole('button', { name: /Draft Template/ })).toHaveCount(0);
    const [nameBox, saveBox, moreBox, headBox, bodyBox] = await Promise.all([box(name), box(save), box(more), box(head), box(body)]);
    // One row: Save and More share the title's line, all inside the head zone.
    expect(Math.abs(centreY(saveBox) - centreY(moreBox))).toBeLessThanOrEqual(2);
    expect(saveBox.y).toBeLessThan(nameBox.y + nameBox.height);
    expect(saveBox.x).toBeGreaterThan(nameBox.x);
    expect(moreBox.x + moreBox.width).toBeLessThanOrEqual(headBox.x + headBox.width + 0.5);
    // The editable body gets the primary space.
    expect(bodyBox.height).toBeGreaterThan(headBox.height * 2);
    await expect(body.getByRole('textbox', { name: 'Body' })).toBeVisible();

    await more.click();
    const menu = page.getByRole('menu', { name: 'Template actions' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Draft Template/ })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Delete template' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(more).toBeFocused();
  });

  test('all four tabs sit fully inside the strip at 390px, beside the help button on the title row', async ({ page }) => {
    await openLibrary(page);
    const strip = page.getByRole('tablist', { name: 'Prompt Library sections' });
    expect(await strip.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    const stripBox = await box(strip);
    for (const name of ['Templates', 'Variable lists', 'Dimensions', 'Settings']) {
      const tab = await box(page.getByRole('tab', { name }));
      expect(tab.x, `${name} starts inside the strip`).toBeGreaterThanOrEqual(stripBox.x - 0.5);
      expect(tab.x + tab.width, `${name} ends inside the strip`).toBeLessThanOrEqual(stripBox.x + stripBox.width + 0.5);
      // The touch gate gives every tab the 44px floor.
      expect(tab.height, `${name} touch floor`).toBeGreaterThanOrEqual(44);
    }
    // Help left the strip for the title row and keeps its touch target.
    const help = await box(page.getByRole('button', { name: 'How the Prompt Library works' }));
    const title = await box(page.getByRole('heading', { name: 'Prompt Library' }));
    expect(help.width).toBeGreaterThanOrEqual(44);
    expect(help.height).toBeGreaterThanOrEqual(44);
    expect(help.y + help.height).toBeLessThanOrEqual(stripBox.y + 0.5);
    expect(centreY(help)).toBeLessThan(title.y + title.height);
  });

  test('a narrower phone scrolls the tab strip with an edge fade and keeps the active tab in view', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await openLibrary(page);
    const strip = page.getByRole('tablist', { name: 'Prompt Library sections' });
    const geometry = await strip.evaluate((el) => ({
      overflows: el.scrollWidth > el.clientWidth,
      mask: getComputedStyle(el).maskImage || getComputedStyle(el).getPropertyValue('-webkit-mask-image'),
    }));
    expect(geometry.overflows).toBe(true);
    expect(geometry.mask).toContain('linear-gradient');

    // Settings is reachable: select it and it ends up inside the strip.
    const settings = page.getByRole('tab', { name: 'Settings' });
    await settings.click();
    await expect(settings).toHaveAttribute('aria-selected', 'true');
    await page.waitForTimeout(100);
    const [stripBox, settingsBox] = await Promise.all([box(strip), box(settings)]);
    expect(settingsBox.x).toBeGreaterThanOrEqual(stripBox.x - 0.5);
    expect(settingsBox.x + settingsBox.width).toBeLessThanOrEqual(stripBox.x + stripBox.width + 0.5);

    // Back to the first tab: it scrolls back into view too.
    const templates = page.getByRole('tab', { name: 'Templates' });
    await templates.click();
    await page.waitForTimeout(100);
    const [stripAgain, templatesBox] = await Promise.all([box(strip), box(templates)]);
    expect(templatesBox.x).toBeGreaterThanOrEqual(stripAgain.x - 0.5);
  });

  test('a variable-list option row is name, weight and More on one line', async ({ page }) => {
    await openLibrary(page);
    await page.getByRole('tab', { name: 'Variable lists' }).click();
    const editor = page.getByRole('form', { name: 'Edit variable list mood' });
    await expect(editor).toBeVisible();
    const head = editor.locator('[data-zone="head"]');
    await expect(head.getByRole('button', { name: 'More list actions' })).toBeVisible();
    await expect(head.getByRole('button', { name: /Draft List/ })).toHaveCount(0);

    const body = editor.locator('[data-zone="body"]');
    const name = body.getByRole('textbox', { name: 'Option 1: serene' });
    const weight = body.getByRole('spinbutton').first();
    const more = body.getByRole('button', { name: 'More actions for serene' });
    await expect(body.getByRole('button', { name: /tags for serene/ })).toHaveCount(0);
    await expect(body.getByRole('button', { name: 'Remove option serene' })).toHaveCount(0);

    const [nameBox, weightBox, moreBox, bodyBox] = await Promise.all([box(name), box(weight), box(more), box(body)]);
    expect(Math.abs(centreY(nameBox) - centreY(weightBox))).toBeLessThanOrEqual(2);
    expect(Math.abs(centreY(nameBox) - centreY(moreBox))).toBeLessThanOrEqual(2);
    expect(moreBox.x + moreBox.width).toBeLessThanOrEqual(bodyBox.x + bodyBox.width + 0.5);
    expect(nameBox.width).toBeGreaterThan(150);

    // Tags and Remove stay reachable behind the row's More.
    await more.click();
    const menu = page.getByRole('menu', { name: 'Option 1 actions' });
    await menu.getByRole('menuitem', { name: 'Show tags' }).click();
    await expect(menu).toHaveCount(0);
    await expect(body.getByText('Create dimensions before assigning tags.')).toBeVisible();
    await more.click();
    await page.getByRole('menu', { name: 'Option 1 actions' }).getByRole('menuitem', { name: 'Remove option' }).click();
    await expect(body.getByRole('textbox', { name: /serene/ })).toHaveCount(0);
  });
});

test.describe('desktop prompt library editors', () => {
  test.use({ viewport: { width: 1280, height: 800 }, hasTouch: false, isMobile: false, deviceScaleFactor: 1 });

  test('keep Draft, Tags and Remove inline with no More', async ({ page }) => {
    await openLibrary(page);
    const head = page.getByRole('form', { name: /template/i }).locator('[data-zone="head"]');
    await expect(head.getByRole('button', { name: /Draft Template/ })).toBeVisible();
    await expect(head.getByRole('button', { name: 'More template actions' })).toHaveCount(0);

    await page.getByRole('tab', { name: 'Variable lists' }).click();
    const body = page.getByRole('form', { name: 'Edit variable list mood' }).locator('[data-zone="body"]');
    await expect(body.getByRole('button', { name: 'Show tags for serene' })).toBeVisible();
    await expect(body.getByRole('button', { name: 'Remove option serene' })).toBeVisible();
    await expect(body.getByRole('button', { name: 'More actions for serene' })).toHaveCount(0);
  });
});

import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

/*
 * The prompt picker's axis sheet is a body-level portal stacked over the
 * picker's own sheet and backdrop — two full-screen tap-catchers, one on top of
 * the other. happy-dom can assert the handlers; only a real browser can confirm
 * the stack actually hit-tests the way the handlers assume, with real layout,
 * real z-order and a real tap.
 *
 * Ceiling worth knowing: this lane is Chromium-only, and the WebKit-specific
 * click retargeting that made the original bug user-visible cannot be
 * reproduced here. These guard the policy (which layer a tap reaches, and that
 * no soft keyboard is summoned), not the platform behaviour.
 */
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });

async function openAxisSheet(page: Page): Promise<void> {
  await page.goto('/e2e/harness/index.html?case=picker');
  await page.getByRole('button', { name: 'Harness template' }).tap();
  await page.getByRole('button', { name: /^Advanced/ }).tap();
  await page.getByRole('button', { name: /Choose mood value/ }).tap();
  await expect(page.getByRole('dialog', { name: 'mood' })).toBeVisible();
}

test.describe('phone prompt picker', () => {
  test('pinning a value from the axis sheet leaves the picker open', async ({ page }) => {
    await openAxisSheet(page);

    await page.getByRole('button', { name: 'brooding' }).tap();

    await expect(page.getByRole('dialog', { name: 'mood' })).toBeHidden();
    await expect(page.locator('#picker-state')).toHaveText('open');
    await expect(page.getByLabel('Resolved prompt preview')).toContainText('brooding');
  });

  test('dismissing the axis sheet from its backdrop closes only the axis sheet', async ({ page }) => {
    await openAxisSheet(page);

    // The dimmed strip above the sheet — the natural "never mind" gesture, and
    // the one that used to take the whole library with it.
    const sheetTop = await page.getByRole('dialog', { name: 'mood' })
      .evaluate((el) => el.getBoundingClientRect().top);
    await page.touchscreen.tap(195, Math.max(24, sheetTop / 2));

    await expect(page.getByRole('dialog', { name: 'mood' })).toBeHidden();
    await expect(page.locator('#picker-state')).toHaveText('open');
  });

  // The footer used to wrap into three rows because `.controls` needed 431px
  // against 351px of content width, orphaning `Stash & roll` on its own
  // right-aligned line. The instrument strip is nowrap and the readout
  // ellipsizes, so no label state can reintroduce the wrap.
  test('the refine footer holds two rows and never wraps', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?case=picker');
    await page.getByRole('button', { name: 'Harness template' }).tap();
    await page.waitForTimeout(250);

    const shape = await page.evaluate(() => {
      const foot = document.querySelector('[data-zone="foot"]');
      if (!foot) throw new Error('no footer');
      const buttons = [...foot.querySelectorAll('button')];
      const tops = [...new Set(buttons.map((b) => Math.round(b.getBoundingClientRect().top)))];
      const widest = buttons.reduce((a, b) =>
        b.getBoundingClientRect().width > a.getBoundingClientRect().width ? b : a);
      return {
        rows: tops.length,
        height: Math.round(foot.getBoundingClientRect().height),
        widestLabel: widest.getAttribute('aria-label') ?? widest.textContent.trim(),
      };
    });

    expect(shape.rows).toBe(2);
    expect(shape.height).toBeLessThan(140);
    // At speed, size is the tap heuristic — the primary must not lose to a
    // secondary, which is exactly what `Use prompt` (105px) did against
    // `Stash & roll` (122px) before.
    expect(shape.widestLabel).toBe('Use prompt');
  });

  test('the seed readout carries lock and stash state as text', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?case=picker');
    await page.getByRole('button', { name: 'Harness template' }).tap();
    await page.getByRole('button', { name: 'Stash & roll' }).tap();
    await page.getByRole('button', { name: 'Lock seed' }).tap();
    await page.waitForTimeout(200);

    // The icons carry no visible label, so the state they toggle has to be
    // legible somewhere that does not depend on the hover-only tooltip layer.
    const readout = await page.locator('[data-zone="foot"] span').first().textContent();
    expect(readout).toContain('Locked');
    expect(readout).toContain('1 stashed');
  });

  test('the axis sheet opens without summoning the soft keyboard', async ({ page }) => {
    await openAxisSheet(page);

    const focused = await page.evaluate(() => {
      const el = document.activeElement;
      const sheet = document.querySelector('[data-axis-menu-root] [role="dialog"]');
      return {
        isTextField: el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement,
        insideSheet: sheet?.contains(el) ?? false,
      };
    });

    expect(focused.isTextField).toBe(false);
    expect(focused.insideSheet).toBe(true);
  });
});

/*
 * Landscape phone. `min-height` beats `max-height` in CSS, so the panel's 380px
 * floor used to override the sheet's ceiling and take 96% of a 375pt-tall
 * screen. Floor and ceiling are now expressed against the same rule.
 */
test.describe('landscape phone', () => {
  test.use({ viewport: { width: 667, height: 375 }, hasTouch: true, isMobile: true });

  test('the sheet leaves a strip of backdrop rather than taking the screen', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?case=picker');
    await page.getByRole('button', { name: 'Harness template' }).tap();
    await page.waitForTimeout(250);

    const shape = await page.evaluate(() => {
      const panel = document.querySelector('[data-sheet="true"]');
      const body = panel?.querySelector('[data-zone="body"]');
      if (!panel || !body) throw new Error('no sheet');
      return {
        panelTop: Math.round(panel.getBoundingClientRect().top),
        bodyHeight: Math.round(body.getBoundingClientRect().height),
      };
    });

    expect(shape.panelTop).toBeGreaterThanOrEqual(24);
    // Enough room to actually read the prompt it is asking you to approve.
    expect(shape.bodyHeight).toBeGreaterThan(120);
  });
});

/*
 * Pointer devices only — the lock's pressed state has no text label any more,
 * so it rests entirely on the control's own paint. The canonical
 * `.icon:hover:not(:disabled)` outweighs a bare `[aria-pressed='true']`, which
 * would repaint a locked seed back to the unlocked border while the pointer
 * sits on it.
 */
test.describe('desktop picker', () => {
  test.use({ viewport: { width: 1280, height: 900 }, hasTouch: false, isMobile: false });

  test('a locked seed still reads as locked while hovered', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?case=picker');
    await page.getByRole('button', { name: 'Harness template' }).click();
    const lock = page.getByRole('button', { name: 'Lock seed' });
    await lock.click();
    await expect(lock).toHaveAttribute('aria-pressed', 'true');

    await lock.hover();
    // Past the border-color transition, or the read lands mid-interpolation.
    await page.waitForTimeout(300);

    const hovered = await lock.evaluate((el) => {
      const rect = el.querySelector('svg rect');
      if (!rect) throw new Error('no lock glyph');
      return {
        border: getComputedStyle(el).borderTopColor,
        // The filled shackle body is the carrier hover cannot repaint.
        rectFill: getComputedStyle(rect).fill,
      };
    });

    // --ink, the pressed border — NOT the --ink-3 that `.icon:hover` would
    // otherwise win with, which is the unpressed hover treatment.
    expect(hovered.border).toBe('rgb(20, 19, 15)');
    expect(hovered.rectFill).not.toBe('none');
  });

  // Arrow keys used to be swallowed in the capture phase before the menu's own
  // filter/roving handler ran, so the value list was unreachable by keyboard.
  test('arrow keys walk the axis menu from its filter and stay inside it', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?case=picker');
    await page.getByRole('button', { name: 'Harness template' }).click();
    await page.getByRole('button', { name: /^Advanced/ }).click();
    await page.getByRole('button', { name: /Choose mood value/ }).click();
    const menu = page.getByRole('dialog', { name: 'mood' });
    await expect(menu).toBeVisible();
    const filter = menu.getByPlaceholder('Filter values...');
    await expect(filter).toBeFocused();

    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('button', { name: 'Random' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('button', { name: 'serene' })).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(menu.getByRole('button', { name: 'Random' })).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(menu.getByRole('button', { name: 'playful' })).toBeFocused();

    await filter.fill('brood');
    await page.keyboard.press('ArrowUp');
    await expect(menu.getByRole('button', { name: 'brooding' })).toBeFocused();

    await expect(menu).toBeVisible();
    await expect(page.locator('#picker-state')).toHaveText('open');
  });

  // The menu's roving rows are tabindex="-1". The trap used to count them as
  // its boundary, so with Random as the only roving tab stop, Tab from Random
  // walked native order straight out of the menu into the page behind it.
  test('Tab and Shift+Tab from Random stay inside the axis menu', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?case=picker');
    await page.getByRole('button', { name: 'Harness template' }).click();
    await page.getByRole('button', { name: /^Advanced/ }).click();
    await page.getByRole('button', { name: /Choose mood value/ }).click();
    const menu = page.getByRole('dialog', { name: 'mood' });
    await expect(menu.getByPlaceholder('Filter values...')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    const random = menu.getByRole('button', { name: 'Random' });
    await expect(random).toBeFocused();

    const focusInsideMenu = () => page.evaluate(() => {
      const panel = document.querySelector('[data-axis-menu-root] [role="dialog"]');
      return panel !== null && panel.contains(document.activeElement) && document.activeElement !== panel;
    });

    await page.keyboard.press('Tab');
    expect(await focusInsideMenu()).toBe(true);
    // Random is the last tab stop, so Tab wraps to the first (the close button).
    await expect(menu.getByRole('button', { name: 'Close' })).toBeFocused();

    for (let i = 0; i < 6; i += 1) {
      await page.keyboard.press('Tab');
      expect(await focusInsideMenu()).toBe(true);
    }
    for (let i = 0; i < 6; i += 1) {
      await page.keyboard.press('Shift+Tab');
      expect(await focusInsideMenu()).toBe(true);
    }

    await random.focus();
    await page.keyboard.press('Shift+Tab');
    expect(await focusInsideMenu()).toBe(true);
    await expect(menu).toBeVisible();
    await expect(page.locator('#picker-state')).toHaveText('open');
  });

  test('the lock glyph does not borrow the dice animation on open', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?case=picker');
    await page.getByRole('button', { name: 'Harness template' }).click();
    await page.waitForTimeout(250);

    const animations = await page.evaluate(() => {
      const foot = document.querySelector('[data-zone="foot"]');
      if (!foot) throw new Error('no footer');
      return [...foot.querySelectorAll('button')].map((b) => ({
        label: b.getAttribute('aria-label'),
        // `none` for a glyph that was never told to move.
        anim: getComputedStyle(b.querySelector('svg') ?? b).animationName,
      }));
    });

    expect(animations.find((a) => a.label === 'Lock seed')?.anim).toBe('none');
    expect(animations.find((a) => a.label === 'Re-roll')?.anim).toBe('none');
  });
});

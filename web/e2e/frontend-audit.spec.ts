import { expect, test, type Page } from '@playwright/test';

/*
 * Real-browser evidence for the frontend audit fixes that happy-dom cannot see:
 * production stylesheet parity in the harness, modal-scoped toast ownership
 * (top layer / inert root / custom focus trap), and the hoverable,
 * Escape-dismissible data-tip label.
 */

test.use({ viewport: { width: 1280, height: 900 } });

async function openRefine(page: Page): Promise<void> {
  await page.goto('/e2e/harness/index.html?case=picker');
  await page.getByRole('button', { name: 'Harness template' }).click();
  await expect(page.getByRole('button', { name: 'Lock seed' })).toBeVisible();
}

test.describe('harness production styles', () => {
  test('loads global.css: box-sizing, body typography and .srOnly', async ({ page }) => {
    await page.goto('/e2e/harness/index.html?case=picker');
    const probe = await page.evaluate(() => {
      const body = getComputedStyle(document.body);
      const sans = getComputedStyle(document.documentElement).getPropertyValue('--sans').trim();
      const label = document.querySelector<HTMLElement>('label.srOnly');
      if (!label) throw new Error('missing .srOnly label');
      const srOnly = getComputedStyle(label);
      const box = label.getBoundingClientRect();
      const plain = document.body.appendChild(document.createElement('div'));
      const boxSizing = getComputedStyle(plain).boxSizing;
      plain.remove();
      return {
        boxSizing,
        bodyMargin: body.margin,
        bodyFont: body.fontFamily,
        bodyOverflow: body.overflow,
        sans,
        srOnlyPosition: srOnly.position,
        srOnlyClipPath: srOnly.getPropertyValue('clip-path'),
        srOnlyWidth: box.width,
        srOnlyHeight: box.height,
      };
    });
    expect(probe.boxSizing).toBe('border-box');
    expect(probe.bodyMargin).toBe('0px');
    expect(probe.bodyOverflow).toBe('hidden');
    expect(probe.sans).toContain('Helvetica Neue');
    expect(probe.bodyFont).toContain('Helvetica Neue');
    expect(probe.srOnlyPosition).toBe('absolute');
    expect(probe.srOnlyClipPath).toBe('inset(50%)');
    expect(probe.srOnlyWidth).toBeLessThanOrEqual(1);
    expect(probe.srOnlyHeight).toBeLessThanOrEqual(1);
  });
});

test.describe('queue-clear Undo inside the open picker', () => {
  test('Enter activates hosted Undo without dismissing the nested confirmation', async ({ page }) => {
    await openRefine(page);
    const picker = page.getByRole('dialog', { name: 'Templates' });
    await picker.getByRole('button', { name: 'Stash & roll' }).click();
    await picker.getByRole('button', { name: 'Clear', exact: true }).click();
    await picker.getByRole('button', { name: 'Stash & roll' }).click();
    await picker.getByRole('button', { name: 'Back to template list' }).click();
    const confirm = page.getByRole('dialog', { name: 'Clear queued rolls?' });
    const undo = confirm.getByRole('button', { name: 'Undo', exact: true });
    await expect(undo).toBeVisible();
    await undo.hover();
    let reached = false;
    for (let i = 0; i < 6 && !reached; i += 1) {
      await page.keyboard.press('Tab');
      reached = await undo.evaluate((element) => document.activeElement === element);
    }
    expect(reached).toBe(true);
    await page.keyboard.press('Enter');
    // Undo restores the queue; its toast intentionally remains until expiry.
    // The underlying picker is inert while the native confirmation is open.
    await expect(page.locator('[data-zone="foot"] span').first()).toContainText('2 stashed');
    await expect(confirm).toBeVisible();
    await expect(confirm).not.toHaveAttribute('data-closing', 'true');
    await confirm.getByRole('button', { name: 'Keep queue' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(picker.locator('[data-zone="foot"] span').first()).toContainText('2 stashed');
  });

  test('renders inside the picker panel and is reachable by keyboard and pointer', async ({ page }) => {
    await openRefine(page);
    const picker = page.getByRole('dialog', { name: 'Templates' });
    await picker.getByRole('button', { name: 'Stash & roll' }).click();
    await picker.getByRole('button', { name: 'Stash & roll' }).click();
    await expect(picker.locator('[data-zone="foot"] span').first()).toContainText('2 stashed');

    await picker.getByRole('button', { name: 'Clear', exact: true }).click();
    // The queue list is gone; the Undo must outlive it.
    await expect(picker.getByRole('button', { name: 'Clear', exact: true })).toHaveCount(0);
    const undo = picker.getByRole('button', { name: 'Undo', exact: true });
    await expect(undo).toBeVisible();
    // One copy only, and not in the inert app root.
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(1);
    expect(await undo.evaluate((element) => element.closest('[inert], [aria-hidden="true"]') === null)).toBe(true);
    // Visible on screen and the topmost thing at its own centre.
    expect(await undo.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return hit === element || element.contains(hit);
    })).toBe(true);

    // Keyboard: the picker's own focus trap must cycle onto it.
    let reached = false;
    for (let i = 0; i < 40 && !reached; i += 1) {
      await page.keyboard.press('Tab');
      reached = await undo.evaluate((element) => document.activeElement === element);
      expect(await picker.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    }
    expect(reached).toBe(true);
    await page.keyboard.press('Enter');

    await expect(picker.locator('[data-zone="foot"] span').first()).toContainText('2 stashed');
    await expect(page.locator('#picker-state')).toHaveText('open');
  });

  test('a later stash merges with the restored queue', async ({ page }) => {
    await openRefine(page);
    const picker = page.getByRole('dialog', { name: 'Templates' });
    await picker.getByRole('button', { name: 'Stash & roll' }).click();
    await picker.getByRole('button', { name: 'Clear', exact: true }).click();
    await picker.getByRole('button', { name: 'Stash & roll' }).click();
    await picker.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(picker.locator('[data-zone="foot"] span').first()).toContainText('2 stashed');
  });

  test('follows the replaced panel across desktop → phone → desktop and stays keyboard-reachable', async ({ page }) => {
    await openRefine(page);
    const picker = page.getByRole('dialog', { name: 'Templates' });
    await picker.getByRole('button', { name: 'Stash & roll' }).click();
    await picker.getByRole('button', { name: 'Clear', exact: true }).click();
    // Both locators re-resolve, so they always address the CURRENT panel node.
    const undo = picker.getByRole('button', { name: 'Undo', exact: true });
    await expect(undo).toBeVisible();
    // Clear removed itself while focused; the trap re-seats focus inside the
    // panel on its own (never focused from here) so the first Tab is trapped.
    await expect.poll(() => picker.evaluate((element) => element.contains(document.activeElement))).toBe(true);

    const expectHostedAndReachable = async (sheet: 'true' | 'false') => {
      await expect(picker).toHaveAttribute('data-sheet', sheet);
      await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(1);
      expect(await undo.evaluate((element) => {
        const host = element.closest('[data-toast-host="contained"]');
        const panel = host?.parentElement;
        return host !== null && panel?.isConnected === true
          && panel.getAttribute('role') === 'dialog'
          && element.closest('[inert], [aria-hidden="true"]') === null;
      })).toBe(true);
      expect(await undo.evaluate((element) => {
        const panel = element.closest('[role="dialog"]');
        const footer = panel?.querySelector('[data-zone="foot"]');
        const stack = element.closest('[data-toast-host]');
        return footer !== null && footer !== undefined && stack !== null
          && footer.getBoundingClientRect().bottom <= stack.getBoundingClientRect().top + 0.5;
      })).toBe(true);
      // Hover pauses the auto-dismiss (WCAG 2.2.1) while the trap is walked.
      await undo.hover();
      let reached = false;
      for (let i = 0; i < 40 && !reached; i += 1) {
        await page.keyboard.press('Tab');
        reached = await undo.evaluate((element) => document.activeElement === element);
        // The trap is bound to the current node: Tab never leaves it.
        expect(await picker.evaluate((element) => element.contains(document.activeElement))).toBe(true);
      }
      expect(reached).toBe(true);
    };

    await expectHostedAndReachable('false');
    await page.setViewportSize({ width: 390, height: 844 });
    await expectHostedAndReachable('true');
    await page.setViewportSize({ width: 1280, height: 900 });
    await expectHostedAndReachable('false');

    await page.keyboard.press('Enter');
    await expect(picker.locator('[data-zone="foot"] span').first()).toContainText('1 stashed');
    await expect(page.locator('#picker-state')).toHaveText('open');
  });

  test('closing the picker hands the toast back to the app root', async ({ page }) => {
    await openRefine(page);
    const picker = page.getByRole('dialog', { name: 'Templates' });
    await picker.getByRole('button', { name: 'Stash & roll' }).click();
    await picker.getByRole('button', { name: 'Clear', exact: true }).click();
    await expect(picker.getByRole('button', { name: 'Undo', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Close templates' }).click();
    await expect(page.locator('#picker-state')).toHaveText('closed');
    const undo = page.getByRole('button', { name: 'Undo', exact: true });
    await expect(undo).toHaveCount(1);
    expect(await undo.evaluate((element) => element.closest('[data-toast-host]') === null)).toBe(true);
  });
});

test.describe('shared data-tip label', () => {
  // One real label node (useTooltipDismiss), not a pseudo-element of the host.
  const label = (page: Page) => page.locator('[data-tip-label]');
  const labelState = async (page: Page) => ({
    text: await label(page).textContent(),
    ...await label(page).evaluate((element) => {
      const style = getComputedStyle(element);
      return { visibility: style.visibility, opacity: style.opacity };
    }),
    dismissed: await page.getByRole('button', { name: 'Lock seed' }).evaluate((element) => element.hasAttribute('data-tip-dismissed')),
  });
  const labelCentre = (page: Page) => label(page).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });

  test('stays open while the pointer travels from the host onto the label', async ({ page }) => {
    await openRefine(page);
    const lock = page.getByRole('button', { name: 'Lock seed' });
    const box = await lock.boundingBox();
    if (!box) throw new Error('missing Lock seed');
    const x = box.x + box.width / 2;
    await page.mouse.move(x, box.y + box.height / 2);
    await expect.poll(async () => (await labelState(page)).opacity).toBe('1');
    // It shows over the picker's masked scroll body, as the topmost surface.
    const centre = await labelCentre(page);
    expect(await label(page).evaluate((element, point) => document.elementFromPoint(point.x, point.y) === element, centre)).toBe(true);

    // Walk straight up onto the label one pixel at a time, through the gap
    // (every placement spans the host's centre line).
    await page.mouse.move(x, centre.y, { steps: Math.ceil(Math.abs(box.y + box.height / 2 - centre.y)) });
    await page.waitForTimeout(250);
    expect(await labelState(page)).toEqual({ text: await lock.getAttribute('data-tip'), visibility: 'visible', opacity: '1', dismissed: false });
  });

  test('a click on the shown label never activates the host or dismisses the picker', async ({ page }) => {
    await openRefine(page);
    const lock = page.getByRole('button', { name: 'Lock seed' });
    const box = await lock.boundingBox();
    if (!box) throw new Error('missing Lock seed');
    const x = box.x + box.width / 2;
    await page.mouse.move(x, box.y + box.height / 2);
    await expect.poll(async () => (await labelState(page)).opacity).toBe('1');
    await expect(lock).toHaveAttribute('aria-pressed', 'false');

    // Onto the label, and press it twice.
    const centre = await labelCentre(page);
    await page.mouse.move(x, centre.y, { steps: Math.ceil(Math.abs(box.y + box.height / 2 - centre.y)) });
    await page.mouse.click(x, centre.y);
    await page.mouse.click(x, centre.y);
    // The transparent hover bridge is shielded just like the painted label.
    await page.mouse.click(x, box.y - 3);
    await page.waitForTimeout(100);
    await expect(lock).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#picker-state')).toHaveText('open');

    // The button itself still toggles…
    await page.mouse.click(x, box.y + box.height / 2);
    await expect(lock).toHaveAttribute('aria-pressed', 'true');
    // …and so does keyboard activation.
    await lock.focus();
    await page.keyboard.press('Enter');
    await expect(lock).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.press('Space');
    await expect(lock).toHaveAttribute('aria-pressed', 'true');
  });

  test('Escape dismisses the label without closing the picker, until hover resets', async ({ page }) => {
    await openRefine(page);
    const lock = page.getByRole('button', { name: 'Lock seed' });
    const box = await lock.boundingBox();
    if (!box) throw new Error('missing Lock seed');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect.poll(async () => (await labelState(page)).opacity).toBe('1');

    await page.keyboard.press('Escape');
    await expect.poll(async () => (await labelState(page)).visibility).toBe('hidden');
    expect((await labelState(page)).dismissed).toBe(true);
    await expect(page.locator('#picker-state')).toHaveText('open');

    // Still hovered: stays dismissed past the reveal delay.
    await page.waitForTimeout(600);
    expect((await labelState(page)).visibility).toBe('hidden');

    // Leave and come back: re-armed.
    await page.mouse.move(5, 5);
    await expect.poll(async () => (await labelState(page)).dismissed).toBe(false);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect.poll(async () => (await labelState(page)).opacity).toBe('1');

    // With nothing showing, Escape belongs to the picker again.
    await page.mouse.move(5, 5);
    await expect.poll(async () => (await labelState(page)).visibility).toBe('hidden');
    await page.keyboard.press('Escape');
    await expect(page.locator('#picker-state')).toHaveText('closed');
  });
});

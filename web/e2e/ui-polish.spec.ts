import { devices, expect, test, type Page } from '@playwright/test';

const noHorizontalOverflow = (page: Page) => page.evaluate(() =>
  document.documentElement.scrollWidth <= window.innerWidth + 1,
);

test('full studio shell remains contained on desktop and tablet', async ({ page }) => {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 834, height: 1194 }]) {
    await page.setViewportSize(viewport);
    await page.goto('/e2e/studio/index.html?view=prompts');
    await expect(page.getByRole('form', { name: /Edit template/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Back to feed' })).toBeVisible();
    expect(await noHorizontalOverflow(page)).toBe(true);

    if (viewport.width === 834) {
      await page.getByRole('button', { name: 'Expand sidebar' }).click();
      const editor = await page.getByRole('form', { name: /Edit template/ }).boundingBox();
      if (!editor) throw new Error('Missing tablet template editor');
      expect(editor.width).toBeGreaterThanOrEqual(320);
      await page.getByRole('button', { name: 'Collapse sidebar' }).click();
      const back = page.getByRole('button', { name: 'Back to feed' });
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
      await page.getByRole('button', { name: 'Back to feed' }).click();
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
    await page.getByRole('button', { name: 'Back to feed' }).click();
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

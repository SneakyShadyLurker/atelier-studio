import { expect, test } from '@playwright/test';
import type { Batch } from '@atelier/shared';

test.describe('frontend input regressions', () => {
  test('automatic polling errors are visible and the existing Retry recovers', async ({ page }) => {
    let refreshPosts = 0;
    let historyGets = 0;
    const state = page.getByTestId('history-refresh-state');
    await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
      const path = new URL(route.request().url()).pathname;
      const active = JSON.parse(await state.getAttribute('data-batch') ?? 'null') as Batch | null;
      if (!active) throw new Error('Missing active batch');
      if (path === '/api/history/refresh') {
        refreshPosts += 1;
        if (refreshPosts === 1) {
          await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Polling unavailable' }) });
        } else {
          const terminal: Batch = { ...active, status: 'done', tiles: active.tiles.map((tile) => ({ ...tile, status: 'done', url: '/img/completed.png', ext: 'png', mime: 'image/png', completedAt: Date.now() })) };
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [terminal], missingBatchIds: [] }) });
        }
        return;
      }
      if (path === '/api/history') {
        historyGets += 1;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [active], nextCursor: null }) });
        return;
      }
      throw new Error(`Unexpected request ${path}`);
    });
    await page.goto('/e2e/harness/index.html?case=frontend-history-refresh');
    await expect(state).toHaveText('error', { timeout: 7000 });
    await page.getByRole('button', { name: 'Retry active history', exact: true }).click();
    await expect(state).toHaveText('done');
    await expect(page.getByRole('button', { name: 'Retry active history', exact: true })).toHaveCount(0);
    expect(refreshPosts).toBe(2);
    expect(historyGets).toBe(1);
  });

  test('automatic polling completes a deep job without refetching twenty cached pages', async ({ page }) => {
    let historyGets = 0;
    let refreshPosts = 0;
    const unexpected: string[] = [];
    const state = page.getByTestId('history-refresh-state');
    await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === '/api/history/refresh' && request.method() === 'POST') {
        refreshPosts += 1;
        const active = JSON.parse(await state.getAttribute('data-batch') ?? 'null') as Batch | null;
        if (!active) throw new Error('Missing deep active batch');
        expect(request.postDataJSON()).toEqual({ batchIds: [active.id], storyIds: [], collectionId: 'null' });
        const terminal: Batch = {
          ...active,
          status: 'done',
          tiles: active.tiles.map((tile) => ({ ...tile, status: 'done', url: '/img/polling-complete.png', ext: 'png', mime: 'image/png', completedAt: Date.now() })),
        };
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [terminal], missingBatchIds: [] }) });
        return;
      }
      if (path === '/api/history' && request.method() === 'GET') historyGets += 1;
      else unexpected.push(`${request.method()} ${path}`);
      await route.fulfill({ status: 405, contentType: 'application/json', body: JSON.stringify({ error: 'Offline harness' }) });
    });
    await page.goto('/e2e/harness/index.html?case=frontend-history-refresh');
    await expect(state).toHaveText('loading');
    const pagination = page.getByTestId('history-refresh-pagination');
    const before = await pagination.textContent();
    expect(JSON.parse(before ?? 'null')).toMatchObject({ pageCount: 20, deepPage: 19 });

    // Real foreground timers own completion: no manual refetch or clock jump.
    await expect(state).toHaveText('done', { timeout: 7000 });
    expect(JSON.parse(await state.getAttribute('data-batch') ?? 'null')).toMatchObject({ status: 'done', tiles: [{ status: 'done' }] });
    await expect(pagination).toHaveText(before ?? '');
    expect(refreshPosts).toBe(1);
    expect(historyGets).toBe(0);
    expect(unexpected).toEqual([]);
  });

  test('offline Prompt Library navigation preserves the composer draft without reloading', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/e2e/studio/index.html');
    const expand = page.getByRole('button', { name: 'Expand composer', exact: true });
    if (await expand.isVisible()) await expand.click();
    const prompt = page.getByRole('textbox', { name: 'Prompt', exact: true });
    const draft = 'A coastal observatory draft to retain across navigation';
    await prompt.fill(draft);
    const timeOrigin = await page.evaluate(() => performance.timeOrigin);

    await page.getByRole('button', { name: 'Prompt Library', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Prompt Library', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Editorial portrait', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Back to feed', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Prompt Library', exact: true })).toHaveCount(0);
    if (await expand.isVisible()) await expand.click();
    await expect(prompt).toBeVisible();
    await expect(prompt).toHaveValue(draft);
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
  });

  test('phone keyboard expansion transfers focus to the I2V motion prompt', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/e2e/harness/index.html?case=frontend-i2v');
    const expand = page.getByRole('button', { name: 'Expand composer' });
    await expand.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('textbox', { name: 'Motion prompt' })).toBeFocused();
    await expect(expand).toHaveCount(0);
    await page.keyboard.press('Tab');
    const inside = await page.evaluate(() => document.getElementById('atelier-composer')?.contains(document.activeElement));
    expect(inside).toBe(true);
  });

  test('composition confirmation never saves; normal Enter does', async ({ page }) => {
    const saved: { name: string; body: string }[] = [];
    await page.route('**/api/prompts/templates', async (route) => {
      const body = route.request().postDataJSON() as { name: string; body: string };
      saved.push(body);
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: '00000000-0000-4000-8000-000000000001', ...body, sortOrder: 0, createdAt: 1, updatedAt: 1 }) });
    });
    await page.goto('/e2e/harness/index.html?case=frontend-save-template');
    await page.getByRole('button', { name: 'Open save template' }).click();
    const name = page.getByRole('textbox', { name: 'Template name' });
    await name.fill('未完成');
    await name.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
    await expect(name).toBeVisible();
    expect(saved).toEqual([]);
    await name.dispatchEvent('keydown', { key: 'Enter', keyCode: 229 });
    await expect(name).toBeVisible();
    expect(saved).toEqual([]);
    await name.fill('完成');
    await name.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Save prompt as template' })).toHaveCount(0);
    expect(saved).toEqual([{ name: '完成', body: 'A fox near a pond' }]);
  });
});

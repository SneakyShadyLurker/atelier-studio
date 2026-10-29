import { expect, test } from '@playwright/test';
import type * as ClientGuards from '../../src/api/client';
import { batches, library, models, promptLibrary } from './fixture';

test('offline studio data satisfies the production read contracts', async ({ page }) => {
  await page.goto('/e2e/studio/index.html');
  const valid = await page.evaluate(async (data) => {
    // The validators live in Vite's browser module graph; importing them in
    // Playwright's Node process would evaluate import.meta.env without Vite.
    const moduleUrl = '/src/api/client.ts';
    const guards = await import(/* @vite-ignore */ moduleUrl) as typeof ClientGuards;
    return guards.isModelList(data.models)
      && guards.isCollectionsResponse(data.library)
      && guards.isPromptLibraryResponse(data.promptLibrary)
      && guards.isBatchHistoryPage({ items: data.batches, nextCursor: null });
  }, { batches, library, models, promptLibrary });
  expect(valid).toBe(true);
});

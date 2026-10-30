import { expect, test } from '@playwright/test';
import type * as ClientGuards from '../../src/api/client';
import type * as DiagnosisGuards from '../../src/api/libraryDiagnosis';
import type * as CoverageGuards from '../../src/api/libraryCoverage';
import { batches, library, models, promptLibrary } from './fixture';

test('offline studio data satisfies the production read contracts', async ({ page }) => {
  await page.goto('/e2e/studio/index.html');
  const valid = await page.evaluate(async (data) => {
    // The validators live in Vite's browser module graph; importing them in
    // Playwright's Node process would evaluate import.meta.env without Vite.
    const moduleUrl = '/src/api/client.ts';
    const guards = await import(/* @vite-ignore */ moduleUrl) as typeof ClientGuards;
    const diagnosisUrl = '/src/api/libraryDiagnosis.ts';
    const diagnosisGuards = await import(/* @vite-ignore */ diagnosisUrl) as typeof DiagnosisGuards;
    const coverageUrl = '/src/api/libraryCoverage.ts';
    const coverageGuards = await import(/* @vite-ignore */ coverageUrl) as typeof CoverageGuards;
    const [diagnosis, coverage, generation] = await Promise.all([
      fetch('/api/prompts/library-diagnosis', { method: 'POST' }),
      fetch('/api/prompts/library-coverage', { method: 'POST' }),
      fetch('/api/generate', { method: 'POST' }),
    ]);
    return guards.isModelList(data.models)
      && guards.isCollectionsResponse(data.library)
      && guards.isPromptLibraryResponse(data.promptLibrary)
      && guards.isBatchHistoryPage({ items: data.batches, nextCursor: null })
      && diagnosis.status === 200 && diagnosisGuards.isLibraryDiagnosisResponse(await diagnosis.json())
      && coverage.status === 200 && coverageGuards.isLibraryCoverageResponse(await coverage.json())
      && generation.status === 405;
  }, { batches, library, models, promptLibrary });
  expect(valid).toBe(true);
});

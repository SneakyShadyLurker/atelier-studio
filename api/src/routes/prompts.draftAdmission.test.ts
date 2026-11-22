import { afterEach, describe, expect, test } from 'bun:test';
import { setTextModelProviderForTests } from '../providers/text/registry';
import type {
  DraftTemplateResponse,
  DraftVariableListResponse,
} from '@atelier/shared';
import {
  type DraftResult,
  type DraftTemplateResult,
  type EnhanceChunk,
  type TestTextFeatureProvider,
} from '../providers/text/featureHelpers';
import { resetLlmAdmissionForTests } from '../orchestrator/llmAdmission';
import { parseSseText, testRuntime } from '../test/helpers';

afterEach(() => {
  setTextModelProviderForTests(null);
  resetLlmAdmissionForTests();
});

async function* emptyEnhance(): AsyncGenerator<EnhanceChunk, void, unknown> {
  await Promise.resolve();
  if (Date.now() < 0) yield { type: 'done' };
}

function pendingProvider(
  method: 'draftList',
  result: DraftResult,
): { provider: TestTextFeatureProvider; resolve(): void };
function pendingProvider(
  method: 'draftTemplate',
  result: DraftTemplateResult,
): { provider: TestTextFeatureProvider; resolve(): void };
function pendingProvider(
  method: 'draftList' | 'draftTemplate',
  result: DraftResult | DraftTemplateResult,
): { provider: TestTextFeatureProvider; resolve(): void } {
  let release: (() => void) | null = null;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const base: TestTextFeatureProvider = {
    enhance: emptyEnhance,
    draftList: () => Promise.resolve({ type: 'failed', status: null, detail: 'not implemented' }),
    draftTemplate: () => Promise.resolve({ type: 'failed', status: null, detail: 'not implemented' }),
    inferDimensions: () => Promise.resolve({ type: 'ok', ops: [] }),
    inferDimensionsSingleAttempt: () => Promise.resolve({ type: 'ok', ops: [] }),
    rescueDimension: () => Promise.resolve({ type: 'failed', kind: 'permanent', status: null, detail: 'x' }),
  };
  return {
    provider: {
      ...base,
      [method]: async () => {
        await wait;
        return result;
      },
    },
    resolve: () => { release?.(); },
  };
}

function postListDraft(app: ReturnType<typeof testRuntime>['app']) {
  return app.fetch(new Request('http://local/api/prompts/lists/draft', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'Remote-User': 'alice' },
    body: JSON.stringify({ mode: 'extend', name: 'mood', options: [{ value: 'calm', weight: 1 }] }),
  }));
}

function postTemplateDraft(app: ReturnType<typeof testRuntime>['app']) {
  return app.fetch(new Request('http://local/api/prompts/templates/draft', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'Remote-User': 'alice' },
    body: JSON.stringify({ name: 'portrait', existingBody: '', description: 'make it vivid' }),
  }));
}

describe('prompt draft LLM admission', () => {
  test('list draft returns pre-stream 429 while the draft admission pool is full', async () => {
    const pending = pendingProvider('draftList', {
      type: 'ok',
      payload: {
        kind: 'changes',
        baseCount: 1,
        changes: [{ id: 0, op: 'add', value: 'wistful', weight: 1, why: '' }],
        unplaced: [],
        summary: null,
      } satisfies DraftVariableListResponse,
    });
    setTextModelProviderForTests(pending.provider);
    const { app } = testRuntime({
      seedLegacyText: true,
      PROMPT_LIBRARY_USERS: 'alice',
      MAX_CONCURRENT_LLM_DRAFT_PER_USER: '1',
    });

    const first = await postListDraft(app);
    expect(first.status).toBe(200);
    const blocked = await postListDraft(app);

    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({
      error: 'queue full',
      code: 'QUEUE_FULL',
      reason: 'per-user',
      retry_after_seconds: 30,
    });
    pending.resolve();
    expect(parseSseText(await first.text()).at(-1)?.event).toBe('done');
  });

  test('template draft returns pre-stream 429 while the draft admission pool is full', async () => {
    const pending = pendingProvider('draftTemplate', {
      type: 'ok',
      payload: { kind: 'body', body: 'portrait body', warnings: [] } satisfies DraftTemplateResponse,
    });
    setTextModelProviderForTests(pending.provider);
    const { app } = testRuntime({
      seedLegacyText: true,
      PROMPT_LIBRARY_USERS: 'alice',
      MAX_CONCURRENT_LLM_DRAFT_PER_USER: '1',
    });

    const first = await postTemplateDraft(app);
    expect(first.status).toBe(200);
    const blocked = await postTemplateDraft(app);

    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({
      error: 'queue full',
      code: 'QUEUE_FULL',
      reason: 'per-user',
      retry_after_seconds: 30,
    });
    pending.resolve();
    expect(parseSseText(await first.text()).at(-1)?.event).toBe('done');
  });
});

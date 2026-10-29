import { afterEach, describe, expect, test } from 'bun:test';
import type {
  DraftTemplateResponse,
  DraftVariableListResponse,
} from '@atelier/shared';
import {
  setCliproxyTextProviderForTests,
  type DraftResult,
  type DraftTemplateResult,
  type EnhanceChunk,
  type TestCliproxyTextProvider,
} from '../providers/cliproxyText';
import { resetLlmAdmissionForTests } from '../orchestrator/llmAdmission';
import { parseSseText, testRuntime } from '../test/helpers';

afterEach(() => {
  setCliproxyTextProviderForTests(null);
  resetLlmAdmissionForTests();
});

async function* emptyEnhance(): AsyncGenerator<EnhanceChunk, void, unknown> {
  await Promise.resolve();
  if (Date.now() < 0) yield { type: 'done' };
}

function pendingProvider(
  method: 'draftList',
  result: DraftResult,
): { provider: TestCliproxyTextProvider; resolve(): void };
function pendingProvider(
  method: 'draftTemplate',
  result: DraftTemplateResult,
): { provider: TestCliproxyTextProvider; resolve(): void };
function pendingProvider(
  method: 'draftList' | 'draftTemplate',
  result: DraftResult | DraftTemplateResult,
): { provider: TestCliproxyTextProvider; resolve(): void } {
  let release: (() => void) | null = null;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const base: TestCliproxyTextProvider = {
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

function seedList(db: ReturnType<typeof testRuntime>['db'], userId = 'alice'): string {
  const id = crypto.randomUUID();
  const now = Date.now();
  db.query('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)').run(userId, now);
  db.query(
    'INSERT INTO variable_lists (id, user_id, name, sort_order, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)',
  ).run(id, userId, 'mood', now, now);
  return id;
}

function postListDraft(app: ReturnType<typeof testRuntime>['app'], listId: string) {
  return app.fetch(new Request(`http://local/api/prompts/lists/${listId}/draft`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'Remote-User': 'alice' },
    body: JSON.stringify({ name: 'mood', existing: [] }),
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
      payload: { kind: 'entries', entries: ['wistful'] } satisfies DraftVariableListResponse,
    });
    setCliproxyTextProviderForTests(pending.provider);
    const { app, db } = testRuntime({
      PROMPT_LIBRARY_USERS: 'alice',
      MAX_CONCURRENT_LLM_DRAFT_PER_USER: '1',
    });
    const listId = seedList(db);

    const first = await postListDraft(app, listId);
    expect(first.status).toBe(200);
    const blocked = await postListDraft(app, listId);

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
    setCliproxyTextProviderForTests(pending.provider);
    const { app } = testRuntime({
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

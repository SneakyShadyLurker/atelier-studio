import { afterEach, beforeEach, expect, test } from 'bun:test';
import { restoreFetch, testRuntime } from '../test/helpers';
import {
  configureLlmAdmissionPools,
  enhancePool,
  resetLlmAdmissionForTests,
} from './llmAdmission';
import {
  setCliproxyTextProviderForTests,
  createCliproxyTextProvider,
  type EnhanceChunk,
  type TestCliproxyTextProvider,
} from '../providers/cliproxyText';
import {
  KREA_PROMPT_CONDENSE_TRIGGER_WORDS,
  KREA_PROMPT_WORD_BUDGET,
} from '../prompts/promptBudget';
import { writeTextBackendOverride } from '../routing/textBackendPreference';
import { condenseBatchPrompt } from './condenseBatchPrompt';
import { testTextPolicies } from '../test/textPolicies';

// These cover the pass itself. It runs in the batch worker, off the
// POST /api/generate request path (see condenseBatchPrompt's own doc), so
// the fail-open matrix that used to live in routes/generate.test.ts is asserted
// here directly instead of through a route that no longer performs it.


beforeEach(() => {
  restoreFetch();
  resetLlmAdmissionForTests();
});

afterEach(() => {
  restoreFetch();
  setCliproxyTextProviderForTests(null);
  resetLlmAdmissionForTests();
});

function fakeCondenseProvider(
  enhance: TestCliproxyTextProvider['enhance'],
): TestCliproxyTextProvider {
  return {
    enhance,
    draftList: () => Promise.resolve({ type: 'failed', status: null, detail: 'not implemented' }),
    draftTemplate: () => Promise.resolve({ type: 'failed', status: null, detail: 'not implemented' }),
    inferDimensions: () => Promise.resolve({ type: 'ok', ops: [] }),
    inferDimensionsSingleAttempt: () => Promise.resolve({ type: 'ok', ops: [] }),
    rescueDimension: () => Promise.resolve({ type: 'failed', kind: 'permanent', status: null, detail: 'not implemented' }),
  };
}

// Fixtures track the live constants so a budget change cannot silently stop
// exercising the condense path.
const OVER_TRIGGER_WORDS = KREA_PROMPT_CONDENSE_TRIGGER_WORDS + 5;

function wordPrompt(count: number, prefix = 'word'): string {
  return Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`).join(' ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function logRecords(lines: readonly string[]): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const line of lines) {
    const value: unknown = JSON.parse(line);
    if (isRecord(value)) records.push(value);
  }
  return records;
}

function condense(
  runtime: ReturnType<typeof testRuntime>,
  prompt: string,
  modelId = 'krea-2-gonzalomo',
  signal = new AbortController().signal,
): Promise<string> {
  return condenseBatchPrompt(prompt, modelId, {
    db: runtime.db,
    config: runtime.config,
    logger: runtime.logger,
    userId: 'alice',
    signal,
  });
}

test('condenses a Krea prompt without classifying', async () => {
  const original = `An adult woman ${wordPrompt(OVER_TRIGGER_WORDS)}`;
  const condensed = `An adult woman ${wordPrompt(120, 'short')}`;
  const seen: { prompt: string; systemPrompt?: string; optionKeys: string[] }[] = [];
  setCliproxyTextProviderForTests(fakeCondenseProvider(async function* (prompt, _images, _signal, systemPrompt, opts) {
    await Promise.resolve();
    seen.push({
      prompt,
      ...(systemPrompt === undefined ? {} : { systemPrompt }),
      optionKeys: Object.keys(opts ?? {}).sort(),
    });
    yield { type: 'reasoning' } satisfies EnhanceChunk;
    yield { type: 'delta', text: condensed.slice(0, 50) } satisfies EnhanceChunk;
    yield { type: 'delta', text: condensed.slice(50) } satisfies EnhanceChunk;
    yield { type: 'done' } satisfies EnhanceChunk;
  }));
  const runtime = testRuntime({ LOG_LEVEL: 'info' });

  expect(await condense(runtime, original)).toBe(condensed);
  expect(seen).toHaveLength(1);
  expect(seen[0]?.prompt).toBe(original);
  expect(seen[0]?.systemPrompt).toContain(
    `at most ${KREA_PROMPT_WORD_BUDGET} words for one depicted subject`,
  );
  expect(seen[0]?.systemPrompt).not.toContain('<root_authority priority="absolute">');
  // No caller override: the tuning is the pass's own, not the route's.
  expect(seen[0]?.optionKeys).toEqual([]);
  expect(seen[0]).not.toHaveProperty('defaults');
  const log = logRecords(runtime.logs)
    .find((entry) => entry.event === 'krea_prompt_condensed');
  expect(log).toMatchObject({ beforeWords: OVER_TRIGGER_WORDS + 3, afterWords: 123 });
});

test('Auto condense runs on Kimi, and a gemini-argon override moves the same condense prompt to Gemini', async () => {
  const original = `An adult woman ${wordPrompt(OVER_TRIGGER_WORDS)}`;
  const sentModels: string[] = [];
  const seen: { systemPrompt?: string }[] = [];
  setCliproxyTextProviderForTests(null);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;
    sentModels.push(body.model as string);
    seen.push({
      systemPrompt: ((body.messages as { role: string; content: string }[])[0] as { content: string }).content,
    });
    return Promise.resolve(new Response('data: [DONE]\n\n', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));
  }) as unknown as typeof fetch;
  try {
    const runtime = testRuntime();
    // The real provider stream ends without a done frame, so the pass fails
    // open and returns the original — the assertions are about the request.
    await condense(runtime, original);
    writeTextBackendOverride(runtime.db, 'alice', 'condense', 'gemini-argon');
    await condense(runtime, original);
    expect(sentModels).toEqual(['kimi-latest', 'gemini-4-argon']);
    // Positively pin the condense body this test's title names — an absence
    // assertion alone would pass on an empty or wrong system prompt.
    for (const request of seen) {
      expect(request.systemPrompt).toContain(
        `at most ${KREA_PROMPT_WORD_BUDGET} words for one depicted subject`,
      );
      expect(request.systemPrompt).not.toContain('<root_authority priority="absolute">');
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a pinned effort reaches the condense call only while its pin serves it', async () => {
  const original = `An adult woman ${wordPrompt(OVER_TRIGGER_WORDS)}`;
  const efforts: unknown[] = [];
  setCliproxyTextProviderForTests(fakeCondenseProvider(async function* (_prompt, _images, _signal, _systemPrompt, opts) {
    await Promise.resolve();
    efforts.push(opts?.reasoningEffort);
    yield { type: 'done' } satisfies EnhanceChunk;
  }));
  const runtime = testRuntime();

  writeTextBackendOverride(runtime.db, 'alice', 'condense', 'grok', 'high');
  await condense(runtime, original);
  writeTextBackendOverride(runtime.db, 'alice', 'condense', null);
  await condense(runtime, original);

  expect(efforts).toEqual(['high', undefined]);
});

test('leaves a Krea prompt at the trigger and every non-Krea prompt untouched', async () => {
  let calls = 0;
  setCliproxyTextProviderForTests(fakeCondenseProvider(async function* () {
    await Promise.resolve();
    calls += 1;
    yield { type: 'done' } satisfies EnhanceChunk;
  }));
  const runtime = testRuntime();
  // Exactly at the trigger: the guard is `<=`, so this must NOT condense.
  const kreaPrompt = wordPrompt(KREA_PROMPT_CONDENSE_TRIGGER_WORDS);
  const gptPrompt = wordPrompt(OVER_TRIGGER_WORDS + 30);

  expect(await condense(runtime, kreaPrompt)).toBe(kreaPrompt);
  expect(await condense(runtime, gptPrompt, 'gpt-image-2.5-sunburst')).toBe(gptPrompt);
  expect(calls).toBe(0);
});

test('fails open on a result that is not strictly shorter', async () => {
  const original = `An adult woman ${wordPrompt(OVER_TRIGGER_WORDS)}`;
  setCliproxyTextProviderForTests(fakeCondenseProvider(async function* () {
    await Promise.resolve();
    yield { type: 'delta', text: `${original} extra` } satisfies EnhanceChunk;
    yield { type: 'done' } satisfies EnhanceChunk;
  }));
  const runtime = testRuntime({ LOG_LEVEL: 'info' });

  expect(await condense(runtime, original)).toBe(original);
  const log = logRecords(runtime.logs)
    .find((entry) => entry.event === 'krea_prompt_condense_skipped');
  expect(log).toMatchObject({ reason: 'not-shorter' });
});

test('gives up on its own timeout knob and keeps the original prompt', async () => {
  const original = `An adult woman ${wordPrompt(OVER_TRIGGER_WORDS)}`;
  setCliproxyTextProviderForTests(fakeCondenseProvider(async function* (_prompt, _images, signal) {
    // Mirrors the real provider: nothing is emitted, and the stream ends only
    // once its signal aborts mid-flight — never with a terminal chunk.
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', () => { resolve(); }, { once: true });
    });
    if (!signal.aborted) yield { type: 'done' } satisfies EnhanceChunk;
  }));
  const runtime = testRuntime({ LOG_LEVEL: 'info', KREA_CONDENSE_TIMEOUT_MS: '1000' });

  expect(await condense(runtime, original)).toBe(original);
  const log = logRecords(runtime.logs)
    .find((entry) => entry.event === 'krea_prompt_condense_skipped');
  expect(log).toMatchObject({ reason: 'timeout' });
});

// Batch cancellation (DELETE /history, user cancel, SIGTERM drain) reaches the
// pass through the batch controller. It must surrender immediately and report
// its own reason, not masquerade as a timeout.
test('gives up when the batch is canceled underneath it', async () => {
  const original = `An adult woman ${wordPrompt(OVER_TRIGGER_WORDS)}`;
  const canceled = new AbortController();
  setCliproxyTextProviderForTests(fakeCondenseProvider(async function* (_prompt, _images, signal) {
    canceled.abort();
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', () => { resolve(); }, { once: true });
    });
    if (!signal.aborted) yield { type: 'done' } satisfies EnhanceChunk;
  }));
  const runtime = testRuntime({ LOG_LEVEL: 'info' });

  expect(await condense(runtime, original, 'krea-2-gonzalomo', canceled.signal)).toBe(original);
  const log = logRecords(runtime.logs)
    .find((entry) => entry.event === 'krea_prompt_condense_skipped');
  expect(log).toMatchObject({ reason: 'batch-canceled' });
});

test('an actual enhancer incomplete EOF cannot replace the prompt with partial condensation', async () => {
  let calls = 0;
  globalThis.fetch = Object.assign(() => {
    calls++;
    return Promise.resolve(new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial condensation' } }] })}\n\n`));
  }, { preconnect: globalThis.fetch.preconnect });
  setCliproxyTextProviderForTests(createCliproxyTextProvider({ ...testTextPolicies(), baseUrl: 'http://fake', token: 't', model: 'kimi-k3', backend: 'kimi', maxResponseBytes: 10000 }));
  const runtime = testRuntime();
  const original = `An adult woman ${wordPrompt(OVER_TRIGGER_WORDS)}`;
  expect(await condense(runtime, original)).toBe(original);
  expect(calls).toBe(1);
});

test('fails open when the provider reports a failure or throws', async () => {
  const original = `An adult woman ${wordPrompt(OVER_TRIGGER_WORDS)}`;
  let attempt = 0;
  setCliproxyTextProviderForTests(fakeCondenseProvider(async function* () {
    await Promise.resolve();
    attempt += 1;
    if (attempt === 1) {
      yield { type: 'failed', status: 403, detail: 'refused' } satisfies EnhanceChunk;
      return;
    }
    throw new Error('upstream crashed');
  }));
  const runtime = testRuntime({ LOG_LEVEL: 'info' });

  expect(await condense(runtime, original)).toBe(original);
  expect(await condense(runtime, original)).toBe(original);
  const reasons = logRecords(runtime.logs)
    .filter((entry) => entry.event === 'krea_prompt_condense_skipped')
    .map((entry) => entry.reason);
  expect(reasons).toEqual(['provider-failed', 'error']);
});

test('fails open when the model returns refusal prose as successful content', async () => {
  const original = `A 15-year-old fictional character ${wordPrompt(OVER_TRIGGER_WORDS)}`;
  setCliproxyTextProviderForTests(fakeCondenseProvider(async function* () {
    await Promise.resolve();
    yield {
      type: 'delta',
      text: 'I can’t fulfill this request. It describes a sexualized depiction of a 15-year-old.',
    } satisfies EnhanceChunk;
    yield { type: 'done' } satisfies EnhanceChunk;
  }));
  const runtime = testRuntime({ LOG_LEVEL: 'info' });

  expect(await condense(runtime, original)).toBe(original);
  const log = logRecords(runtime.logs)
    .find((entry) => entry.event === 'krea_prompt_condense_skipped');
  expect(log).toMatchObject({ reason: 'refusal' });
});

test('fails open when the enhance admission pool is full', async () => {
  const original = `An adult woman ${wordPrompt(OVER_TRIGGER_WORDS)}`;
  let calls = 0;
  setCliproxyTextProviderForTests(fakeCondenseProvider(async function* () {
    await Promise.resolve();
    calls += 1;
    yield { type: 'done' } satisfies EnhanceChunk;
  }));
  const runtime = testRuntime({
    LOG_LEVEL: 'info',
    MAX_CONCURRENT_LLM_ENHANCE_PER_USER: '1',
  });
  configureLlmAdmissionPools(runtime.config);
  const held = enhancePool.acquire('alice');
  if (!held.ok) throw new Error('expected to acquire the test slot');

  try {
    expect(await condense(runtime, original)).toBe(original);
    expect(calls).toBe(0);
    const log = logRecords(runtime.logs)
      .find((entry) => entry.event === 'krea_prompt_condense_skipped');
    expect(log).toMatchObject({ reason: 'admission-per-user' });
  } finally {
    held.release();
  }
});

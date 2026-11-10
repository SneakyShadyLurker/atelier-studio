import { afterEach, beforeEach, expect, test } from 'bun:test';
import { MAX_PROMPT_CHARS } from '@atelier/shared';
import { setTextModelProviderForTests } from '../providers/text/registry';
import { restoreFetch, testRuntime } from '../test/helpers';
import { resetLlmAdmissionForTests } from './llmAdmission';
import {
  type EnhanceChunk,
  type TestTextFeatureProvider,
} from '../providers/text/featureHelpers';
import { H3_IMAGE_ENHANCE_SYSTEM_PROMPT } from '../prompts/enhanceSystemPrompt';
import { H3_IMAGE_PROMPT_EXPAND_BELOW_WORDS } from '../prompts/promptBudget';
import { expandBatchPrompt } from './expandBatchPrompt';
import { needsQueuedPromptPreparation } from './queuedPromptPreparation';

beforeEach(() => {
  restoreFetch();
  resetLlmAdmissionForTests();
});

afterEach(() => {
  restoreFetch();
  setTextModelProviderForTests(null);
  resetLlmAdmissionForTests();
});

const H3 = 'minimax-h3-image';

function fakeProvider(enhance: TestTextFeatureProvider['enhance']): TestTextFeatureProvider {
  return {
    enhance,
    draftList: () => Promise.resolve({ type: 'failed', status: null, detail: 'not implemented' }),
    draftTemplate: () => Promise.resolve({ type: 'failed', status: null, detail: 'not implemented' }),
    inferDimensions: () => Promise.resolve({ type: 'ok', ops: [] }),
    inferDimensionsSingleAttempt: () => Promise.resolve({ type: 'ok', ops: [] }),
    rescueDimension: () => Promise.resolve({ type: 'failed', kind: 'permanent', status: null, detail: 'not implemented' }),
  };
}

/** A provider that streams `text` and completes, counting its calls. */
function replying(text: string): { readonly calls: () => number } {
  let calls = 0;
  setTextModelProviderForTests(fakeProvider(async function* () {
    await Promise.resolve();
    calls += 1;
    yield { type: 'delta', text } satisfies EnhanceChunk;
    yield { type: 'done' } satisfies EnhanceChunk;
  }));
  return { calls: () => calls };
}

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

function skipReason(runtime: ReturnType<typeof testRuntime>): unknown {
  return logRecords(runtime.logs).find((entry) => entry.event === 'h3_image_prompt_expand_skipped')?.reason;
}

function expand(
  runtime: ReturnType<typeof testRuntime>,
  prompt: string,
  modelId = H3,
  signal = new AbortController().signal,
): Promise<string> {
  return expandBatchPrompt(prompt, modelId, {
    config: runtime.config,
    text: runtime.text,
    logger: runtime.logger,
    userId: 'alice',
    signal,
  });
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => { resolve(); }, { once: true });
  });
}

const SHORT = 'an adult woman reading by a window';
const EXPANDED = `A candid photograph of ${wordPrompt(150, 'detail')}`;

test('expands a short H3 Image prompt with the H3 Image enhance system prompt', async () => {
  const seen: { prompt: string; systemPrompt?: string }[] = [];
  setTextModelProviderForTests(fakeProvider(async function* (prompt, _images, _signal, systemPrompt) {
    await Promise.resolve();
    seen.push({ prompt, ...(systemPrompt === undefined ? {} : { systemPrompt }) });
    yield { type: 'delta', text: `  ${EXPANDED.slice(0, 40)}` } satisfies EnhanceChunk;
    yield { type: 'delta', text: `${EXPANDED.slice(40)}\n` } satisfies EnhanceChunk;
    yield { type: 'done' } satisfies EnhanceChunk;
  }));
  const runtime = testRuntime({ seedLegacyText: true, LOG_LEVEL: 'info' });

  expect(await expand(runtime, SHORT)).toBe(EXPANDED);
  expect(seen).toEqual([{ prompt: SHORT, systemPrompt: H3_IMAGE_ENHANCE_SYSTEM_PROMPT }]);
  const log = logRecords(runtime.logs).find((entry) => entry.event === 'h3_image_prompt_expanded');
  expect(log).toMatchObject({ beforeWords: 7, afterWords: 154 });
  // Content-free: no prompt text reaches the logs.
  expect(runtime.logs.some((line) => line.includes('reading by a window') || line.includes('detail1'))).toBe(false);
});

test('expands at 59 words and leaves 60 or more untouched without a call', async () => {
  const reply = replying(EXPANDED);
  const runtime = testRuntime({ seedLegacyText: true });
  const below = wordPrompt(H3_IMAGE_PROMPT_EXPAND_BELOW_WORDS - 1);
  const at = wordPrompt(H3_IMAGE_PROMPT_EXPAND_BELOW_WORDS);
  const longer = wordPrompt(250);

  expect(H3_IMAGE_PROMPT_EXPAND_BELOW_WORDS).toBe(60);
  expect(await expand(runtime, at)).toBe(at);
  expect(await expand(runtime, longer)).toBe(longer);
  expect(reply.calls()).toBe(0);
  expect(await expand(runtime, below)).toBe(EXPANDED);
  expect(reply.calls()).toBe(1);
});

test('leaves Krea, MOSS and both H3 video prompts untouched without a call', async () => {
  const reply = replying(EXPANDED);
  const runtime = testRuntime({ seedLegacyText: true });

  for (const modelId of ['krea-2-gonzalomo', 'moss-image-sft', 'minimax-h3-i2v', 'minimax-h3-t2v']) {
    expect(await expand(runtime, SHORT, modelId)).toBe(SHORT);
  }
  expect(reply.calls()).toBe(0);
});

test('H3_IMAGE_AUTO_EXPAND=false turns the preparation predicate and the pass off', async () => {
  const reply = replying(EXPANDED);
  const on = testRuntime({ seedLegacyText: true });
  const off = testRuntime({ seedLegacyText: true, H3_IMAGE_AUTO_EXPAND: 'false' });

  expect(needsQueuedPromptPreparation(on.config, H3, SHORT)).toBe(true);
  expect(needsQueuedPromptPreparation(on.config, H3, wordPrompt(60))).toBe(false);
  expect(needsQueuedPromptPreparation(off.config, H3, SHORT)).toBe(false);
  // The switch is H3-only: Krea condensation keeps its own trigger.
  expect(needsQueuedPromptPreparation(off.config, 'krea-2-gonzalomo', wordPrompt(400))).toBe(true);
  expect(needsQueuedPromptPreparation(on.config, 'krea-2-gonzalomo', SHORT)).toBe(false);
  expect(await expand(off, SHORT)).toBe(SHORT);
  expect(reply.calls()).toBe(0);
});

test('fails open on a provider failure or a thrown provider', async () => {
  let attempt = 0;
  setTextModelProviderForTests(fakeProvider(async function* () {
    await Promise.resolve();
    attempt += 1;
    if (attempt === 1) {
      yield { type: 'failed', status: 403, detail: 'refused' } satisfies EnhanceChunk;
      return;
    }
    throw new Error('upstream crashed');
  }));
  const runtime = testRuntime({ seedLegacyText: true, LOG_LEVEL: 'info' });

  expect(await expand(runtime, SHORT)).toBe(SHORT);
  expect(await expand(runtime, SHORT)).toBe(SHORT);
  const reasons = logRecords(runtime.logs)
    .filter((entry) => entry.event === 'h3_image_prompt_expand_skipped')
    .map((entry) => entry.reason);
  expect(reasons).toEqual(['provider-failed', 'error']);
});

test('gives up on its own timeout knob and keeps the original prompt', async () => {
  setTextModelProviderForTests(fakeProvider(async function* (_prompt, _images, signal) {
    await waitForAbort(signal);
    if (!signal.aborted) yield { type: 'done' } satisfies EnhanceChunk;
  }));
  const runtime = testRuntime({ seedLegacyText: true, LOG_LEVEL: 'info', H3_IMAGE_EXPAND_TIMEOUT_MS: '1000' });

  expect(await expand(runtime, SHORT)).toBe(SHORT);
  expect(skipReason(runtime)).toBe('timeout');
});

test('gives up when the batch is canceled underneath it', async () => {
  const canceled = new AbortController();
  setTextModelProviderForTests(fakeProvider(async function* (_prompt, _images, signal) {
    canceled.abort();
    await waitForAbort(signal);
    if (!signal.aborted) yield { type: 'done' } satisfies EnhanceChunk;
  }));
  const runtime = testRuntime({ seedLegacyText: true, LOG_LEVEL: 'info' });

  expect(await expand(runtime, SHORT, H3, canceled.signal)).toBe(SHORT);
  expect(skipReason(runtime)).toBe('batch-canceled');
});

test('a stream that ends without completing cannot replace the prompt', async () => {
  setTextModelProviderForTests(fakeProvider(async function* () {
    await Promise.resolve();
    yield { type: 'delta', text: EXPANDED } satisfies EnhanceChunk;
  }));
  const runtime = testRuntime({ seedLegacyText: true, LOG_LEVEL: 'info' });

  expect(await expand(runtime, SHORT)).toBe(SHORT);
  expect(skipReason(runtime)).toBe('truncated');
});

for (const [label, text, reason] of [
  ['empty output', '   \n', 'empty'],
  ['refusal prose', 'I can’t fulfill this request. It describes a sexualized depiction of a 15-year-old.', 'refusal'],
  ['an over-long output', `${wordPrompt(80)} ${'x'.repeat(MAX_PROMPT_CHARS)}`, 'over-char-limit'],
  ['an output that is not longer', 'an adult woman reads near the window', 'not-longer'],
] as const) {
  test(`fails open on ${label}`, async () => {
    replying(text);
    const runtime = testRuntime({ seedLegacyText: true, LOG_LEVEL: 'info' });

    expect(await expand(runtime, SHORT)).toBe(SHORT);
    expect(skipReason(runtime)).toBe(reason);
  });
}

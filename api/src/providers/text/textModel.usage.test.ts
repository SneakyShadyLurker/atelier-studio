import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { TEST_SERVER_HOSTNAME } from '../../test/server';
import type { LanguageModelV4, LanguageModelV4StreamPart, LanguageModelV4Usage, SharedV4Warning } from '@ai-sdk/provider';
import { restoreFetch } from '../../test/helpers';
import { hostPortProbeResponse, isHostPortProbe } from '../../test/hostProbe';
import { genericTextModel, testTextModelProvider, testTextProviderRow } from '../../test/textModelProvider';
import { testTextPolicies } from '../../test/textPolicies';
import type { ProviderLogger } from '../types';
import { openaiCompatibleAdapter } from './openaiCompatible';
import { createTextModelProvider, type TextModelProvider } from './textModel';

// Token usage and timing: the wire tap keeps the trailing usage frame of an
// OpenAI-style stream, and every provider call logs one content-free
// `text_call` event.

const servers: Bun.Server<unknown>[] = [];
beforeEach(() => {
  restoreFetch();
});
afterEach(async () => {
  restoreFetch();
  await Promise.all(servers.splice(0).map((s) => s.stop(true)));
});

interface Captured {
  readonly bodies: Record<string, unknown>[];
}

/** An upstream that writes `frames` and then holds the connection open until the client cancels. */
function serveHeldOpen(frames: readonly string[], captured?: Captured): { url: string; released: Promise<void> } {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const server = Bun.serve({
    port: 0,
    hostname: TEST_SERVER_HOSTNAME,
    async fetch(req) {
      if (isHostPortProbe(req)) return hostPortProbeResponse();
      captured?.bodies.push(await req.json() as Record<string, unknown>);
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(frames.map((f) => `data: ${f}\n\n`).join('')));
        },
        cancel() { release(); },
      }), { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, released };
}

/** An upstream that writes `frames` and then breaks the connection instead of closing it. */
function serveResetAfter(frames: readonly string[]): string {
  const server = Bun.serve({
    port: 0,
    hostname: TEST_SERVER_HOSTNAME,
    fetch(req) {
      if (isHostPortProbe(req)) return hostPortProbeResponse();
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(frames.map((f) => `data: ${f}\n\n`).join('')));
          setTimeout(() => { controller.error(new Error('connection reset')); }, 30);
        },
      }), { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

function captureLogger(): { logger: ProviderLogger; records: Record<string, unknown>[] } {
  const records: Record<string, unknown>[] = [];
  return {
    records,
    logger: {
      info: (fields) => { records.push({ level: 'info', ...fields }); },
      warn: (fields) => { records.push({ level: 'warn', ...fields }); },
    },
  };
}

async function enhanceAll(provider: TextModelProvider): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const chunk of provider.enhance('a cat', [], new AbortController().signal)) out.push(chunk);
  return out;
}

const content = (text: string, finish: string | null = null) =>
  JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: finish }] });
const usageFrame = JSON.stringify({
  choices: [],
  usage: {
    prompt_tokens: 11,
    completion_tokens: 7,
    prompt_tokens_details: { cached_tokens: 4 },
    completion_tokens_details: { reasoning_tokens: 3 },
  },
});

const hung = (ms: number) => new Promise<'hung'>((resolve) => { setTimeout(() => { resolve('hung'); }, ms); });

describe('wire tap end rule', () => {
  test('captures the usage frame sent after the finish_reason frame, then releases the upstream', async () => {
    const { url, released } = serveHeldOpen([content('a cat', 'stop'), usageFrame]);
    const { logger, records } = captureLogger();
    const provider = testTextModelProvider({ origin: url, model: genericTextModel('m'), logger, finishGraceMs: 10_000 });
    expect(await Promise.race([enhanceAll(provider), hung(3000)])).toEqual([{ type: 'delta', text: 'a cat' }, { type: 'done' }]);
    expect(await Promise.race([released.then(() => 'released' as const), hung(1000)])).toBe('released');
    const call = records.find((r) => r.event === 'text_call');
    expect(call).toMatchObject({ inputTokens: 11, outputTokens: 7, reasoningTokens: 3, cacheReadTokens: 4, finish: 'stop' });
  });

  test('a finish_reason frame carrying usage ends the stream at once', async () => {
    const withUsage = JSON.stringify({ ...JSON.parse(content('a cat', 'stop')) as object, usage: { prompt_tokens: 5, completion_tokens: 2 } });
    const { url } = serveHeldOpen([withUsage]);
    const { logger, records } = captureLogger();
    const provider = testTextModelProvider({ origin: url, model: genericTextModel('m'), logger, finishGraceMs: 10_000 });
    expect(await Promise.race([enhanceAll(provider), hung(3000)])).toEqual([{ type: 'delta', text: 'a cat' }, { type: 'done' }]);
    expect(records.find((r) => r.event === 'text_call')).toMatchObject({ inputTokens: 5, outputTokens: 2 });
  });

  test('[DONE] right after the finish_reason frame ends at once, without waiting out the grace period', async () => {
    const { url } = serveHeldOpen([content('a cat', 'stop'), '[DONE]']);
    const provider = testTextModelProvider({ origin: url, model: genericTextModel('m'), finishGraceMs: 10_000 });
    expect(await Promise.race([enhanceAll(provider), hung(3000)])).toEqual([{ type: 'delta', text: 'a cat' }, { type: 'done' }]);
  });

  test('a finish_reason frame followed by silence closes after the grace period', async () => {
    const { url, released } = serveHeldOpen([content('a cat', 'stop')]);
    const provider = testTextModelProvider({ origin: url, model: genericTextModel('m'), finishGraceMs: 100 });
    const started = Date.now();
    expect(await Promise.race([enhanceAll(provider), hung(3000)])).toEqual([{ type: 'delta', text: 'a cat' }, { type: 'done' }]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    expect(await Promise.race([released.then(() => 'released' as const), hung(1000)])).toBe('released');
  });

  test('a connection that breaks after the finish_reason frame still completes the answer', async () => {
    const url = serveResetAfter([content('a cat', 'stop')]);
    const provider = testTextModelProvider({ origin: url, model: genericTextModel('m'), finishGraceMs: 10_000 });
    expect(await Promise.race([enhanceAll(provider), hung(3000)])).toEqual([{ type: 'delta', text: 'a cat' }, { type: 'done' }]);
  });

  test('a connection that breaks before any finish_reason frame is still a failure', async () => {
    const url = serveResetAfter([content('a cat')]);
    const provider = testTextModelProvider({ origin: url, model: genericTextModel('m'), finishGraceMs: 10_000 });
    const chunks = await Promise.race([enhanceAll(provider), hung(3000)]);
    expect(Array.isArray(chunks) && chunks.at(-1)).toMatchObject({ type: 'failed' });
  });

  test('content frames after the finish_reason frame are never forwarded', async () => {
    const { url } = serveHeldOpen([content('a cat', 'stop'), content(' and more'), usageFrame]);
    const provider = testTextModelProvider({ origin: url, model: genericTextModel('m'), finishGraceMs: 10_000 });
    expect(await Promise.race([enhanceAll(provider), hung(3000)])).toEqual([{ type: 'delta', text: 'a cat' }, { type: 'done' }]);
  });

  test('includeUsage asks an OpenAI-compatible stream for usage; off by default', async () => {
    const captured: Captured = { bodies: [] };
    const { url } = serveHeldOpen([content('ok', 'stop'), '[DONE]'], captured);
    await enhanceAll(testTextModelProvider({ origin: url, model: genericTextModel('m'), includeUsage: true }));
    await enhanceAll(testTextModelProvider({ origin: url, model: genericTextModel('m') }));
    expect(captured.bodies[0]?.stream_options).toEqual({ include_usage: true });
    expect(captured.bodies[1]?.stream_options).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// text_call events, driven through a scripted language model.

const USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 120, noCache: 100, cacheRead: 20, cacheWrite: undefined },
  outputTokens: { total: 40, text: 30, reasoning: 10 },
};

type Script = (attempt: number) => LanguageModelV4StreamPart[] | Error;

function scriptedModel(script: Script, delayMs = 0): { model: LanguageModelV4; attempts: () => number } {
  let attempts = 0;
  const model: LanguageModelV4 = {
    specificationVersion: 'v4',
    provider: 'scripted',
    modelId: 'scripted',
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error('not used')),
    doStream: async () => {
      attempts += 1;
      const parts = script(attempts);
      if (parts instanceof Error) throw parts;
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { stream: new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          for (const part of parts) controller.enqueue(part);
          controller.close();
        },
      }) };
    },
  };
  return { model, attempts: () => attempts };
}

function okParts(text: string, warnings: SharedV4Warning[] = [], usage: LanguageModelV4Usage = USAGE): LanguageModelV4StreamPart[] {
  return [
    { type: 'stream-start', warnings },
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: text },
    { type: 'text-end', id: 't' },
    { type: 'finish', usage, finishReason: { unified: 'stop', raw: 'stop' } },
  ];
}

function scriptedProvider(script: Script, logger: ProviderLogger, rowId = 'row-1'): TextModelProvider {
  const { model } = scriptedModel(script, 5);
  const provider = testTextProviderRow('http://x');
  return createTextModelProvider({
    ...testTextPolicies(),
    adapter: { ...openaiCompatibleAdapter, languageModel: () => model },
    provider,
    credential: () => Promise.resolve('sk-test'),
    model: genericTextModel('m', { id: rowId }),
    maxResponseBytes: 1_000_000,
    logger,
  });
}

const signal = () => new AbortController().signal;

describe('text_call event', () => {
  test('one content-free event per call with task, row, protocol, timings, tokens, finish and outcome', async () => {
    const { logger, records } = captureLogger();
    const provider = scriptedProvider(() => okParts('PRIVATE_OUTPUT_CANARY'), logger);
    expect(await provider.rewrite({ prompt: 'PRIVATE_PROMPT_CANARY' }, signal())).toEqual({ type: 'ok', text: 'PRIVATE_OUTPUT_CANARY' });
    const calls = records.filter((r) => r.event === 'text_call');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      level: 'info',
      event: 'text_call',
      task: 'rewrite',
      textModelId: 'row-1',
      protocol: 'openai-compatible',
      durationMs: expect.any(Number) as unknown as number,
      ttfbMs: expect.any(Number) as unknown as number,
      inputTokens: 120,
      outputTokens: 40,
      reasoningTokens: 10,
      cacheReadTokens: 20,
      finish: 'stop',
      outcome: 'ok',
      attempts: 1,
    });
    expect(JSON.stringify(records)).not.toContain('CANARY');
  });

  test('a call retried by its policy logs once, with its attempts and the last attempt\'s usage', async () => {
    const { logger, records } = captureLogger();
    const transient = Object.assign(new Error('upstream 503'), { statusCode: 503 });
    const provider = scriptedProvider((attempt) => (attempt === 1 ? transient : okParts('fine')), logger);
    const result = await provider.rewrite({ prompt: 'p' }, signal());
    expect(result.type).toBe('ok');
    const calls = records.filter((r) => r.event === 'text_call');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ attempts: 2, outcome: 'ok', inputTokens: 120 });
  });

  test('token fields are omitted when the upstream sent none; a failure logs its kind', async () => {
    const { logger, records } = captureLogger();
    const none: LanguageModelV4Usage = {
      inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: undefined, text: undefined, reasoning: undefined },
    };
    const provider = scriptedProvider(() => [
      { type: 'stream-start', warnings: [] },
      { type: 'finish', usage: none, finishReason: { unified: 'content-filter', raw: 'content_filter' } },
    ], logger);
    const result = await provider.draftList({ name: 'Colours', existing: [], target: 10 }, signal());
    expect(result.type).toBe('failed');
    const call = records.find((r) => r.event === 'text_call');
    expect(call).toMatchObject({ task: 'draft-list', finish: 'content-filter', outcome: 'permanent', attempts: 1 });
    for (const key of ['inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens', 'ttfbMs']) {
      expect(call !== undefined && key in call).toBe(false);
    }
  });

  test('streamed tasks log once when the stream ends', async () => {
    const { logger, records } = captureLogger();
    const provider = scriptedProvider(() => okParts('a cat'), logger);
    await enhanceAll(provider);
    expect(records.filter((r) => r.event === 'text_call')).toEqual([
      expect.objectContaining({ task: 'enhance', outcome: 'ok', attempts: 1 }) as unknown as Record<string, unknown>,
    ]);
  });

  test('tasks are named per feature method', async () => {
    const { logger, records } = captureLogger();
    const provider = scriptedProvider(() => okParts('{}'), logger);
    await provider.inferDimensions('{}', signal());
    await provider.inferTaxonomy('{}', signal());
    await provider.inferDimensionsSingleAttempt('{}', signal());
    await provider.aiFill({ systemPrompt: 's', userContent: 'u' }, signal());
    await provider.aiFill({ systemPrompt: 's', userContent: 'u', batchSize: 3 }, signal());
    expect(records.filter((r) => r.event === 'text_call').map((r) => r.task))
      .toEqual(['infer', 'taxonomy', 'infer-retry-gaps', 'ai-fill', 'ai-fill-batch']);
  });

  test('SDK call warnings log once per model row as identifiers only', async () => {
    const { logger, records } = captureLogger();
    const warnings: SharedV4Warning[] = [
      { type: 'unsupported', feature: 'topK', details: 'PRIVATE_DETAIL_CANARY' },
      { type: 'deprecated', setting: 'maxTokens', message: 'PRIVATE_MESSAGE_CANARY' },
      { type: 'other', message: 'PRIVATE_MESSAGE_CANARY' },
    ];
    const provider = scriptedProvider(() => okParts('x', warnings), logger, 'row-warn');
    await provider.rewrite({ prompt: 'p' }, signal());
    await provider.rewrite({ prompt: 'p' }, signal());
    const logged = records.filter((r) => r.event === 'text_call_warnings');
    expect(logged).toEqual([{
      level: 'warn',
      event: 'text_call_warnings',
      textModelId: 'row-warn',
      warningTypes: ['unsupported:topK', 'deprecated:maxTokens', 'other'],
    }]);
    expect(JSON.stringify(records)).not.toContain('CANARY');
  });
});

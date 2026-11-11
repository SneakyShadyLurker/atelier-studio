import { afterEach, describe, expect, test } from 'bun:test';
import { genericTextModel, testTextModelProvider, testTextProviderRow } from '../../test/textModelProvider';
import { testTextPolicies } from '../../test/textPolicies';
import type { BrainstormChunk, EnhanceChunk } from './featureHelpers';
import { textAdapterFor } from './registry';
import { createTextModelProvider, type TextModelProvider } from './textModel';

// In-stream failures of the streamed generators (enhance, brainstorm) and the
// accumulating calls: error-frame classification and the stall watchdog.

const original = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = original;
});

const encoder = new TextEncoder();
const contentFrame = (text: string): string => `data: {"choices":[{"delta":{"content":${JSON.stringify(text)}}}]}\n\n`;
const stopFrame = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';

/** A 200 SSE response whose body the script writes over time. */
function scriptedResponse(script: (send: (text: string) => void, signal: AbortSignal) => Promise<void>): Response {
  const cancelled = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      await script((text) => {
        if (!cancelled.signal.aborted) controller.enqueue(encoder.encode(text));
      }, cancelled.signal);
      if (!cancelled.signal.aborted) controller.close();
    },
    cancel() {
      cancelled.abort();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const wait = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => {
    clearTimeout(timer);
    resolve();
  }, { once: true });
});

/** Sends one content frame, then nothing until the reader gives up. */
const stalledAfterContent = () => scriptedResponse(async (send, signal) => {
  send(contentFrame('partial'));
  await wait(60_000, signal);
});

function useFetch(respond: (call: number) => Response): { readonly calls: () => number } {
  let calls = 0;
  globalThis.fetch = (() => {
    calls += 1;
    return Promise.resolve(respond(calls));
  }) as unknown as typeof fetch;
  return { calls: () => calls };
}

/** A provider with the stall watchdog on (testTextModelProvider has no idle option). */
function watchedProvider(streamIdleMs: number): TextModelProvider {
  const provider = testTextProviderRow('http://x');
  return createTextModelProvider({
    ...testTextPolicies(),
    adapter: textAdapterFor(provider.protocol),
    provider,
    credential: () => Promise.resolve('sk-test'),
    model: genericTextModel('m'),
    maxResponseBytes: 1_000_000,
    streamIdleMs,
  });
}

async function enhanceChunks(provider: TextModelProvider): Promise<EnhanceChunk[]> {
  const chunks: EnhanceChunk[] = [];
  for await (const chunk of provider.enhance('hi', [], new AbortController().signal)) chunks.push(chunk);
  return chunks;
}

async function brainstormChunks(provider: TextModelProvider): Promise<BrainstormChunk[]> {
  const chunks: BrainstormChunk[] = [];
  for await (const chunk of provider.brainstormCharacters(
    { count: 2, modelId: 'gpt-image-2.6-sunburst' },
    new AbortController().signal,
  )) chunks.push(chunk);
  return chunks;
}

describe('enhance classifies in-stream error frames', () => {
  const plain = () => testTextModelProvider({ origin: 'http://x', model: genericTextModel('m') });

  test('a quota error frame yields a quota failure', async () => {
    useFetch(() => scriptedResponse((send) => {
      send(contentFrame('Hello'));
      send('data: {"error":{"message":"weekly limit reached"}}\n\n');
      return Promise.resolve();
    }));
    const chunks = await enhanceChunks(plain());
    expect(chunks.at(-1)).toMatchObject({ type: 'failed', kind: 'quota', status: null });
  });

  test('a 5xx error frame yields a transient failure', async () => {
    useFetch(() => scriptedResponse((send) => {
      send(contentFrame('Hello'));
      send('data: {"error":{"code":503,"message":"upstream unavailable"}}\n\n');
      return Promise.resolve();
    }));
    const chunks = await enhanceChunks(plain());
    expect(chunks.at(-1)).toEqual({
      type: 'failed',
      kind: 'transient',
      status: null,
      detail: '{"code":503,"message":"upstream unavailable"}',
    });
  });
});

describe('stream stall watchdog', () => {
  test('enhance fails transient when the upstream goes silent', async () => {
    useFetch(stalledAfterContent);
    const chunks = await enhanceChunks(watchedProvider(50));
    expect(chunks[0]).toEqual({ type: 'delta', text: 'partial' });
    expect(chunks.at(-1)).toMatchObject({ type: 'failed', kind: 'transient' });
  });

  test('brainstorm fails transient when the upstream goes silent', async () => {
    useFetch(stalledAfterContent);
    const chunks = await brainstormChunks(watchedProvider(50));
    expect(chunks.at(-1)).toMatchObject({ type: 'failed', kind: 'transient' });
  });

  test('an accumulating call retries a stalled stream', async () => {
    const fetchState = useFetch((call) => call === 1
      ? stalledAfterContent()
      : scriptedResponse((send) => {
        send(contentFrame(JSON.stringify({ kind: 'entries', entries: ['teal'] })));
        send(stopFrame);
        return Promise.resolve();
      }));
    const result = await watchedProvider(50).draftList(
      { name: 'colours', existing: [], target: 1 },
      new AbortController().signal,
    );
    expect(result).toEqual({ type: 'ok', payload: { kind: 'entries', entries: ['teal'] } });
    expect(fetchState.calls()).toBe(2);
  });

  test('SSE comment keepalives without content do not cut the stream', async () => {
    useFetch(() => scriptedResponse(async (send, signal) => {
      // 200 ms of keepalives, each well inside the 50 ms idle limit.
      for (let i = 0; i < 10 && !signal.aborted; i += 1) {
        send(': keepalive\n\n');
        await wait(20, signal);
      }
      send(contentFrame('Hello'));
      send(stopFrame);
    }));
    const chunks = await enhanceChunks(watchedProvider(50));
    expect(chunks).toEqual([{ type: 'delta', text: 'Hello' }, { type: 'done' }]);
  });

  test('without an idle limit the watchdog is off', async () => {
    useFetch(() => scriptedResponse(async (send, signal) => {
      send(contentFrame('Hel'));
      await wait(120, signal);
      send(contentFrame('lo'));
      send(stopFrame);
    }));
    const chunks = await enhanceChunks(testTextModelProvider({ origin: 'http://x', model: genericTextModel('m') }));
    expect(chunks.at(-1)).toEqual({ type: 'done' });
  });
});

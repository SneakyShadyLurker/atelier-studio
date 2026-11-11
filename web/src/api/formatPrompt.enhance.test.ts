import { afterEach, describe, expect, mock, test } from 'bun:test';
import { formatPromptForModel } from './formatPrompt';

// An Enhance press rewrites through the same transport as the model formats:
// the real apiFetch + parseEnhanceStream, with only globalThis.fetch stubbed.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function sseBody(text: string): Response {
  return new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function queueFull(): Response {
  return new Response(JSON.stringify({ error: 'queue full', code: 'QUEUE_FULL', retry_after_seconds: 0 }), {
    status: 429,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

describe("formatPromptForModel — 'enhance'", () => {
  test('posts the request and returns the accumulated rewrite', async () => {
    let body: unknown;
    globalThis.fetch = ((_input: unknown, init?: { body?: string }) => {
      body = JSON.parse(init?.body ?? '{}');
      return Promise.resolve(sseBody('event: delta\ndata: {"text":"a red "}\n\nevent: delta\ndata: {"text":"fox"}\n\nevent: done\ndata: {}\n\n'));
    }) as unknown as typeof fetch;
    const request = { prompt: 'a fox', modelId: 'model-a', refImageIds: ['ref-1'], ratio: '1:1' as const };
    expect(await formatPromptForModel(request, 'enhance')).toBe('a red fox');
    expect(body).toEqual(request);
  });

  test('a stream that ends without done is a failure, never a partial rewrite', async () => {
    globalThis.fetch = (() => Promise.resolve(sseBody('event: delta\ndata: {"text":"a red"}\n\n'))) as unknown as typeof fetch;
    expect(await rejection(formatPromptForModel({ prompt: 'a fox' }, 'enhance'))).toBeInstanceOf(Error);
  });

  test('an empty rewrite is a failure', async () => {
    globalThis.fetch = (() => Promise.resolve(sseBody('event: done\ndata: {}\n\n'))) as unknown as typeof fetch;
    expect(await rejection(formatPromptForModel({ prompt: 'a fox' }, 'enhance'))).toBeInstanceOf(Error);
  });

  test('never reconnects once the stream opened (the upstream call is billed)', async () => {
    const fetchMock = mock(() => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(':keepalive\n\n'));
        controller.error(new Error('edge reset'));
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    expect(await rejection(formatPromptForModel({ prompt: 'a fox' }, 'enhance'))).toBeInstanceOf(Error);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('retries a typed QUEUE_FULL (no slot was taken) and returns the rewrite', async () => {
    let calls = 0;
    const fetchMock = mock(() => Promise.resolve(++calls === 1
      ? queueFull()
      : sseBody('event: delta\ndata: {"text":"a red fox"}\n\nevent: done\ndata: {}\n\n')));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    expect(await formatPromptForModel({ prompt: 'a fox' }, 'enhance')).toBe('a red fox');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

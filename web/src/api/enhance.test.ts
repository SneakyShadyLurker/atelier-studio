import { afterEach, describe, expect, mock, test } from 'bun:test';
import { enhancePromptStream } from './enhance';
import { parseEnhanceStream } from './sse';

const originalFetch = globalThis.fetch;
const originalReload = window.location.reload.bind(window.location);

afterEach(() => {
  globalThis.fetch = originalFetch;
  window.location.reload = originalReload;
  sessionStorage.clear();
  mock.restore();
});

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
}

async function rejectedValue(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected promise to reject');
}

describe('parseEnhanceStream', () => {
  test('maps delta/done frames to typed events', async () => {
    const text =
      'event: delta\ndata: {"text":"a "}\n\n' +
      'event: delta\ndata: {"text":"cat"}\n\n' +
      'event: done\ndata: {}\n\n';
    const events = [];
    for await (const e of parseEnhanceStream(streamOf(text))) events.push(e);
    expect(events).toEqual([
      { event: 'delta', data: { text: 'a ' } },
      { event: 'delta', data: { text: 'cat' } },
      { event: 'done', data: {} },
    ]);
  });

  test('error frame throws instead of yielding', async () => {
    let caught: unknown;
    try {
      for await (const _e of parseEnhanceStream(streamOf('event: error\ndata: {"message":"nope"}\n\n'))) { /* drain */ }
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('nope');
  });

  test('rejects an unknown event name', async () => {
    const gen = parseEnhanceStream(streamOf('event: bogus\ndata: {}\n\n'));
    let caught: unknown;
    try {
      for await (const _e of gen) { /* drain */ }
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/unknown SSE event/);
  });
});

describe('enhancePromptStream request body', () => {
  test('forwards refImageIds in the POST body', async () => {
    let capturedBody: unknown;
    globalThis.fetch = ((_input: unknown, init?: { body?: string }) => {
      capturedBody = JSON.parse(init?.body ?? '{}');
      const sse = 'event: done\ndata: {}\n\n';
      return Promise.resolve(new Response(streamOf(sse), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }));
    }) as unknown as typeof fetch;
    const events = [];
    for await (const e of enhancePromptStream({ prompt: 'cat', refImageIds: ['id-1', 'id-2'] })) {
      events.push(e);
    }
    expect((capturedBody as { prompt: string; refImageIds: string[] }).prompt).toBe('cat');
    expect((capturedBody as { refImageIds: string[] }).refImageIds).toEqual(['id-1', 'id-2']);
  });
});

describe('enhancePromptStream', () => {
  test('does not reconnect after a pre-payload stream drop', async () => {
    let calls = 0;
    const fetchMock = mock(() => Promise.resolve(new Response(
      ++calls === 1
        ? new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(':keepalive\n\n'));
              controller.error(new Error('edge reset'));
            },
          })
        : streamOf('event: delta\ndata: {"text":"clean restart"}\n\nevent: done\ndata: {}\n\n'),
      {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      },
    )));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const events = [];
    const stream = enhancePromptStream({ prompt: 'cat' });
    let caught: unknown;
    try {
      for await (const event of stream) events.push(event);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
  });

  test('schedules auth reload when a direct SSE fetch gets a 401', async () => {
    const reload = mock(() => undefined);
    window.location.reload = reload;
    globalThis.fetch = mock(() => new Response('', { status: 401 })) as unknown as typeof fetch;

    const stream = enhancePromptStream({ prompt: 'cat' });
    expect(await rejectedValue(stream.next())).toMatchObject({ status: 401 });

    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('schedules auth reload when a direct SSE fetch gets 200 html', async () => {
    const reload = mock(() => undefined);
    window.location.reload = reload;
    globalThis.fetch = mock(() => new Response('<!doctype html><title>Login</title>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    })) as unknown as typeof fetch;

    const stream = enhancePromptStream({ prompt: 'cat' });
    expect(await rejectedValue(stream.next())).toMatchObject({ status: 200 });

    expect(reload).toHaveBeenCalledTimes(1);
  });
});

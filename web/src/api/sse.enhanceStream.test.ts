import { afterEach, describe, expect, mock, test } from 'bun:test';
import { openSseStream, parseEnhanceStream } from './sse';

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

describe('openSseStream', () => {
  test('schedules auth reload when a direct SSE fetch gets a 401', async () => {
    const reload = mock(() => undefined);
    window.location.reload = reload;
    globalThis.fetch = mock(() => new Response('', { status: 401 })) as unknown as typeof fetch;

    expect(await rejectedValue(openSseStream('/enhance-prompt', { prompt: 'cat' }, 'prompt enhance'))).toMatchObject({ status: 401 });

    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('schedules auth reload when a direct SSE fetch gets 200 html', async () => {
    const reload = mock(() => undefined);
    window.location.reload = reload;
    globalThis.fetch = mock(() => new Response('<!doctype html><title>Login</title>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    })) as unknown as typeof fetch;

    expect(await rejectedValue(openSseStream('/enhance-prompt', { prompt: 'cat' }, 'prompt enhance'))).toMatchObject({ status: 200 });

    expect(reload).toHaveBeenCalledTimes(1);
  });
});

import { afterEach, describe, expect, test } from 'bun:test';
import { ApiError } from './client';
import { batchEventsStream, generateStream } from './generate';

const STALL_MS = 30_000;

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;

interface TimerRecord {
  handler: () => void;
  delay: number;
  cleared: boolean;
  dueAt: number;
  fired: boolean;
}

interface ManualClock {
  timers: TimerRecord[];
  advanceBy: (durationMs: number) => void;
}

function installManualTimers(): ManualClock {
  const timers: TimerRecord[] = [];
  let now = 0;
  globalThis.setTimeout = ((handler: TimerHandler, delay?: number) => {
    const record: TimerRecord = {
      handler: () => {
        if (typeof handler === 'function') {
          (handler as () => void)();
        }
      },
      delay: delay ?? 0,
      cleared: false,
      dueAt: now + (delay ?? 0),
      fired: false,
    };
    timers.push(record);
    return record as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id?: ReturnType<typeof setTimeout>) => {
    const record = id as unknown as TimerRecord | undefined;
    if (record) record.cleared = true;
  }) as typeof clearTimeout;
  return {
    timers,
    advanceBy: (durationMs: number) => {
      const target = now + durationMs;
      for (;;) {
        const next = timers
          .filter((timer) => !timer.cleared && !timer.fired && timer.dueAt <= target)
          .sort((left, right) => left.dueAt - right.dueAt)[0];
        if (!next) break;
        now = next.dueAt;
        next.fired = true;
        next.handler();
      }
      now = target;
    },
  };
}

async function flushAsync(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

function expectStalledAbort(reason: unknown): void {
  expect(reason).toBeInstanceOf(DOMException);
  expect((reason as DOMException).name).toBe('AbortError');
  expect((reason as DOMException).message).toBe('stalled');
}

function doneFrame(batchId = 'batch-1'): string {
  return `event: done\ndata: ${JSON.stringify({ batchId })}\n\n`;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
});

describe('generateStream request id handling', () => {
  test('adds a client request id to generation submissions', async () => {
    let observed: RequestInit | undefined;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      observed = init;
      return Promise.resolve(new Response('event: done\ndata: {"batchId":"b1"}\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }));
    }) as unknown as typeof fetch;

    for await (const _event of generateStream({ prompt: 'p', modelId: 'mock', ratio: '1:1', count: 1 })) {
      // drain
    }

    expect(new Headers(observed?.headers).get('X-Request-Id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(observed?.credentials).toBe('same-origin');
  });

  test('propagates the response request id on API errors', async () => {
    globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({ error: 'server failed' }), {
      status: 503,
      headers: {
        'Content-Type': 'application/json',
        'X-Request-Id': 'req_server_123',
      },
    }))) as unknown as typeof fetch;

    let caught: unknown;
    try {
      for await (const _event of generateStream({ prompt: 'p', modelId: 'mock', ratio: '1:1', count: 1 })) {
        // drain
      }
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).toHaveProperty('requestId', 'req_server_123');
  });

  test('rejects a successful submission without an authoritative batch id', async () => {
    let fetchCount = 0;
    globalThis.fetch = (() => {
      fetchCount += 1;
      return Promise.resolve(new Response(JSON.stringify({ status: 'running' }), {
        status: 201,
        headers: {
          'Content-Type': 'application/json',
          'X-Request-Id': 'req_invalid_submission',
        },
      }));
    }) as unknown as typeof fetch;

    let caught: unknown;
    try {
      for await (const _event of generateStream({ prompt: 'p', modelId: 'mock', ratio: '1:1', count: 1 })) {
        // drain
      }
    } catch (error) {
      caught = error;
    }

    expect(fetchCount).toBe(1);
    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).toHaveProperty('status', 201);
    expect(caught).toHaveProperty('requestId', 'req_invalid_submission');
    expect(caught).toHaveProperty('body', { code: 'invalid-response-shape' });
  });
});

describe('generateStream acceptance', () => {
  test('reports the accepted batch id before the events GET and keeps callbacks off the wire', async () => {
    const order: string[] = [];
    let postBody: unknown;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith('/generate')) {
        order.push('post');
        const body = init?.body;
        if (typeof body !== 'string') throw new Error('expected string request body');
        postBody = JSON.parse(body);
        return Promise.resolve(Response.json({ batchId: 'batch-accepted' }, { status: 201 }));
      }
      order.push('events');
      return Promise.resolve(new Response(JSON.stringify({ error: 'unavailable' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }));
    }) as unknown as typeof fetch;

    const request = { prompt: 'p', modelId: 'mock', ratio: '1:1', count: 1 } as const;
    let caught: unknown;
    try {
      for await (const _event of generateStream(request, undefined, {
        onAccepted: (batchId) => { order.push(`accepted:${batchId}`); },
      })) {
        // drain
      }
    } catch (error) {
      caught = error;
    }

    expect(order).toEqual(['post', 'accepted:batch-accepted', 'events']);
    expect(postBody).toEqual(request);
    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).toHaveProperty('status', 503);
  });

  test('a 200 replay body with a batchId is accepted like a 201', async () => {
    const order: string[] = [];
    const acceptances: unknown[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith('/generate')) {
        order.push('post');
        return Promise.resolve(Response.json({
          batchId: 'batch-replayed',
          tiles: [{ tileId: 't1', tileIndex: 0, seed: 1 }],
          status: 'done',
          pool: 'shared',
          replayed: true,
        }, { status: 200 }));
      }
      order.push(`events:${new URL(url, 'http://local').pathname}`);
      return Promise.resolve(new Response(doneFrame('batch-replayed'), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }));
    }) as unknown as typeof fetch;

    const events: string[] = [];
    for await (const event of generateStream(
      { prompt: 'p', modelId: 'mock', ratio: '1:1', count: 1, idempotencyKey: 'roll-1' },
      undefined,
      {
        onAccepted: (batchId, acceptance) => {
          order.push(`accepted:${batchId}`);
          acceptances.push(acceptance);
        },
      },
    )) {
      events.push(event.event);
    }

    expect(order).toEqual(['post', 'accepted:batch-replayed', 'events:/api/batches/batch-replayed/events']);
    expect(acceptances).toEqual([{ replayed: true }]);
    expect(events).toEqual(['done']);
  });

  test('a 201 acceptance is reported as not replayed', async () => {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith('/generate')) {
        return Promise.resolve(Response.json({ batchId: 'batch-new' }, { status: 201 }));
      }
      return Promise.resolve(new Response(doneFrame('batch-new'), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }));
    }) as unknown as typeof fetch;
    const acceptances: unknown[] = [];

    for await (const _event of generateStream({ prompt: 'p', modelId: 'mock', ratio: '1:1', count: 1 }, undefined, {
      onAccepted: (_batchId, acceptance) => { acceptances.push(acceptance); },
    })) {
      // drain
    }

    expect(acceptances).toEqual([{ replayed: false }]);
  });

  test('does not report acceptance for a rejected submission', async () => {
    globalThis.fetch = (() => Promise.resolve(Response.json(
      { error: 'queue full', code: 'QUEUE_FULL' },
      { status: 429 },
    ))) as unknown as typeof fetch;
    const accepted: string[] = [];

    let caught: unknown;
    try {
      for await (const _event of generateStream(
        { prompt: 'p', modelId: 'mock', ratio: '1:1', count: 1 },
        undefined,
        { onAccepted: (batchId) => { accepted.push(batchId); } },
      )) {
        // drain
      }
    } catch (error) {
      caught = error;
    }

    expect(caught).toHaveProperty('status', 429);
    expect(accepted).toEqual([]);
  });

  test('reports acceptance once from the first batch event of a direct SSE response', async () => {
    const batchFrame = `event: batch\ndata: ${JSON.stringify({
      batchId: 'batch-sse',
      status: 'running',
      createdAt: 1,
      tiles: [{ tileId: 't1', tileIndex: 0, seed: 1 }],
    })}\n\n`;
    globalThis.fetch = (() => Promise.resolve(new Response(batchFrame + batchFrame + doneFrame('batch-sse'), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }))) as unknown as typeof fetch;
    const accepted: string[] = [];
    const events: string[] = [];

    for await (const event of generateStream(
      { prompt: 'p', modelId: 'mock', ratio: '1:1', count: 1 },
      undefined,
      { onAccepted: (batchId) => { accepted.push(batchId); } },
    )) {
      events.push(event.event);
    }

    expect(accepted).toEqual(['batch-sse']);
    expect(events).toEqual(['batch', 'batch', 'done']);
  });
});

describe('batchEventsStream stall watchdog', () => {
  test('aborts when an events stream goes silent for more than the stall timeout', async () => {
    const clock = installManualTimers();
    let fetchSignal: AbortSignal | undefined;

    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      fetchSignal = init?.signal ?? undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          fetchSignal?.addEventListener('abort', () => {
            controller.error(fetchSignal?.reason);
          }, { once: true });
        },
      });
      return Promise.resolve(new Response(stream, {
        headers: { 'content-type': 'text/event-stream' },
      }));
    }) as typeof fetch;

    const iterator = batchEventsStream('batch-1');
    const pending = iterator.next();

    try {
      await flushAsync();

      expect(fetchSignal).toBeDefined();
      clock.advanceBy(STALL_MS + 1);
      const error = await pending.catch((caught: unknown) => caught);

      expectStalledAbort(error);
    } finally {
      await iterator.return(undefined);
    }
  });

  test('does not abort while complete keepalive frames arrive within the stall timeout', async () => {
    const clock = installManualTimers();
    const encoder = new TextEncoder();
    let fetchSignal: AbortSignal | undefined;
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;

    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      fetchSignal = init?.signal ?? undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          fetchSignal?.addEventListener('abort', () => {
            controller.error(fetchSignal?.reason);
          }, { once: true });
        },
      });
      return Promise.resolve(new Response(stream, {
        headers: { 'content-type': 'text/event-stream' },
      }));
    }) as typeof fetch;

    const events: unknown[] = [];
    const consume = (async () => {
      for await (const event of batchEventsStream('batch-1')) {
        events.push(event);
      }
    })();

    await flushAsync();
    expect(streamController).toBeDefined();

    for (let index = 0; index < 6; index += 1) {
      clock.advanceBy(10_000);
      streamController?.enqueue(encoder.encode(':keepalive\n\n'));
      await flushAsync();
      expect(fetchSignal?.aborted).toBe(false);
    }

    streamController?.enqueue(encoder.encode(doneFrame()));
    streamController?.close();
    await consume;

    expect(fetchSignal?.aborted).toBe(false);
    expect(events).toEqual([{ event: 'done', data: { batchId: 'batch-1' } }]);
  });

  test('aborts when raw bytes drip without a complete SSE frame', async () => {
    const clock = installManualTimers();
    const caller = new AbortController();
    const encoder = new TextEncoder();
    let fetchSignal: AbortSignal | undefined;
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;

    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      fetchSignal = init?.signal ?? undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          fetchSignal?.addEventListener('abort', () => {
            controller.error(fetchSignal?.reason);
          }, { once: true });
        },
      });
      return Promise.resolve(new Response(stream, {
        headers: { 'content-type': 'text/event-stream' },
      }));
    }) as typeof fetch;

    const iterator = batchEventsStream('batch-1', caller.signal);
    const pending = iterator.next().catch((caught: unknown) => caught);

    try {
      await flushAsync();
      expect(streamController).toBeDefined();

      clock.advanceBy(29_000);
      streamController?.enqueue(encoder.encode(':'));
      await flushAsync();
      expect(fetchSignal?.aborted).toBe(false);

      clock.advanceBy(1_001);
      expect(fetchSignal?.aborted).toBe(true);
      const error = await pending.catch((caught: unknown) => caught);

      expectStalledAbort(error);
    } finally {
      caller.abort();
      await iterator.return(undefined);
    }
  });

  test('aborts when fetch never resolves before response headers', async () => {
    const clock = installManualTimers();
    const caller = new AbortController();
    let fetchSignal: AbortSignal | undefined;

    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      fetchSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        fetchSignal?.addEventListener('abort', () => {
          reject(new Error('fetch aborted'));
        }, { once: true });
      });
    }) as typeof fetch;

    const iterator = batchEventsStream('batch-1', caller.signal);
    const pending = iterator.next().catch((caught: unknown) => caught);

    try {
      await flushAsync();

      expect(fetchSignal).toBeDefined();
      clock.advanceBy(STALL_MS + 1);
      expect(fetchSignal?.aborted).toBe(true);
      const error: unknown = fetchSignal?.reason;
      await pending;

      expectStalledAbort(error);
    } finally {
      caller.abort();
      await iterator.return(undefined);
    }
  });
});

import type { Batch, GenerateRequest, Model } from '@atelier/shared';
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { historyKeys } from '../api/history';
import { modelKeys } from '../api/models';
import { resetAnnouncedBatchesForTests } from '../lib/queueLiveAnnouncer';
import { useAtelierStore } from '../store/atelier';
import { emitHistoryCancel, MY_TAB_ID, resetBroadcastForTests } from './broadcastHistory';
import { getBatch, registerBatch, resetInFlightForTests } from './inFlightBatches';
import type { HistoryData } from './historyCache';
import { useGenerate } from './useGenerate';
import { markDrainOwned } from '../lib/drainOwnership';
import { flushQueryNotifications } from '../../test/fixtures/queryNotifications';

const originalFetch = globalThis.fetch;
const originalBroadcastChannel = window.BroadcastChannel;

const models: readonly Model[] = [
  {
    id: 'gemini-3-pro-image-preview',
    name: 'Nano Banana Pro',
    backend: 'cloud',
    tag: 'google',
    latency: 'medium',
    supportedRatios: ['1:1', '4:5', '16:9', '9:16'],
    requiresKey: { provider: 'google' },
    pool: 'byok',
      concurrencyCapPerUser: 4,
      maxCountPerBatch: 4,
  },
];

const sharedModel: Model = {
  id: 'mock-slow',
  name: 'Mock Slow',
  backend: 'local',
  tag: 'dev',
  latency: 'slow',
  supportedRatios: ['1:1'],
  pool: 'shared',
  concurrencyCapPerUser: 4,
  maxCountPerBatch: 4,
};

const allModelsById: ReadonlyMap<string, Model> = new Map(
  [...models, sharedModel].map((model) => [model.id, model]),
);

function wrapper(client: QueryClient) {
  return function TestWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

class MockChannel {
  static listeners = new Set<(event: MessageEvent) => void>();

  postMessage(message: unknown): void {
    for (const listener of MockChannel.listeners) {
      listener({ data: message } as MessageEvent);
    }
  }

  addEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
    MockChannel.listeners.add(listener);
  }

  removeEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
    MockChannel.listeners.delete(listener);
  }

  close(): void {
    return undefined;
  }
}

function setBroadcastChannel(value: typeof BroadcastChannel | undefined): void {
  Object.defineProperty(window, 'BroadcastChannel', {
    configurable: true,
    writable: true,
    value,
  });
}

afterEach(async () => {
  // A settled generation notifies its TanStack observers one tick later; land
  // that inside act before tearing down.
  await act(async () => { await flushQueryNotifications(); });
  globalThis.fetch = originalFetch;
  mock.restore();
  resetBroadcastForTests();
  resetInFlightForTests();
  resetAnnouncedBatchesForTests();
  MockChannel.listeners.clear();
  setBroadcastChannel(originalBroadcastChannel);
  useAtelierStore.setState({
    byokOpen: false,
    draining: false,
    toasts: [],
    draft: { prompt: '', modelId: '', ratio: '1:1', durationFrames: null, count: 2, refImages: [], rollQueue: [] },
  });
  useAtelierStore.getState().clearFollowAnchor();
  document.querySelector('[data-atelier-queue-live]')?.remove();
});

describe('useGenerate cross-tab cancel handling', () => {
  test('aborts an in-flight generate request on unmount before the batch event arrives', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    let capturedSignal: AbortSignal | undefined;
    globalThis.fetch = mock((_input: RequestInfo | URL, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        capturedSignal?.addEventListener('abort', () => {
          reject(capturedSignal?.reason instanceof Error ? capturedSignal.reason : new DOMException('aborted', 'AbortError'));
        }, { once: true });
      });
    }) as unknown as typeof fetch;

    const { result, unmount } = renderHook(() => useGenerate(allModelsById), { wrapper: wrapper(client) });
    const pending = result.current.generate({
      prompt: 'make an image',
      modelId: 'mock-slow',
      ratio: '1:1',
      count: 1,
    }).catch(() => undefined);
    await waitFor(() => {
      expect(capturedSignal).toBeDefined();
    });

    unmount();

    await waitFor(() => {
      expect(capturedSignal?.aborted).toBe(true);
    });
    await pending;
  });

  test('aborts the owning SSE controller when a sibling tab broadcasts cancel', async () => {
    setBroadcastChannel(MockChannel as never);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidateQueries = mock(() => Promise.resolve());
    client.invalidateQueries = invalidateQueries;
    const controller = new AbortController();
    registerBatch('batch-cross-tab-cancel', controller);

    renderHook(() => useGenerate(allModelsById), { wrapper: wrapper(client) });
    emitHistoryCancel('batch-cross-tab-cancel', 'sibling-tab');

    await waitFor(() => {
      expect(controller.signal.aborted).toBe(true);
    });
    expect(controller.signal.reason).toMatchObject({
      name: 'AbortError',
      message: 'canceled by sibling tab',
    });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: historyKeys.all() });
  });

  test('ignores cancel messages from this tab id', async () => {
    setBroadcastChannel(MockChannel as never);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidateQueries = mock(() => Promise.resolve());
    client.invalidateQueries = invalidateQueries;
    const controller = new AbortController();
    registerBatch('batch-same-tab-cancel', controller);

    renderHook(() => useGenerate(allModelsById), { wrapper: wrapper(client) });
    emitHistoryCancel('batch-same-tab-cancel', MY_TAB_ID);

    await Promise.resolve();
    expect(controller.signal.aborted).toBe(false);
    expect(invalidateQueries).not.toHaveBeenCalled();
  });
});

describe('useGenerate BYOK gate', () => {
  test('opens BYOK and does not call generate when cached model requires a key', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    client.setQueryData(modelKeys.list(), models);
    const fetchMock = mock(() => Promise.resolve(new Response(null, { status: 500 })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useGenerate(allModelsById), { wrapper: wrapper(client) });

    let rejection: unknown;
    await act(async () => {
      try {
        await result.current.generate({
          prompt: 'make an image',
          modelId: 'gemini-3-pro-image-preview',
          ratio: '1:1',
          count: 1,
        });
      } catch (error) {
        rejection = error;
      }
    });

    expect(rejection).toMatchObject({ name: 'NeedsKeyError' });

    await waitFor(() => {
      expect(useAtelierStore.getState().byokOpen).toBe(true);
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useAtelierStore.getState().toasts).toHaveLength(0);
  });

  test('opens BYOK without toast when server reports missing Google key', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const fetchMock = mock(() =>
      Promise.resolve(Response.json(
        { error: 'BYOK key required', code: 'NEEDS_GOOGLE_KEY' },
        { status: 400 },
      ))
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // Stale client registry (no BYOK model in the map) so the client-side
    // requiresKey gate misses and the SERVER's NEEDS_GOOGLE_KEY 400 is the
    // path under test.
    const { result } = renderHook(() => useGenerate(new Map()), { wrapper: wrapper(client) });

    let rejection: unknown;
    await act(async () => {
      try {
        await result.current.generate({
          prompt: 'make an image',
          modelId: 'gemini-3-pro-image-preview',
          ratio: '1:1',
          count: 1,
        });
      } catch (error) {
        rejection = error;
      }
    });

    expect(rejection).toMatchObject({ name: 'ApiError', status: 400 });
    await waitFor(() => {
      expect(useAtelierStore.getState().byokOpen).toBe(true);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useAtelierStore.getState().toasts).toHaveLength(0);
  });
});

describe('useGenerate queue-full copy', () => {
  test('suppresses a drain-owned QUEUE_FULL toast while preserving the rejection', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    client.setQueryData(modelKeys.list(), [sharedModel]);
    globalThis.fetch = mock(() =>
      Promise.resolve(Response.json(
        { error: 'queue full', code: 'QUEUE_FULL', retry_after_seconds: 1 },
        { status: 429 },
      ))
    ) as unknown as typeof fetch;
    useAtelierStore.setState({ draining: true, toasts: [] });

    const { result } = renderHook(() => useGenerate(allModelsById), { wrapper: wrapper(client) });
    const request = {
      prompt: 'make an image',
      modelId: 'mock-slow',
      ratio: '1:1',
      count: 1,
    } satisfies Parameters<typeof result.current.generate>[0];
    markDrainOwned(request);
    let rejection: unknown;
    await act(async () => {
      try {
        await result.current.generate(request);
      } catch (error) {
        rejection = error;
      }
    });

    expect(rejection).toMatchObject({ name: 'ApiError', status: 429 });
    expect(useAtelierStore.getState().toasts).toHaveLength(0);
    useAtelierStore.setState({ draining: false });
  });

  test('toasts a non-drain-owned QUEUE_FULL request while a drain is active', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    client.setQueryData(modelKeys.list(), [sharedModel]);
    globalThis.fetch = mock(() =>
      Promise.resolve(Response.json(
        { error: 'queue full', code: 'QUEUE_FULL', retry_after_seconds: 2 },
        { status: 429 },
      ))
    ) as unknown as typeof fetch;
    useAtelierStore.setState({ draining: true, toasts: [] });

    const { result } = renderHook(() => useGenerate(allModelsById), { wrapper: wrapper(client) });
    let rejection: unknown;
    await act(async () => {
      try {
        await result.current.generate({
          prompt: 'retry one failed tile',
          modelId: 'mock-slow',
          ratio: '1:1',
          count: 1,
        });
      } catch (error) {
        rejection = error;
      }
    });

    expect(rejection).toMatchObject({ name: 'ApiError', status: 429 });
    expect(useAtelierStore.getState().toasts[0]?.text).toBe('At capacity — try again in 2s');
  });

  test('uses structured retry-after copy for QUEUE_FULL 429s', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    client.setQueryData(modelKeys.list(), [sharedModel]);
    globalThis.fetch = mock(() =>
      Promise.resolve(Response.json(
        { error: 'queue full', code: 'QUEUE_FULL', reason: 'shared', retry_after_seconds: 5 },
        { status: 429 },
      ))
    ) as unknown as typeof fetch;

    const { result } = renderHook(() => useGenerate(allModelsById), { wrapper: wrapper(client) });

    let rejection: unknown;
    await act(async () => {
      try {
        await result.current.generate({
          prompt: 'make an image',
          modelId: 'mock-slow',
          ratio: '1:1',
          count: 1,
        });
      } catch (error) {
        rejection = error;
      }
    });

    expect(rejection).toMatchObject({ name: 'ApiError', status: 429 });
    expect(useAtelierStore.getState().toasts[0]?.text).toBe('At capacity — try again in 5s');
  });
});

describe('useGenerate queue accounting', () => {
  test('counts a queued batch once and keeps it queued after stream truncation', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    client.setQueryData(modelKeys.list(), [sharedModel]);
    const batchId = '00000000-0000-4000-8000-000000000901';
    const fetchMock = mock((input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input), 'http://local');
      if (url.pathname === '/api/generate') {
        return Promise.resolve(Response.json({
          batchId,
          status: 'queued',
          pool: 'shared',
          queueLengthAhead: 0,
          tiles: [
            { tileId: 't1', tileIndex: 0, seed: 1 },
            { tileId: 't2', tileIndex: 1, seed: 2 },
            { tileId: 't3', tileIndex: 2, seed: 3 },
            { tileId: 't4', tileIndex: 3, seed: 4 },
          ],
        }, { status: 201 }));
      }
      if (url.pathname === `/api/batches/${batchId}/events`) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(
              `event: batch\ndata: ${JSON.stringify({
                batchId,
                status: 'queued',
                createdAt: 1_700_000_000_000,
                queueLengthAhead: 0,
                tiles: [
                  { tileId: 't1', tileIndex: 0, seed: 1 },
                  { tileId: 't2', tileIndex: 1, seed: 2 },
                  { tileId: 't3', tileIndex: 2, seed: 3 },
                  { tileId: 't4', tileIndex: 3, seed: 4 },
                ],
              })}\n\n`,
            ));
            controller.close();
          },
        });
        return Promise.resolve(new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useGenerate(allModelsById), { wrapper: wrapper(client) });

    let rejection: unknown;
    await act(async () => {
      try {
        await result.current.generate({
        prompt: 'make an image',
        modelId: 'mock-slow',
        ratio: '1:1',
        count: 4,
        });
      } catch (error) {
        rejection = error;
      }
    });

    expect(rejection).toMatchObject({ name: 'StreamTruncatedError' });
    const data = client.getQueryData<{ pages: readonly { items: readonly { id: string; status?: string }[] }[] }>(['history', { view: { kind: 'unsorted' }, q: '' }]);
    expect(data?.pages[0]?.items[0]?.status).toBe('queued');
  });

  test('announces queued generation start when the queue event arrives', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    client.setQueryData(modelKeys.list(), [sharedModel]);
    const batchId = '00000000-0000-4000-8000-000000000902';
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input), 'http://local');
      if (url.pathname === '/api/generate') {
        return Promise.resolve(Response.json({
          batchId,
          status: 'queued',
          pool: 'shared',
          queueLengthAhead: 0,
          tiles: [{ tileId: 't1', tileIndex: 0, seed: 1 }],
        }, { status: 201 }));
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(`event: batch\ndata: ${JSON.stringify({
            batchId,
            status: 'queued',
            createdAt: 1_700_000_000_000,
            queueLengthAhead: 0,
            tiles: [{ tileId: 't1', tileIndex: 0, seed: 1 }],
          })}\n\n`));
          controller.enqueue(encoder.encode(`event: queue\ndata: ${JSON.stringify({ batchId, status: 'running' })}\n\n`));
          controller.enqueue(encoder.encode(`event: done\ndata: ${JSON.stringify({ batchId })}\n\n`));
          controller.close();
        },
      });
      return Promise.resolve(new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }));
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useGenerate(allModelsById), { wrapper: wrapper(client) });
    await act(async () => {
      await result.current.generate({
        prompt: 'make an image',
        modelId: 'mock-slow',
        ratio: '1:1',
        count: 1,
      });
    });

    expect(document.querySelector('[data-atelier-queue-live]')?.textContent).toContain('Generation started for Mock Slow');
  });

  test('announces completion in the page-level region even with no batch row mounted', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    client.setQueryData(modelKeys.list(), [sharedModel]);
    const batchId = '00000000-0000-4000-8000-000000000903';
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input), 'http://local');
      if (url.pathname === '/api/generate') {
        return Promise.resolve(Response.json({ batchId, status: 'running', pool: 'shared', tiles: [{ tileId: 't1', tileIndex: 0, seed: 1 }, { tileId: 't2', tileIndex: 1, seed: 2 }] }, { status: 201 }));
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(`event: batch\ndata: ${JSON.stringify({
            batchId, status: 'running', createdAt: 1_700_000_000_000,
            tiles: [{ tileId: 't1', tileIndex: 0, seed: 1 }, { tileId: 't2', tileIndex: 1, seed: 2 }],
          })}\n\n`));
          controller.enqueue(encoder.encode(`event: tile\ndata: ${JSON.stringify({
            tileId: 't1', tileIndex: 0, status: 'done', url: '/api/img/t1', ext: 'png', mime: 'image/png', completedAt: 100,
          })}\n\n`));
          controller.enqueue(encoder.encode(`event: tile\ndata: ${JSON.stringify({
            tileId: 't2', tileIndex: 1, status: 'done', url: '/api/img/t2', ext: 'png', mime: 'image/png', completedAt: 200,
          })}\n\n`));
          controller.enqueue(encoder.encode(`event: done\ndata: ${JSON.stringify({ batchId })}\n\n`));
          controller.close();
        },
      });
      return Promise.resolve(new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useGenerate(allModelsById), { wrapper: wrapper(client) });
    await act(async () => {
      await result.current.generate({ prompt: 'make an image', modelId: 'mock-slow', ratio: '1:1', count: 2 });
    });

    expect(document.querySelector('[data-atelier-queue-live]')?.textContent).toBe('2 images ready');
  });

  test('SSE batch event follows the new batch', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    client.setQueryData(modelKeys.list(), [sharedModel]);
    const batchId = '00000000-0000-4000-8000-000000000902';
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input), 'http://local');
      if (url.pathname === '/api/generate') {
        return Promise.resolve(Response.json({
          batchId,
          status: 'queued',
          pool: 'shared',
          queueLengthAhead: 0,
          tiles: [{ tileId: 't1', tileIndex: 0, seed: 1 }],
        }, { status: 201 }));
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(`event: batch\ndata: ${JSON.stringify({
            batchId,
            status: 'queued',
            createdAt: 1_700_000_000_000,
            queueLengthAhead: 0,
            tiles: [{ tileId: 't1', tileIndex: 0, seed: 1 }],
          })}\n\n`));
          controller.enqueue(encoder.encode(`event: queue\ndata: ${JSON.stringify({ batchId, status: 'running' })}\n\n`));
          controller.enqueue(encoder.encode(`event: done\ndata: ${JSON.stringify({ batchId })}\n\n`));
          controller.close();
        },
      });
      return Promise.resolve(new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }));
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useGenerate(allModelsById), { wrapper: wrapper(client) });
    await act(async () => {
      await result.current.generate({
        prompt: 'make an image',
        modelId: 'mock-slow',
        ratio: '1:1',
        count: 1,
      });
    });

    expect(useAtelierStore.getState().followAnchorId).toBe(batchId);
  });
});

describe('useGenerate accepted batch identity', () => {
  const request = {
    prompt: 'make an image',
    modelId: 'mock-slow',
    ratio: '1:1',
    count: 1,
  } satisfies GenerateRequest;

  function acceptedThen(batchId: string, events: () => Response): { posts: unknown[] } {
    const posts: unknown[] = [];
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input), 'http://local');
      if (url.pathname === '/api/generate') {
        const body = init?.body;
        if (typeof body !== 'string') throw new Error('expected string request body');
        posts.push(JSON.parse(body));
        return Promise.resolve(Response.json({
          batchId,
          status: 'running',
          pool: 'shared',
          tiles: [{ tileId: 't1', tileIndex: 0, seed: 1 }],
        }, { status: 201 }));
      }
      return Promise.resolve(events());
    }) as unknown as typeof fetch;
    return { posts };
  }

  async function runGenerate(client: QueryClient, onAccepted: (batchId: string) => void): Promise<unknown> {
    const { result } = renderHook(() => useGenerate(allModelsById), { wrapper: wrapper(client) });
    let rejection: unknown;
    await act(async () => {
      try {
        await result.current.generate(request, { onAccepted });
      } catch (error) {
        rejection = error;
      }
    });
    return rejection;
  }

  test('a 201 followed by an events 503 reports acceptance and normalizes to a truncated stream', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidateQueries = mock(() => Promise.resolve());
    client.invalidateQueries = invalidateQueries;
    const batchId = '00000000-0000-4000-8000-000000000b01';
    const { posts } = acceptedThen(batchId, () => Response.json({ error: 'unavailable' }, { status: 503 }));
    const accepted: string[] = [];

    const rejection = await runGenerate(client, (id) => { accepted.push(id); });

    expect(accepted).toEqual([batchId]);
    expect(rejection).toMatchObject({ name: 'StreamTruncatedError', batchId });
    expect(useAtelierStore.getState().toasts).toHaveLength(0);
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: historyKeys.all() });
    expect(posts).toEqual([request]);
  });

  test('a 201 followed by a non-SSE events response keeps the accepted identity', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const batchId = '00000000-0000-4000-8000-000000000b02';
    acceptedThen(batchId, () => new Response('<html></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }));
    const accepted: string[] = [];

    const rejection = await runGenerate(client, (id) => { accepted.push(id); });

    expect(accepted).toEqual([batchId]);
    expect(rejection).toMatchObject({ name: 'StreamTruncatedError', batchId });
    expect(useAtelierStore.getState().toasts).toHaveLength(0);
  });

  test('the real batch event still writes the server createdAt into the cache after acceptance', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const batchId = '00000000-0000-4000-8000-000000000b03';
    acceptedThen(batchId, () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(`event: batch\ndata: ${JSON.stringify({
            batchId,
            status: 'running',
            createdAt: 1_700_000_000_123,
            tiles: [{ tileId: 't1', tileIndex: 0, seed: 1 }],
          })}\n\n`));
          controller.enqueue(encoder.encode(`event: done\ndata: ${JSON.stringify({ batchId })}\n\n`));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    const accepted: string[] = [];

    const rejection = await runGenerate(client, (id) => { accepted.push(id); });

    expect(rejection).toBeUndefined();
    expect(accepted).toEqual([batchId]);
    const data = client.getQueryData<{ pages: readonly { items: readonly Batch[] }[] }>(historyKeys.list());
    expect(data?.pages[0]?.items.find((batch) => batch.id === batchId)).toMatchObject({
      createdAt: 1_700_000_000_123,
      tiles: [{ id: 't1', status: 'loading' }],
    });
  });

  test('an unaccepted 429 never reports acceptance and keeps the ApiError', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    globalThis.fetch = mock(() => Promise.resolve(Response.json(
      { error: 'queue full', code: 'QUEUE_FULL', retry_after_seconds: 1 },
      { status: 429 },
    ))) as unknown as typeof fetch;
    const accepted: string[] = [];

    const rejection = await runGenerate(client, (id) => { accepted.push(id); });

    expect(accepted).toEqual([]);
    expect(rejection).toMatchObject({ name: 'ApiError', status: 429 });
  });

  test('offline, a submission fails at once instead of waiting for the network', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    globalThis.fetch = mock(() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch;
    onlineManager.setOnline(false);
    try {
      const rejection = await runGenerate(client, () => undefined);
      expect(rejection).toBeInstanceOf(TypeError);
    } finally {
      onlineManager.setOnline(true);
    }
  });
});

describe('useGenerate optimistic video batch', () => {
  const videoModel: Model = {
    id: 'minimax-h3-i2v',
    name: 'MiniMax H3',
    backend: 'local',
    tag: 'comfyui',
    latency: 'slow',
    supportedRatios: ['16:9'],
    supportedDurations: [124, 243, 362],
    defaultDuration: 124,
    supportsI2V: true,
    outputsVideo: true,
    pool: 'local',
    concurrencyCapPerUser: 1,
    maxCountPerBatch: 1,
  };

  async function optimisticBatch(request: GenerateRequest, batchId: string) {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input), 'http://local');
      if (url.pathname === '/api/generate') {
        return Promise.resolve(Response.json({ batchId, status: 'queued', pool: 'local', tiles: [{ tileId: 't1', tileIndex: 0, seed: 1 }] }, { status: 201 }));
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(`event: batch\ndata: ${JSON.stringify({
            batchId, status: 'queued', createdAt: 1_700_000_000_000,
            tiles: [{ tileId: 't1', tileIndex: 0, seed: 1 }],
          })}\n\n`));
          controller.enqueue(encoder.encode(`event: done\ndata: ${JSON.stringify({ batchId })}\n\n`));
          controller.close();
        },
      });
      return Promise.resolve(new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useGenerate(new Map([[videoModel.id, videoModel]])), { wrapper: wrapper(client) });
    await act(async () => {
      await result.current.generate(request);
    });
    const data = client.getQueryData<{ pages: readonly { items: readonly Batch[] }[] }>(historyKeys.list());
    return data?.pages[0]?.items.find((batch) => batch.id === batchId);
  }

  test('preserves the requested duration and source for an immediate rerun', async () => {
    const batch = await optimisticBatch({
      prompt: 'animate',
      modelId: videoModel.id,
      ratio: '16:9',
      count: 1,
      i2vSourceUploadId: 'upload-src',
      durationFrames: 362,
    }, '00000000-0000-4000-8000-000000000a01');
    expect(batch).toMatchObject({ i2vSourceUploadId: 'upload-src', durationFrames: 362 });
  });

  test('falls back to the selected model default duration when the request omits it', async () => {
    const batch = await optimisticBatch({
      prompt: 'animate',
      modelId: videoModel.id,
      ratio: '16:9',
      count: 1,
      i2vSourceUploadId: 'upload-src',
    }, '00000000-0000-4000-8000-000000000a02');
    expect(batch?.durationFrames).toBe(124);
  });
});

describe('useGenerate terminal-event dedup', () => {
  test('a duplicate terminal event for the same tile is dropped with a warning', async () => {
    const originalWarn = console.warn;
    console.warn = mock(() => undefined);
    try {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      });
      client.setQueryData(modelKeys.list(), [sharedModel]);
      const batchId = '00000000-0000-4000-8000-000000000903';
      globalThis.fetch = mock((input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : String(input), 'http://local');
        if (url.pathname === '/api/generate') {
          return Promise.resolve(Response.json({
            batchId,
            status: 'running',
            pool: 'shared',
            tiles: [
              { tileId: 't1', tileIndex: 0, seed: 1 },
              { tileId: 't2', tileIndex: 1, seed: 2 },
              { tileId: 't3', tileIndex: 2, seed: 3 },
            ],
          }, { status: 201 }));
        }
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode(`event: batch\ndata: ${JSON.stringify({
              batchId,
              status: 'running',
              createdAt: 1_700_000_000_000,
              tiles: [
                { tileId: 't1', tileIndex: 0, seed: 1 },
                { tileId: 't2', tileIndex: 1, seed: 2 },
                { tileId: 't3', tileIndex: 2, seed: 3 },
              ],
            })}\n\n`));
            controller.enqueue(encoder.encode(`event: tile\ndata: ${JSON.stringify({
              tileId: 't1', tileIndex: 0, status: 'done',
              url: '/api/img/t1', thumbUrl: '/api/img/t1/thumb',
              ext: 'png', mime: 'image/png', completedAt: 100,
            })}\n\n`));
            // Duplicate of t1's terminal — simulates the batches.events race
            // before the server-side fix landed, or any future regression.
            controller.enqueue(encoder.encode(`event: tile\ndata: ${JSON.stringify({
              tileId: 't1', tileIndex: 0, status: 'done',
              url: '/api/img/t1', thumbUrl: '/api/img/t1/thumb',
              ext: 'png', mime: 'image/png', completedAt: 100,
            })}\n\n`));
            controller.enqueue(encoder.encode(`event: tile\ndata: ${JSON.stringify({
              tileId: 't2', tileIndex: 1, status: 'done',
              url: '/api/img/t2', thumbUrl: '/api/img/t2/thumb',
              ext: 'png', mime: 'image/png', completedAt: 200,
            })}\n\n`));
            controller.enqueue(encoder.encode(`event: tile\ndata: ${JSON.stringify({
              tileId: 't3', tileIndex: 2, status: 'done',
              url: '/api/img/t3', thumbUrl: '/api/img/t3/thumb',
              ext: 'png', mime: 'image/png', completedAt: 300,
            })}\n\n`));
            controller.enqueue(encoder.encode(`event: done\ndata: ${JSON.stringify({ batchId })}\n\n`));
            controller.close();
          },
        });
        return Promise.resolve(new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }));
      }) as unknown as typeof fetch;

      const { result } = renderHook(() => useGenerate(allModelsById), { wrapper: wrapper(client) });
      await act(async () => {
        await result.current.generate({
          prompt: 'make an image',
          modelId: 'mock-slow',
          ratio: '1:1',
          count: 3,
        });
      });

      const warnMock = console.warn as unknown as { mock: { calls: readonly (readonly unknown[])[] } };
      expect(warnMock.mock.calls.some((args) => {
        const first = args[0];
        return typeof first === 'string' && first.includes('duplicate terminal event for tile');
      })).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  test('a canceled-then-done sequence on the same tile only counts the first terminal', async () => {
    const originalWarn = console.warn;
    console.warn = mock(() => undefined);
    try {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      });
      client.setQueryData(modelKeys.list(), [sharedModel]);
      const batchId = '00000000-0000-4000-8000-000000000904';
      globalThis.fetch = mock((input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : String(input), 'http://local');
        if (url.pathname === '/api/generate') {
          return Promise.resolve(Response.json({
            batchId,
            status: 'running',
            pool: 'shared',
            tiles: [
              { tileId: 't1', tileIndex: 0, seed: 1 },
              { tileId: 't2', tileIndex: 1, seed: 2 },
            ],
          }, { status: 201 }));
        }
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode(`event: batch\ndata: ${JSON.stringify({
              batchId,
              status: 'running',
              createdAt: 1_700_000_000_000,
              tiles: [
                { tileId: 't1', tileIndex: 0, seed: 1 },
                { tileId: 't2', tileIndex: 1, seed: 2 },
              ],
            })}\n\n`));
            // canceled is a terminal — counts once.
            controller.enqueue(encoder.encode(`event: tile\ndata: ${JSON.stringify({
              tileId: 't1', tileIndex: 0, status: 'canceled', completedAt: 100,
            })}\n\n`));
            // Late duplicate done for the same tile id — must be dropped.
            controller.enqueue(encoder.encode(`event: tile\ndata: ${JSON.stringify({
              tileId: 't1', tileIndex: 0, status: 'done',
              url: '/api/img/t1', thumbUrl: '/api/img/t1/thumb',
              ext: 'png', mime: 'image/png', completedAt: 150,
            })}\n\n`));
            controller.enqueue(encoder.encode(`event: tile\ndata: ${JSON.stringify({
              tileId: 't2', tileIndex: 1, status: 'done',
              url: '/api/img/t2', thumbUrl: '/api/img/t2/thumb',
              ext: 'png', mime: 'image/png', completedAt: 200,
            })}\n\n`));
            controller.enqueue(encoder.encode(`event: done\ndata: ${JSON.stringify({ batchId })}\n\n`));
            controller.close();
          },
        });
        return Promise.resolve(new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }));
      }) as unknown as typeof fetch;

      const { result } = renderHook(() => useGenerate(allModelsById), { wrapper: wrapper(client) });
      await act(async () => {
        await result.current.generate({
          prompt: 'make an image',
          modelId: 'mock-slow',
          ratio: '1:1',
          count: 2,
        });
      });

      const warnMock = console.warn as unknown as { mock: { calls: readonly (readonly unknown[])[] } };
      expect(warnMock.mock.calls.some((args) => {
        const first = args[0];
        return typeof first === 'string' && first.includes('duplicate terminal event for tile');
      })).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe('useGenerate idempotent replay', () => {
  const replayedId = '00000000-0000-4000-8000-000000000c01';
  type CachedHistory = HistoryData;

  function sse(frames: readonly { event: string; data: unknown }[]): string {
    return frames.map((frame) => `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`).join('');
  }

  function replayThen(events: string): void {
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input), 'http://local');
      if (url.pathname === '/api/generate') {
        return Promise.resolve(Response.json({
          batchId: replayedId,
          status: 'running',
          pool: 'shared',
          tiles: [{ tileId: 'rt1', tileIndex: 0, seed: 1 }],
          replayed: true,
        }, { status: 200 }));
      }
      return Promise.resolve(new Response(events, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    }) as unknown as typeof fetch;
  }

  const replayEvents = sse([
    { event: 'batch', data: { batchId: replayedId, status: 'running', createdAt: 1_700_000_000_500, tiles: [{ tileId: 'rt1', tileIndex: 0, seed: 1 }] } },
    { event: 'tile', data: { tileId: 'rt1', tileIndex: 0, status: 'done', url: '/api/img/rt1', ext: 'png', mime: 'image/png', completedAt: 10 } },
    { event: 'done', data: { batchId: replayedId } },
  ]);

  // The request the client re-sent after the draft changed: none of its
  // metadata describes the batch the server already holds under this key.
  const changedRequest = {
    prompt: 'changed draft prompt',
    modelId: 'mock-slow',
    ratio: '1:1',
    count: 1,
    refImageIds: ['new-draft-ref'],
    idempotencyKey: 'roll-1',
  } satisfies GenerateRequest;

  function cachedBatches(client: QueryClient): readonly Batch[] {
    return client.getQueryData<CachedHistory>(historyKeys.list())?.pages.flatMap((page) => page.items) ?? [];
  }

  test('a replay with changed draft settings keeps the server metadata and still applies tile updates', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    client.setQueryData(modelKeys.list(), [sharedModel]);
    const serverBatch: Batch = {
      id: replayedId,
      prompt: 'server prompt',
      modelId: 'mock-slow',
      modelLabel: 'Mock Slow',
      ratio: '1:1',
      createdAt: 1_700_000_000_000,
      collectionId: 'collection-1',
      pinned: true,
      status: 'running',
      tiles: [{ id: 'rt1', seed: 1, status: 'loading' }],
    };
    client.setQueryData<CachedHistory>(historyKeys.list(), {
      pages: [{ items: [serverBatch], nextCursor: null, hasLoadingTiles: true, loadingTileCount: 1, activeByModel: {} }],
      pageParams: [null],
      loadingTileCount: 1,
      activeByModel: {},
    });
    const invalidated: unknown[] = [];
    const originalInvalidate = client.invalidateQueries.bind(client);
    client.invalidateQueries = ((filters?: Parameters<QueryClient['invalidateQueries']>[0]) => {
      invalidated.push(filters?.queryKey);
      return originalInvalidate(filters);
    });
    replayThen(replayEvents);
    const accepted: string[] = [];

    const { result } = renderHook(() => useGenerate(allModelsById), { wrapper: wrapper(client) });
    await act(async () => {
      await result.current.generate(changedRequest, { onAccepted: (id) => { accepted.push(id); } });
    });

    expect(accepted).toEqual([replayedId]);
    const cached = cachedBatches(client).filter((batch) => batch.id === replayedId);
    expect(cached).toHaveLength(1);
    expect(cached[0]).toMatchObject({
      prompt: 'server prompt',
      collectionId: 'collection-1',
      pinned: true,
      createdAt: 1_700_000_000_000,
      tiles: [{ id: 'rt1', status: 'done' }],
    });
    // The re-sent draft's references never describe the replayed batch; a
    // Retry or Re-roll built from this cache would otherwise send them.
    expect(cached[0]?.tiles[0]).not.toHaveProperty('refImageIds');
    expect(invalidated).toContainEqual(historyKeys.all());
  });

  test('a replay of an archived batch is not inserted into Unsorted', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    client.setQueryData(modelKeys.list(), [sharedModel]);
    replayThen(replayEvents);

    const { result } = renderHook(() => useGenerate(allModelsById), { wrapper: wrapper(client) });
    await act(async () => {
      await result.current.generate(changedRequest);
    });

    expect(cachedBatches(client).some((batch) => batch.id === replayedId)).toBe(false);
    expect(useAtelierStore.getState().followAnchorId).not.toBe(replayedId);
  });

  test('a finished stream leaves another owner\'s registered controller in place', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    client.setQueryData(modelKeys.list(), [sharedModel]);
    const batchId = '00000000-0000-4000-8000-000000000c02';
    const foreign = new AbortController();
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input), 'http://local');
      if (url.pathname === '/api/generate') {
        return Promise.resolve(Response.json({
          batchId,
          status: 'running',
          pool: 'shared',
          tiles: [{ tileId: 'ft1', tileIndex: 0, seed: 1 }],
        }, { status: 201 }));
      }
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(sse([{ event: 'batch', data: {
            batchId, status: 'running', createdAt: 1, tiles: [{ tileId: 'ft1', tileIndex: 0, seed: 1 }],
          } }])));
        },
        async pull(controller) {
          // Once this stream registered the batch, a second stream of the same
          // batch (a replay) registers its own controller.
          for (let i = 0; i < 100 && getBatch(batchId) === undefined; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
          expect(getBatch(batchId)).toBeDefined();
          registerBatch(batchId, foreign);
          controller.enqueue(encoder.encode(sse([{ event: 'done', data: { batchId } }])));
          controller.close();
        },
      });
      return Promise.resolve(new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useGenerate(allModelsById), { wrapper: wrapper(client) });
    await act(async () => {
      await result.current.generate({ prompt: 'p', modelId: 'mock-slow', ratio: '1:1', count: 1 });
    });

    expect(getBatch(batchId)?.controller).toBe(foreign);
    expect(foreign.signal.aborted).toBe(false);
  });
});

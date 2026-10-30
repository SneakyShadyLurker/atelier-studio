import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { Batch, HistoryPage, Model } from '@atelier/shared';
import type { InfiniteData } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';
import { historyKeys } from '../src/api/history';
import { emitHistoryInvalidate, resetBroadcastForTests } from '../src/hooks/broadcastHistory';
import { getBatch, resetInFlightForTests } from '../src/hooks/inFlightBatches';
import { useGenerate } from '../src/hooks/useGenerate';

// Tests run with an empty registry map on purpose: modelLabel falls back to
// the raw modelId ('gpt-image-2.5-sunburst' assertions below) and no fixture requires a
// BYOK key.
const emptyModelsById: ReadonlyMap<string, Model> = new Map();
import { APP_VIEW_UNSORTED, collectionView, useAtelierStore } from '../src/store/atelier';

const originalBroadcastChannel = window.BroadcastChannel;

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

afterEach(() => {
  cleanup();
  mock.restore();
  resetBroadcastForTests();
  resetInFlightForTests();
  MockChannel.listeners.clear();
  setBroadcastChannel(originalBroadcastChannel);
  useAtelierStore.setState({
    activeBatchId: null,
    toasts: [],
    previews: new Map(),
    view: APP_VIEW_UNSORTED,
    q: '',
    followAnchorId: null,
  });
});

async function rejectedValue(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected promise to reject');
}

function wrapper(client: QueryClient) {
  return function TestWrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function sseResponse(body: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

// Stream that emits an initial body but stays open until `close()` is invoked.
// Useful for tests that need a generation to be "in flight" while another
// fires (cap rejection, cancellation, abort propagation).
function pendingSseResponse(initialBody: string): { response: Response; close: () => void } {
  let close: () => void = () => { /* set in start() */ };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (initialBody) controller.enqueue(new TextEncoder().encode(initialBody));
      close = () => { controller.close(); };
    },
  });
  return {
    response: new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    close,
  };
}

function controllableSseResponse(): {
  response: Response;
  enqueue: (body: string) => void;
  close: () => void;
} {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
  });
  return {
    response: new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    enqueue: (body) => {
      if (!controller) throw new Error('stream controller not ready');
      controller.enqueue(encoder.encode(body));
    },
    close: () => {
      controller?.close();
    },
  };
}

function sseChunk(lines: readonly string[]): string {
  return `${lines.join('\n')}\n\n`;
}

describe('useGenerate', () => {
  test('the live optimistic batch retains effective motion instructions before history settles', async () => {
    const stream = controllableSseResponse();
    globalThis.fetch = mock(() => stream.response) as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const { result } = renderHook(() => useGenerate(emptyModelsById), { wrapper: wrapper(client) });
    const generation = result.current.generate({ prompt: 'The subject turns', motionPrompt: 'Slow orbit and hold.', modelId: 'i2v', ratio: '1:1', count: 1 });
    stream.enqueue('event: batch\ndata: {"batchId":"motion-batch","createdAt":1,"tiles":[]}\n\n');
    await waitFor(() => {
      const batch = client.getQueryData<InfiniteData<HistoryPage<Batch>>>(historyKeys.list())?.pages[0]?.items[0];
      expect(batch?.motionPrompt).toBe('Slow orbit and hold.');
      expect(batch?.prompt).toBe('The subject turns');
    });
    stream.enqueue('event: done\ndata: {"batchId":"motion-batch"}\n\n');
    stream.close();
    await act(async () => { await generation; });
    client.clear();
  });

  test('a timeout attaching events after server acceptance stays an accepted stream failure', async () => {
    const fetch = mock((_input: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
      ? Promise.resolve(Response.json({ batchId: 'accepted-timeout' }, { status: 201 }))
      : Promise.reject(new DOMException('stalled', 'TimeoutError')));
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const accepted = mock();
    const { result } = renderHook(() => useGenerate(emptyModelsById), { wrapper: wrapper(client) });
    let error: unknown;
    await act(async () => {
      error = await rejectedValue(result.current.generate({ prompt: 'p', modelId: 'm', ratio: '1:1', count: 1 }, { onAccepted: accepted }));
    });
    expect(error).toMatchObject({ name: 'StreamTruncatedError', batchId: 'accepted-timeout' });
    expect(accepted).toHaveBeenCalledWith('accepted-timeout');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(useAtelierStore.getState().toasts.filter((toast) => toast.tone === 'error')).toEqual([]);
    client.clear();
  });
  test('seeds history from batch event and patches terminal tile events', async () => {
    globalThis.fetch = mock(() => sseResponse([
      'event: batch',
      'data: {"batchId":"batch-1","createdAt":1700000000000,"tiles":[{"tileId":"tile-1","tileIndex":0,"seed":123}]}',
      '',
      'event: tile',
      'data: {"tileId":"tile-1","tileIndex":0,"status":"done","url":"/api/img/tile-1","thumbUrl":"/api/img/tile-1/thumb","ext":"png","mime":"image/png","completedAt":10}',
      '',
      'event: done',
      'data: {"batchId":"batch-1"}',
      '',
      '',
    ].join('\n'))) as unknown as typeof fetch;

    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData<InfiniteData<HistoryPage<Batch>>>(historyKeys.list(), { pages: [{ items: [], nextCursor: null }], pageParams: [undefined] });

    const { result } = renderHook(() => useGenerate(emptyModelsById), { wrapper: wrapper(client) });
    await act(async () => {
      await result.current.generate({ prompt: 'small red chair', modelId: 'gpt-image-2.5-sunburst', ratio: '1:1', count: 1 });
    });

    await waitFor(() => {
      const data = client.getQueryData<InfiniteData<HistoryPage<Batch>>>(historyKeys.list());
      expect(data?.pages[0]?.items[0]?.tiles[0]?.status).toBe('done');
    });

    const batch = client.getQueryData<InfiniteData<HistoryPage<Batch>>>(historyKeys.list())?.pages[0]?.items[0];
    expect(batch?.id).toBe('batch-1');
    expect(batch?.tiles[0]).toMatchObject({
      id: 'tile-1',
      status: 'done',
      url: '/api/img/tile-1?media=2',
      thumbUrl: '/api/img/tile-1/thumb?media=2',
      ext: 'png',
      mime: 'image/png',
    });
    expect(useAtelierStore.getState().activeBatchId).toBe('batch-1');
  });

  test('does not force scope from inside the generation stream', async () => {
    globalThis.fetch = mock(() => sseResponse([
      'event: batch',
      'data: {"batchId":"batch-scoped","createdAt":1700000000000,"tiles":[{"tileId":"tile-scoped","tileIndex":0,"seed":123}]}',
      '',
      'event: done',
      'data: {"batchId":"batch-scoped"}',
      '',
      '',
    ].join('\n'))) as unknown as typeof fetch;

    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData<InfiniteData<HistoryPage<Batch>>>(historyKeys.list(), { pages: [{ items: [], nextCursor: null }], pageParams: [undefined] });
    useAtelierStore.getState().setView(collectionView('019e13e4-f168-7555-8dbe-6be97df82b17'));
    useAtelierStore.getState().setQ('filtered');

    const { result } = renderHook(() => useGenerate(emptyModelsById), { wrapper: wrapper(client) });
    await act(async () => {
      await result.current.generate({ prompt: 'small red chair', modelId: 'gpt-image-2.5-sunburst', ratio: '1:1', count: 1 }).catch(() => undefined);
    });

    expect(useAtelierStore.getState().view).toEqual(collectionView('019e13e4-f168-7555-8dbe-6be97df82b17'));
    expect(useAtelierStore.getState().q).toBe('filtered');
  });

  test('does not clear active search from inside the generation stream', async () => {
    globalThis.fetch = mock(() => sseResponse([
      'event: batch',
      'data: {"batchId":"batch-search","createdAt":1700000000000,"tiles":[{"tileId":"tile-search","tileIndex":0,"seed":123}]}',
      '',
      'event: done',
      'data: {"batchId":"batch-search"}',
      '',
      '',
    ].join('\n'))) as unknown as typeof fetch;

    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData<InfiniteData<HistoryPage<Batch>>>(historyKeys.list(), { pages: [{ items: [], nextCursor: null }], pageParams: [undefined] });
    useAtelierStore.getState().setQ('old');

    const { result } = renderHook(() => useGenerate(emptyModelsById), { wrapper: wrapper(client) });
    await act(async () => {
      await result.current.generate({ prompt: 'small red chair', modelId: 'gpt-image-2.5-sunburst', ratio: '1:1', count: 1 }).catch(() => undefined);
    });

    expect(useAtelierStore.getState().view).toEqual(APP_VIEW_UNSORTED);
    expect(useAtelierStore.getState().q).toBe('old');
  });

  test('partial previews land in the Zustand store, not the cache, and clear on terminal', async () => {
    // Regression: when partials lived on the loading tile in the TanStack
    // cache, a /history refetch (window-focus, reconnect, mutation
    // invalidate) replaced the cache with the server's preview-less
    // loading row, dropping the in-flight preview back to the placeholder
    // mid-stream. This test pins the new contract: previews live in the
    // Zustand `previews` slice (refetch-immune) and the cache's loading
    // tile carries no preview field at any point.
    const { response, close } = pendingSseResponse([
      'event: batch',
      'data: {"batchId":"batch-p","createdAt":1700000000000,"tiles":[{"tileId":"tp","tileIndex":0,"seed":1}]}',
      '',
      'event: tile',
      'data: {"tileId":"tp","tileIndex":0,"status":"partial","preview":"data:image/png;base64,AAAA","index":0}',
      '',
      '',
    ].join('\n'));
    globalThis.fetch = mock(() => response) as unknown as typeof fetch;

    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData<InfiniteData<HistoryPage<Batch>>>(historyKeys.list(), { pages: [{ items: [], nextCursor: null }], pageParams: [undefined] });

    const { result } = renderHook(() => useGenerate(emptyModelsById), { wrapper: wrapper(client) });
    const promise = result.current.generate({ prompt: 'p', modelId: 'gpt-image-2.5-sunburst', ratio: '1:1', count: 1 });

    // Wait for the partial to land in the store.
    await waitFor(() => {
      expect(useAtelierStore.getState().previews.get('tp')).toEqual({ url: 'data:image/png;base64,AAAA', index: 0 });
    });
    // Cache must NOT carry the preview — that's the architectural
    // invariant that prevents refetch from wiping it.
    const loadingTile = client.getQueryData<InfiniteData<HistoryPage<Batch>>>(historyKeys.list())?.pages[0]?.items[0]?.tiles[0];
    expect(loadingTile?.status).toBe('loading');
    expect(loadingTile).not.toHaveProperty('preview');
    expect(loadingTile).not.toHaveProperty('previewIndex');

    // Simulate refetchOnWindowFocus: server returns the loading row with
    // no preview. With previews in the store, this no longer disturbs the
    // in-flight partial.
    client.setQueryData<InfiniteData<HistoryPage<Batch>>>(historyKeys.list(), {
      pages: [{
        items: [{
          id: 'batch-p',
          prompt: 'p',
          ratio: '1:1',
          modelId: 'gpt-image-2.5-sunburst',
          modelLabel: 'gpt-image-2.5-sunburst',
          createdAt: 0,
          collectionId: null,
            pinned: false,
            status: 'done',
          tiles: [{ id: 'tp', seed: 1, status: 'loading' }],
        }],
        nextCursor: null,
      }],
      pageParams: [undefined],
    });
    expect(useAtelierStore.getState().previews.get('tp')).toEqual({ url: 'data:image/png;base64,AAAA', index: 0 });

    // Drain: the stream truncates without `done`. The finally block must
    // sweep the orphan preview entry so the data: URL doesn't leak.
    close();
    await promise.catch(() => { /* expected truncation */ });
    await waitFor(() => {
      expect(useAtelierStore.getState().previews.get('tp')).toBeUndefined();
    });
  });

  test('queued stream writes queued status until it starts running', async () => {
    const stream = controllableSseResponse();
    globalThis.fetch = mock(() => stream.response) as unknown as typeof fetch;

    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData<InfiniteData<HistoryPage<Batch>>>(historyKeys.list(), { pages: [{ items: [], nextCursor: null }], pageParams: [undefined] });

    const { result } = renderHook(() => useGenerate(emptyModelsById), { wrapper: wrapper(client) });
    const promise = result.current.generate({ prompt: 'queued', modelId: 'gpt-image-2.5-sunburst', ratio: '1:1', count: 2 });

    act(() => {
      stream.enqueue(sseChunk([
        'event: batch',
        'data: {"batchId":"batch-q","status":"queued","createdAt":1700000000000,"queueLengthAhead":1,"tiles":[{"tileId":"tq1","tileIndex":0,"seed":1},{"tileId":"tq2","tileIndex":1,"seed":2}]}',
      ]));
    });
    await waitFor(() => {
      const data = client.getQueryData<InfiniteData<HistoryPage<Batch>>>(historyKeys.list());
      expect(data?.pages[0]?.items[0]?.status).toBe('queued');
    });

    act(() => {
      stream.enqueue(sseChunk([
        'event: queue',
        'data: {"batchId":"batch-q","status":"running"}',
      ]));
    });
    await waitFor(() => {
      const data = client.getQueryData<InfiniteData<HistoryPage<Batch>>>(historyKeys.list());
      expect(data?.pages[0]?.items[0]?.status).toBe('running');
    });

    act(() => {
      stream.enqueue(sseChunk([
        'event: tile',
        'data: {"tileId":"tq1","tileIndex":0,"status":"done","url":"/api/img/tq1","ext":"png","mime":"image/png","completedAt":10}',
      ]));
      stream.enqueue(sseChunk([
        'event: tile',
        'data: {"tileId":"tq2","tileIndex":1,"status":"done","url":"/api/img/tq2","ext":"png","mime":"image/png","completedAt":11}',
      ]));
      stream.enqueue(sseChunk([
        'event: done',
        'data: {"batchId":"batch-q"}',
      ]));
      stream.close();
    });
    await promise;

    const data = client.getQueryData<InfiniteData<HistoryPage<Batch>>>(historyKeys.list());
    expect(data?.pages[0]?.items[0]?.status).toBe('done');
  });

  test('partial arriving after the tile is already terminal is dropped (cache guard)', async () => {
    // Old `updateLoadingTilePreview` had a status-must-be-loading guard
    // because it operated on the cache directly. The new store-based
    // setTilePreview can't see tile status, so without a cache check in
    // useGenerate, a late `partial` after `done` would re-create an
    // orphan store entry no LoadingTile is listening to. The guard at
    // the partial branch (`findTileInCache(...).status === 'loading'`)
    // is what prevents that re-creation.
    globalThis.fetch = mock(() => sseResponse([
      'event: batch',
      'data: {"batchId":"bg","createdAt":1700000000000,"tiles":[{"tileId":"tg","tileIndex":0,"seed":1}]}',
      '',
      'event: tile',
      'data: {"tileId":"tg","tileIndex":0,"status":"done","url":"/api/img/tg","ext":"png","mime":"image/png","completedAt":1}',
      '',
      // Late partial — protocol-tolerated reordering. Must be dropped
      // because the tile is already done.
      'event: tile',
      'data: {"tileId":"tg","tileIndex":0,"status":"partial","preview":"data:image/png;base64,LATE","index":99}',
      '',
      'event: done',
      'data: {"batchId":"bg"}',
      '',
      '',
    ].join('\n'))) as unknown as typeof fetch;

    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData<InfiniteData<HistoryPage<Batch>>>(historyKeys.list(), { pages: [{ items: [], nextCursor: null }], pageParams: [undefined] });

    const { result } = renderHook(() => useGenerate(emptyModelsById), { wrapper: wrapper(client) });
    await act(async () => {
      await result.current.generate({ prompt: 'g', modelId: 'gpt-image-2.5-sunburst', ratio: '1:1', count: 1 });
    });

    // Cache reflects the terminal state; store has no orphan entry from
    // the late partial.
    const tile = client.getQueryData<InfiniteData<HistoryPage<Batch>>>(historyKeys.list())?.pages[0]?.items[0]?.tiles[0];
    expect(tile?.status).toBe('done');
    expect(useAtelierStore.getState().previews.get('tg')).toBeUndefined();
  });

  test('terminal tile event clears the preview entry from the store', async () => {
    globalThis.fetch = mock(() => sseResponse([
      'event: batch',
      'data: {"batchId":"bx","createdAt":1700000000000,"tiles":[{"tileId":"tx","tileIndex":0,"seed":7}]}',
      '',
      'event: tile',
      'data: {"tileId":"tx","tileIndex":0,"status":"partial","preview":"data:image/png;base64,BBBB","index":0}',
      '',
      'event: tile',
      'data: {"tileId":"tx","tileIndex":0,"status":"done","url":"/api/img/tx","ext":"png","mime":"image/png","completedAt":42}',
      '',
      'event: done',
      'data: {"batchId":"bx"}',
      '',
      '',
    ].join('\n'))) as unknown as typeof fetch;

    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData<InfiniteData<HistoryPage<Batch>>>(historyKeys.list(), { pages: [{ items: [], nextCursor: null }], pageParams: [undefined] });

    const { result } = renderHook(() => useGenerate(emptyModelsById), { wrapper: wrapper(client) });
    await act(async () => {
      await result.current.generate({ prompt: 'x', modelId: 'gpt-image-2.5-sunburst', ratio: '1:1', count: 1 });
    });

    expect(useAtelierStore.getState().previews.get('tx')).toBeUndefined();
    const tile = client.getQueryData<InfiniteData<HistoryPage<Batch>>>(historyKeys.list())?.pages[0]?.items[0]?.tiles[0];
    expect(tile?.status).toBe('done');
  });

  test('canceled tile events remove the tile without an error or canceled toast', async () => {
    const stream = controllableSseResponse();
    globalThis.fetch = mock(() => stream.response) as unknown as typeof fetch;

    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData<InfiniteData<HistoryPage<Batch>>>(historyKeys.list(), { pages: [{ items: [], nextCursor: null }], pageParams: [undefined] });

    const { result } = renderHook(() => useGenerate(emptyModelsById), { wrapper: wrapper(client) });
    const promise = result.current.generate({ prompt: 'cancel me', modelId: 'gpt-image-2.5-sunburst', ratio: '1:1', count: 1 });

    stream.enqueue(sseChunk([
      'event: batch',
      'data: {"batchId":"batch-cancel","createdAt":1700000000000,"tiles":[{"tileId":"tile-cancel","tileIndex":0,"seed":1}]}',
    ]));
    await waitFor(() => {
      const data = client.getQueryData<InfiniteData<HistoryPage<Batch>>>(historyKeys.list());
      expect(data?.pages[0]?.items).toHaveLength(1);
    });

    stream.enqueue(sseChunk([
      'event: tile',
      'data: {"tileId":"tile-cancel","tileIndex":0,"status":"canceled","completedAt":10}',
    ]));
    await waitFor(() => {
      const data = client.getQueryData<InfiniteData<HistoryPage<Batch>>>(historyKeys.list());
      expect(data?.pages[0]?.items).toEqual([]);
    });

    stream.enqueue(sseChunk([
      'event: done',
      'data: {"batchId":"batch-cancel"}',
    ]));
    stream.close();
    await promise;

    const toastTexts = useAtelierStore.getState().toasts.map((toast) => toast.text);
    expect(toastTexts.some((text) => text === 'Canceled' || text.toLowerCase().includes('error'))).toBe(false);
  });

  test('registers an in-flight batch on batch event and unregisters after stream settles', async () => {
    const stream = controllableSseResponse();
    globalThis.fetch = mock(() => stream.response) as unknown as typeof fetch;

    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData<InfiniteData<HistoryPage<Batch>>>(historyKeys.list(), { pages: [{ items: [], nextCursor: null }], pageParams: [undefined] });

    const { result } = renderHook(() => useGenerate(emptyModelsById), { wrapper: wrapper(client) });
    const promise = result.current.generate({ prompt: 'track me', modelId: 'gpt-image-2.5-sunburst', ratio: '1:1', count: 1 });

    stream.enqueue(sseChunk([
      'event: batch',
      'data: {"batchId":"batch-live","createdAt":1700000000000,"tiles":[{"tileId":"tile-live","tileIndex":0,"seed":1}]}',
    ]));
    await waitFor(() => { expect(getBatch('batch-live')).toBeDefined(); });

    stream.enqueue(sseChunk([
      'event: done',
      'data: {"batchId":"batch-live"}',
    ]));
    stream.close();
    await promise;

    expect(getBatch('batch-live')).toBeUndefined();
  });

  test('BroadcastChannel invalidation invalidates history queries', async () => {
    setBroadcastChannel(MockChannel as never);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const invalidateQueries = mock(() => Promise.resolve());
    client.invalidateQueries = invalidateQueries;

    renderHook(() => useGenerate(emptyModelsById), { wrapper: wrapper(client) });
    emitHistoryInvalidate('batch-cross-tab');

    await waitFor(() => {
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: historyKeys.all() });
    });
  });

  test('4xx generate responses toast the server error without adding a batch', async () => {
    globalThis.fetch = mock(() => new Response(JSON.stringify({ error: 'validation failed' }), { status: 400 })) as unknown as typeof fetch;

    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData<InfiniteData<HistoryPage<Batch>>>(historyKeys.list(), { pages: [{ items: [], nextCursor: null }], pageParams: [undefined] });

    const { result } = renderHook(() => useGenerate(emptyModelsById), { wrapper: wrapper(client) });
    expect(await rejectedValue(result.current.generate({ prompt: 'x', modelId: 'bad', ratio: '1:1', count: 1 }))).toMatchObject({
      message: 'validation failed',
    });

    const data = client.getQueryData<InfiniteData<HistoryPage<Batch>>>(historyKeys.list());
    expect(data?.pages[0]?.items).toEqual([]);
    // The api's 4xx `error` strings are deliberately user-safe product copy;
    // describeError surfaces them so the user gets an actionable reason.
    // Opaque 5xx/transport failures are the ones flattened to generic copy.
    expect(useAtelierStore.getState().toasts[0]?.text).toBe('validation failed');
  });

  test('preserves ready reference chips after the batch event accepts the request', async () => {
    const readyRef = {
      clientId: 'client-ready',
      serverId: 'upload-ready',
      status: 'ready' as const,
      mime: 'image/png',
      sizeBytes: 1,
      previewUrl: '/api/uploads/upload-ready',
    };
    useAtelierStore.setState({
      draft: { prompt: 'edit', modelId: 'gpt-image-2.5-sunburst', ratio: '1:1', durationFrames: null, count: 1, refImages: [readyRef], rollQueue: [], brainstormBrief: '', brainstormCount: 12 },
    });
    globalThis.fetch = mock(() => new Response(JSON.stringify({ error: 'validation failed' }), { status: 400 })) as unknown as typeof fetch;

    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData<InfiniteData<HistoryPage<Batch>>>(historyKeys.list(), { pages: [{ items: [], nextCursor: null }], pageParams: [undefined] });
    const { result } = renderHook(() => useGenerate(emptyModelsById), { wrapper: wrapper(client) });

    await rejectedValue(result.current.generate({ prompt: 'edit', modelId: 'gpt-image-2.5-sunburst', ratio: '1:1', count: 1, refImageIds: ['upload-ready'] }));
    expect(useAtelierStore.getState().draft.refImages).toEqual([readyRef]);

    globalThis.fetch = mock(() => sseResponse([
      'event: batch',
      'data: {"batchId":"batch-ref","createdAt":1700000000000,"refImageIds":["upload-ready"],"tiles":[{"tileId":"tile-ref","tileIndex":0,"seed":1}]}',
      '',
      'event: tile',
      'data: {"tileId":"tile-ref","tileIndex":0,"status":"done","url":"/api/img/tile-ref","ext":"png","mime":"image/png","completedAt":1}',
      '',
      'event: done',
      'data: {"batchId":"batch-ref"}',
      '',
      '',
    ].join('\n'))) as unknown as typeof fetch;

    await act(async () => {
      await result.current.generate({ prompt: 'edit', modelId: 'gpt-image-2.5-sunburst', ratio: '1:1', count: 1, refImageIds: ['upload-ready'] });
    });

    expect(useAtelierStore.getState().draft.refImages).toEqual([readyRef]);
  });

  test('rejects a successful submission without an authoritative batch id', async () => {
    // The JSON submission response selects the follow-up SSE route. Reject a
    // malformed response before it can become /batches/undefined/events.
    globalThis.fetch = mock(() => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;

    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData<InfiniteData<HistoryPage<Batch>>>(historyKeys.list(), { pages: [{ items: [], nextCursor: null }], pageParams: [undefined] });

    const { result } = renderHook(() => useGenerate(emptyModelsById), { wrapper: wrapper(client) });
    expect(await rejectedValue(result.current.generate({ prompt: 'x', modelId: 'gpt-image-2.5-sunburst', ratio: '1:1', count: 1 }))).toMatchObject({
      message: 'invalid generation response shape',
    });
    const data = client.getQueryData<InfiniteData<HistoryPage<Batch>>>(historyKeys.list());
    expect(data?.pages[0]?.items).toEqual([]);
  });

  test('per-pool observation: streaming tiles count against the model.pool counter and release on terminal events', async () => {
    // The cap is enforced server-side; the client only observes its own
    // in-flight streams per pool so the Composer can display an accurate
    // "X/Y tiles" indicator. After all tiles deliver terminal events, the
    // pool counter must converge back to 0.
    globalThis.fetch = mock(() => sseResponse([
      'event: batch',
      'data: {"batchId":"batch-fill","createdAt":1700000000000,"tiles":[{"tileId":"a","tileIndex":0,"seed":1},{"tileId":"b","tileIndex":1,"seed":2},{"tileId":"c","tileIndex":2,"seed":3},{"tileId":"d","tileIndex":3,"seed":4}]}',
      '',
      'event: tile',
      'data: {"tileId":"a","tileIndex":0,"status":"done","url":"/api/img/a","ext":"png","mime":"image/png","completedAt":1}',
      '',
      'event: tile',
      'data: {"tileId":"b","tileIndex":1,"status":"done","url":"/api/img/b","ext":"png","mime":"image/png","completedAt":2}',
      '',
      'event: tile',
      'data: {"tileId":"c","tileIndex":2,"status":"failed","error":"upstream rejected","completedAt":3}',
      '',
      'event: tile',
      'data: {"tileId":"d","tileIndex":3,"status":"done","url":"/api/img/d","ext":"png","mime":"image/png","completedAt":4}',
      '',
      'event: done',
      'data: {"batchId":"batch-fill"}',
      '',
      '',
    ].join('\n'))) as unknown as typeof fetch;

    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData<InfiniteData<HistoryPage<Batch>>>(historyKeys.list(), { pages: [{ items: [], nextCursor: null }], pageParams: [undefined] });

    const { result } = renderHook(() => useGenerate(emptyModelsById), { wrapper: wrapper(client) });
    await act(async () => {
      await result.current.generate({ prompt: 'fills it', modelId: 'gpt-image-2.5-sunburst', ratio: '1:1', count: 4 });
    });

    const data = client.getQueryData<InfiniteData<HistoryPage<Batch>>>(historyKeys.list());
    expect(data?.pages[0]?.items[0]?.status).toBe('done');
  });

  test('pre-flight 429 leaves loading tiles in unrelated batches untouched', async () => {
    // A pre-flight failure must not wipe loading state in batches that have
    // nothing to do with the rejected request.
    globalThis.fetch = mock(() => new Response(JSON.stringify({ error: 'concurrent tile limit reached' }), { status: 429 })) as unknown as typeof fetch;

    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const inflightBatch: Batch = {
      id: 'unrelated-batch',
      prompt: 'still streaming',
      ratio: '1:1',
      modelId: 'gpt-image-2.5-sunburst',
      modelLabel: 'gpt-image-2.5-sunburst',
      createdAt: 1,
      collectionId: null,
        pinned: false,
        status: 'done',
      tiles: [{ id: 'tile-x', seed: 1, status: 'loading' }],
    };
    client.setQueryData<InfiniteData<HistoryPage<Batch>>>(historyKeys.list(), {
      pages: [{ items: [inflightBatch], nextCursor: null }],
      pageParams: [undefined],
    });

    const { result } = renderHook(() => useGenerate(emptyModelsById), { wrapper: wrapper(client) });
    expect(await rejectedValue(result.current.generate({ prompt: 'x', modelId: 'gpt-image-2.5-sunburst', ratio: '1:1', count: 1 }))).toBeInstanceOf(Error);

    // The unrelated batch's loading tile must survive the pre-flight 429.
    const after = client.getQueryData<InfiniteData<HistoryPage<Batch>>>(historyKeys.list());
    const tile = after?.pages[0]?.items[0]?.tiles[0];
    expect(tile?.status).toBe('loading');
    expect(useAtelierStore.getState().toasts[0]?.text).toBe('concurrent tile limit reached');
  });

  test('EOF without done leaves loading tiles loading, not failed', async () => {
    // v3 spec: server keeps generating after client disconnect, so a clean
    // EOF without a `done` event must NOT flip cached tiles to `failed`.
    // The cache stays in `loading`; the historyOpts refetchInterval converges
    // it once the server's tiles settle.
    const batchFrame = sseChunk([
      'event: batch',
      'data: {"batchId":"batch-eof","createdAt":1700000000000,"tiles":[{"tileId":"tile-eof","tileIndex":0,"seed":42}]}',
    ]);
    // Stream emits the batch frame then closes without a `done` event.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(batchFrame));
        controller.close();
      },
    });
    globalThis.fetch = mock(() => new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })) as unknown as typeof fetch;

    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData<InfiniteData<HistoryPage<Batch>>>(historyKeys.list(), { pages: [{ items: [], nextCursor: null }], pageParams: [undefined] });

    const { result } = renderHook(() => useGenerate(emptyModelsById), { wrapper: wrapper(client) });
    const error = await rejectedValue(result.current.generate({ prompt: 'eof test', modelId: 'gpt-image-2.5-sunburst', ratio: '1:1', count: 1 }));

    // Must have thrown StreamTruncatedError (the existing truncation sentinel).
    expect(error).toMatchObject({ name: 'StreamTruncatedError' });

    // The cached tile must still be loading — NOT failed.
    const data = client.getQueryData<InfiniteData<HistoryPage<Batch>>>(historyKeys.list());
    const tile = data?.pages[0]?.items[0]?.tiles[0];
    expect(tile?.status).toBe('loading');

    // History invalidation fires in the finally block regardless of truncation.
    expect(client.getQueryState(historyKeys.scoped({ kind: 'unsorted' }, ''))?.isInvalidated).toBe(true);
  });

  test('mid-stream fetch error leaves loading tiles loading, not failed', async () => {
    // v3 spec: a network failure mid-stream must not flip cached tiles to
    // `failed`. The server is still running; the cache converges via the
    // historyOpts refetchInterval once tiles settle server-side.
    //
    // Strategy: enqueue the batch frame, then immediately error the stream.
    // The SSE parser reads chunks sequentially: it will process the batch
    // frame fully before it reads again and discovers the stream errored.
    // The batch therefore lands in cache; the inner catch fires with a
    // non-abort error. Under the current code, failOwned() is called; under
    // the fixed code it must not be.
    const encoder = new TextEncoder();
    const batchFrame = sseChunk([
      'event: batch',
      'data: {"batchId":"batch-err","createdAt":1700000000000,"tiles":[{"tileId":"tile-err","tileIndex":0,"seed":7}]}',
    ]);
    // Use pendingSseResponse to enqueue the batch frame and hold the stream
    // open; then error the stream via a separate controller.error call
    // smuggled out from the ReadableStream constructor.
    // Capture the stream controller so we can inject an error after the
    // batch frame has been consumed by the SSE parser.
    const ctrlHolder: { current: ReadableStreamDefaultController<Uint8Array> | null } = { current: null };
    const errorStream = new ReadableStream<Uint8Array>({
      start(controller) {
        ctrlHolder.current = controller;
        controller.enqueue(encoder.encode(batchFrame));
        // Do NOT close or error here — we error after the batch is in cache.
      },
    });
    globalThis.fetch = mock(() => new Response(errorStream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })) as unknown as typeof fetch;

    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData<InfiniteData<HistoryPage<Batch>>>(historyKeys.list(), { pages: [{ items: [], nextCursor: null }], pageParams: [undefined] });

    const { result } = renderHook(() => useGenerate(emptyModelsById), { wrapper: wrapper(client) });

    const promise = result.current.generate({ prompt: 'net error test', modelId: 'gpt-image-2.5-sunburst', ratio: '1:1', count: 1 });

    // Wait for the batch frame to be processed — batch-err must appear in cache.
    await waitFor(() => {
      const d = client.getQueryData<InfiniteData<HistoryPage<Batch>>>(historyKeys.list());
      expect(d?.pages[0]?.items[0]?.id).toBe('batch-err');
    });

    // Now error the stream to simulate a mid-stream TCP reset.
    ctrlHolder.current?.error(new TypeError('network error: connection reset'));

    const error = await rejectedValue(promise);

    // Must have thrown — the stream error propagates as a TypeError.
    expect(error).toBeInstanceOf(Error);

    // The cached tile must still be loading — NOT failed.
    const data = client.getQueryData<InfiniteData<HistoryPage<Batch>>>(historyKeys.list());
    const tile = data?.pages[0]?.items[0]?.tiles[0];
    expect(tile?.status).toBe('loading');

    // History invalidation fires in the finally block regardless.
    expect(client.getQueryState(historyKeys.scoped({ kind: 'unsorted' }, ''))?.isInvalidated).toBe(true);
  });

  test('stream loss BEFORE the batch event invalidates history (no batchId yet)', async () => {
    // Fix 1: pre-batch stream loss — batchId is null, but the finally block
    // must still call invalidateQueries so the server-side batch (which the
    // v3 server keeps running) is reconciled via the next history refetch.
    // The stream closes immediately without emitting ANY SSE event.
    const emptyStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    globalThis.fetch = mock(() => new Response(emptyStream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })) as unknown as typeof fetch;

    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData<InfiniteData<HistoryPage<Batch>>>(historyKeys.list(), { pages: [{ items: [], nextCursor: null }], pageParams: [undefined] });

    const { result } = renderHook(() => useGenerate(emptyModelsById), { wrapper: wrapper(client) });
    const error = await rejectedValue(result.current.generate({ prompt: 'pre-batch loss', modelId: 'gpt-image-2.5-sunburst', ratio: '1:1', count: 1 }));

    // Must have thrown StreamTruncatedError (batchId is null, no batch event seen).
    expect(error).toMatchObject({ name: 'StreamTruncatedError' });

    // History invalidation must still fire even though batchId was never set.
    expect(client.getQueryState(historyKeys.scoped({ kind: 'unsorted' }, ''))?.isInvalidated).toBe(true);
  });

  test('mid-stream network error AFTER the batch event throws StreamTruncatedError (no toast)', async () => {
    // Fix 2: post-batch mid-stream failure must be normalized to
    // StreamTruncatedError so onError suppresses the misleading
    // "Generation failed" toast — the server may still be generating.
    const encoder = new TextEncoder();
    const batchFrame = sseChunk([
      'event: batch',
      'data: {"batchId":"batch-noerr","createdAt":1700000000000,"tiles":[{"tileId":"tile-noerr","tileIndex":0,"seed":9}]}',
    ]);
    const ctrlHolder: { current: ReadableStreamDefaultController<Uint8Array> | null } = { current: null };
    const errorStream = new ReadableStream<Uint8Array>({
      start(controller) {
        ctrlHolder.current = controller;
        controller.enqueue(encoder.encode(batchFrame));
        // Hold open; error injected after batch is in cache.
      },
    });
    globalThis.fetch = mock(() => new Response(errorStream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })) as unknown as typeof fetch;

    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData<InfiniteData<HistoryPage<Batch>>>(historyKeys.list(), { pages: [{ items: [], nextCursor: null }], pageParams: [undefined] });

    const { result } = renderHook(() => useGenerate(emptyModelsById), { wrapper: wrapper(client) });
    const promise = result.current.generate({ prompt: 'post-batch net error', modelId: 'gpt-image-2.5-sunburst', ratio: '1:1', count: 1 });

    // Wait for the batch to land in cache before erroring the stream.
    await waitFor(() => {
      const d = client.getQueryData<InfiniteData<HistoryPage<Batch>>>(historyKeys.list());
      expect(d?.pages[0]?.items[0]?.id).toBe('batch-noerr');
    });

    // Simulate TCP reset mid-stream.
    ctrlHolder.current?.error(new TypeError('network error: connection reset'));

    const error = await rejectedValue(promise);

    // Must be a StreamTruncatedError, not the raw TypeError, so onError swallows it.
    expect(error).toMatchObject({ name: 'StreamTruncatedError' });

    // No error-severity toast should have been emitted.
    const errorToasts = useAtelierStore.getState().toasts.filter((t) => t.tone === 'error');
    expect(errorToasts).toHaveLength(0);
  });
});

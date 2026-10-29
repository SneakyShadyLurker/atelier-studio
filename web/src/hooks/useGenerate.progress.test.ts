import type { Batch, HistoryPage, Model } from '@atelier/shared';
import type { InfiniteData } from '@tanstack/react-query';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { createElement, type PropsWithChildren } from 'react';
import { historyKeys } from '../api/history';
import { resetBroadcastForTests } from './broadcastHistory';
import { resetInFlightForTests } from './inFlightBatches';
import { useGenerate } from './useGenerate';
import { APP_VIEW_UNSORTED, useAtelierStore } from '../store/atelier';

const emptyModelsById: ReadonlyMap<string, Model> = new Map();

afterEach(() => {
  cleanup();
  mock.restore();
  resetBroadcastForTests();
  resetInFlightForTests();
  useAtelierStore.setState({
    activeBatchId: null,
    toasts: [],
    previews: new Map(),
    view: APP_VIEW_UNSORTED,
    q: '',
    followAnchorId: null,
  });
});

function wrapper(client: QueryClient) {
  return function TestWrapper({ children }: PropsWithChildren) {
    return createElement(QueryClientProvider, { client }, children);
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

function tileProgressFor(tileId: string): number | undefined {
  const state = useAtelierStore.getState() as unknown as {
    readonly tileProgress?: Readonly<Record<string, number>>;
  };
  return state.tileProgress?.[tileId];
}

describe('useGenerate progress events', () => {
  test('progress updates tileProgress without marking the tile terminal and done clears it', async () => {
    const stream = controllableSseResponse();
    globalThis.fetch = mock(() => stream.response) as unknown as typeof fetch;

    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData<InfiniteData<HistoryPage<Batch>>>(historyKeys.list(), {
      pages: [{ items: [], nextCursor: null }],
      pageParams: [undefined],
    });

    const { result } = renderHook(() => useGenerate(emptyModelsById), { wrapper: wrapper(client) });
    const promise = result.current.generate({
      prompt: 'animate progress',
      modelId: 'gpt-image-2.5-sunburst',
      ratio: '1:1',
      count: 1,
    });

    act(() => {
      stream.enqueue(sseChunk([
        'event: batch',
        'data: {"batchId":"batch-progress","createdAt":1700000000000,"tiles":[{"tileId":"tile-progress","tileIndex":0,"seed":1}]}',
      ]));
      stream.enqueue(sseChunk([
        'event: tile',
        'data: {"tileId":"tile-progress","tileIndex":0,"status":"progress","progress":0.35,"phase":"sampling"}',
      ]));
    });

    await waitFor(() => {
      expect(tileProgressFor('tile-progress')).toBe(0.35);
    });
    const loadingTile = client.getQueryData<InfiniteData<HistoryPage<Batch>>>(historyKeys.list())?.pages[0]?.items[0]?.tiles[0];
    expect(loadingTile?.status).toBe('loading');

    act(() => {
      stream.enqueue(sseChunk([
        'event: tile',
        'data: {"tileId":"tile-progress","tileIndex":0,"status":"done","url":"/api/img/tile-progress","ext":"png","mime":"image/png","completedAt":42}',
      ]));
      stream.enqueue(sseChunk([
        'event: done',
        'data: {"batchId":"batch-progress"}',
      ]));
      stream.close();
    });

    await promise;
    expect(tileProgressFor('tile-progress')).toBeUndefined();
    const doneTile = client.getQueryData<InfiniteData<HistoryPage<Batch>>>(historyKeys.list())?.pages[0]?.items[0]?.tiles[0];
    expect(doneTile?.status).toBe('done');
  });
});

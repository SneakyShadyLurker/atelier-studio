import type { Model } from '@atelier/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { allDoneBatch } from '../../test/fixtures/batches';
import { initialAtelierState, useAtelierStore } from '../store/atelier';
import { supersedeSourceHandoffs } from '../lib/composerSourceHandoff';
import { useEditFromTile } from './useEditFromTile';

const model: Model = {
  id: 'gpt-image-2.5-sunburst-cloud',
  name: 'GPT Image 2.5 Sunburst',
  backend: 'cloud',
  tag: 'cloud',
  latency: 'fast',
  supportedRatios: ['1:1', '4:5'],
  defaultRatio: '4:5',
  supportsReferenceImages: true,
  maxRefImages: 4,
  pool: 'shared',
  concurrencyCapPerUser: 4,
  maxCountPerBatch: 4,
};

const tile = allDoneBatch.tiles.find((candidate) => candidate.status === 'done');
if (!tile) throw new Error('done tile fixture is required');
const tileApiUrl = `/api/img/${tile.id}`;

const originalFetch = globalThis.fetch;
const createObjectURLDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
const revokeObjectURLDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function TestWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (createObjectURLDescriptor) Object.defineProperty(URL, 'createObjectURL', createObjectURLDescriptor);
  if (revokeObjectURLDescriptor) Object.defineProperty(URL, 'revokeObjectURL', revokeObjectURLDescriptor);
  mock.restore();
  useAtelierStore.setState(initialAtelierState, true);
});

describe('useEditFromTile', () => {
  test('serializes rapid edit handoffs so only one tile upload can win', async () => {
    URL.createObjectURL = mock(() => 'blob:generated-edit');
    URL.revokeObjectURL = mock(() => undefined);
    let releaseTileFetch: ((response: Response) => void) | undefined;
    const tileFetch = new Promise<Response>((resolve) => {
      releaseTileFetch = resolve;
    });
    const fetchMock = mock((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === tileApiUrl) return tileFetch;
      if (url === '/api/uploads') {
        return Promise.resolve(Response.json({
          id: 'upload-generated-edit',
          mime: 'image/png',
          ext: 'png',
          sizeBytes: 10,
          width: 64,
          height: 64,
          createdAt: 1,
        }));
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { result } = renderHook(
      () => [useEditFromTile(), useEditFromTile()] as const,
      { wrapper: wrapper() },
    );

    const first = result.current[0](tile, model, { ratio: allDoneBatch.ratio });
    const second = result.current[1](tile, model, { ratio: allDoneBatch.ratio });
    expect(await second).toBe(false);

    releaseTileFetch?.(new Response(new Blob(['tile-bytes'], { type: 'image/png' })));
    await act(async () => {
      expect(await first).toBe(true);
    });

    expect(fetchMock.mock.calls.filter(([input]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return url === tileApiUrl;
    })).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([input]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return url === '/api/uploads';
    })).toHaveLength(1);
    expect(useAtelierStore.getState().draft.ratio).toBe(allDoneBatch.ratio);
  });

  test('a source change during the tile download attaches nothing and stays silent', async () => {
    URL.createObjectURL = mock(() => 'blob:generated-edit');
    URL.revokeObjectURL = mock(() => undefined);
    let releaseTileFetch: ((response: Response) => void) | undefined;
    const tileFetch = new Promise<Response>((resolve) => { releaseTileFetch = resolve; });
    const fetchMock = mock((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === tileApiUrl) return tileFetch;
      return Promise.resolve(new Response('unexpected', { status: 500 }));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { result } = renderHook(() => useEditFromTile(), { wrapper: wrapper() });

    const edit = result.current(tile, model, { ratio: allDoneBatch.ratio });
    // e.g. Clear all, or an Animate started from another tile.
    supersedeSourceHandoffs();
    releaseTileFetch?.(new Response(new Blob(['tile-bytes'], { type: 'image/png' })));
    await act(async () => {
      expect(await edit).toBe(false);
    });

    const state = useAtelierStore.getState();
    expect(state.draft.refImages).toHaveLength(0);
    expect(state.draft.modelId).toBe(initialAtelierState.draft.modelId);
    expect(state.toasts).toHaveLength(0);
    expect(fetchMock.mock.calls).toHaveLength(1);
  });

  test('a newer video handoff during the ref upload keeps its model and video draft', async () => {
    URL.createObjectURL = mock(() => 'blob:generated-edit');
    URL.revokeObjectURL = mock(() => undefined);
    let releaseUpload: ((response: Response) => void) | undefined;
    const upload = new Promise<Response>((resolve) => { releaseUpload = resolve; });
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === tileApiUrl) return Promise.resolve(new Response(new Blob(['tile-bytes'], { type: 'image/png' })));
      if (url === '/api/uploads') return upload;
      return Promise.resolve(new Response('not found', { status: 404 }));
    }) as unknown as typeof fetch;
    const { result } = renderHook(() => useEditFromTile(), { wrapper: wrapper() });

    let edit: Promise<boolean> = Promise.resolve(true);
    act(() => { edit = result.current(tile, model, { ratio: allDoneBatch.ratio }); });
    await waitFor(() => { expect(useAtelierStore.getState().draft.refImages).toHaveLength(1); });
    // An Animate from another tile lands while the ref is still uploading.
    supersedeSourceHandoffs();
    useAtelierStore.getState().setDraft({ modelId: 'minimax-h3-i2v', i2vSourceUploadId: 'animate-source' });
    await act(async () => {
      releaseUpload?.(Response.json({
        id: 'upload-generated-edit', mime: 'image/png', ext: 'png', sizeBytes: 10, width: 64, height: 64, createdAt: 1,
      }));
      expect(await edit).toBe(false);
    });

    const draft = useAtelierStore.getState().draft;
    expect(draft.modelId).toBe('minimax-h3-i2v');
    expect(draft.i2vSourceUploadId).toBe('animate-source');
    // The attached chip is an ordinary, removable composer ref.
    expect(draft.refImages.map((ref) => ref.status)).toEqual(['ready']);
  });
});

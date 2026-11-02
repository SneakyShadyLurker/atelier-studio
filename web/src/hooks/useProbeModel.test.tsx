import type { Model } from '@atelier/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { modelKeys, modelsOpts } from '../api/models';
import { useProbeModel } from './useProbeModel';
import { flushQueryNotifications } from '../../test/fixtures/queryNotifications';

const originalFetch = globalThis.fetch;

function localModel(id: string, ok: boolean, checkedAt: number): Model {
  return {
    id,
    name: id,
    backend: 'local',
    tag: 'comfyui',
    latency: 'medium',
    supportedRatios: ['1:1'],
    concurrencyCapPerUser: 1,
    maxCountPerBatch: 1,
    pool: 'local',
    availability: ok
      ? { ok: true, checkedAt }
      : { ok: false, checkedAt, reason: 'unavailable' },
  };
}

function deferredResponse(): {
  promise: Promise<Response>;
  resolve: (response: Response) => void;
} {
  let resolve: (response: Response) => void = () => undefined;
  const promise = new Promise<Response>((settle) => { resolve = settle; });
  return { promise, resolve };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
  mock.restore();
});

describe('useProbeModel cache freshness', () => {
  test('a late older response cannot replace newer per-model availability', async () => {
    const first = deferredResponse();
    const second = deferredResponse();
    let requestIndex = 0;
    globalThis.fetch = mock(() => {
      requestIndex += 1;
      return requestIndex === 1 ? first.promise : second.promise;
    }) as unknown as typeof fetch;
    const structuralSharing = modelsOpts().structuralSharing;
    if (structuralSharing === undefined) {
      throw new Error('expected models query structural sharing');
    }
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, structuralSharing },
        mutations: { retry: false },
      },
    });
    client.setQueryData(modelKeys.list(), [
      localModel('model-a', false, 100),
      localModel('model-b', false, 100),
    ]);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useProbeModel(), { wrapper });

    const olderPromise = result.current.mutateAsync('model-a');
    const newerPromise = result.current.mutateAsync('model-b');
    await act(async () => {
      second.resolve(Response.json([
        localModel('model-a', true, 300),
        localModel('model-b', true, 300),
      ]));
      await newerPromise;
    });
    const afterNewer = client.getQueryData<readonly Model[]>(modelKeys.list());
    expect(afterNewer?.map((model) => model.availability?.checkedAt)).toEqual([300, 300]);

    await act(async () => {
      first.resolve(Response.json([
        localModel('model-a', false, 200),
        localModel('model-b', false, 200),
      ]));
      await olderPromise;
    });
    const afterOlder = client.getQueryData<readonly Model[]>(modelKeys.list());

    expect(afterOlder).toBe(afterNewer);
    expect(afterOlder?.map((model) => model.availability?.ok)).toEqual([true, true]);
    expect(afterOlder?.map((model) => model.availability?.checkedAt)).toEqual([300, 300]);
  });

  test('a probe response is authoritative for registry membership and order', async () => {
    globalThis.fetch = mock(() => Promise.resolve(Response.json([
      localModel('model-c', true, 300),
      localModel('model-a', true, 300),
    ]))) as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    client.setQueryData(modelKeys.list(), [
      localModel('model-a', false, 100),
      localModel('model-b', false, 100),
    ]);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useProbeModel(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync('model-a');
      await flushQueryNotifications();
    });

    const cached = client.getQueryData<readonly Model[]>(modelKeys.list());
    expect(cached?.map((model) => model.id)).toEqual(['model-c', 'model-a']);
    expect(cached?.map((model) => model.availability?.ok)).toEqual([true, true]);
  });
});

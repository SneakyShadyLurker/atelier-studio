import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { resetMediaCacheForTests } from '../lib/mediaCache';
import { useCachedMedia, useCachedThumb } from './useCachedMedia';

interface Call { url: string; init: RequestInit | undefined; resolve: (response: Response) => void }

const realFetch = globalThis.fetch;
const realCreate = URL.createObjectURL.bind(URL);
const realRevoke = URL.revokeObjectURL.bind(URL);
let calls: Call[] = [];

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 4; index += 1) await new Promise((resolve) => { setTimeout(resolve, 0); });
  });
}

beforeEach(() => {
  calls = [];
  resetMediaCacheForTests({ capBytes: 10_000, backoffMs: 1 });
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve) => {
    calls.push({ url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, init, resolve });
  })) as typeof fetch;
  let created = 0;
  URL.createObjectURL = () => { created += 1; return `blob:test/${created}`; };
  URL.revokeObjectURL = () => undefined;
});

afterEach(() => {
  cleanup();
  resetMediaCacheForTests();
  globalThis.fetch = realFetch;
  URL.createObjectURL = realCreate;
  URL.revokeObjectURL = realRevoke;
});

function ok(): Response {
  return new Response(new Blob([new Uint8Array(10)]), { status: 200 });
}

describe('useCachedMedia', () => {
  test('loads, then a remount is ready and cached on its first render without a request', async () => {
    const first = renderHook(() => useCachedMedia('/api/img/a/thumb', { priority: 'high' }));
    expect(first.result.current.status).toBe('loading');
    expect(first.result.current.src).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.priority).toBe('high');
    calls[0]?.resolve(ok());
    await settle();
    expect(first.result.current).toMatchObject({ status: 'ready', src: 'blob:test/1', cached: false });
    first.unmount();
    await settle();

    const renders: { status: string; cached: boolean }[] = [];
    const second = renderHook(() => {
      const media = useCachedMedia('/api/img/a/thumb');
      renders.push({ status: media.status, cached: media.cached });
      return media;
    });
    expect(renders[0]).toEqual({ status: 'ready', cached: true });
    expect(second.result.current.src).toBe('blob:test/1');
    expect(calls).toHaveLength(1);
  });

  test('reports an error, and retry starts a fresh download', async () => {
    const { result } = renderHook(() => useCachedMedia('/api/img/gone/thumb'));
    calls[0]?.resolve(new Response(null, { status: 404 }));
    await settle();
    expect(result.current.status).toBe('error');
    act(() => { result.current.retry(); });
    expect(result.current.status).toBe('loading');
    expect(calls).toHaveLength(2);
    calls[1]?.resolve(ok());
    await settle();
    expect(result.current.status).toBe('ready');
  });

  test('passes data: URLs through untouched and treats a missing URL as unavailable', () => {
    const data = renderHook(() => useCachedMedia('data:image/png;base64,AAAA'));
    expect(data.result.current).toMatchObject({ status: 'ready', src: 'data:image/png;base64,AAAA', cached: false });
    const none = renderHook(() => useCachedMedia(undefined));
    expect(none.result.current).toMatchObject({ status: 'error', src: undefined, cached: false });
    expect(calls).toHaveLength(0);
  });

  test('switching URLs releases the old one and judges the new one by its own first render', async () => {
    const { result, rerender } = renderHook(({ url }: { url: string }) => useCachedMedia(url), { initialProps: { url: '/a' } });
    calls[0]?.resolve(ok());
    await settle();
    expect(result.current.cached).toBe(false);
    rerender({ url: '/b' });
    expect(result.current.status).toBe('loading');
    expect(result.current.cached).toBe(false);
    rerender({ url: '/a' });
    expect(result.current).toMatchObject({ status: 'ready', cached: true });
  });
});

describe('useCachedThumb', () => {
  test('a tile without a thumbnail uses the original at once and fetches nothing', () => {
    const fetchMock = mock(() => Promise.resolve(new Response(new Blob(['x']))));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { result } = renderHook(() => useCachedThumb(undefined, '/api/img/a'));
    expect(result.current).toBe('/api/img/a');
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  test('a thumbnail that cannot be loaded falls back to the original', async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(null, { status: 404 }))) as unknown as typeof fetch;
    const { result } = renderHook(() => useCachedThumb('/api/img/a/thumb', '/api/img/a'));
    expect(result.current === undefined).toBe(true);
    await waitFor(() => { expect(result.current).toBe('/api/img/a'); });
  });
});

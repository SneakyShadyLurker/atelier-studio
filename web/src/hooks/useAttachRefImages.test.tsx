import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MAX_REF_BYTES_PER_BATCH, MAX_UPLOAD_INPUT_BYTES } from '@atelier/shared';
import { useAttachRefImages } from './useAttachRefImages';
import { useAtelierStore } from '../store/atelier';

const createObjectURLDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
const revokeObjectURLDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
const originalFetch = globalThis.fetch;

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return function W({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function imageFile(size: number, name = 'ref.png'): File {
  return new File([new Uint8Array(size)], name, { type: 'image/png' });
}

afterEach(() => {
  if (createObjectURLDescriptor) Object.defineProperty(URL, 'createObjectURL', createObjectURLDescriptor);
  if (revokeObjectURLDescriptor) Object.defineProperty(URL, 'revokeObjectURL', revokeObjectURLDescriptor);
  globalThis.fetch = originalFetch;
  mock.restore();
  useAtelierStore.setState({
    draft: { prompt: '', modelId: '', ratio: '1:1', durationFrames: null, count: 2, refImages: [], rollQueue: [] },
    toasts: [],
  });
});

describe('useAttachRefImages', () => {
  test('returns a stable attach callback across unchanged renders', () => {
    const { result, rerender } = renderHook(() => useAttachRefImages(), { wrapper: wrapper() });
    const first = result.current;

    rerender();

    expect(result.current).toBe(first);
  });

  test('rejects oversized files before adding a draft ref or uploading', async () => {
    URL.createObjectURL = mock(() => 'blob:oversized');
    URL.revokeObjectURL = mock(() => undefined);
    globalThis.fetch = mock(() => Promise.resolve(Response.json({}))) as unknown as typeof fetch;
    const { result } = renderHook(() => useAttachRefImages(), { wrapper: wrapper() });

    await act(async () => {
      await result.current([imageFile(MAX_UPLOAD_INPUT_BYTES + 1)], { mode: 'append', capacity: 4 });
    });

    expect(useAtelierStore.getState().draft.refImages).toEqual([]);
    expect(useAtelierStore.getState().toasts[0]?.text).toBe('Reference image is too large');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('rejects attachments that would exceed the per-batch byte budget', async () => {
    URL.createObjectURL = mock(() => 'blob:within-cap');
    URL.revokeObjectURL = mock(() => undefined);
    globalThis.fetch = mock(() => Promise.resolve(Response.json({}))) as unknown as typeof fetch;
    useAtelierStore.setState({
      draft: {
        prompt: '',
        modelId: '',
        ratio: '1:1', durationFrames: null,
        count: 2,
        refImages: [{
          clientId: 'existing',
          serverId: 'upload-existing',
          status: 'ready',
          mime: 'image/png',
          sizeBytes: MAX_REF_BYTES_PER_BATCH - 1,
          previewUrl: '/api/uploads/upload-existing',
        }],
        rollQueue: [],
      },
    });
    const { result } = renderHook(() => useAttachRefImages(), { wrapper: wrapper() });

    await act(async () => {
      await result.current([imageFile(2)], { mode: 'append', capacity: 4 });
    });

    expect(useAtelierStore.getState().draft.refImages).toHaveLength(1);
    expect(useAtelierStore.getState().toasts[0]?.text).toBe('Reference images exceed the per-batch limit');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('uses the runtime reference byte budget supplied by the selected model', async () => {
    URL.createObjectURL = mock(() => 'blob:runtime-cap');
    URL.revokeObjectURL = mock(() => undefined);
    globalThis.fetch = mock(() => Promise.resolve(Response.json({}))) as unknown as typeof fetch;
    useAtelierStore.setState({
      draft: {
        prompt: '',
        modelId: '',
        ratio: '1:1', durationFrames: null,
        count: 2,
        refImages: [{
          clientId: 'existing',
          serverId: 'upload-existing',
          status: 'ready',
          mime: 'image/png',
          sizeBytes: 11,
          previewUrl: '/api/uploads/upload-existing',
        }],
        rollQueue: [],
      },
    });
    const { result } = renderHook(() => useAttachRefImages(), { wrapper: wrapper() });

    await act(async () => {
      await result.current([imageFile(2)], { mode: 'append', capacity: 4, maxRefBytesPerBatch: 12 });
    });

    expect(useAtelierStore.getState().draft.refImages).toHaveLength(1);
    expect(useAtelierStore.getState().toasts[0]?.text).toBe('Reference images exceed the per-batch limit');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('never relaxes the reference byte budget above the shared safe cap before models load', async () => {
    URL.createObjectURL = mock(() => 'blob:shared-cap');
    URL.revokeObjectURL = mock(() => undefined);
    globalThis.fetch = mock(() => Promise.resolve(Response.json({}))) as unknown as typeof fetch;
    useAtelierStore.setState({
      draft: {
        prompt: '',
        modelId: '',
        ratio: '1:1', durationFrames: null,
        count: 2,
        refImages: [{
          clientId: 'existing',
          serverId: 'upload-existing',
          status: 'ready',
          mime: 'image/png',
          sizeBytes: MAX_REF_BYTES_PER_BATCH - 1,
          previewUrl: '/api/uploads/upload-existing',
        }],
        rollQueue: [],
      },
    });
    const { result } = renderHook(() => useAttachRefImages(), { wrapper: wrapper() });

    await act(async () => {
      await result.current([imageFile(2)], { mode: 'append', capacity: 10, maxRefBytesPerBatch: MAX_REF_BYTES_PER_BATCH * 2 });
    });

    expect(useAtelierStore.getState().draft.refImages).toHaveLength(1);
    expect(useAtelierStore.getState().toasts[0]?.text).toBe('Reference images exceed the per-batch limit');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('replace-last appends when effective capacity has room above the fallback cap', async () => {
    URL.createObjectURL = mock(() => 'blob:capacity-10');
    URL.revokeObjectURL = mock(() => undefined);
    crypto.randomUUID = mock(() => 'client-new') as unknown as typeof crypto.randomUUID;
    globalThis.fetch = mock(() => Promise.resolve(Response.json({
      id: 'upload-new',
      mime: 'image/png',
      ext: 'png',
      sizeBytes: 1,
      width: 1,
      height: 1,
      createdAt: 1,
    }))) as unknown as typeof fetch;
    useAtelierStore.setState({
      draft: {
        prompt: '',
        modelId: '',
        ratio: '1:1', durationFrames: null,
        count: 2,
        refImages: [1, 2, 3, 4].map((index) => ({
          clientId: `client-${index}`,
          serverId: `upload-${index}`,
          status: 'ready' as const,
          mime: 'image/png',
          sizeBytes: 1,
          previewUrl: `/api/uploads/upload-${index}`,
        })),
        rollQueue: [],
      },
    });
    const { result } = renderHook(() => useAttachRefImages(), { wrapper: wrapper() });

    await act(async () => {
      await result.current([imageFile(1)], { mode: 'replace-last', capacity: 10 });
    });

    expect(useAtelierStore.getState().draft.refImages.map((ref) => ref.clientId)).toEqual([
      'client-1',
      'client-2',
      'client-3',
      'client-4',
      'client-new',
    ]);
  });

  test('accepts a HEIC file reported with empty MIME type', async () => {
    URL.createObjectURL = mock(() => 'blob:heic');
    URL.revokeObjectURL = mock(() => undefined);
    crypto.randomUUID = mock(() => 'client-heic') as unknown as typeof crypto.randomUUID;
    globalThis.fetch = mock(() => Promise.resolve(Response.json({
      id: 'upload-heic',
      mime: 'image/png',
      ext: 'png',
      sizeBytes: 8,
      width: 1,
      height: 1,
      createdAt: 1,
    }))) as unknown as typeof fetch;
    const { result } = renderHook(() => useAttachRefImages(), { wrapper: wrapper() });
    const heic = new File([new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70])], 'IMG_1234.HEIC', { type: '' });
    await act(async () => {
      await result.current([heic], { mode: 'append', capacity: 4 });
    });
    expect(useAtelierStore.getState().draft.refImages.length).toBe(1);
  });

  test('rejects svg', async () => {
    URL.createObjectURL = mock(() => 'blob:svg');
    URL.revokeObjectURL = mock(() => undefined);
    globalThis.fetch = mock(() => Promise.resolve(Response.json({}))) as unknown as typeof fetch;
    const { result } = renderHook(() => useAttachRefImages(), { wrapper: wrapper() });
    const svg = new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' });
    await act(async () => {
      await result.current([svg], { mode: 'append', capacity: 4 });
    });
    expect(useAtelierStore.getState().draft.refImages.length).toBe(0);
  });

  test('removes an appended replacement when its upload fails', async () => {
    URL.createObjectURL = mock(() => 'blob:failed-replacement');
    const revokeObjectURL = mock(() => undefined);
    URL.revokeObjectURL = revokeObjectURL;
    crypto.randomUUID = mock(() => 'client-failed') as unknown as typeof crypto.randomUUID;
    globalThis.fetch = mock(() => Promise.resolve(new Response(
      JSON.stringify({ error: 'quota exceeded' }),
      { status: 429 },
    ))) as unknown as typeof fetch;
    const { result } = renderHook(() => useAttachRefImages(), { wrapper: wrapper() });

    let attached = true;
    await act(async () => {
      attached = await result.current([imageFile(1)], { mode: 'replace-last', capacity: 4 });
    });

    expect(attached).toBe(false);
    expect(useAtelierStore.getState().draft.refImages).toEqual([]);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:failed-replacement');
  });

  test('trims excess refs to the source-model capacity and deletes their uploads', async () => {
    URL.createObjectURL = mock(() => 'blob:capacity-trim');
    URL.revokeObjectURL = mock(() => undefined);
    crypto.randomUUID = mock(() => 'client-new') as unknown as typeof crypto.randomUUID;
    const calls: string[] = [];
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (init?.method === 'DELETE') return Promise.resolve(new Response(null, { status: 204 }));
      return Promise.resolve(Response.json({
        id: 'upload-new',
        mime: 'image/png',
        ext: 'png',
        sizeBytes: 1,
        width: 1,
        height: 1,
        createdAt: 1,
      }));
    }) as unknown as typeof fetch;
    useAtelierStore.setState({
      draft: {
        prompt: '',
        modelId: '',
        ratio: '1:1', durationFrames: null,
        count: 2,
        refImages: [1, 2, 3, 4, 5, 6].map((index) => ({
          clientId: `client-${index}`,
          serverId: `upload-${index}`,
          status: 'ready' as const,
          mime: 'image/png',
          sizeBytes: 1,
          previewUrl: `/api/uploads/upload-${index}`,
        })),
        rollQueue: [],
      },
    });
    const { result } = renderHook(() => useAttachRefImages(), { wrapper: wrapper() });

    await act(async () => {
      await result.current([imageFile(1)], { mode: 'replace-last', capacity: 4 });
    });

    expect(useAtelierStore.getState().draft.refImages.map((ref) => ref.clientId)).toEqual([
      'client-1',
      'client-2',
      'client-3',
      'client-new',
    ]);
    await waitFor(() => {
      expect(calls).toContain('DELETE /api/uploads/upload-4');
      expect(calls).toContain('DELETE /api/uploads/upload-5');
      expect(calls).toContain('DELETE /api/uploads/upload-6');
    });
  });

  test('restores every trimmed ref when the generated-image upload fails', async () => {
    URL.createObjectURL = mock(() => 'blob:failed-trim');
    URL.revokeObjectURL = mock(() => undefined);
    crypto.randomUUID = mock(() => 'client-new') as unknown as typeof crypto.randomUUID;
    globalThis.fetch = mock(() => Promise.resolve(new Response(
      JSON.stringify({ error: 'quota exceeded' }),
      { status: 429 },
    ))) as unknown as typeof fetch;
    useAtelierStore.setState({
      draft: {
        prompt: '',
        modelId: '',
        ratio: '1:1', durationFrames: null,
        count: 2,
        refImages: [1, 2, 3, 4, 5, 6].map((index) => ({
          clientId: `client-${index}`,
          serverId: `upload-${index}`,
          status: 'ready' as const,
          mime: 'image/png',
          sizeBytes: 1,
          previewUrl: `/api/uploads/upload-${index}`,
        })),
        rollQueue: [],
      },
    });
    const { result } = renderHook(() => useAttachRefImages(), { wrapper: wrapper() });

    await act(async () => {
      await result.current([imageFile(1)], { mode: 'replace-last', capacity: 4 });
    });

    expect(useAtelierStore.getState().draft.refImages.map((ref) => ref.clientId)).toEqual([
      'client-1',
      'client-2',
      'client-3',
      'client-4',
      'client-5',
      'client-6',
    ]);
  });

  test('does not evict a reference whose upload is still in flight', async () => {
    URL.createObjectURL = mock(() => 'blob:pending-trim');
    URL.revokeObjectURL = mock(() => undefined);
    globalThis.fetch = mock(() => Promise.resolve(Response.json({}))) as unknown as typeof fetch;
    useAtelierStore.setState({
      draft: {
        prompt: '',
        modelId: '',
        ratio: '1:1', durationFrames: null,
        count: 2,
        refImages: [1, 2, 3, 4].map((index) => ({
          clientId: `client-${index}`,
          ...(index < 4 ? { serverId: `upload-${index}` } : {}),
          status: index < 4 ? 'ready' as const : 'uploading' as const,
          mime: 'image/png',
          sizeBytes: 1,
          previewUrl: index < 4 ? `/api/uploads/upload-${index}` : 'blob:uploading-4',
        })),
        rollQueue: [],
      },
    });
    const { result } = renderHook(() => useAttachRefImages(), { wrapper: wrapper() });

    await act(async () => {
      await result.current([imageFile(1)], { mode: 'replace-last', capacity: 4 });
    });

    expect(useAtelierStore.getState().draft.refImages.map((ref) => ref.clientId)).toEqual([
      'client-1',
      'client-2',
      'client-3',
      'client-4',
    ]);
    expect(useAtelierStore.getState().toasts[0]?.text).toBe('Wait for reference images to finish uploading');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('replace-last evicts the effective capacity slot used by byte-budget preflight', async () => {
    URL.createObjectURL = mock(() => 'blob:capacity-slot');
    URL.revokeObjectURL = mock(() => undefined);
    crypto.randomUUID = mock(() => 'client-new') as unknown as typeof crypto.randomUUID;
    const calls: string[] = [];
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      calls.push(url);
      if (url.endsWith('/uploads/upload-10')) return Promise.resolve(new Response(null, { status: 204 }));
      return Promise.resolve(Response.json({
        id: 'upload-new',
        mime: 'image/png',
        ext: 'png',
        sizeBytes: 20,
        width: 1,
        height: 1,
        createdAt: 1,
      }));
    }) as unknown as typeof fetch;
    useAtelierStore.setState({
      draft: {
        prompt: '',
        modelId: '',
        ratio: '1:1', durationFrames: null,
        count: 2,
        refImages: Array.from({ length: 10 }, (_, index) => ({
          clientId: `client-${index + 1}`,
          serverId: `upload-${index + 1}`,
          status: 'ready' as const,
          mime: 'image/png',
          sizeBytes: index === 9 ? 50 : 4,
          previewUrl: `/api/uploads/upload-${index + 1}`,
        })),
        rollQueue: [],
      },
    });
    const { result } = renderHook(() => useAttachRefImages(), { wrapper: wrapper() });

    await act(async () => {
      await result.current([imageFile(20)], { mode: 'replace-last', capacity: 10, maxRefBytesPerBatch: 56 });
    });

    const refs = useAtelierStore.getState().draft.refImages;
    expect(refs.map((ref) => ref.clientId)).toEqual([
      'client-1',
      'client-2',
      'client-3',
      'client-4',
      'client-5',
      'client-6',
      'client-7',
      'client-8',
      'client-9',
      'client-new',
    ]);
    expect(refs.reduce((total, ref) => total + ref.sizeBytes, 0)).toBe(56);
    await waitFor(() => { expect(calls).toContain('/api/uploads/upload-10'); });
  });
});

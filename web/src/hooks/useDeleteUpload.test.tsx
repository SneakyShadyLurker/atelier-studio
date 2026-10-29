import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import {
  holdSubmissionUploads,
  initialAtelierState,
  useAtelierStore,
  type QueuedRoll,
  type RollSubmission,
} from '../store/atelier';
import { useDeleteUpload } from './useDeleteUpload';

const originalFetch = globalThis.fetch;
const deleted: string[] = [];
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

const submission = (refImageIds: string[]): RollSubmission => ({
  request: { modelId: 'model-a', ratio: '1:1', count: 1, refImageIds },
  lockedSeed: null,
  wantsMotion: false,
  motionFields: {},
});

const queuedRoll = (id: string, refImageIds: string[]): QueuedRoll => ({
  id, text: 'queued', seed: 1, source: 'composer', submission: submission(refImageIds),
});

function renderDelete() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrapper = ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(() => useDeleteUpload(), { wrapper });
}

const toastTexts = () => useAtelierStore.getState().toasts.map((toast) => toast.text);

describe('useDeleteUpload', () => {
  beforeEach(() => {
    deleted.length = 0;
    useAtelierStore.setState(initialAtelierState, true);
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') deleted.push(decodeURIComponent(requestUrl(input).split('/').pop() ?? ''));
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    useAtelierStore.setState(initialAtelierState, true);
  });

  test('deletes an upload no queued or pending work holds at once', async () => {
    const { result } = renderDelete();
    let outcome: unknown;
    await act(async () => { outcome = await result.current.mutateAsync('up-free'); });
    expect(outcome).toEqual({ referenced: false });
    expect(deleted).toEqual(['up-free']);
  });

  test('an upload a queued roll references reports referenced, and leaving the queue never deletes it', async () => {
    useAtelierStore.getState().requeueRoll(queuedRoll('roll-1', ['up-queued']));
    const { result } = renderDelete();
    let outcome: unknown;
    await act(async () => { outcome = await result.current.mutateAsync('up-queued'); });
    expect(outcome).toEqual({ referenced: true });
    expect(deleted).toEqual([]);
    expect(toastTexts()).toContain('Upload is still referenced');

    await act(async () => {
      useAtelierStore.getState().removeQueuedRoll('roll-1');
      await tick();
    });
    expect(deleted).toEqual([]);

    // Once nothing holds it, an explicit delete goes through.
    await act(async () => { outcome = await result.current.mutateAsync('up-queued'); });
    expect(outcome).toEqual({ referenced: false });
    expect(deleted).toEqual(['up-queued']);
  });

  test('an upload a pending press holds reports referenced, and releasing the hold never deletes it', async () => {
    const release = holdSubmissionUploads([submission(['up-pending'])]);
    const { result } = renderDelete();
    let outcome: unknown;
    await act(async () => { outcome = await result.current.mutateAsync('up-pending'); });
    expect(outcome).toEqual({ referenced: true });
    expect(deleted).toEqual([]);

    await act(async () => {
      release();
      await tick();
    });
    expect(deleted).toEqual([]);

    await act(async () => { outcome = await result.current.mutateAsync('up-pending'); });
    expect(outcome).toEqual({ referenced: false });
    expect(deleted).toEqual(['up-pending']);
  });

  test('a server 409 still reports referenced with the same feedback', async () => {
    globalThis.fetch = mock(() => Promise.resolve(Response.json({ error: 'upload still referenced' }, { status: 409 }))) as unknown as typeof fetch;
    const { result } = renderDelete();
    let outcome: unknown;
    await act(async () => { outcome = await result.current.mutateAsync('up-server-held'); });
    expect(outcome).toEqual({ referenced: true });
    expect(toastTexts()).toContain('Upload is still referenced');
  });
});

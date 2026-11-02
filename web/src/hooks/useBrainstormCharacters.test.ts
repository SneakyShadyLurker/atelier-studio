import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useBrainstormCharacters } from './useBrainstormCharacters';
import { useAtelierStore } from '../store/atelier';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
  useAtelierStore.getState().clearRollQueue();
  useAtelierStore.setState({ toasts: [] });
});

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
}

function sseFetch(body: string) {
  return mock(() => Promise.resolve(new Response(streamOf(body), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })));
}

describe('useBrainstormCharacters', () => {
  test('stashes one roll per prompt event and ends in done state', async () => {
    globalThis.fetch = sseFetch(
      'event: prompt\ndata: {"index":0,"text":"p0"}\n\n' +
      'event: prompt\ndata: {"index":1,"text":"p1"}\n\n' +
      'event: done\ndata: {"count":2}\n\n',
    ) as unknown as typeof fetch;
    const { result } = renderHook(() => useBrainstormCharacters());
    await act(async () => { await result.current.run({ brief: 'x', count: 2, modelId: 'gpt-image-2.5-sunburst' }); });
    expect(useAtelierStore.getState().draft.rollQueue).toHaveLength(2);
    expect(result.current.status).toBe('done');
    expect(result.current.generated).toBe(2);
  });

  test('surfaces an error event as error status without stashing', async () => {
    globalThis.fetch = sseFetch('event: error\ndata: {"message":"boom"}\n\n') as unknown as typeof fetch;
    const { result } = renderHook(() => useBrainstormCharacters());
    await act(async () => { await result.current.run({ brief: '', count: 5, modelId: 'm' }); });
    expect(result.current.status).toBe('error');
    expect(result.current.errorMessage).toBe('boom');
    expect(useAtelierStore.getState().draft.rollQueue).toHaveLength(0);
  });

  test('cancel aborts the in-flight stream and moves status out of running', async () => {
    let aborted = false;
    globalThis.fetch = mock((_url: string, init?: RequestInit) => {
      init?.signal?.addEventListener('abort', () => { aborted = true; });
      return Promise.resolve(new Response(
        new ReadableStream<Uint8Array>({ start() { /* stays open */ } }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      ));
    }) as unknown as typeof fetch;
    const { result } = renderHook(() => useBrainstormCharacters());
    act(() => { void result.current.run({ count: 3, modelId: 'm' }); });
    await waitFor(() => { expect(result.current.status).toBe('running'); });
    act(() => { result.current.cancel(); });
    expect(aborted).toBe(true);
    expect(result.current.status).toBe('canceled');
  });

  test('treats EOF without a done frame as error but keeps partial rolls', async () => {
    globalThis.fetch = sseFetch('event: prompt\ndata: {"index":0,"text":"p0"}\n\n') as unknown as typeof fetch;
    const { result } = renderHook(() => useBrainstormCharacters());
    await act(async () => { await result.current.run({ count: 3, modelId: 'm' }); });
    expect(result.current.status).toBe('error');
    expect(useAtelierStore.getState().draft.rollQueue).toHaveLength(1);
  });

  test('done with count below requested ends done and warns', async () => {
    globalThis.fetch = sseFetch(
      'event: prompt\ndata: {"index":0,"text":"p0"}\n\n' +
      'event: done\ndata: {"count":1}\n\n',
    ) as unknown as typeof fetch;
    const { result } = renderHook(() => useBrainstormCharacters());
    await act(async () => { await result.current.run({ count: 5, modelId: 'm' }); });
    expect(result.current.status).toBe('done');
    expect(useAtelierStore.getState().draft.rollQueue).toHaveLength(1);
    expect(useAtelierStore.getState().toasts.some((t) => t.text.includes('1 of 5'))).toBe(true);
  });
});

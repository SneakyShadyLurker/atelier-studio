import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useDraftList } from './useDraftList';
import { useAtelierStore } from '../store/atelier';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
  useAtelierStore.setState({ toasts: [] });
});

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return function W({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}
// The draft route now streams its result as SSE: a 200 success carries the
// payload in a terminal `done` frame, while pre-LLM validation failures stay
// plain JSON (4xx/5xx). Build the right response shape for either.
function draftResponse(status: number, body: unknown): Response {
  if (status === 200) {
    return new Response(`event: done\ndata: ${JSON.stringify(body)}\n\n`, {
      status: 200, headers: { 'Content-Type': 'text/event-stream' },
    });
  }
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function jsonFetch(status: number, body: unknown) {
  return mock(() => Promise.resolve(draftResponse(status, body)));
}

interface DraftRequest {
  name: string;
  existing: string[];
  description?: string;
}

function requestBody(init?: RequestInit): DraftRequest {
  if (typeof init?.body !== 'string') throw new Error('missing request body');
  return JSON.parse(init.body) as DraftRequest;
}

function draftFetch(handler: (body: DraftRequest, call: number) => { status: number; body: unknown }) {
  const requests: DraftRequest[] = [];
  const f = mock((_u: string, init?: RequestInit) => {
    const sent = requestBody(init);
    requests.push(sent);
    const response = handler(sent, requests.length);
    return Promise.resolve(draftResponse(response.status, response.body));
  });
  return { fetch: f, requests };
}

function harness(
  options: {
    values?: string[];
    onEntries?: ReturnType<typeof mock<(entries: string[]) => void>>;
  } = {},
) {
  let values = options.values ?? ['red'];
  const onEntries = options.onEntries ?? mock((_: string[]) => { return; });
  const view = renderHook(
    () => useDraftList({ listId: 'l1', name: 'Colours', getCurrentValues: () => values, onEntries }),
    { wrapper: wrapper() },
  );
  return {
    view,
    onEntries,
    setValues: (next: string[]) => { values = next; },
  };
}

describe('useDraftList', () => {
  test('entries -> onEntries + done', async () => {
    globalThis.fetch = jsonFetch(200, { kind: 'entries', entries: ['blue', 'green'] }) as unknown as typeof fetch;
    const h = harness();
    act(() => { h.view.result.current.draft(); });
    await waitFor(() => { expect(h.view.result.current.status).toBe('done'); });
    expect(h.onEntries).toHaveBeenCalledWith(['blue', 'green']);
    expect(h.view.result.current.dialogMode).toBeNull();
  });

  test('clarify -> clarifying + question exposed', async () => {
    globalThis.fetch = jsonFetch(200, { kind: 'clarify', question: 'which?' }) as unknown as typeof fetch;
    const h = harness();
    act(() => { h.view.result.current.draft(); });
    await waitFor(() => { expect(h.view.result.current.status).toBe('clarifying'); });
    expect(h.view.result.current.dialogMode).toBe('clarify');
    expect(h.view.result.current.clarifyQuestion).toBe('which?');
  });

  test('submitDescription resends with description and resolves to entries', async () => {
    const f = mock((_u: string, init?: RequestInit) => {
      const sent = JSON.parse(typeof init?.body === 'string' ? init.body : '') as { description?: string };
      const body = sent.description ? { kind: 'entries', entries: ['x'] } : { kind: 'clarify', question: 'q' };
      return Promise.resolve(draftResponse(200, body));
    });
    globalThis.fetch = f as unknown as typeof fetch;
    const h = harness();
    act(() => { h.view.result.current.draft(); });
    await waitFor(() => { expect(h.view.result.current.status).toBe('clarifying'); });
    act(() => { h.view.result.current.submitDescription('cat breeds'); });
    await waitFor(() => { expect(h.view.result.current.status).toBe('done'); });
    expect(h.onEntries).toHaveBeenCalledWith(['x']);
  });

  test('cancelDialog clears the question', async () => {
    globalThis.fetch = jsonFetch(200, { kind: 'clarify', question: 'q' }) as unknown as typeof fetch;
    const h = harness();
    act(() => { h.view.result.current.draft(); });
    await waitFor(() => { expect(h.view.result.current.clarifyQuestion).toBe('q'); });
    act(() => { h.view.result.current.cancelDialog(); });
    expect(h.view.result.current.dialogMode).toBeNull();
    expect(h.view.result.current.clarifyQuestion).toBeNull();
    expect(h.view.result.current.status).toBe('idle');
  });

  test('error toasts and sets error status', async () => {
    globalThis.fetch = jsonFetch(502, { error: 'boom' }) as unknown as typeof fetch;
    const h = harness();
    act(() => { h.view.result.current.draft(); });
    await waitFor(() => { expect(h.view.result.current.status).toBe('error'); });
    expect(useAtelierStore.getState().toasts.length).toBeGreaterThan(0);
  });

  test('empty entries result toasts instead of silently doing nothing', async () => {
    globalThis.fetch = jsonFetch(200, { kind: 'entries', entries: [] }) as unknown as typeof fetch;
    const onEntries = mock((_: string[]) => undefined);
    const view = renderHook(
      () => useDraftList({ listId: 'l1', name: 'Colours', getCurrentValues: () => ['red'], onEntries }),
      { wrapper: wrapper() },
    );
    act(() => { view.result.current.draft(); });
    await waitFor(() => { expect(view.result.current.status).toBe('done'); });
    expect(onEntries).not.toHaveBeenCalled();
    expect(useAtelierStore.getState().toasts.length).toBeGreaterThan(0);
  });

  test('unmount aborts the in-flight request', async () => {
    let aborted = false;
    globalThis.fetch = mock((_u: string, init?: RequestInit) => {
      init?.signal?.addEventListener('abort', () => { aborted = true; });
      return new Promise<Response>(() => { /* never resolves */ });
    }) as unknown as typeof fetch;
    const h = harness();
    act(() => { h.view.result.current.draft(); });
    await waitFor(() => { expect(h.view.result.current.status).toBe('drafting'); });
    h.view.unmount();
    await waitFor(() => { expect(aborted).toBe(true); });
  });

  test('draft with empty values opens seed prompt without a fetch', () => {
    const f = jsonFetch(200, { kind: 'entries', entries: ['blue'] });
    globalThis.fetch = f as unknown as typeof fetch;
    const h = harness({ values: [] });
    act(() => { h.view.result.current.draft(); });
    expect(h.view.result.current.status).toBe('seed-prompt');
    expect(h.view.result.current.dialogMode).toBe('seed');
    expect(h.view.result.current.clarifyQuestion).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  test('submitDescription from seed prompt posts description with an empty existing snapshot', async () => {
    const upstream = draftFetch(() => ({ status: 200, body: { kind: 'entries', entries: ['blue'] } }));
    globalThis.fetch = upstream.fetch as unknown as typeof fetch;
    const h = harness({ values: [] });
    act(() => { h.view.result.current.draft(); });
    act(() => { h.view.result.current.submitDescription('cat breeds'); });
    await waitFor(() => { expect(h.view.result.current.status).toBe('done'); });
    expect(upstream.requests).toEqual([{ name: 'Colours', existing: [], description: 'cat breeds' }]);
    expect(h.onEntries).toHaveBeenCalledWith(['blue']);
    expect(h.view.result.current.dialogMode).toBeNull();
  });

  test('submitDescription from seed prompt preserves dialog mode and error on failure', async () => {
    globalThis.fetch = jsonFetch(502, { error: 'upstream unavailable' }) as unknown as typeof fetch;
    const h = harness({ values: [] });
    act(() => { h.view.result.current.draft(); });
    act(() => { h.view.result.current.submitDescription('cat breeds'); });
    await waitFor(() => { expect(h.view.result.current.status).toBe('error'); });
    expect(h.view.result.current.dialogMode).toBe('seed');
    // describeError sanitizes the raw server message to stable user-facing copy.
    expect(h.view.result.current.error).toBe('Something went wrong on our end. Please try again.');
  });

  test('retry after seeded failure reuses the empty existing snapshot', async () => {
    const upstream = draftFetch((_body, call) => {
      if (call === 1) return { status: 502, body: { error: 'upstream unavailable' } };
      return { status: 200, body: { kind: 'entries', entries: ['blue'] } };
    });
    globalThis.fetch = upstream.fetch as unknown as typeof fetch;
    const h = harness({ values: [] });
    act(() => { h.view.result.current.draft(); });
    act(() => { h.view.result.current.submitDescription('cat breeds'); });
    await waitFor(() => { expect(h.view.result.current.status).toBe('error'); });
    h.setValues(['mutated row']);
    act(() => { h.view.result.current.submitDescription('dog breeds'); });
    await waitFor(() => { expect(h.view.result.current.status).toBe('done'); });
    expect(upstream.requests).toEqual([
      { name: 'Colours', existing: [], description: 'cat breeds' },
      { name: 'Colours', existing: [], description: 'dog breeds' },
    ]);
  });

  test('cancelDialog during in-flight fetch suppresses late onSuccess entries', async () => {
    // Race: fetch resolves AFTER cancelDialog aborts the controller but
    // BEFORE onSuccess dispatches. The aborted signal must gate the late
    // result so entries the user explicitly cancelled never reach onEntries.
    let resolve: ((response: Response) => void) | null = null;
    globalThis.fetch = mock(() => new Promise<Response>((r) => { resolve = r; })) as unknown as typeof fetch;
    const onEntries = mock((_: string[]) => undefined);
    const h = harness({ values: [], onEntries });
    act(() => { h.view.result.current.draft(); });
    act(() => { h.view.result.current.submitDescription('cat breeds'); });
    await waitFor(() => { expect(h.view.result.current.status).toBe('drafting'); });
    act(() => { h.view.result.current.cancelDialog(); });
    expect(h.view.result.current.status).toBe('idle');
    expect(resolve).not.toBeNull();
    act(() => {
      resolve?.(draftResponse(200, { kind: 'entries', entries: ['blue', 'green'] }));
    });
    // Give the mutation a tick to settle.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(onEntries).not.toHaveBeenCalled();
    expect(h.view.result.current.status).toBe('idle');
    expect(h.view.result.current.dialogMode).toBeNull();
  });

  test('cancelDialog from seed prompt resets dialog state', () => {
    const h = harness({ values: [] });
    act(() => { h.view.result.current.draft(); });
    act(() => { h.view.result.current.cancelDialog(); });
    expect(h.view.result.current.status).toBe('idle');
    expect(h.view.result.current.dialogMode).toBeNull();
    expect(h.view.result.current.clarifyQuestion).toBeNull();
    expect(h.view.result.current.error).toBeNull();
  });

  test('draft while seed prompt is open is a no-op', () => {
    const f = jsonFetch(200, { kind: 'entries', entries: ['blue'] });
    globalThis.fetch = f as unknown as typeof fetch;
    const h = harness({ values: [] });
    act(() => { h.view.result.current.draft(); });
    act(() => { h.view.result.current.draft(); });
    expect(h.view.result.current.status).toBe('seed-prompt');
    expect(h.view.result.current.dialogMode).toBe('seed');
    expect(f).not.toHaveBeenCalled();
  });

  test('draft after seeded success can re-enter seed prompt when values are empty again', async () => {
    const upstream = draftFetch(() => ({ status: 200, body: { kind: 'entries', entries: ['blue'] } }));
    globalThis.fetch = upstream.fetch as unknown as typeof fetch;
    const h = harness({ values: [] });
    act(() => { h.view.result.current.draft(); });
    act(() => { h.view.result.current.submitDescription('cat breeds'); });
    await waitFor(() => { expect(h.view.result.current.status).toBe('done'); });
    act(() => { h.view.result.current.draft(); });
    expect(h.view.result.current.status).toBe('seed-prompt');
    expect(h.view.result.current.dialogMode).toBe('seed');
  });

  test('clarify submit failure preserves dialog mode, error, and question', async () => {
    const upstream = draftFetch((body) => {
      if (body.description) return { status: 502, body: { error: 'upstream unavailable' } };
      return { status: 200, body: { kind: 'clarify', question: 'which colours?' } };
    });
    globalThis.fetch = upstream.fetch as unknown as typeof fetch;
    const h = harness({ values: ['red'] });
    act(() => { h.view.result.current.draft(); });
    await waitFor(() => { expect(h.view.result.current.status).toBe('clarifying'); });
    act(() => { h.view.result.current.submitDescription('paint colours'); });
    await waitFor(() => { expect(h.view.result.current.status).toBe('error'); });
    expect(h.view.result.current.dialogMode).toBe('clarify');
    expect(h.view.result.current.clarifyQuestion).toBe('which colours?');
    // describeError sanitizes the raw server message to stable user-facing copy.
    expect(h.view.result.current.error).toBe('Something went wrong on our end. Please try again.');
  });

  test('clarify submit reuses the existing snapshot captured by the original draft call', async () => {
    const upstream = draftFetch((body) => {
      if (body.description) return { status: 200, body: { kind: 'entries', entries: ['green'] } };
      return { status: 200, body: { kind: 'clarify', question: 'which colours?' } };
    });
    globalThis.fetch = upstream.fetch as unknown as typeof fetch;
    const h = harness({ values: ['red'] });
    act(() => { h.view.result.current.draft(); });
    await waitFor(() => { expect(h.view.result.current.status).toBe('clarifying'); });
    h.setValues(['mutated row']);
    act(() => { h.view.result.current.submitDescription('paint colours'); });
    await waitFor(() => { expect(h.view.result.current.status).toBe('done'); });
    expect(upstream.requests).toEqual([
      { name: 'Colours', existing: ['red'] },
      { name: 'Colours', existing: ['red'], description: 'paint colours' },
    ]);
  });
});

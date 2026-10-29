import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useDraftTemplate } from './useDraftTemplate';
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
// plain JSON (4xx/5xx).
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

function harness(options: { body?: string } = {}) {
  let body = options.body ?? 'some existing body';
  const onBody = mock((_: string) => { return; });
  const onWarnings = mock((_: readonly string[]) => { return; });
  const view = renderHook(
    () => useDraftTemplate({
      name: 'My Template',
      getCurrentBody: () => body,
      onBody,
      onWarnings,
    }),
    { wrapper: wrapper() },
  );
  return {
    view,
    onBody,
    onWarnings,
    setBody: (next: string) => { body = next; },
  };
}

describe('useDraftTemplate', () => {
  test('sends the selected image context without fetching a separate model catalog', async () => {
    const previous = useAtelierStore.getState().draft;
    const modelId = 'gpt-image-2.5-sunburst';
    useAtelierStore.setState({ draft: { ...previous, modelId } });
    const requests: RequestInit[] = [];
    globalThis.fetch = mock((_url: unknown, init?: RequestInit) => {
      if (init) requests.push(init);
      return Promise.resolve(draftResponse(200, { kind: 'body', body: 'a painted landscape', warnings: [] }));
    }) as unknown as typeof fetch;
    const h = harness();
    try {
      act(() => { h.view.result.current.draft(); });
      await waitFor(() => { expect(h.view.result.current.status).toBe('done'); });
      expect(requests).toHaveLength(1);
      const body = requests[0]?.body;
      if (typeof body !== 'string') throw new Error('expected a string request body');
      expect(JSON.parse(body)).toMatchObject({ modelId });
    } finally {
      h.view.unmount();
      useAtelierStore.setState({ draft: previous });
    }
  });
  test('empty body + draft() → seed-prompt status, dialogMode=seed, no API call', () => {
    const f = jsonFetch(200, { kind: 'body', body: 'result', warnings: [] });
    globalThis.fetch = f as unknown as typeof fetch;
    const h = harness({ body: '' });
    act(() => { h.view.result.current.draft(); });
    expect(h.view.result.current.status).toBe('seed-prompt');
    expect(h.view.result.current.dialogMode).toBe('seed');
    expect(h.view.result.current.clarifyQuestion).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  test('non-empty body + draft() → drafting status, API called immediately', async () => {
    globalThis.fetch = mock(() => new Promise<Response>(() => { /* never resolves */ })) as unknown as typeof fetch;
    const h = harness({ body: 'some body text' });
    act(() => { h.view.result.current.draft(); });
    await waitFor(() => { expect(h.view.result.current.status).toBe('drafting'); });
  });

  test('cancelDialog from seed-prompt → idle, no API call', () => {
    const f = jsonFetch(200, { kind: 'body', body: 'result', warnings: [] });
    globalThis.fetch = f as unknown as typeof fetch;
    const h = harness({ body: '' });
    act(() => { h.view.result.current.draft(); });
    expect(h.view.result.current.status).toBe('seed-prompt');
    act(() => { h.view.result.current.cancelDialog(); });
    expect(h.view.result.current.status).toBe('idle');
    expect(h.view.result.current.dialogMode).toBeNull();
    expect(h.view.result.current.clarifyQuestion).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  test('body response → onBody fires; warnings non-empty → onWarnings fires; status done', async () => {
    globalThis.fetch = jsonFetch(200, { kind: 'body', body: 'drafted body', warnings: ['watch out'] }) as unknown as typeof fetch;
    const h = harness();
    act(() => { h.view.result.current.draft(); });
    await waitFor(() => { expect(h.view.result.current.status).toBe('done'); });
    expect(h.onBody).toHaveBeenCalledWith('drafted body');
    expect(h.onWarnings).toHaveBeenCalledWith(['watch out']);
    expect(h.view.result.current.dialogMode).toBeNull();
  });

  test('clarify response → dialogMode=clarify, clarifyQuestion set, status clarifying', async () => {
    globalThis.fetch = jsonFetch(200, { kind: 'clarify', question: 'What style?' }) as unknown as typeof fetch;
    const h = harness();
    act(() => { h.view.result.current.draft(); });
    await waitFor(() => { expect(h.view.result.current.status).toBe('clarifying'); });
    expect(h.view.result.current.dialogMode).toBe('clarify');
    expect(h.view.result.current.clarifyQuestion).toBe('What style?');
  });

  test('error response → status=error, toast fired', async () => {
    globalThis.fetch = jsonFetch(502, { error: 'upstream error' }) as unknown as typeof fetch;
    const h = harness();
    act(() => { h.view.result.current.draft(); });
    await waitFor(() => { expect(h.view.result.current.status).toBe('error'); });
    expect(useAtelierStore.getState().toasts.length).toBeGreaterThan(0);
  });

  test('abort on unmount does not throw', async () => {
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
});

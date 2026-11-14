import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ApiError } from '../api/client';
import type { TemplateReview } from '../components/PromptManager/templateReview';
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

function harness(options: { body?: string; commitChoice?: () => Promise<void> } = {}) {
  let body = options.body ?? 'some existing body';
  const onBody = mock((_: string) => { return; });
  const onWarnings = mock((_: readonly string[]) => { return; });
  const onReview = mock((_: TemplateReview) => { return; });
  const commitChoice = mock(options.commitChoice ?? (() => Promise.resolve()));
  const view = renderHook(
    () => useDraftTemplate({
      name: 'My Template',
      getCurrentBody: () => body,
      onBody,
      onReview,
      onWarnings,
      commitChoice,
    }),
    { wrapper: wrapper() },
  );
  return {
    view,
    onBody,
    onReview,
    onWarnings,
    commitChoice,
    setBody: (next: string) => { body = next; },
  };
}

function sentBodies(f: ReturnType<typeof mock>): unknown[] {
  return f.mock.calls.map((call) => {
    const init = (call as unknown[])[1] as RequestInit | undefined;
    return typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
  });
}

describe('useDraftTemplate', () => {
  test('sends the selected image context without fetching a separate model catalog', async () => {
    const previous = useAtelierStore.getState().draft;
    const modelId = 'gpt-image-2.6-sunburst';
    useAtelierStore.setState({ draft: { ...previous, modelId } });
    const requests: RequestInit[] = [];
    globalThis.fetch = mock((_url: unknown, init?: RequestInit) => {
      if (init) requests.push(init);
      return Promise.resolve(draftResponse(200, { kind: 'body', body: 'a painted landscape', warnings: [] }));
    }) as unknown as typeof fetch;
    const h = harness();
    try {
      act(() => { h.view.result.current.draft(); });
      act(() => { h.view.result.current.submitDescription('paint it'); });
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
    expect(h.commitChoice).not.toHaveBeenCalled();
  });

  test('non-empty body + draft() → rework-prompt status, dialogMode=rework, no API call', () => {
    const f = jsonFetch(200, { kind: 'body', body: 'result', warnings: [] });
    globalThis.fetch = f as unknown as typeof fetch;
    const h = harness({ body: 'some body text' });
    act(() => { h.view.result.current.draft(); });
    expect(h.view.result.current.status).toBe('rework-prompt');
    expect(h.view.result.current.dialogMode).toBe('rework');
    expect(f).not.toHaveBeenCalled();
    expect(h.commitChoice).not.toHaveBeenCalled();
  });

  test('a rework submit saves the choice first, then sends the body untrimmed with the change instructions', async () => {
    const order: string[] = [];
    const f = mock((_url: unknown, _init?: RequestInit) => {
      order.push('draft');
      return Promise.resolve(draftResponse(200, { kind: 'body', body: 'revised', warnings: [] }));
    });
    globalThis.fetch = f as unknown as typeof fetch;
    const h = harness({ body: '  some body text  ', commitChoice: () => { order.push('commit'); return Promise.resolve(); } });
    act(() => { h.view.result.current.draft(); });
    act(() => { h.view.result.current.submitDescription(' moodier lighting '); });
    await waitFor(() => { expect(h.view.result.current.status).toBe('drafting'); });
    await waitFor(() => { expect(h.view.result.current.status).toBe('done'); });
    expect(order).toEqual(['commit', 'draft']);
    expect(sentBodies(f)).toEqual([{ name: 'My Template', existingBody: '  some body text  ', description: 'moodier lighting' }]);
    expect(h.onBody).toHaveBeenCalledWith('revised');
  });

  test('a rejected save shows inline in the dialog and sends no draft', async () => {
    const f = jsonFetch(200, { kind: 'body', body: 'revised', warnings: [] });
    globalThis.fetch = f as unknown as typeof fetch;
    const h = harness({ commitChoice: () => Promise.reject(new ApiError(409, 'That model is offline right now.')) });
    act(() => { h.view.result.current.draft(); });
    act(() => { h.view.result.current.submitDescription('moodier'); });
    await waitFor(() => { expect(h.view.result.current.status).toBe('error'); });
    expect(h.view.result.current.error).toBe('That model is offline right now.');
    expect(h.view.result.current.dialogMode).toBe('rework');
    expect(f).not.toHaveBeenCalled();
    expect(useAtelierStore.getState().toasts).toHaveLength(0);
  });

  test('cancel while the choice is saving sends no draft', async () => {
    const f = jsonFetch(200, { kind: 'body', body: 'revised', warnings: [] });
    globalThis.fetch = f as unknown as typeof fetch;
    let finishSave: () => void = () => undefined;
    const h = harness({ commitChoice: () => new Promise<void>((resolve) => { finishSave = resolve; }) });
    act(() => { h.view.result.current.draft(); });
    act(() => { h.view.result.current.submitDescription('moodier'); });
    await waitFor(() => { expect(h.commitChoice).toHaveBeenCalledTimes(1); });
    act(() => { h.view.result.current.cancelDialog(); });
    await act(async () => { finishSave(); await Promise.resolve(); });
    await waitFor(() => { expect(h.view.result.current.status).toBe('idle'); });
    expect(f).not.toHaveBeenCalled();
    expect(h.onBody).not.toHaveBeenCalled();
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
    expect(h.commitChoice).not.toHaveBeenCalled();
  });

  test('body response → onBody fires; warnings non-empty → onWarnings fires; status done', async () => {
    globalThis.fetch = jsonFetch(200, { kind: 'body', body: 'drafted body', warnings: ['watch out'] }) as unknown as typeof fetch;
    const h = harness();
    act(() => { h.view.result.current.draft(); });
    act(() => { h.view.result.current.submitDescription('anything'); });
    await waitFor(() => { expect(h.view.result.current.status).toBe('done'); });
    expect(h.onBody).toHaveBeenCalledWith('drafted body');
    expect(h.onWarnings).toHaveBeenCalledWith(['watch out']);
    expect(h.view.result.current.dialogMode).toBeNull();
  });

  test('clarify response → dialogMode=clarify, clarifyQuestion set, status clarifying', async () => {
    globalThis.fetch = jsonFetch(200, { kind: 'clarify', question: 'What style?' }) as unknown as typeof fetch;
    const h = harness({ body: '' });
    act(() => { h.view.result.current.draft(); });
    act(() => { h.view.result.current.submitDescription('a portrait'); });
    await waitFor(() => { expect(h.view.result.current.status).toBe('clarifying'); });
    expect(h.view.result.current.dialogMode).toBe('clarify');
    expect(h.view.result.current.clarifyQuestion).toBe('What style?');
  });

  test('error response → status=error, shown inline in the open dialog without a toast', async () => {
    globalThis.fetch = jsonFetch(502, { error: 'upstream error' }) as unknown as typeof fetch;
    const h = harness();
    act(() => { h.view.result.current.draft(); });
    act(() => { h.view.result.current.submitDescription('anything'); });
    await waitFor(() => { expect(h.view.result.current.status).toBe('error'); });
    expect(h.view.result.current.error).not.toBeNull();
    expect(h.view.result.current.dialogMode).toBe('rework');
    expect(useAtelierStore.getState().toasts).toHaveLength(0);
  });

  test('abort on unmount does not throw', async () => {
    let aborted = false;
    globalThis.fetch = mock((_u: string, init?: RequestInit) => {
      init?.signal?.addEventListener('abort', () => { aborted = true; });
      return new Promise<Response>(() => { /* never resolves */ });
    }) as unknown as typeof fetch;
    const h = harness();
    act(() => { h.view.result.current.draft(); });
    act(() => { h.view.result.current.submitDescription('anything'); });
    await waitFor(() => { expect(h.view.result.current.status).toBe('drafting'); });
    await waitFor(() => { expect(globalThis.fetch).toHaveBeenCalledTimes(1); });
    h.view.unmount();
    await waitFor(() => { expect(aborted).toBe(true); });
  });

  test('a blank body is sent as an empty string', async () => {
    const f = jsonFetch(200, { kind: 'body', body: 'seeded', warnings: [] });
    globalThis.fetch = f as unknown as typeof fetch;
    const h = harness({ body: '  \n  ' });
    act(() => { h.view.result.current.draft(); });
    expect(h.view.result.current.dialogMode).toBe('seed');
    act(() => { h.view.result.current.submitDescription('a portrait'); });
    await waitFor(() => { expect(h.view.result.current.status).toBe('done'); });
    expect(sentBodies(f)).toEqual([{ name: 'My Template', existingBody: '', description: 'a portrait' }]);
    expect(h.onBody).toHaveBeenCalledWith('seeded');
    expect(h.onReview).not.toHaveBeenCalled();
  });
});

describe('useDraftTemplate changes payload', () => {
  const base = 'A red coat in soft light.\n';
  const changes = (overrides: Record<string, unknown> = {}) => ({
    kind: 'changes',
    baseLength: base.length,
    changes: [{ id: 0, start: 2, end: 5, replace: 'blue', why: 'Bluer.' }],
    unplaced: [],
    summary: 'Cooler.',
    warnings: [],
    ...overrides,
  });

  async function submit(response: unknown) {
    globalThis.fetch = jsonFetch(200, response) as unknown as typeof fetch;
    const h = harness({ body: base });
    act(() => { h.view.result.current.draft(); });
    act(() => { h.view.result.current.submitDescription(' bluer '); });
    await waitFor(() => { expect(['done', 'rework-prompt']).toContain(h.view.result.current.status); });
    return h;
  }

  test('placed changes become a review with the description as instructions', async () => {
    const h = await submit(changes());
    expect(h.view.result.current.status).toBe('done');
    expect(h.view.result.current.dialogMode).toBeNull();
    expect(h.onBody).not.toHaveBeenCalled();
    expect(h.onWarnings).not.toHaveBeenCalled();
    expect(h.onReview).toHaveBeenCalledTimes(1);
    expect(h.onReview.mock.calls[0]?.[0]).toEqual({
      base,
      changes: [{ id: 0, start: 2, end: 5, replace: 'blue', why: 'Bluer.' }],
      unplaced: [],
      summary: 'Cooler.',
      instructions: 'bluer',
      rejected: [],
    });
  });

  test('warnings of a changes payload reach onWarnings', async () => {
    const h = await submit(changes({ warnings: ['Removed {{x}}.'] }));
    expect(h.onWarnings).toHaveBeenCalledWith(['Removed {{x}}.']);
    expect(h.onReview).toHaveBeenCalledTimes(1);
  });

  test('no changes and nothing unplaced keeps the dialog open with the summary', async () => {
    const h = await submit(changes({ changes: [], summary: 'Already moody.' }));
    expect(h.view.result.current.status).toBe('rework-prompt');
    expect(h.view.result.current.dialogMode).toBe('rework');
    expect(h.view.result.current.notice).toBe('Already moody.');
    expect(h.onReview).not.toHaveBeenCalled();
    expect(h.onBody).not.toHaveBeenCalled();
  });

  test('no changes, nothing unplaced and no summary shows the nothing-to-change note', async () => {
    const h = await submit(changes({ changes: [], summary: null }));
    expect(h.view.result.current.notice).toBe('The model found nothing to change.');
  });

  test('no changes with unplaced edits shows the did-not-line-up note', async () => {
    const h = await submit(changes({
      changes: [],
      summary: 'Bluer.',
      unplaced: [{ find: 'velvet', replace: 'silk', why: '', reason: 'missing' }],
      warnings: ['w'],
    }));
    expect(h.view.result.current.notice).toBe("The model's edits did not line up with the template text. Try again, or pick another model.");
    expect(h.view.result.current.dialogMode).toBe('rework');
    expect(h.onWarnings).toHaveBeenCalledWith(['w']);
    expect(h.onReview).not.toHaveBeenCalled();
  });
});

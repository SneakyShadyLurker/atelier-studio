import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { VariableList } from '@atelier/shared';
import { PromptDraftStore } from '../components/PromptManager/draftStore';
import { useAtelierStore } from '../store/atelier';
import { useDraftNewList } from './useDraftNewList';

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

const CREATED: VariableList = { id: 'list-new', name: 'scarf', options: [], sortOrder: 0, createdAt: 1, updatedAt: 1 };
const ANSWER = { kind: 'list', name: 'scarf', options: [{ value: 'a red scarf', weight: 1 }, { value: 'a blue scarf', weight: 4 }] };

function server(createStatus = 201) {
  const order: string[] = [];
  globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/prompts/lists/draft')) {
      order.push('draft');
      return Promise.resolve(new Response(`event: done\ndata: ${JSON.stringify(ANSWER)}\n\n`, {
        status: 200, headers: { 'Content-Type': 'text/event-stream' },
      }));
    }
    if (url.endsWith('/prompts/lists') && init?.method === 'POST') {
      order.push('create');
      return Promise.resolve(createStatus === 201
        ? Response.json(CREATED, { status: 201 })
        : Response.json({ error: 'A list with that name already exists' }, { status: createStatus }));
    }
    return Promise.resolve(Response.json({ templates: [], variableLists: [CREATED], dimensions: [] }));
  }) as unknown as typeof fetch;
  return order;
}

function harness() {
  const store = new PromptDraftStore();
  const onCreated = mock((_: VariableList) => undefined);
  const commitChoice = mock(() => Promise.resolve());
  const view = renderHook(() => useDraftNewList({ store, commitChoice, onCreated }), { wrapper: wrapper() });
  return { store, onCreated, commitChoice, view };
}

describe('useDraftNewList', () => {
  test('creating a list seeds its drafted rows as an unsaved draft and selects it, then toasts', async () => {
    const order = server();
    const h = harness();
    act(() => { h.view.result.current.draft(); });
    expect(h.view.result.current.dialogMode).toBe('seed');
    const revision = h.store.getListSeedRevision();
    act(() => { h.view.result.current.submitDescription('scarves'); });
    await waitFor(() => { expect(h.view.result.current.status).toBe('done'); });
    expect(order).toEqual(['draft', 'create']);
    expect(h.commitChoice).toHaveBeenCalledTimes(1);
    expect(h.onCreated).toHaveBeenCalledWith(CREATED);
    const draft = h.store.getList('list-new');
    expect(draft?.name).toBe('scarf');
    expect(draft?.options.map((row) => [row.value, row.weight, row.weightInput, row.tagIds.length, row.key.startsWith('draft:')]))
      .toEqual([['a red scarf', 1, '1', 0, true], ['a blue scarf', 4, '4', 0, true]]);
    expect(h.store.getListSeedRevision()).toBe(revision + 1);
    expect(useAtelierStore.getState().toasts.some((toast) => toast.text === 'Variable list created')).toBe(true);
    expect(h.view.result.current.dialogMode).toBeNull();
  });

  test('a rejected create keeps the dialog busy until it settles, then shows the error; nothing is seeded', async () => {
    server(409);
    const h = harness();
    act(() => { h.view.result.current.draft(); });
    act(() => { h.view.result.current.submitDescription('scarves'); });
    expect(h.view.result.current.status).toBe('drafting');
    await waitFor(() => { expect(h.view.result.current.status).toBe('error'); });
    expect(h.view.result.current.error).toBe('A list with that name already exists');
    expect(h.view.result.current.dialogMode).toBe('seed');
    expect(h.store.getList('list-new')).toBeUndefined();
    expect(h.onCreated).not.toHaveBeenCalled();
  });

  test('a blank description sends nothing', () => {
    const order = server();
    const h = harness();
    act(() => { h.view.result.current.draft(); });
    act(() => { h.view.result.current.submitDescription('  '); });
    expect(order).toEqual([]);
  });
});

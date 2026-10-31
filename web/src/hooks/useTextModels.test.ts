import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type PropsWithChildren } from 'react';
import type { TextModelsResponse } from '@atelier/shared';
import { TEXT_TASKS } from '@atelier/shared';
import { textModelKeys } from '../api/textModels';
import { shouldDehydrateQuery } from '../lib/persister';
import { textModelLabel, usePendingTaskPicks, useSetTaskPick, useTextModels } from './useTextModels';

const originalFetch = globalThis.fetch;

const SETTINGS: TextModelsResponse = {
  models: [
    { id: 'kimi', displayName: 'Kimi K3', providerName: 'CLIProxyAPI', vision: true, reasoningLevels: ['low', 'high', 'max'], status: 'available' },
    { id: 'grok', displayName: 'Grok 4.7', providerName: 'CLIProxyAPI', vision: false, reasoningLevels: ['low', 'medium'], status: 'available' },
    { id: 'scout', displayName: 'Llama 4 Scout', providerName: 'Ollama', vision: true, reasoningLevels: [], status: 'available' },
  ],
  tasks: TEXT_TASKS.map((task) => (task === 'enhance'
    ? { task, pick: 'kimi', effort: 'high', effectiveModelId: 'kimi', pickState: 'active' }
    : { task, effectiveModelId: 'kimi' })),
  defaults: { default: 'kimi', byTask: {} },
  writers: {},
};

function setup(put: (init: RequestInit) => Promise<Response>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  // The settled save refetches; GET serves whatever the server last stored.
  let stored = SETTINGS;
  const fetchMock = mock((_input: RequestInfo | URL, init?: RequestInit) => (init?.method === 'PUT'
    ? put(init)
    : Promise.resolve(Response.json(stored))));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);
  const hook = renderHook(() => ({
    settings: useTextModels(),
    setPick: useSetTaskPick(),
    pending: usePendingTaskPicks(),
  }), { wrapper });
  const store = (next: TextModelsResponse) => { stored = next; };
  return { client, fetchMock, hook, store };
}

function enhanceRow(client: QueryClient) {
  return client.getQueryData<TextModelsResponse>(textModelKeys.all())?.tasks.find((row) => row.task === 'enhance');
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

describe('useTextModels', () => {
  test('reads the user text-model settings', async () => {
    const { fetchMock, hook } = setup(() => Promise.resolve(Response.json(SETTINGS)));
    await waitFor(() => { expect(hook.result.current.settings.data).toEqual(SETTINGS); });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/text-models');
  });

  test('is never persisted to IndexedDB, so live model status cannot hydrate stale', async () => {
    const { client, hook } = setup(() => Promise.resolve(Response.json(SETTINGS)));
    await waitFor(() => { expect(hook.result.current.settings.isSuccess).toBe(true); });
    const query = client.getQueryCache().find({ queryKey: textModelKeys.all() });
    if (query === undefined) throw new Error('text-models query missing');
    expect(shouldDehydrateQuery(query)).toBe(false);
  });
});

describe('useSetTaskPick', () => {
  test('sends the pick and omits an unset effort', async () => {
    const { fetchMock, hook } = setup(() => Promise.resolve(Response.json(SETTINGS)));
    await waitFor(() => { expect(hook.result.current.settings.isSuccess).toBe(true); });
    await act(async () => { await hook.result.current.setPick.mutateAsync({ task: 'ai-fill', modelId: 'grok' }); });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/text-models/tasks/ai-fill',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ modelId: 'grok' }) }),
    );
  });

  test('writes optimistically, locks the task, then takes the server response', async () => {
    let resolvePut: ((response: Response) => void) | undefined;
    const { client, hook, store } = setup(() => new Promise<Response>((resolve) => { resolvePut = resolve; }));
    await waitFor(() => { expect(hook.result.current.settings.isSuccess).toBe(true); });

    act(() => { void hook.result.current.setPick.mutateAsync({ task: 'enhance', modelId: 'grok' }); });
    // 'high' is not one of Grok's levels, so the optimistic row drops it.
    await waitFor(() => {
      expect(enhanceRow(client)).toEqual({ task: 'enhance', pick: 'grok', effectiveModelId: 'grok', pickState: 'active' });
    });
    expect([...hook.result.current.pending]).toEqual(['enhance']);

    const authoritative: TextModelsResponse = {
      ...SETTINGS,
      tasks: SETTINGS.tasks.map((row) => (row.task === 'enhance'
        ? { task: 'enhance', pick: 'grok', effort: 'medium', effectiveModelId: 'grok', pickState: 'active' }
        : row)),
    };
    store(authoritative);
    resolvePut?.(Response.json(authoritative));
    await waitFor(() => { expect(enhanceRow(client)?.effort).toBe('medium'); });
    await waitFor(() => { expect(hook.result.current.pending.size).toBe(0); });
  });

  test('a model change without an effort keeps the stored effort while the new model offers it', async () => {
    let resolvePut: ((response: Response) => void) | undefined;
    const { client, hook } = setup(() => new Promise<Response>((resolve) => { resolvePut = resolve; }));
    await waitFor(() => { expect(hook.result.current.settings.isSuccess).toBe(true); });
    // Kimi at 'low'; Grok offers 'low' too.
    client.setQueryData<TextModelsResponse>(textModelKeys.all(), {
      ...SETTINGS,
      tasks: SETTINGS.tasks.map((row) => (row.task === 'enhance' ? { ...row, effort: 'low' } : row)),
    });

    act(() => { void hook.result.current.setPick.mutateAsync({ task: 'enhance', modelId: 'grok' }); });
    await waitFor(() => {
      expect(enhanceRow(client)).toEqual({ task: 'enhance', pick: 'grok', effort: 'low', effectiveModelId: 'grok', pickState: 'active' });
    });
    resolvePut?.(Response.json(SETTINGS));
    await waitFor(() => { expect(hook.result.current.pending.size).toBe(0); });
  });

  test('keeps an effort the new model accepts and clears the pick back to the default', async () => {
    const pending: (() => void)[] = [];
    const { client, hook } = setup(() => new Promise<Response>((resolve) => {
      pending.push(() => { resolve(Response.json(SETTINGS)); });
    }));
    await waitFor(() => { expect(hook.result.current.settings.isSuccess).toBe(true); });

    act(() => { void hook.result.current.setPick.mutateAsync({ task: 'enhance', modelId: 'kimi', effort: 'max' }); });
    await waitFor(() => { expect(enhanceRow(client)?.effort).toBe('max'); });
    pending.shift()?.();
    await waitFor(() => { expect(hook.result.current.pending.size).toBe(0); });

    act(() => { void hook.result.current.setPick.mutateAsync({ task: 'enhance', modelId: null }); });
    await waitFor(() => { expect(enhanceRow(client)).toEqual({ task: 'enhance', effectiveModelId: 'kimi' }); });
    pending.shift()?.();
  });

  test('clearing a pick optimistically falls back past an offline task assignment', async () => {
    let resolvePut: ((response: Response) => void) | undefined;
    const { client, hook } = setup(() => new Promise<Response>((resolve) => { resolvePut = resolve; }));
    await waitFor(() => { expect(hook.result.current.settings.isSuccess).toBe(true); });
    // Enhance is assigned to Grok, which is offline; the resolver would serve the Kimi default.
    client.setQueryData<TextModelsResponse>(textModelKeys.all(), {
      ...SETTINGS,
      models: SETTINGS.models.map((model) => (model.id === 'grok' ? { ...model, status: 'offline' } : model)),
      defaults: { default: 'kimi', byTask: { enhance: 'grok' } },
    });

    act(() => { void hook.result.current.setPick.mutateAsync({ task: 'enhance', modelId: null }); });
    await waitFor(() => { expect(enhanceRow(client)).toEqual({ task: 'enhance', effectiveModelId: 'kimi' }); });
    resolvePut?.(Response.json(SETTINGS));
    await waitFor(() => { expect(hook.result.current.pending.size).toBe(0); });
  });

  test('rolls back when the save fails', async () => {
    const { client, hook } = setup(() => Promise.resolve(Response.json({ error: 'model is offline' }, { status: 400 })));
    await waitFor(() => { expect(hook.result.current.settings.isSuccess).toBe(true); });

    let failure: unknown;
    await act(async () => {
      await hook.result.current.setPick.mutateAsync({ task: 'enhance', modelId: 'scout' }).catch((error: unknown) => { failure = error; });
    });
    expect(failure).toBeInstanceOf(Error);
    expect(enhanceRow(client)).toEqual(SETTINGS.tasks[0]);
  });
});

describe('textModelLabel', () => {
  test('selects a model display name by id', () => {
    expect(textModelLabel('scout')(SETTINGS)).toBe('Llama 4 Scout');
    expect(textModelLabel('gone')(SETTINGS)).toBeUndefined();
  });
});

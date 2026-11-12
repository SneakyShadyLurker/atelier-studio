import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { TextModelsResponse } from '@atelier/shared';
import { TEXT_TASKS } from '@atelier/shared';
import { useTaskModelChoice } from './useTaskModelChoice';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

const LISTING: TextModelsResponse = {
  models: [
    { id: 'kimi', displayName: 'Kimi K3', providerName: 'CLIProxyAPI', vision: true, reasoningLevels: ['low', 'high', 'max'], status: 'available' },
    { id: 'grok', displayName: 'Grok 4.7', providerName: 'CLIProxyAPI', vision: false, reasoningLevels: ['low', 'medium'], status: 'available' },
    { id: 'scout', displayName: 'Llama 4 Scout', providerName: 'Ollama', vision: true, reasoningLevels: [], status: 'available' },
    { id: 'gone', displayName: 'Gone', providerName: 'Ollama', vision: false, reasoningLevels: [], status: 'offline' },
  ],
  tasks: TEXT_TASKS.map((task) => (task === 'template-draft'
    ? { task, pick: 'kimi', effort: 'high', effectiveModelId: 'kimi', pickState: 'active' }
    : { task, effectiveModelId: 'kimi' })),
  defaults: { default: 'kimi', byTask: {} },
  writers: { 'img-pref': 'grok', 'img-lock': 'scout' },
  lockedWriters: ['img-lock'],
};

function setup(listing: unknown, put: (init: RequestInit) => Promise<Response> = () => Promise.resolve(Response.json(listing)), initial: { imageModelId?: string } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const fetchMock = mock((_input: RequestInfo | URL, init?: RequestInit) => (init?.method === 'PUT'
    ? put(init)
    : Promise.resolve(Response.json(listing))));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const hook = renderHook(() => useTaskModelChoice('template-draft', initial.imageModelId), { wrapper });
  const puts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT').map(([, init]) => (typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined));
  return { hook, puts };
}

describe('useTaskModelChoice', () => {
  test('starts from the saved pick and effort, with provider groups and the default name', async () => {
    const { hook } = setup(LISTING);
    await waitFor(() => { expect(hook.result.current.state.kind).toBe('ready'); });
    expect(hook.result.current.modelId).toBe('kimi');
    expect(hook.result.current.effort).toBe('high');
    expect(hook.result.current.effortLevels).toEqual(['low', 'high', 'max']);
    expect(hook.result.current.groups.map((g) => g.providerName)).toEqual(['CLIProxyAPI', 'Ollama']);
    expect(hook.result.current.defaultName).toBe('Kimi K3');
  });

  test('an offline pick stays selected, with no effort, and an untouched dialog saves nothing', async () => {
    const offline: TextModelsResponse = {
      ...LISTING,
      tasks: [{ task: 'template-draft', pick: 'gone', effectiveModelId: 'kimi', pickState: 'offline' }],
    };
    const { hook, puts } = setup(offline);
    await waitFor(() => { expect(hook.result.current.state.kind).toBe('ready'); });
    // Shown as the pick it is, so "Use default" is a different value to choose.
    expect(hook.result.current.modelId).toBe('gone');
    expect(hook.result.current.effortLevels).toBeNull();
    // Unchanged: committing must not clobber the stored offline pick.
    await act(async () => { await hook.result.current.commit(); });
    expect(puts()).toEqual([]);
  });

  test("choosing 'Use default' directly over a stored offline pick clears that pick", async () => {
    const offline: TextModelsResponse = {
      ...LISTING,
      tasks: [{ task: 'template-draft', pick: 'gone', effectiveModelId: 'kimi', pickState: 'offline' }],
    };
    const { hook, puts } = setup(offline);
    await waitFor(() => { expect(hook.result.current.state.kind).toBe('ready'); });
    act(() => { hook.result.current.setModelId(''); });
    expect(hook.result.current.modelId).toBe('');
    await act(async () => { await hook.result.current.commit(); });
    expect(puts()).toEqual([{ modelId: null, effort: null }]);
  });

  test("a pick the listing no longer names starts at 'Use default'", async () => {
    const unlisted: TextModelsResponse = {
      ...LISTING,
      tasks: [{ task: 'template-draft', pick: 'removed', effectiveModelId: 'kimi' }],
    };
    const { hook, puts } = setup(unlisted);
    await waitFor(() => { expect(hook.result.current.state.kind).toBe('ready'); });
    expect(hook.result.current.modelId).toBe('');
    await act(async () => { await hook.result.current.commit(); });
    expect(puts()).toEqual([]);
    // Trying another model and returning to the default is an explicit choice:
    // it clears the stored pick, which would win again if the model came back.
    act(() => { hook.result.current.setModelId('kimi'); });
    act(() => { hook.result.current.setModelId(''); });
    await act(async () => { await hook.result.current.commit(); });
    expect(puts()).toEqual([{ modelId: null, effort: null }]);
  });

  test("an image model's preferred writer names the default", async () => {
    const { hook } = setup(LISTING, undefined, { imageModelId: 'img-pref' });
    await waitFor(() => { expect(hook.result.current.state.kind).toBe('ready'); });
    expect(hook.result.current.defaultName).toBe('Grok 4.7');
  });

  test('switching model drops an effort it does not offer and keeps one it does', async () => {
    const { hook } = setup(LISTING);
    await waitFor(() => { expect(hook.result.current.state.kind).toBe('ready'); });
    act(() => { hook.result.current.setModelId('grok'); });
    expect(hook.result.current.effort).toBe('default');
    act(() => { hook.result.current.setEffort('low'); });
    act(() => { hook.result.current.setModelId('kimi'); });
    expect(hook.result.current.effort).toBe('low');
    act(() => { hook.result.current.setModelId(''); });
    expect(hook.result.current.effort).toBe('default');
    expect(hook.result.current.effortLevels).toBeNull();
  });

  test('an offline model is not selectable', async () => {
    const { hook } = setup(LISTING);
    await waitFor(() => { expect(hook.result.current.state.kind).toBe('ready'); });
    act(() => { hook.result.current.setModelId('gone'); });
    expect(hook.result.current.modelId).toBe('kimi');
  });

  test('commit saves only a changed choice', async () => {
    const { hook, puts } = setup(LISTING);
    await waitFor(() => { expect(hook.result.current.state.kind).toBe('ready'); });
    await act(async () => { await hook.result.current.commit(); });
    expect(puts()).toEqual([]);
    act(() => { hook.result.current.setModelId('grok'); });
    act(() => { hook.result.current.setEffort('medium'); });
    await act(async () => { await hook.result.current.commit(); });
    expect(puts()).toEqual([{ modelId: 'grok', effort: 'medium' }]);
  });

  test("'Use default' saves a cleared pick", async () => {
    const { hook, puts } = setup(LISTING);
    await waitFor(() => { expect(hook.result.current.state.kind).toBe('ready'); });
    act(() => { hook.result.current.setModelId(''); });
    await act(async () => { await hook.result.current.commit(); });
    expect(puts()).toEqual([{ modelId: null, effort: null }]);
  });

  test('a failed save rejects the commit', async () => {
    const { hook } = setup(LISTING, () => Promise.resolve(Response.json({ error: 'nope' }, { status: 500 })));
    await waitFor(() => { expect(hook.result.current.state.kind).toBe('ready'); });
    act(() => { hook.result.current.setModelId('grok'); });
    let caught: unknown;
    await act(async () => { await hook.result.current.commit().catch((error: unknown) => { caught = error; }); });
    expect(caught).toBeInstanceOf(Error);
  });

  test('a locked writer reports its name and commit saves nothing', async () => {
    const { hook, puts } = setup(LISTING, undefined, { imageModelId: 'img-lock' });
    await waitFor(() => { expect(hook.result.current.state).toEqual({ kind: 'locked', writerName: 'Llama 4 Scout' }); });
    act(() => { hook.result.current.setModelId('grok'); });
    await act(async () => { await hook.result.current.commit(); });
    expect(puts()).toEqual([]);
  });

  test('a listing without the models array is unavailable and saves nothing', async () => {
    const { hook, puts } = setup({ ok: true });
    await waitFor(() => { expect(hook.result.current.state.kind).toBe('unavailable'); });
    expect(hook.result.current.modelId).toBe('');
    await act(async () => { await hook.result.current.commit(); });
    expect(puts()).toEqual([]);
  });

  test('a listing without lockedWriters is read as nothing locked', async () => {
    const { lockedWriters: _dropped, ...older } = LISTING;
    const { hook } = setup(older, undefined, { imageModelId: 'img-lock' });
    await waitFor(() => { expect(hook.result.current.state.kind).toBe('ready'); });
  });

  test('reset discards the local edits', async () => {
    const { hook } = setup(LISTING);
    await waitFor(() => { expect(hook.result.current.state.kind).toBe('ready'); });
    act(() => { hook.result.current.setModelId('grok'); });
    expect(hook.result.current.modelId).toBe('grok');
    act(() => { hook.result.current.reset(); });
    expect(hook.result.current.modelId).toBe('kimi');
    expect(hook.result.current.effort).toBe('high');
  });
});

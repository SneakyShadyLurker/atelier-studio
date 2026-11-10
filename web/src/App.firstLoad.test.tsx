import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider, type PersistedClient, type Persister } from '@tanstack/react-query-persist-client';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, mock, test } from 'bun:test';
import type { Batch, Model } from '@atelier/shared';
import { useAtelierStore, initialAtelierState } from './store/atelier';

const { default: App } = await import('./App');
const originalFetch = globalThis.fetch;
const originalMatchMedia = window.matchMedia.bind(window);

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  window.matchMedia = originalMatchMedia;
  useAtelierStore.setState(initialAtelierState, true);
});

const INVITATION = 'What would you like to make?';
const model: Model = { id: 'm', name: 'M', backend: 'cloud', tag: 'cloud', latency: 'fast', pool: 'shared', supportedRatios: ['1:1'], concurrencyCapPerUser: 1, maxCountPerBatch: 1 };
const batch: Batch = {
  id: 'batch-1',
  prompt: 'A restored batch',
  ratio: '1:1',
  modelId: model.id,
  modelLabel: model.name,
  createdAt: 1_000,
  collectionId: null,
  pinned: false,
  status: 'done',
  tiles: [{ id: 'tile-1', seed: 1, status: 'done', url: '/api/img/tile-1', ext: 'png', mime: 'image/png', completedAt: 1_000 }],
};

function installEnvironment(history: () => Promise<Response>): void {
  useAtelierStore.setState(initialAtelierState, true);
  if (window.location.origin === 'null') window.location.href = 'http://localhost/';
  window.history.replaceState({}, '', 'http://localhost/');
  window.matchMedia = mock((media: string) => ({ matches: false, media, onchange: null, addEventListener: mock(), removeEventListener: mock(), addListener: mock(), removeListener: mock(), dispatchEvent: () => true }));
  globalThis.fetch = mock((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/models')) return Promise.resolve(Response.json([model]));
    if (url.endsWith('/collections')) return Promise.resolve(Response.json({ items: [], summary: { totalCount: 1, pinnedCount: 0, unsortedCount: 1, archivedTotalCount: 0, archivedPinnedCount: 0, archivedUnsortedCount: 0 } }));
    if (url.endsWith('/prompts')) return Promise.resolve(Response.json({ templates: [], variableLists: [], dimensions: [] }));
    if (url.includes('/history')) return history();
    return Promise.resolve(Response.json({}));
  }) as unknown as typeof fetch;
}

function feedText(): string {
  return document.querySelector('[data-testid="feed"]')?.textContent ?? '';
}

test('a reload shows the loading plate, never the invitation, while the persisted cache restores', async () => {
  const history = Promise.withResolvers<Response>();
  installEnvironment(() => history.promise);
  const restored = Promise.withResolvers<PersistedClient | undefined>();
  const persister: Persister = {
    persistClient: () => Promise.resolve(),
    restoreClient: () => restored.promise,
    removeClient: () => Promise.resolve(),
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<PersistQueryClientProvider client={client} persistOptions={{ persister }}><App /></PersistQueryClientProvider>);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

  // Restoring: the history query is pending and idle.
  expect(feedText()).toContain('Loading history…');
  expect(screen.queryByText(INVITATION)).toBeNull();

  // Nothing persisted: the restore ends and the first history read starts.
  await act(async () => { restored.resolve(undefined); await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(feedText()).toContain('Loading history…');
  expect(screen.queryByText(INVITATION)).toBeNull();

  await act(async () => { history.resolve(Response.json({ items: [batch], nextCursor: null })); await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect((await screen.findAllByText('A restored batch')).length).toBeGreaterThan(0);
  expect(screen.queryByText(INVITATION)).toBeNull();
  expect(feedText()).not.toContain('Loading history…');
  client.clear();
});

test('an empty first read still shows the invitation once it settles', async () => {
  installEnvironment(() => Promise.resolve(Response.json({ items: [], nextCursor: null })));
  const persister: Persister = {
    persistClient: () => Promise.resolve(),
    restoreClient: () => Promise.resolve(undefined),
    removeClient: () => Promise.resolve(),
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<PersistQueryClientProvider client={client} persistOptions={{ persister }}><App /></PersistQueryClientProvider>);
  await waitFor(() => { expect(feedText()).not.toContain('Loading history…'); });
  expect(screen.getByText(INVITATION)).toBeDefined();
  client.clear();
});

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, mock, test } from 'bun:test';
import type { Batch, Model } from '@atelier/shared';
import App from './App';
import { useAtelierStore, initialAtelierState } from './store/atelier';

const originalFetch = globalThis.fetch;
const originalMatchMedia = window.matchMedia.bind(window);

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  window.matchMedia = originalMatchMedia;
  useAtelierStore.setState(initialAtelierState, true);
});

const batch: Batch = {
  id: 'batch-1',
  prompt: 'A copper observatory at dusk',
  ratio: '1:1',
  modelId: 'm',
  modelLabel: 'M',
  createdAt: 1_000,
  collectionId: null,
  pinned: false,
  status: 'done',
  tiles: [{ id: 'tile-1', seed: 1, status: 'done', url: 'data:image/png;base64,AAAA', ext: 'png', mime: 'image/png', completedAt: 1_100 }],
};

// The Lightbox renders only while its batch is in the visible scope. A
// selection whose batch left underneath it (another tab archived or moved it)
// shows no dialog, so it must not keep the page shell inert.
test('a Lightbox selection whose batch left the scope does not keep the shell inert', async () => {
  useAtelierStore.setState(initialAtelierState, true);
  if (window.location.origin === 'null') window.location.href = 'http://localhost/';
  window.history.replaceState({}, '', 'http://localhost/');
  window.matchMedia = mock((media: string) => ({ matches: false, media, onchange: null, addEventListener: mock(), removeEventListener: mock(), addListener: mock(), removeListener: mock(), dispatchEvent: () => true }));
  const model: Model = { id: 'm', name: 'M', backend: 'cloud', tag: 'cloud', latency: 'fast', pool: 'shared', supportedRatios: ['1:1'], concurrencyCapPerUser: 1, maxCountPerBatch: 1 };
  let items: Batch[] = [batch];
  globalThis.fetch = mock((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/models')) return Promise.resolve(Response.json([model]));
    if (url.endsWith('/collections')) return Promise.resolve(Response.json({ items: [], summary: { totalCount: items.length, pinnedCount: 0, unsortedCount: items.length, archivedTotalCount: 0, archivedPinnedCount: 0, archivedUnsortedCount: 0 } }));
    if (url.endsWith('/prompts')) return Promise.resolve(Response.json({ templates: [], variableLists: [], dimensions: [] }));
    if (url.includes('/history')) return Promise.resolve(Response.json({ items, nextCursor: null }));
    return Promise.resolve(Response.json({}));
  }) as unknown as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><App /></QueryClientProvider>);
  await screen.findAllByText(batch.prompt);
  const main = view.container.querySelector('main');
  const sidebar = view.container.querySelector('#atelier-sidebar');
  if (!main || !sidebar) throw new Error('shell missing');

  act(() => { useAtelierStore.getState().openLightbox('batch-1', 'tile-1'); });
  await waitFor(() => { expect(main.hasAttribute('inert')).toBe(true); });
  expect(sidebar.hasAttribute('inert')).toBe(true);

  // The batch leaves the scope while the viewer is open.
  items = [];
  await act(async () => { await client.invalidateQueries(); });
  await waitFor(() => { expect(screen.queryAllByText(batch.prompt).length).toBe(0); });
  expect(main.hasAttribute('inert')).toBe(false);
  expect(sidebar.hasAttribute('inert')).toBe(false);
  client.clear();
});

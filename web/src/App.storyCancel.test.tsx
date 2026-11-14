import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, mock, test } from 'bun:test';
import type { Batch, Model } from '@atelier/shared';
import { HISTORY_WRITE_MUTATION_KEY } from './hooks/historyWrites';
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

const model: Model = { id: 'm', name: 'M', backend: 'cloud', tag: 'cloud', latency: 'fast', pool: 'shared', supportedRatios: ['1:1'], concurrencyCapPerUser: 1, maxCountPerBatch: 1 };
const batch: Batch = {
  id: 'batch-1',
  prompt: 'A story in progress',
  ratio: '1:1',
  modelId: model.id,
  modelLabel: model.name,
  createdAt: 1_000,
  collectionId: null,
  pinned: false,
  status: 'done',
  tiles: [{ id: 'tile-1', seed: 1, status: 'done', url: '/api/img/tile-1', ext: 'png', mime: 'image/png', completedAt: 1_000 }],
  story: { id: 'story-1', status: 'rendering', segmentIndex: 0, segmentCount: 2, logline: 'arc', etaMs: 1 },
};

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

test('the story-cancel re-read of history waits behind another pending history write', async () => {
  useAtelierStore.setState(initialAtelierState, true);
  if (window.location.origin === 'null') window.location.href = 'http://localhost/';
  window.history.replaceState({}, '', 'http://localhost/');
  window.matchMedia = mock((media: string) => ({ matches: false, media, onchange: null, addEventListener: mock(), removeEventListener: mock(), addListener: mock(), removeListener: mock(), dispatchEvent: () => true }));
  let historyReads = 0;
  globalThis.fetch = mock((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/models')) return Promise.resolve(Response.json([model]));
    if (url.endsWith('/collections')) return Promise.resolve(Response.json({ items: [], summary: { totalCount: 1, pinnedCount: 0, unsortedCount: 1, archivedTotalCount: 0, archivedPinnedCount: 0, archivedUnsortedCount: 0 } }));
    if (url.endsWith('/prompts')) return Promise.resolve(Response.json({ templates: [], variableLists: [], dimensions: [] }));
    if (url.endsWith('/stories/story-1/cancel')) return Promise.resolve(Response.json({ inflightBatchId: null }));
    if (url.includes('/history/refresh')) return Promise.resolve(Response.json({ items: [] }));
    if (url.includes('/history')) {
      historyReads += 1;
      return Promise.resolve(Response.json({ items: [batch], nextCursor: null }));
    }
    return Promise.resolve(Response.json({}));
  }) as unknown as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><App /></QueryClientProvider>);
  expect((await screen.findAllByText('A story in progress')).length).toBeGreaterThan(0);
  await settle();

  const other = Promise.withResolvers<null>();
  const otherWrite = client.getMutationCache()
    .build(client, { mutationKey: HISTORY_WRITE_MUTATION_KEY, mutationFn: () => other.promise })
    .execute(undefined);
  const readsBefore = historyReads;

  const [more] = screen.getAllByRole('button', { name: 'More actions' });
  if (!more) throw new Error('expected the batch More button');
  act(() => { fireEvent.click(more); });
  await act(async () => { fireEvent.click(await screen.findByRole('menuitem', { name: 'Cancel story' })); });
  await settle();
  expect(useAtelierStore.getState().toasts.map((toast) => toast.text)).toContain('Story canceled');
  expect(historyReads).toBe(readsBefore);

  await act(async () => { other.resolve(null); await otherWrite; });
  await settle();
  expect(historyReads).toBeGreaterThan(readsBefore);
  client.clear();
});

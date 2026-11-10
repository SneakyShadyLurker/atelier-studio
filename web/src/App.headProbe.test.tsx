import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, mock, test } from 'bun:test';
import type { Model } from '@atelier/shared';
import type { AppView } from './store/atelier';
import { useAtelierStore, initialAtelierState } from './store/atelier';

// Call through to the real probe and record what the shell mounts it for.
const probeModule = await import('./hooks/useHistoryHeadProbe');
const realProbe = probeModule.useHistoryHeadProbe;
const probeCalls: { view: AppView; q: string }[] = [];
void mock.module('./hooks/useHistoryHeadProbe', () => ({
  ...probeModule,
  useHistoryHeadProbe: (view: AppView, q: string, options?: { intervalMs?: number }) => {
    probeCalls.push({ view, q });
    realProbe(view, q, options);
  },
}));
const { default: App } = await import('./App');
const originalFetch = globalThis.fetch;
const originalMatchMedia = window.matchMedia.bind(window);

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  window.matchMedia = originalMatchMedia;
  useAtelierStore.setState(initialAtelierState, true);
});

test('the shell runs the head probe for the active view', async () => {
  useAtelierStore.setState(initialAtelierState, true);
  if (window.location.origin === 'null') window.location.href = 'http://localhost/';
  window.history.replaceState({}, '', 'http://localhost/');
  window.matchMedia = mock((media: string) => ({ matches: false, media, onchange: null, addEventListener: mock(), removeEventListener: mock(), addListener: mock(), removeListener: mock(), dispatchEvent: () => true }));
  const model: Model = { id: 'm', name: 'M', backend: 'cloud', tag: 'cloud', latency: 'fast', pool: 'shared', supportedRatios: ['1:1'], concurrencyCapPerUser: 1, maxCountPerBatch: 1 };
  globalThis.fetch = mock((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/models')) return Promise.resolve(Response.json([model]));
    if (url.endsWith('/collections')) return Promise.resolve(Response.json({ items: [], summary: { totalCount: 0, pinnedCount: 1, unsortedCount: 0, archivedTotalCount: 0, archivedPinnedCount: 0, archivedUnsortedCount: 0 } }));
    if (url.endsWith('/prompts')) return Promise.resolve(Response.json({ templates: [], variableLists: [], dimensions: [] }));
    if (url.includes('/history')) return Promise.resolve(Response.json({ items: [], nextCursor: null }));
    return Promise.resolve(Response.json({}));
  }) as unknown as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><App /></QueryClientProvider>);
  await waitFor(() => { expect(probeCalls.at(-1)).toEqual({ view: { kind: 'unsorted' }, q: '' }); });

  await act(async () => { fireEvent.click(await screen.findByRole('button', { name: /^Pinned/ })); });
  await waitFor(() => { expect(probeCalls.at(-1)?.view).toEqual({ kind: 'pinned' }); });
  client.clear();
});

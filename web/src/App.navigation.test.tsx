import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, mock, test } from 'bun:test';
import type { Batch, Model } from '@atelier/shared';
import { use } from 'react';
import { useAtelierStore, initialAtelierState } from './store/atelier';

const loaded = Promise.withResolvers<undefined>();
function DeferredPromptManager() {
  use(loaded.promise);
  return <h2>Deferred prompt library</h2>;
}
void mock.module('./components/PromptManager', () => ({ default: DeferredPromptManager }));
void mock.module('./components/Canvas', () => ({ default: ({ batches }: { batches: readonly Batch[] }) => <div>Retained feed {batches.length}</div> }));
const { default: App } = await import('./App');
const originalFetch = globalThis.fetch;
const originalMatchMedia = window.matchMedia.bind(window);

afterEach(() => {
  cleanup(); globalThis.fetch = originalFetch; window.matchMedia = originalMatchMedia;
  useAtelierStore.setState(initialAtelierState, true);
});

test('external navigation defers the view while preserving one URL/store owner and inerts stale actions', async () => {
  useAtelierStore.setState(initialAtelierState, true);
  if (window.location.origin === 'null') window.location.href = 'http://localhost/';
  window.history.replaceState({}, '', 'http://localhost/');
  window.matchMedia = mock((media: string) => ({ matches: false, media, onchange: null, addEventListener: mock(), removeEventListener: mock(), addListener: mock(), removeListener: mock(), dispatchEvent: () => true }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const model: Model = { id: 'm', name: 'M', backend: 'cloud', tag: 'cloud', latency: 'fast', pool: 'shared', supportedRatios: ['1:1'], concurrencyCapPerUser: 1, maxCountPerBatch: 1 };
  globalThis.fetch = mock((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/models')) return Promise.resolve(Response.json([model]));
    if (url.endsWith('/collections')) return Promise.resolve(Response.json({ items: [], summary: { totalCount: 0, pinnedCount: 0, unsortedCount: 0, archivedTotalCount: 0, archivedPinnedCount: 0, archivedUnsortedCount: 0 } }));
    if (url.endsWith('/prompts')) return Promise.resolve(Response.json({ templates: [], variableLists: [], dimensions: [] }));
    if (url.includes('/history')) return Promise.resolve(Response.json({ items: [], nextCursor: null }));
    return Promise.resolve(Response.json({}));
  }) as unknown as typeof fetch;
  const view = render(<QueryClientProvider client={client}><App /></QueryClientProvider>);
  await screen.findByRole('button', { name: 'Prompt Library' });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Prompt Library' })); await Promise.resolve(); });
  expect(useAtelierStore.getState().view.kind).toBe('prompts');
  expect(window.location.search).toContain('view=prompts');
  expect(screen.getByText('Retained feed 0')).toBeDefined();
  expect(screen.queryByText('Loading view')).toBeNull();
  expect(view.container.querySelector('[data-view-pending="true"]')).not.toBeNull();
  expect(view.container.querySelector('main')?.hasAttribute('inert')).toBe(false);
  expect(view.container.querySelector('[data-testid="feed"]')?.hasAttribute('inert')).toBe(true);
  expect(view.container.querySelector('#atelier-sidebar')?.hasAttribute('inert')).toBe(false);
  await act(async () => { loaded.resolve(undefined); await Promise.resolve(); });
  expect(screen.getByRole('heading', { name: 'Deferred prompt library' })).toBeDefined();
  expect(view.container.querySelector('[data-view-pending="true"]')).toBeNull();
  client.clear();
});

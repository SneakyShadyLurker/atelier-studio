import type { Batch, Collection, Model } from '@atelier/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { ComponentProps } from 'react';
import { fixtureModels } from './fixtures/models';
import Canvas from '../src/components/Canvas';
import Sidebar from '../src/components/Sidebar';
import { useAtelierStore, initialAtelierState, type AppView } from '../src/store/atelier';

// The real viewer renders for every tile except the one this suite breaks on
// purpose, so the mock never changes Lightbox behavior for anything else.
const { default: RealLightbox } = await import('../src/components/Lightbox');
const BROKEN_TILE = 'scope-batch-tile';
void mock.module('../src/components/Lightbox', () => ({
  default: (props: ComponentProps<typeof RealLightbox>) => {
    if (useAtelierStore.getState().lightbox?.tileId === BROKEN_TILE) throw new Error('viewer exploded');
    return <RealLightbox {...props} />;
  },
}));
const { default: App } = await import('../src/App');
const { ManagedViewHeader } = await import('../src/components/ManagedViewHeader');

const COLLECTION_ID = '019e13e4-f168-7555-8dbe-6be97df82b17';
const collection: Collection = { id: COLLECTION_ID, name: 'Logo concepts', count: 1, archivedCount: 0, createdAt: 1 };

const originalFetch = globalThis.fetch;
const originalMatchMedia = window.matchMedia.bind(window);
const originalConsoleError = console.error;

function batch(collectionId: string | null): Batch {
  return {
    id: 'scope-batch',
    prompt: 'a lighthouse',
    ratio: '1:1',
    modelId: fixtureModels[0]?.id ?? 'm',
    modelLabel: 'Model',
    createdAt: 1,
    collectionId,
    pinned: false,
    status: 'done',
    tiles: [{ id: BROKEN_TILE, seed: 1, status: 'done', url: '/img/scope.png', ext: 'png', mime: 'image/png', completedAt: 1 }],
  };
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function renderApp(search: string, collectionId: string | null) {
  if (window.location.origin === 'null') window.location.href = 'http://localhost/';
  window.history.replaceState({}, '', `http://localhost/${search}`);
  installDesktopMedia();
  globalThis.fetch = mock((input: RequestInfo | URL) => {
    const url = requestUrl(input);
    if (url.endsWith('/models')) return Promise.resolve(Response.json(fixtureModels));
    if (url.endsWith('/collections')) {
      return Promise.resolve(Response.json({
        items: [collection],
        summary: { totalCount: 1, pinnedCount: 0, unsortedCount: collectionId ? 0 : 1, archivedTotalCount: 0, archivedPinnedCount: 0, archivedUnsortedCount: 0 },
      }));
    }
    if (url.endsWith('/prompts')) return Promise.resolve(Response.json({ templates: [], variableLists: [], dimensions: [] }));
    if (url.includes('/history')) return Promise.resolve(Response.json({ items: [batch(collectionId)], nextCursor: null }));
    return Promise.resolve(Response.json({}));
  }) as unknown as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><App /></QueryClientProvider>);
  return client;
}

function installDesktopMedia() {
  window.matchMedia = mock((media: string) => ({ matches: false, media, onchange: null, addEventListener: mock(), removeEventListener: mock(), addListener: mock(), removeListener: mock(), dispatchEvent: () => true }));
}

/** Rail and content column side by side, the way App mounts them. */
function renderScope(view: AppView) {
  installDesktopMedia();
  useAtelierStore.setState({ view });
  globalThis.fetch = mock((input: RequestInfo | URL) => {
    const url = requestUrl(input);
    if (url.endsWith('/collections')) {
      return Promise.resolve(Response.json({
        items: [collection],
        summary: { totalCount: 1, pinnedCount: 0, unsortedCount: 0, archivedTotalCount: 0, archivedPinnedCount: 0, archivedUnsortedCount: 0 },
      }));
    }
    return Promise.resolve(Response.json({}));
  }) as unknown as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Sidebar
        history={{ items: [], nextCursor: null }}
        models={fixtureModels}
        activeBatchId={null}
        historyQ=""
        archivedCount={0}
        promptsEnabled={false}
        onSelect={() => undefined}
        onSelectView={() => undefined}
        onClear={() => undefined}
      />
      <Canvas
        batches={[]}
        modelById={new Map<string, Model>()}
        collections={[collection]}
        activeView={view}
        hasNextPage={false}
        isFetchingNextPage={false}
        onLoadMore={() => undefined}
        onBatchAction={() => undefined}
        promptsEnabled={false}
        onTileAction={() => undefined}
        onOpenTile={() => undefined}
        q=""
      />
    </QueryClientProvider>,
  );
  return client;
}

/** The content column's title must name the active rail row exactly. */
async function expectTitleMatchesRail(name: string) {
  const activeRow = await waitFor(() => {
    const row = within(screen.getByRole('navigation', { name: 'Library' }))
      .getAllByRole('button')
      .find((button) => button.getAttribute('aria-current') === 'page');
    expect(row).toBeDefined();
    return row;
  });
  const heading = screen.getAllByRole('heading', { level: 2, name }).find((node) => node.id === 'atelier-feed-heading');
  expect(heading?.tagName).toBe('H2');
  expect(Array.from(activeRow?.children ?? []).some((part) => part.textContent === heading?.textContent)).toBe(true);
  expect(screen.getByTestId('canvas-scroller').getAttribute('aria-labelledby')).toBe('atelier-feed-heading');
}

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  window.matchMedia = originalMatchMedia;
  console.error = originalConsoleError;
  useAtelierStore.setState(initialAtelierState, true);
  if (window.location.origin !== 'null') window.history.replaceState({}, '', 'http://localhost/');
});

describe('one scope title', () => {
  test('the content heading equals the active rail row for Unsorted and for a collection', async () => {
    const unsortedClient = renderScope({ kind: 'unsorted' });
    await expectTitleMatchesRail('Unsorted');
    unsortedClient.clear();
    cleanup();

    const collectionClient = renderScope({ kind: 'collection', id: COLLECTION_ID });
    await expectTitleMatchesRail('Logo concepts');
    collectionClient.clear();
  });

  test('a Back button says where it goes and the header has none without onBack', () => {
    render(<ManagedViewHeader heading="Archive" headingId="a" backLabel="Back to Unsorted" onBack={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Back to Unsorted' })).toBeTruthy();
    cleanup();
    render(<ManagedViewHeader heading="Unsorted" headingId="u" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  test('the Lightbox error fallback opened from a collection goes back to that collection', async () => {
    console.error = mock(() => undefined);
    const client = renderApp(`?c=${COLLECTION_ID}`, COLLECTION_ID);
    await screen.findByRole('button', { name: /Logo concepts/, current: 'page' });
    await waitFor(() => { expect(useAtelierStore.getState().view).toEqual({ kind: 'collection', id: COLLECTION_ID }); });
    await act(async () => {
      useAtelierStore.getState().openLightbox('scope-batch', BROKEN_TILE);
      await Promise.resolve();
    });
    expect(await screen.findByRole('button', { name: 'Back to Logo concepts' })).toBeTruthy();
    expect(screen.getByText('Image view unavailable')).toBeTruthy();
    client.clear();
  });
});

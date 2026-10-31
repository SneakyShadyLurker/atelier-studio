import type { Batch, Collection, CollectionsResponse, Model } from '@atelier/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { readFileSync } from 'node:fs';
import BatchView from '../src/components/Batch';
import { collectionKeys } from '../src/api/collections';
import { APP_VIEW_UNSORTED, useAtelierStore } from '../src/store/atelier';

const originalMatchMedia = window.matchMedia.bind(window);

const collections: readonly Collection[] = [
  { id: 'collection-logo', name: 'Logo concepts', count: 3, archivedCount: 0, createdAt: 1 },
  { id: 'collection-studio', name: 'Studio refs', count: 1, archivedCount: 0, createdAt: 2 },
];

const models: readonly Model[] = [{
  id: 'gpt-image-2.5-sunburst-cloud',
  name: 'GPT Image 2.5 Sunburst',
  backend: 'cloud',
  tag: 'cloud',
  latency: 'fast',
  supportedRatios: ['1:1'],
  pool: 'shared',
    concurrencyCapPerUser: 4,
    maxCountPerBatch: 4,
}];
const modelById = new Map(models.map((model) => [model.id, model]));

function batch(overrides: Partial<Batch> = {}): Batch {
  return {
    id: 'batch-logo',
    prompt: 'Logo mark for a Nordic espresso bar',
    ratio: '1:1',
    modelId: 'gpt-image-2.5-sunburst-cloud',
    modelLabel: 'GPT Image 2.5 Sunburst',
    createdAt: Date.now(),
    collectionId: null,
      pinned: false,
      status: 'done',
    tiles: [],
    ...overrides,
  };
}

function collectionsResponse(items: readonly Collection[] = collections): CollectionsResponse {
  return {
    items,
    summary: { totalCount: 4, pinnedCount: 1, unsortedCount: 1, archivedTotalCount: 0, archivedPinnedCount: 0, archivedUnsortedCount: 0 },
  };
}

function installMatchMedia(isPhone = false, reducedMotion = false): void {
  window.matchMedia = mock((query: string) => ({
    matches: query === '(width < 768px)' ? isPhone : query === '(prefers-reduced-motion: reduce)' ? reducedMotion : false,
    media: query,
    onchange: null,
    addEventListener: mock(() => undefined),
    removeEventListener: mock(() => undefined),
    addListener: mock(() => undefined),
    removeListener: mock(() => undefined),
    dispatchEvent: mock(() => true),
  }));
}

function wrapper(client: QueryClient) {
  return function TestWrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function renderBatch(item: Batch, options: { isPhone?: boolean; reducedMotion?: boolean } = {}) {
  installMatchMedia(options.isPhone, options.reducedMotion);
  useAtelierStore.setState({ view: APP_VIEW_UNSORTED, q: '', toasts: [] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(collectionKeys.list(), collectionsResponse());
  const calls: { url: string; method: string; body: unknown }[] = [];
  globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const rawBody = typeof init?.body === 'string' ? init.body : undefined;
    calls.push({ url, method, body: rawBody ? JSON.parse(rawBody) : null });
    if (url.endsWith('/collections') && method === 'POST') {
      return Response.json({ id: 'collection-new', name: 'Mood board', count: 0, archivedCount: 0, createdAt: 3 });
    }
    if (url.includes('/collections/') && method === 'PATCH') {
      return Response.json({ id: 'collection-logo', name: 'Brand marks', count: 3, archivedCount: 0, createdAt: 1 });
    }
    if (url.includes('/history/')) {
      const body = rawBody ? JSON.parse(rawBody) as Partial<Batch> : {};
      return Response.json({ ...item, ...body });
    }
    if (url.endsWith('/collections')) return Response.json(collectionsResponse());
    return Response.json({});
  }) as unknown as typeof fetch;

  const onBatchAction = mock();
  const currentCollection = item.collectionId === null
    ? undefined
    : collections.find((collection) => collection.id === item.collectionId);
  const rendered = render(
    <BatchView
      batch={item}
      modelById={modelById}
      activeView={APP_VIEW_UNSORTED}
      currentCollection={currentCollection}
      onBatchAction={onBatchAction}
      promptsEnabled={false}
      onTileAction={() => undefined}
      onOpenTile={() => undefined}
      q=""
    />,
    { wrapper: wrapper(client) },
  );
  return { ...rendered, calls, client, onBatchAction };
}

async function openMove() {
  // Move is now in the overflow menu — open More then click the Move menuitem
  const more = screen.getByRole('button', { name: /more actions/i });
  fireEvent.click(more);
  const moveItem = await screen.findByRole('menuitem', { name: /move to collection/i });
  fireEvent.click(moveItem);
  return screen.findByRole('dialog', { name: 'Move to collection' });
}

function getMoreBtn(): HTMLElement {
  return screen.getByRole('button', { name: /more actions/i });
}

afterEach(() => {
  cleanup();
  mock.restore();
  window.matchMedia = originalMatchMedia;
  useAtelierStore.setState({ view: APP_VIEW_UNSORTED, q: '', toasts: [] });
});

describe('Batch Phase G header affordances', () => {
  test('renders Archive and More in the visible action row; overflow menu holds Copy, Re-roll, Move', () => {
    renderBatch(batch());
    // Direct header: Archive + More only (no pinned star — batch is unpinned)
    expect(screen.getByRole('button', { name: 'Archive batch' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /more actions/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Copy prompt' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Generate again' })).toBeNull();
    // Overflow menu contains the collapsed actions
    fireEvent.click(screen.getByRole('button', { name: /more actions/i }));
    expect(screen.getByRole('menuitem', { name: /copy prompt/i })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /re-roll/i })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /move to collection/i })).toBeTruthy();
  });

  test('Move icon state and collection meta token follow assignment', () => {
    const { rerender, client } = renderBatch(batch());
    // No direct Move button in header anymore — verify via meta token absence
    expect(screen.queryByText('LOGO CONCEPTS')).toBeNull();

    rerender(
      <QueryClientProvider client={client}>
        <BatchView
          batch={batch({ collectionId: 'collection-logo' })}
          modelById={modelById}
          activeView={APP_VIEW_UNSORTED}
          currentCollection={collections.find((collection) => collection.id === 'collection-logo')}
          onBatchAction={() => undefined}
          promptsEnabled={false}
          onTileAction={() => undefined}
          onOpenTile={() => undefined}
          q=""
        />
      </QueryClientProvider>,
    );

    // After assignment: meta token appears and clicking it opens MovePopover
    expect(screen.getByText('LOGO CONCEPTS')).toBeTruthy();
  });

  test('collection meta token opens the Move popover at the shared trigger', async () => {
    renderBatch(batch({ collectionId: 'collection-logo' }));
    const token = screen.getByText('LOGO CONCEPTS').closest('button');
    if (!token) throw new Error('missing collection meta token button');
    fireEvent.click(token);
    expect(await screen.findByRole('dialog', { name: 'Move to collection' })).toBeTruthy();
  });

  test('pin star exposes pressed state and toggles without invoking batch actions', async () => {
    const { calls, onBatchAction } = renderBatch(batch({ pinned: false }));
    // When unpinned: Pin batch is in the overflow menu (not the header)
    expect(screen.queryByRole('button', { name: 'Pin batch' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /more actions/i }));
    const pinItem = screen.getByRole('menuitem', { name: /^pin batch$/i });
    fireEvent.click(pinItem);
    expect(onBatchAction).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(calls.some((call) => call.url === '/api/history/batch-logo' && call.method === 'PATCH' && (call.body as { pinned?: boolean }).pinned === true)).toBe(true);
    });

    cleanup();
    renderBatch(batch({ pinned: true }));
    // When pinned: Unpin batch is a direct header button
    const unpin = screen.getByRole('button', { name: 'Unpin batch' });
    expect(unpin.getAttribute('aria-pressed')).toBe('true');
    expect(unpin.getAttribute('data-pinned')).toBe('true');
  });
});

describe('MovePopover', () => {
  test('opens from Move icon, keeps Unsorted first, and marks null assignment', async () => {
    renderBatch(batch());
    const dialog = await openMove();
    const rows = within(dialog).getAllByRole('listitem');
    const first = rows[0];
    if (!first) throw new Error('missing first move row');
    expect(within(first).getByText('(Unsorted)')).toBeTruthy();
    expect(first.querySelector('svg')).toBeTruthy();
  });

  test('clicking a collection row moves the batch and closes the popover', async () => {
    const { calls } = renderBatch(batch());
    await openMove();
    fireEvent.click(screen.getByRole('button', { name: 'Logo concepts' }));
    fireEvent.pointerDown(document.body);
    await waitFor(() => {
      expect(calls.some((call) =>
        call.url === '/api/history/batch-logo'
        && call.method === 'PATCH'
        && (call.body as { collectionId?: string }).collectionId === 'collection-logo',
      )).toBe(true);
    });
    // Dismissal rides the shared exit transition (useExitTransition); the
    // unmount lands ~160ms later, outside waitFor's act-wrapped polling.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(screen.queryByRole('dialog', { name: 'Move to collection' })).toBeNull();
  });

  test('double-clicking a collection row renames inline on Enter and cancels on Esc', async () => {
    const { calls } = renderBatch(batch({ collectionId: 'collection-logo' }));
    const dialog = await openMove();
    fireEvent.doubleClick(within(dialog).getByRole('button', { name: /Logo concepts/i }));
    const rename = screen.getByLabelText('Rename collection');
    fireEvent.change(rename, { target: { value: 'Brand marks' } });
    fireEvent.keyDown(rename, { key: 'Enter' });
    await waitFor(() => {
      expect(calls.some((call) => call.url === '/api/collections/collection-logo' && call.method === 'PATCH')).toBe(true);
    });

    fireEvent.doubleClick(within(dialog).getByRole('button', { name: /Logo concepts/i }));
    expect(screen.getByLabelText('Rename collection')).toBeTruthy();
    fireEvent.keyDown(screen.getByLabelText('Rename collection'), { key: 'Escape' });
    await waitFor(() => { expect(screen.queryByLabelText('Rename collection')).toBeNull(); });
  });

  test('+ New collection creates and immediately moves the batch into the new collection', async () => {
    const { calls } = renderBatch(batch());
    await openMove();
    fireEvent.click(screen.getByRole('button', { name: '+ New collection' }));
    const input = screen.getByLabelText('Collection name');
    fireEvent.change(input, { target: { value: 'Mood board' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(calls.some((call) => call.url === '/api/collections' && call.method === 'POST')).toBe(true);
      expect(calls.some((call) =>
        call.url === '/api/history/batch-logo'
        && call.method === 'PATCH'
        && (call.body as { collectionId?: string }).collectionId === 'collection-new',
      )).toBe(true);
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(screen.queryByRole('dialog', { name: 'Move to collection' })).toBeNull();
  });

  test('inert isolates the background, Esc closes, and focus returns to the More trigger', async () => {
    renderBatch(batch());
    const more = getMoreBtn();
    const dialog = await openMove();
    await waitFor(() => { expect(dialog.contains(document.activeElement)).toBe(true); });

    // Containment is delegated to `inert` on every body sibling outside the
    // portal (same mechanism as ConfirmDialog/ByokDialog) — no hand-rolled
    // Tab cycle. happy-dom does not implement `inert`'s focus-blocking, so
    // this asserts the effect's *wiring* (correct host inerted, portal host
    // excluded, cleanup on close, focus restored) — the regression classes a
    // unit test can catch here. Native focus-blocking is a platform guarantee
    // of the shared canonical pattern, exercised by a real browser, not here.
    const bgHost = Array.from(document.body.children).find((child) => child.contains(more));
    if (!bgHost) throw new Error('expected a body child containing the More trigger');
    expect(bgHost.hasAttribute('inert')).toBe(true);
    const portalHost = Array.from(document.body.children).find((child) => child.contains(dialog));
    if (!portalHost) throw new Error('expected the portal host');
    expect(portalHost.hasAttribute('inert')).toBe(false);

    fireEvent.keyDown(document, { key: 'Escape' });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(screen.queryByRole('dialog', { name: 'Move to collection' })).toBeNull();
    expect(bgHost.hasAttribute('inert')).toBe(false);
    // Focus restore is deferred a macrotask (must run after inert cleanup).
    await waitFor(() => { expect(document.activeElement).toBe(more); });
  });

  test('clicking outside closes the popover', async () => {
    renderBatch(batch());
    await openMove();
    fireEvent.pointerDown(document.body);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(screen.queryByRole('dialog', { name: 'Move to collection' })).toBeNull();
  });

  test('More → Move hands over to a fresh popover; neither panel carries script geometry', async () => {
    renderBatch(batch());
    fireEvent.click(getMoreBtn());
    const menu = screen.getByRole('menu', { name: /batch actions/i });
    expect(menu.getAttribute('data-anchor-place')).toBe('below-end');
    expect(menu.getAttribute('popover')).toBe('manual');

    fireEvent.click(screen.getByRole('menuitem', { name: /move to collection/i }));
    const dialog = await screen.findByRole('dialog', { name: 'Move to collection' });
    expect(screen.queryByRole('menu', { name: /batch actions/i })).toBeNull();
    expect(dialog.getAttribute('data-anchor-place')).toBe('below-end');
    expect(dialog.getAttribute('popover')).toBe('manual');
    expect(dialog.getAttribute('style')).toBeNull();
  });

  test('mobile renders as a bottom sheet and backdrop tap dismisses', async () => {
    renderBatch(batch(), { isPhone: true });
    const dialog = await openMove();
    expect(dialog.getAttribute('data-mobile')).toBe('true');
    expect(dialog.hasAttribute('data-anchor-place')).toBe(false);
    expect(dialog.hasAttribute('popover')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Close move popover' }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(screen.queryByRole('dialog', { name: 'Move to collection' })).toBeNull();
  });

  test('reduced-motion CSS keeps the Move layer to an opacity-speed smoke path', () => {
    const css = readFileSync(new URL('../src/components/MovePopover/index.module.css', import.meta.url), 'utf8');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('animation-duration: var(--dur-reduced)');
  });
});

import type { Batch, Collection, CollectionsResponse, HistoryPage, Model } from '@atelier/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import Sidebar from '../src/components/Sidebar';
import { APP_VIEW_ARCHIVE, APP_VIEW_PINNED, APP_VIEW_PROMPTS, APP_VIEW_UNSORTED, collectionView, type AppView, useAtelierStore } from '../src/store/atelier';

const models: readonly Model[] = [{
  id: 'gpt-image-2.5-sunburst-cloud',
  name: 'GPT Image 2.5 Sunburst',
  backend: 'cloud',
  tag: 'cloud',
  latency: 'fast',
  supportedRatios: ['1:1'],
  supportsReferenceImages: true,
  pool: 'shared',
    concurrencyCapPerUser: 4,
    maxCountPerBatch: 4,
}];

const collections: readonly Collection[] = [
  { id: 'collection-logo', name: 'Logo concepts', count: 13, archivedCount: 0, createdAt: 1 },
  { id: 'collection-studio', name: 'Studio refs', count: 2, archivedCount: 0, createdAt: 2 },
];

function batch(overrides: Partial<Batch> = {}): Batch {
  return {
    id: 'batch-logo',
    prompt: 'Logo mark for a Nordic espresso bar',
    ratio: '1:1',
    modelId: 'gpt-image-2.5-sunburst-cloud',
    modelLabel: 'GPT Image 2.5 Sunburst',
    createdAt: 1,
    collectionId: null,
      pinned: false,
      status: 'done',
    tiles: [],
    ...overrides,
  };
}

function history(items: readonly Batch[] = [batch()]): HistoryPage<Batch> {
  return { items, nextCursor: null };
}

function collectionResponse(overrides: Partial<CollectionsResponse> = {}): CollectionsResponse {
  return {
    items: collections,
    summary: { totalCount: 20, pinnedCount: 3, unsortedCount: 5, archivedTotalCount: 0, archivedPinnedCount: 0, archivedUnsortedCount: 0 },
    ...overrides,
  };
}

function wrapper(client: QueryClient) {
  return function TestWrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function installMatchMedia(isPhone: boolean): void {
  window.matchMedia = mock((query: string) => ({
    matches: query === '(width < 768px)' ? isPhone : false,
    media: query,
    onchange: null,
    addEventListener: mock(() => undefined),
    removeEventListener: mock(() => undefined),
    addListener: mock(() => undefined),
    removeListener: mock(() => undefined),
    dispatchEvent: mock(() => true),
  }));
}

function firstElement<T>(items: readonly T[], label: string): T {
  const item = items[0];
  if (item === undefined) throw new Error(`Missing ${label}`);
  return item;
}

function renderSidebar({
  response = collectionResponse(),
  view = APP_VIEW_UNSORTED,
  items = [batch()],
  q = '',
  isPhone = false,
  promptsEnabled = false,
}: {
  response?: CollectionsResponse;
  view?: AppView;
  items?: readonly Batch[];
  q?: string;
  isPhone?: boolean;
  promptsEnabled?: boolean;
} = {}) {
  installMatchMedia(isPhone);
  useAtelierStore.setState({ view, q, toasts: [] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const calls: string[] = [];
  globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    calls.push(url);
    if (url.endsWith('/collections') && method === 'POST') return Response.json(collections[0]);
    if (url.endsWith('/collections')) return Response.json(response);
    if (url.includes('/collections/') && method === 'PATCH') return Response.json(collections[0]);
    if (url.includes('/collections/') && method === 'DELETE') return new Response(null, { status: 204 });
    if (url.includes('/history/batch-logo')) return Response.json(batch({ pinned: true }));
    return Response.json({});
  }) as unknown as typeof fetch;

  const onSelect = mock();
  const rendered = render(
    <Sidebar
      history={history(items)}
      models={models}
      activeBatchId={items[0]?.id ?? null}
      historyQ=""
      archivedCount={0}
      promptsEnabled={promptsEnabled}
      onSelect={onSelect}
      onSelectView={(nextView) => { useAtelierStore.setState({ view: nextView }); }}
        onClear={() => undefined}
    />,
    { wrapper: wrapper(client) },
  );
  return { ...rendered, calls, client, onSelect };
}

afterEach(() => {
  cleanup();
  mock.restore();
  useAtelierStore.setState({ view: APP_VIEW_UNSORTED, q: '', activeBatchId: null, byokOpen: false, toasts: [] });
});

describe('Sidebar Library rail', () => {
  test('gates the pinned Prompt Library rail entry', async () => {
    renderSidebar({ promptsEnabled: true });

    const button = await screen.findByRole('button', { name: 'Prompt Library' });
    fireEvent.click(button);
    expect(useAtelierStore.getState().view).toEqual(APP_VIEW_PROMPTS);

    cleanup();
    renderSidebar({ promptsEnabled: false });
    expect(screen.queryByRole('button', { name: 'Prompt Library' })).toBeNull();
  });

  // The footer/Archive/Prompt-Library pin to the bottom because exactly one
  // flex-grow element sits between the Library rail and them: the `.list`
  // feed in feed views, the `.spacer` in feed-less views. The mid-rail bug
  // was "neither rendered". This locks the XOR invariant across every
  // AppView variant (incl. pinned/collection, which also keep the feed) so a
  // future `hideFeed` drift can't silently reopen it. Note: happy-dom does
  // not apply CSS-module stylesheets, so the `flex:1` value itself is not
  // assertable here — that lives in the design-system CSS, mirroring `.list`.
  test('exactly one flex-grow element (feed XOR spacer) pins the footer in every view', async () => {
    const feedViews: readonly { label: string; view: AppView }[] = [
      { label: 'unsorted', view: APP_VIEW_UNSORTED },
      { label: 'pinned', view: APP_VIEW_PINNED },
      { label: 'collection', view: collectionView('collection-logo') },
    ];
    for (const { label, view } of feedViews) {
      renderSidebar({ view, promptsEnabled: true });
      await screen.findByRole('navigation', { name: 'Library' });
      expect(screen.getByTestId('sidebar-feed'), `${label}: feed present`).toBeTruthy();
      expect(screen.queryByTestId('sidebar-spacer'), `${label}: no spacer`).toBeNull();
      cleanup();
    }

    const feedlessViews: readonly { label: string; view: AppView }[] = [
      { label: 'archive', view: APP_VIEW_ARCHIVE },
      { label: 'prompts', view: APP_VIEW_PROMPTS },
    ];
    for (const { label, view } of feedlessViews) {
      renderSidebar({ view, promptsEnabled: true });
      await screen.findByRole('navigation', { name: 'Library' });
      expect(screen.getByTestId('sidebar-spacer'), `${label}: spacer present`).toBeTruthy();
      expect(screen.queryByTestId('sidebar-feed'), `${label}: no feed`).toBeNull();
      cleanup();
    }
  });

  test('renders library counts, conditional rows, empty microcopy, and scopes to archive when active', async () => {
    renderSidebar();

    const library = await screen.findByRole('navigation', { name: 'Library' });
    expect(within(library).getByRole('button', { name: /Unsorted/i }).getAttribute('aria-current')).toBe('page');
    expect(within(library).getByRole('button', { name: /Unsorted/i }).getAttribute('data-active')).toBe('true');
    expect(within(library).getByRole('button', { name: /Pinned/i })).toBeTruthy();
    expect(within(library).getByText('Logo concepts')).toBeTruthy();

    cleanup();
    renderSidebar({ response: collectionResponse({ items: [], summary: { totalCount: 4, pinnedCount: 0, unsortedCount: 4, archivedTotalCount: 0, archivedPinnedCount: 0, archivedUnsortedCount: 0 } }) });
    expect(screen.queryByRole('button', { name: /Pinned/i })).toBeNull();
    expect(screen.getByRole('button', { name: /Unsorted/i })).toBeTruthy();
    expect(screen.getByText('Group related batches into collections.')).toBeTruthy();

    // Archive is a terminal deletion bin: rail chrome is identical to live
    // views, but content is gated to archived scope — collections with zero
    // archived content are hidden (like Pinned) and "+ New collection" is
    // omitted (no organizing affordance inside a deletion queue). Archive-
    // scoped routing is verified in archive.test.tsx.
    cleanup();
    renderSidebar({
      view: APP_VIEW_ARCHIVE,
      response: collectionResponse({
        items: [
          { id: 'collection-logo', name: 'Logo concepts', count: 3, archivedCount: 2, createdAt: 1 },
          { id: 'collection-studio', name: 'Studio refs', count: 0, archivedCount: 0, createdAt: 2 },
        ],
        summary: { totalCount: 3, pinnedCount: 1, unsortedCount: 0, archivedTotalCount: 3, archivedPinnedCount: 0, archivedUnsortedCount: 1 },
      }),
    });
    const archiveLib = await screen.findByRole('navigation', { name: 'Library' });
    expect(within(archiveLib).getByRole('button', { name: /Unsorted/i })).toBeTruthy();
    expect(within(archiveLib).queryByRole('button', { name: /Pinned/i })).toBeNull();
    expect(within(archiveLib).getByText('Logo concepts')).toBeTruthy();
    expect(within(archiveLib).queryByText('Studio refs')).toBeNull();
    expect(within(archiveLib).queryByRole('button', { name: /New collection/i })).toBeNull();
  });

  test('opens BYOK settings from the sidebar footer gear', () => {
    useAtelierStore.setState({ byokOpen: false });
    renderSidebar();

    const settingsButton = screen.getByRole('button', { name: 'API keys' });
    expect(settingsButton.getAttribute('data-tip')).toBe('API keys');
    expect(settingsButton.getAttribute('data-tip-place')).toBe('above-end');

    fireEvent.click(settingsButton);
    expect(useAtelierStore.getState().byokOpen).toBe(true);
  });

  test('creates, renames, and deletes collections inline', async () => {
    renderSidebar();
    expect(await screen.findByText('Logo concepts')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /New collection/i }));
    const createInput = screen.getByLabelText('Collection name');
    fireEvent.change(createInput, { target: { value: 'Mood board' } });
    fireEvent.keyDown(createInput, { key: 'Enter' });
    await waitFor(() => { expect(globalThis.fetch).toHaveBeenCalledWith('/api/collections', expect.objectContaining({ method: 'POST' })); });

    const library = screen.getByRole('navigation', { name: 'Library' });
    const row = firstElement(within(library).getAllByRole('button', { name: /Logo concepts/i }), 'Logo concepts row');
    fireEvent.doubleClick(within(row).getByText('Logo concepts'));
    const renameInput = screen.getByLabelText('Collection name');
    fireEvent.change(renameInput, { target: { value: 'Brand marks' } });
    fireEvent.keyDown(renameInput, { key: 'Enter' });
    await waitFor(() => { expect(globalThis.fetch).toHaveBeenCalledWith('/api/collections/collection-logo', expect.objectContaining({ method: 'PATCH' })); });
    await waitFor(() => { expect(screen.queryByLabelText('Collection name')).toBeNull(); });

    fireEvent.click(screen.getByRole('button', { name: 'Delete collection Logo concepts' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('Batches will return to Unsorted.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete collection' }));
    await waitFor(() => { expect(globalThis.fetch).toHaveBeenCalledWith('/api/collections/collection-logo', expect.objectContaining({ method: 'DELETE' })); });
  });

  test('empty inline names cancel on blur without mutation', async () => {
    renderSidebar();
    expect(await screen.findByText('Logo concepts')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /New collection/i }));
    fireEvent.blur(screen.getByLabelText('Collection name'));
    await waitFor(() => { expect(screen.queryByLabelText('Collection name')).toBeNull(); });
    expect(globalThis.fetch).not.toHaveBeenCalledWith('/api/collections', expect.objectContaining({ method: 'POST' }));

    const library = screen.getByRole('navigation', { name: 'Library' });
    const row = firstElement(within(library).getAllByRole('button', { name: /Logo concepts/i }), 'Logo concepts row');
    fireEvent.doubleClick(within(row).getByText('Logo concepts'));
    const renameInput = screen.getByLabelText('Collection name');
    fireEvent.change(renameInput, { target: { value: '   ' } });
    fireEvent.blur(renameInput);
    await waitFor(() => { expect(screen.queryByLabelText('Collection name')).toBeNull(); });
    expect(globalThis.fetch).not.toHaveBeenCalledWith('/api/collections/collection-logo', expect.objectContaining({ method: 'PATCH' }));
  });

  test('search desktop and mobile states update the store and mobile cancel clears search', async () => {
    renderSidebar();
    fireEvent.click(await screen.findByRole('button', { name: 'Search prompts' }));
    const desktopInput = screen.getByRole('searchbox', { name: 'Search prompts' });
    fireEvent.change(desktopInput, { target: { value: 'viking' } });
    await waitFor(() => { expect(useAtelierStore.getState().q).toBe('viking'); }, { timeout: 500 });
    fireEvent.keyDown(desktopInput, { key: 'Escape' });
    expect(screen.queryByRole('searchbox', { name: 'Search prompts' })).toBeNull();

    cleanup();
    renderSidebar({ isPhone: true, q: 'old' });
    const mobileInput = await screen.findByRole('searchbox', { name: 'Search prompts' });
    expect(mobileInput.getAttribute('data-mobile')).toBe('true');
    fireEvent.focus(mobileInput);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(useAtelierStore.getState().q).toBe('');
  });

  test('roving tabindex pauses for inputs and aria-live announces count changes', async () => {
    const { rerender } = renderSidebar({ view: APP_VIEW_PINNED });
    const library = await screen.findByRole('navigation', { name: 'Library' });
    const pinned = within(library).getByRole('button', { name: /Pinned/i });
    await waitFor(() => { expect(pinned.getAttribute('tabindex')).toBe('0'); });

    fireEvent.keyDown(library, { key: 'Home' });
    expect(within(library).getByRole('button', { name: /Unsorted/i }).getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(library, { key: 'Enter' });
    expect(useAtelierStore.getState().view).toEqual(APP_VIEW_UNSORTED);
    fireEvent.keyDown(library, { key: 'End' });
    expect(within(library).getByRole('button', { name: /New collection/i }).getAttribute('tabindex')).toBe('0');

    fireEvent.click(within(library).getByRole('button', { name: /New collection/i }));
    expect(document.activeElement).toBe(screen.getByLabelText('Collection name'));

    rerender(
      <Sidebar
        history={history()}
        models={models}
        activeBatchId="batch-logo"
        historyQ=""
        archivedCount={0}
        onSelect={() => undefined}
        onSelectView={(nextView) => { useAtelierStore.setState({ view: nextView }); }}
        onClear={() => undefined}
      />,
    );
    await waitFor(() => { expect(screen.getByText('Unsorted, 5 batches')).toBeTruthy(); }, { timeout: 500 });
  });

  test('roving handler does not steal keyboard events from library controls', async () => {
    renderSidebar();
    const initialView = useAtelierStore.getState().view;
    const library = await screen.findByRole('navigation', { name: 'Library' });

    const search = within(library).getByRole('button', { name: 'Search prompts' });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(useAtelierStore.getState().view).toEqual(initialView);
    fireEvent.click(search);
    expect(screen.getByRole('searchbox', { name: 'Search prompts' })).toBeTruthy();

    const remove = screen.getByRole('button', { name: 'Delete collection Logo concepts' });
    fireEvent.keyDown(remove, { key: 'Enter' });
    expect(useAtelierStore.getState().view).toEqual(initialView);
    fireEvent.click(remove);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});

describe('Sidebar scoped history affordances', () => {
  test('pin star toggles without selecting the history row', async () => {
    const onSelect = renderSidebar({ items: [batch({ pinned: false })] }).onSelect;
    const pin = await screen.findByRole('button', { name: 'Pin batch' });
    expect(pin.getAttribute('aria-pressed')).toBe('false');
    fireEvent.keyDown(pin, { key: 'Enter' });
    fireEvent.keyDown(pin, { key: ' ' });
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(pin);
    expect(onSelect).not.toHaveBeenCalled();
    await waitFor(() => { expect(globalThis.fetch).toHaveBeenCalledWith('/api/history/batch-logo', expect.objectContaining({ method: 'PATCH' })); });
  });

  test('per-scope labels and empty states follow the active view', async () => {
    renderSidebar({ view: APP_VIEW_PINNED, items: [] });
    expect(await screen.findByText('PINNED')).toBeTruthy();
    expect(screen.getByText('No pinned batches yet. Click the star on any generation to pin it.')).toBeTruthy();

    cleanup();
    renderSidebar({ view: APP_VIEW_UNSORTED, items: [] });
    expect(await screen.findByText('UNSORTED')).toBeTruthy();
    expect(screen.getByText('Everything is in a collection. Nice!')).toBeTruthy();

    cleanup();
    renderSidebar({ view: collectionView('collection-logo'), items: [], q: 'forest' });
    expect(await screen.findByText('IN LOGO CONCEPTS')).toBeTruthy();
    expect(screen.getByText('No prompts match "forest".')).toBeTruthy();
  });

  test('mobile cancel exits create and rename states without committing drafts', async () => {
    renderSidebar({ isPhone: true });
    expect(await screen.findByRole('navigation', { name: 'Library' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /New collection/i }));
    const createInput = screen.getByLabelText('Collection name');
    fireEvent.change(createInput, { target: { value: 'Mobile draft' } });
    const createCancel = screen.getByRole('button', { name: 'Cancel' });
    fireEvent.mouseDown(createCancel);
    fireEvent.blur(createInput);
    fireEvent.click(createCancel);
    expect(screen.queryByLabelText('Collection name')).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalledWith('/api/collections', expect.objectContaining({ method: 'POST' }));

    const library = screen.getByRole('navigation', { name: 'Library' });
    const row = firstElement(within(library).getAllByRole('button', { name: /Logo concepts/i }), 'Logo concepts row');
    fireEvent.doubleClick(within(row).getByText('Logo concepts'));
    const renameInput = screen.getByLabelText('Collection name');
    fireEvent.change(renameInput, { target: { value: 'Mobile rename' } });
    const renameCancel = screen.getByRole('button', { name: 'Cancel' });
    fireEvent.mouseDown(renameCancel);
    fireEvent.blur(renameInput);
    fireEvent.click(renameCancel);
    expect(screen.queryByLabelText('Collection name')).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalledWith('/api/collections/collection-logo', expect.objectContaining({ method: 'PATCH' }));
  });
});

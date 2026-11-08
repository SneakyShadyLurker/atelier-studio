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
  id: 'gpt-image-2.6-sunburst-cloud',
  name: 'GPT Image 2.6 Sunburst',
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
    modelId: 'gpt-image-2.6-sunburst-cloud',
    modelLabel: 'GPT Image 2.6 Sunburst',
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
  fireEvent.click(screen.getByRole('button', { name: 'Move to collection' }));
  return screen.findByRole('dialog', { name: 'Move to collection' });
}

function getMoreBtn(): HTMLElement {
  return screen.getByRole('button', { name: 'Move to collection' });
}

afterEach(() => {
  cleanup();
  mock.restore();
  window.matchMedia = originalMatchMedia;
  useAtelierStore.setState({ view: APP_VIEW_UNSORTED, q: '', toasts: [] });
});

describe('Batch Phase G header affordances', () => {
  test('renders Copy, Re-roll, Move and Archive directly with no duplicate menu paths', () => {
    renderBatch(batch());
    // Direct header: Archive + More only (no pinned star — batch is unpinned)
    expect(screen.getByRole('button', { name: 'Archive batch' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /more actions/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy prompt' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Re-roll' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Move to collection' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Generate again' })).toBeNull();
    // Overflow menu contains the collapsed actions
    fireEvent.click(screen.getByRole('button', { name: /more actions/i }));
    expect(screen.queryByRole('menuitem', { name: /copy prompt/i })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /re-roll/i })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /move to collection/i })).toBeNull();
  });

  test('Move icon state and collection meta token follow assignment', () => {
    const { rerender, client } = renderBatch(batch());
    // No direct Move button in header anymore — verify via meta token absence
    expect(screen.queryByText('Logo concepts')).toBeNull();

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
    expect(screen.getByText('Logo concepts')).toBeTruthy();
  });

  test('collection meta token opens the Move popover at the shared trigger', async () => {
    renderBatch(batch({ collectionId: 'collection-logo' }));
    const token = screen.getByText('Logo concepts').closest('button');
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
  test('Move retains the draft inside its row, cancels on leaving, and shares Enter cancellation', async () => {
    const { calls } = renderBatch(batch());
    const dialog = await openMove();
    fireEvent.click(within(dialog).getByRole('button', { name: 'New collection' }));
    const input = screen.getByLabelText('Collection name');
    const move = within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Move' });
    expect(move.disabled).toBe(true);
    fireEvent.change(input, { target: { value: '   ' } });
    expect(move.disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'Draft' } });
    act(() => { move.focus(); });
    expect(input.isConnected).toBe(true);
    expect((input as HTMLInputElement).value).toBe('Draft');
    act(() => { input.focus(); });
    expect(input.isConnected).toBe(true);
    act(() => { move.focus(); });
    const other = within(dialog).getByRole('button', { name: 'Studio refs' });
    act(() => { other.focus(); });
    await waitFor(() => { expect(screen.queryByLabelText('Collection name')).toBeNull(); });
    expect(document.activeElement).toBe(other);
    expect(calls.filter((call) => call.method === 'POST' || call.method === 'PATCH')).toHaveLength(0);
  });

  test.each(['create', 'move'] as const)('holds one create-and-move chain through %s failure and permits deliberate retry', async (failure) => {
    renderBatch(batch());
    const baseFetch = globalThis.fetch;
    let releaseCreate!: (response: Response) => void;
    let releaseMove!: (response: Response) => void;
    const createdNames = new Set<string>();
    const creates: unknown[] = [];
    const moves: unknown[] = [];
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : null;
      if (url === '/api/collections' && init?.method === 'POST') {
        creates.push(body);
        const name = (body as { name: string }).name;
        if (createdNames.has(name)) return Promise.resolve(Response.json({ error: 'Collection name is already used' }, { status: 409 }));
        return new Promise<Response>((resolve) => {
          releaseCreate = (response) => {
            if (response.ok) createdNames.add(name);
            resolve(response);
          };
        });
      }
      if (url === '/api/history/batch-logo' && init?.method === 'PATCH') {
        moves.push(body);
        return new Promise<Response>((resolve) => { releaseMove = resolve; });
      }
      return baseFetch(input, init);
    }) as unknown as typeof fetch;
    const dialog = await openMove();
    fireEvent.click(within(dialog).getByRole('button', { name: 'New collection' }));
    const input = screen.getByLabelText<HTMLInputElement>('Collection name');
    fireEvent.change(input, { target: { value: '  Mood board  ' } });
    const move = within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Move' });
    fireEvent.click(move);
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(move);
    await waitFor(() => { expect(creates).toEqual([{ name: 'Mood board' }]); });
    expect(input.value).toBe('  Mood board  ');
    expect(input.readOnly).toBe(true);
    expect(move.disabled).toBe(true);
    expect(move.getAttribute('aria-busy')).toBe('true');
    if (failure === 'move') {
      act(() => { releaseCreate(Response.json({ id: 'collection-new', name: 'Mood board', count: 0, archivedCount: 0, createdAt: 3 })); });
      await waitFor(() => { expect(moves).toEqual([{ collectionId: 'collection-new' }]); });
      fireEvent.keyDown(input, { key: 'Enter' });
      fireEvent.click(move);
      expect(creates).toHaveLength(1);
      expect(moves).toHaveLength(1);
    }
    act(() => {
      (failure === 'create' ? releaseCreate : releaseMove)(Response.json({ error: 'Collection service refused this name' }, { status: 400 }));
    });
    await waitFor(() => {
      expect(input.readOnly).toBe(false);
      expect(move.disabled).toBe(false);
      expect(useAtelierStore.getState().toasts.some((toast) => toast.text === 'Collection service refused this name')).toBe(true);
    });
    expect(input.value).toBe('  Mood board  ');
    expect(creates).toHaveLength(1);
    expect(moves).toHaveLength(failure === 'move' ? 1 : 0);
    // Retry requires another deliberate activation; Enter uses the same path.
    fireEvent.change(input, { target: { value: 'Mood board ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    if (failure === 'create') {
      await waitFor(() => { expect(creates).toHaveLength(2); });
      act(() => { releaseCreate(Response.json({ id: 'collection-retry', name: 'Mood board', count: 0, archivedCount: 0, createdAt: 4 })); });
    }
    await waitFor(() => { expect(moves).toHaveLength(failure === 'move' ? 2 : 1); });
    const retryId = failure === 'move' ? 'collection-new' : 'collection-retry';
    expect(creates).toHaveLength(failure === 'move' ? 1 : 2);
    expect(moves).toEqual(failure === 'move'
      ? [{ collectionId: 'collection-new' }, { collectionId: 'collection-new' }]
      : [{ collectionId: 'collection-retry' }]);
    act(() => { releaseMove(Response.json({ ...batch(), collectionId: retryId })); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(screen.queryByRole('dialog', { name: 'Move to collection' }) === null).toBe(true);
  });

  test.each([false, true])('changing the name after move failure creates a new identity, new session=%s', async (newSession) => {
    renderBatch(batch());
    const baseFetch = globalThis.fetch;
    const creates: string[] = [];
    const moves: string[] = [];
    const names = new Set<string>();
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { name: string; collectionId: string };
      if (url === '/api/collections' && init?.method === 'POST') {
        creates.push(body.name);
        if (names.has(body.name)) return Response.json({ error: 'Collection name is already used' }, { status: 409 });
        names.add(body.name);
        return Response.json({ id: `created-${String(creates.length)}`, name: body.name, count: 0, archivedCount: 0, createdAt: 3 });
      }
      if (url === '/api/history/batch-logo' && init?.method === 'PATCH') {
        moves.push(body.collectionId);
        return moves.length === 1 ? Response.json({ error: 'Move refused' }, { status: 400 })
          : Response.json({ ...batch(), collectionId: body.collectionId });
      }
      return baseFetch(input, init);
    }) as unknown as typeof fetch;
    const dialog = await openMove();
    fireEvent.click(within(dialog).getByRole('button', { name: 'New collection' }));
    let input = screen.getByLabelText<HTMLInputElement>('Collection name');
    fireEvent.change(input, { target: { value: 'First name' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => { expect(input.readOnly).toBe(false); expect(moves).toEqual(['created-1']); });
    if (newSession) {
      fireEvent.keyDown(input, { key: 'Escape' });
      await waitFor(() => { expect(screen.queryByLabelText('Collection name') === null).toBe(true); });
      fireEvent.click(within(dialog).getByRole('button', { name: 'New collection' }));
      input = screen.getByLabelText<HTMLInputElement>('Collection name');
    }
    fireEvent.change(input, { target: { value: 'Second name' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => { expect(moves).toEqual(['created-1', 'created-2']); });
    expect(creates).toEqual(['First name', 'Second name']);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(screen.queryByRole('dialog', { name: 'Move to collection' }) === null).toBe(true);
  });

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
    await waitFor(() => {
      expect(screen.queryByLabelText('Rename collection')).toBeNull();
      expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: /Logo concepts/i }));
    });
    expect(screen.getByRole('dialog', { name: 'Move to collection' })).toBe(dialog);
    fireEvent.keyDown(within(dialog).getByRole('button', { name: /Logo concepts/i }), { key: 'Escape' });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(screen.queryByRole('dialog', { name: 'Move to collection' })).toBeNull();
    await waitFor(() => { expect(document.activeElement).toBe(getMoreBtn()); });
  });

  test('Escape from New collection restores its remounted button before a second Escape closes', async () => {
    const { calls } = renderBatch(batch());
    const dialog = await openMove();
    fireEvent.click(within(dialog).getByRole('button', { name: 'New collection' }));
    const input = screen.getByLabelText('Collection name');
    fireEvent.change(input, { target: { value: 'Unsaved collection' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByLabelText('Collection name')).toBeNull();
      expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'New collection' }));
    });
    expect(calls.some((call) => call.method === 'POST' || call.method === 'PATCH')).toBe(false);
    fireEvent.keyDown(within(dialog).getByRole('button', { name: 'New collection' }), { key: 'Escape' });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(screen.queryByRole('dialog', { name: 'Move to collection' })).toBeNull();
    await waitFor(() => { expect(document.activeElement).toBe(getMoreBtn()); });
  });

  test.each([
    { kind: 'create', draft: '   ' },
    { kind: 'rename', draft: '   ' },
    { kind: 'rename', draft: 'Logo concepts' },
  ])('$kind with an empty or unchanged name restores the remounted control on Enter ($draft)', async ({ kind, draft }) => {
    const { calls } = renderBatch(batch());
    const dialog = await openMove();
    const name = kind === 'create' ? 'New collection' : 'Logo concepts';
    const control = within(dialog).getByRole('button', { name });
    if (kind === 'create') fireEvent.click(control);
    else fireEvent.doubleClick(control);
    const input = screen.getByLabelText(kind === 'create' ? 'Collection name' : 'Rename collection');
    fireEvent.change(input, { target: { value: draft } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(screen.queryByRole('textbox')).toBeNull();
      expect(document.activeElement).toBe(within(dialog).getByRole('button', { name }));
    });
    expect(calls.some((call) => call.method === 'POST' || call.method === 'PATCH')).toBe(false);
  });

  test.each(['create', 'rename'])('%s keeps IME keys in the input and blur leaves focus on another reachable control', async (kind) => {
    const { calls } = renderBatch(batch());
    const dialog = await openMove();
    const control = within(dialog).getByRole('button', { name: kind === 'create' ? 'New collection' : 'Logo concepts' });
    if (kind === 'create') fireEvent.click(control);
    else fireEvent.doubleClick(control);
    const input = screen.getByLabelText(kind === 'create' ? 'Collection name' : 'Rename collection');
    fireEvent.change(input, { target: { value: 'Draft' } });
    for (const key of ['Enter', 'Escape']) {
      fireEvent.keyDown(input, { key, isComposing: true });
      fireEvent.keyDown(input, { key, keyCode: 229 });
      expect({ key, active: document.activeElement === input }).toEqual({ key, active: true });
      expect(input.isConnected).toBe(true);
    }
    const other = within(dialog).getByRole('button', { name: 'Studio refs' });
    act(() => { other.focus(); });
    await waitFor(() => {
      expect(screen.queryByRole('textbox')).toBeNull();
      expect(document.activeElement).toBe(other);
    });
    expect(calls.some((call) => call.method === 'POST' || call.method === 'PATCH')).toBe(false);
  });

  test('+ New collection creates and immediately moves the batch into the new collection', async () => {
    const { calls } = renderBatch(batch());
    await openMove();
    fireEvent.click(screen.getByRole('button', { name: 'New collection' }));
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
    await waitFor(() => { expect(document.activeElement === more).toBe(true); });
  });

  test('clicking outside closes the popover', async () => {
    renderBatch(batch());
    await openMove();
    fireEvent.pointerDown(document.body);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(screen.queryByRole('dialog', { name: 'Move to collection' })).toBeNull();
  });

  test('More dismisses before direct Move opens; neither panel carries script geometry', async () => {
    renderBatch(batch());
    fireEvent.click(screen.getByRole('button', { name: /more actions/i }));
    const menu = screen.getByRole('menu', { name: /batch actions/i });
    const panel = menu.closest('[data-mobile]');
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute('data-anchor-place')).toBe('below-end');
    expect(panel?.getAttribute('popover')).toBe('manual');

    const finalItem = screen.getByRole('menuitem', { name: 'Pin batch' });
    finalItem.focus();
    fireEvent.keyDown(finalItem, { key: 'Escape' });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(screen.queryByRole('menu', { name: /batch actions/i })).toBeNull();
    fireEvent.click(getMoreBtn());
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

  test('reduced motion reaches the Move layer through the shared motion tokens', () => {
    const css = readFileSync(new URL('../src/components/MovePopover/index.module.css', import.meta.url), 'utf8');
    const shell = readFileSync(new URL('../src/styles/menuShell.module.css', import.meta.url), 'utf8');
    const motion = readFileSync(new URL('../src/styles/motion.css', import.meta.url), 'utf8');
    // The row press comes from the shared menuShell row; it and the check read
    // the tokens that collapse under reduced motion.
    expect(css).toContain("composes: row from '../../styles/menuShell.module.css';");
    expect(shell).toContain('scale(var(--m-press))');
    expect(css).not.toMatch(/scale\(0\.\d+\)/);
    expect(shell).not.toMatch(/scale\(0\.\d+\)/);
    expect(css).toContain('global(atelier-check-in)');
    const reduced = motion.slice(motion.indexOf('@media (prefers-reduced-motion: reduce)'));
    for (const rule of ['--m-scale: 1;', '--m-press: 1;', '--dur-overlay: var(--dur-reduced);', '--dur-sheet: var(--dur-reduced);']) {
      expect(reduced).toContain(rule);
    }
  });
});

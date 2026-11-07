import type { Batch, Tile } from '@atelier/shared';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useLayoutEffect, type PropsWithChildren } from 'react';
import { historyKeys } from '../../api/history';
import { doneTile, loadingTile } from '../../../test/fixtures/tiles';
import { seedTextModelGate } from '../../../test/fixtures/textModelGate';
import { fixtureModels } from '../../../test/fixtures/models';
import { APP_VIEW_UNSORTED, useAtelierStore } from '../../store/atelier';
import BatchView from './index';
import { resetAnnouncedBatchesForTests } from '../../lib/queueLiveAnnouncer';

afterEach(() => {
  cleanup();
  mock.restore();
  useAtelierStore.setState({ q: '', view: APP_VIEW_UNSORTED });
});

const firstModel = fixtureModels[0];
if (!firstModel) throw new Error('fixtureModels is empty');

const batch: Batch = {
  id: 'b1',
  prompt: 'a koi pond',
  ratio: '1:1',
  modelId: firstModel.id,
  modelLabel: 'Test',
  createdAt: Date.now(),
  collectionId: null,
    pinned: false,
    status: 'done',
  tiles: [
    doneTile('tile-1', 1, 'ONE'),
    doneTile('tile-2', 2, 'TWO'),
  ],
};

function wrap() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function W({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function wrapperFor(client: QueryClient) {
  return function W({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function renderBatch(promptsEnabled: boolean, onBatchAction = mock()) {
  render(
    <BatchView
      batch={batch}
      modelById={new Map(fixtureModels.map((model) => [model.id, model]))}
      activeView={APP_VIEW_UNSORTED}
      promptsEnabled={promptsEnabled}
      onBatchAction={onBatchAction}
      onTileAction={mock()}
      onOpenTile={mock()}
      isAboveFold
      q=""
    />,
    { wrapper: wrap() },
  );
  return { onBatchAction };
}

describe('BatchView save-to-templates button', () => {
  test('read-only stale rows disable mutating and open actions', () => {
    const onBatchAction = mock();
    const onTileAction = mock();
    const onOpenTile = mock();
    render(
      <BatchView
        batch={batch}
        modelById={new Map(fixtureModels.map((model) => [model.id, model]))}
        activeView={APP_VIEW_UNSORTED}
        promptsEnabled
        readOnlyActions
        onBatchAction={onBatchAction}
        onTileAction={onTileAction}
        onOpenTile={onOpenTile}
        q=""
      />,
      { wrapper: wrap() },
    );

    // Header buttons that remain directly visible
    for (const label of [
      /^Open image 1\b/,
      'Download tile',
      'Archive tile',
      'Expand tile 1',
      'Archive batch',
      'Re-roll',
      'Move to collection',
    ]) {
      const controls = screen.getAllByLabelText(label);
      for (const control of controls) {
        if (!(control instanceof HTMLButtonElement)) throw new Error(`expected button for ${label}`);
        expect(control.disabled).toBe(true);
      }
    }

    // Overflow menu items are disabled under readOnlyActions (open the menu to check)
    fireEvent.click(screen.getByRole('button', { name: /more actions/i }));
    for (const name of ['Pin batch']) {
      const item = screen.getByRole('menuitem', { name: new RegExp(name, 'i') });
      if (!(item instanceof HTMLButtonElement)) throw new Error(`expected button for ${name}`);
      expect(item.disabled).toBe(true);
    }

    fireEvent.click(screen.getByLabelText('Archive batch'));
    fireEvent.click(screen.getByLabelText(/^Open image 1\b/));
    expect(onBatchAction).not.toHaveBeenCalled();
    expect(onTileAction).not.toHaveBeenCalled();
    expect(onOpenTile).not.toHaveBeenCalled();
  });

  test('model label lookup uses the supplied model map instead of scanning models', () => {
    const throwingModels = [...fixtureModels] as typeof fixtureModels & { find: typeof fixtureModels.find };
    throwingModels.find = () => { throw new Error('models.find should not run for batch model lookup'); };

    render(
      <BatchView
        batch={batch}
        modelById={new Map(fixtureModels.map((model) => [model.id, model]))}
        activeView={APP_VIEW_UNSORTED}
        promptsEnabled={false}
        onBatchAction={mock()}
        onTileAction={mock()}
        onOpenTile={mock()}
        q=""
      />,
      { wrapper: wrap() },
    );

    expect(screen.getByText(firstModel.name)).toBeTruthy();
  });

  test('hidden when prompt library disabled', () => {
    renderBatch(false);
    // Save to templates is now in the overflow menu — open it and verify it's absent
    fireEvent.click(screen.getByRole('button', { name: /more actions/i }));
    expect(screen.queryByRole('menuitem', { name: /save to templates/i })).toBeNull();
  });

  test('shown when enabled and dispatches saveTemplate', () => {
    const { onBatchAction } = renderBatch(true);
    // Save to templates is in the overflow menu
    fireEvent.click(screen.getByRole('button', { name: /more actions/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /save to templates/i }));
    expect(onBatchAction).toHaveBeenCalledWith('saveTemplate', batch);
  });

  test('direct actions keep their order and leave no duplicate paths in More', () => {
    renderBatch(true);
    // Direct actions follow the approved order, without duplicate menu paths.
    const actions = screen.getByLabelText('Archive batch').parentElement;
    if (!actions) throw new Error('action cluster not found');
    const headerLabels = Array.from(actions.querySelectorAll('button')).map((b) => b.getAttribute('aria-label'));
    expect(headerLabels).toEqual(['Copy prompt', 'Re-roll', 'Move to collection', 'Archive batch', 'More actions']);
    // Overflow menu contains the collapsed actions
    fireEvent.click(screen.getByRole('button', { name: /more actions/i }));
    expect(screen.queryByRole('menuitem', { name: /copy prompt/i })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /re-roll/i })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /move to collection/i })).toBeNull();
    expect(screen.getByRole('menuitem', { name: /save to templates/i })).toBeTruthy();
  });

  test('one direct activation dispatches Copy and Re-roll exactly once with the current batch', () => {
    const { onBatchAction } = renderBatch(true);
    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }));
    fireEvent.click(screen.getByRole('button', { name: 'Re-roll' }));
    expect(onBatchAction.mock.calls).toEqual([['copy', batch], ['reroll', batch]]);
  });

  test('More focuses its invoker before opening when activation leaves another control focused', () => {
    renderBatch(false);
    const trigger = screen.getByRole('button', { name: 'More actions' });
    screen.getByRole('button', { name: 'Archive batch' }).focus();
    const expandedAtFocus: (string | null)[] = [];
    trigger.addEventListener('focus', () => { expandedAtFocus.push(trigger.getAttribute('aria-expanded')); });
    fireEvent.click(trigger);
    expect(expandedAtFocus).toEqual(['false']);
    expect(screen.getByRole('menu', { name: 'Batch actions' })).toBeTruthy();
  });

  test('More disappears with its final canonical item and cannot retain an orphan menu', () => {
    const props = { batch, modelById: new Map(fixtureModels.map((model) => [model.id, model])), activeView: APP_VIEW_UNSORTED,
      promptsEnabled: false, onBatchAction: mock(), onTileAction: mock(), onOpenTile: mock(), q: '' };
    const { rerender } = render(<BatchView {...props} />, { wrapper: wrap() });
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('menuitem', { name: 'Pin batch' })).toBeTruthy();
    rerender(<BatchView {...props} batch={{ ...batch, pinned: true }} />);
    expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
    expect(screen.queryByRole('menu', { name: 'Batch actions' })).toBeNull();
    rerender(<BatchView {...props} />);
    expect(screen.getByRole('button', { name: 'More actions' }).getAttribute('aria-expanded')).toBe('false');
  });

  test.each([false, true])('optimistic Pin removes final More after menu cleanup and respects move-on=%s', async (moveOn) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const key = historyKeys.scoped(APP_VIEW_UNSORTED, '');
    const initial = { pages: [{ items: [batch], nextCursor: null }], pageParams: [undefined] };
    client.setQueryData(key, initial);
    const writes: unknown[] = [];
    let release!: (response: Response) => void;
    globalThis.fetch = mock((_input: RequestInfo | URL, init?: RequestInit) => {
      writes.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as unknown);
      return new Promise<Response>((resolve) => { release = resolve; });
    }) as unknown as typeof fetch;
    function CachedBatch() {
      const query = useQuery({ queryKey: key, queryFn: () => Promise.resolve(initial), enabled: false });
      const current = query.data?.pages[0]?.items[0];
      if (!current) throw new Error('missing cached batch');
      return <BatchView batch={current} modelById={new Map(fixtureModels.map((model) => [model.id, model]))}
        activeView={APP_VIEW_UNSORTED} promptsEnabled={false} onBatchAction={mock()} onTileAction={mock()} onOpenTile={mock()} q="" />;
    }
    render(<CachedBatch />, { wrapper: wrapperFor(client) });
    const more = screen.getByRole('button', { name: 'More actions' });
    fireEvent.click(more);
    const pin = screen.getByRole('menuitem', { name: 'Pin batch' });
    act(() => { pin.focus(); });
    fireEvent.click(pin);
    // OverflowMenu flushes closure before the mutation's async onMutate.
    expect(screen.queryByRole('menu') === null).toBe(true);
    expect(more.isConnected).toBe(true);
    const copy = screen.getByRole('button', { name: 'Copy prompt' });
    if (moveOn) act(() => { copy.focus(); });
    const move = screen.getByRole('button', { name: 'Move to collection' });
    await waitFor(() => {
      expect(writes).toEqual([{ pinned: true }]);
      expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
      expect(document.activeElement === (moveOn ? copy : move)).toBe(true);
    });
    expect(move.isConnected).toBe(true);
    await act(async () => { release(Response.json({ ...batch, pinned: true })); await Promise.resolve(); });
    await waitFor(() => { expect(client.isMutating()).toBe(0); });
    expect(document.activeElement === (moveOn ? copy : move)).toBe(true);
  });

  test.each(['trigger', 'menu', 'elsewhere'] as const)('canonical availability removal preserves focus owned by %s', async (owner) => {
    const props = { batch, modelById: new Map(fixtureModels.map((model) => [model.id, model])), activeView: APP_VIEW_UNSORTED,
      promptsEnabled: false, onBatchAction: mock(), onTileAction: mock(), onOpenTile: mock(), q: '' };
    const { rerender } = render(<BatchView {...props} />, { wrapper: wrap() });
    const more = screen.getByRole('button', { name: 'More actions' });
    if (owner === 'menu') {
      fireEvent.click(more);
      act(() => { screen.getByRole('menuitem', { name: 'Pin batch' }).focus(); });
    } else act(() => { (owner === 'trigger' ? more : screen.getByRole('button', { name: 'Copy prompt' })).focus(); });
    rerender(<BatchView {...props} batch={{ ...batch, pinned: true }} />);
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
      expect(screen.queryByRole('menu')).toBeNull();
      expect(document.activeElement === screen.getByRole('button', { name: owner === 'elsewhere' ? 'Copy prompt' : 'Move to collection' })).toBe(true);
    });
  });

  test('marks only the first tile in the above-fold batch as high fetch priority', () => {
    renderBatch(false);
    const images = screen.getAllByRole('img', { name: /Generated image/ });
    expect(images[0]?.getAttribute('fetchpriority')).toBe('high');
    expect(images[1]?.hasAttribute('fetchpriority')).toBe(false);
  });
});

describe('BatchView grid sizing variables', () => {
  test('grid element exposes tile count and the inline tile ratio', () => {
    renderBatch(false);
    const grid = document.querySelector('[data-testid="batch-grid"]');
    if (!grid || !(grid instanceof HTMLElement)) {
      throw new Error('grid element not rendered');
    }
    expect(grid.dataset.tileCount).toBe('2');
    expect(grid.style.getPropertyValue('--tile-ratio-num')).toBe('1');
  });
});

describe('BatchView deferred snapshot', () => {
  // The whole batch renders from one useDeferredValue snapshot, so a removal
  // commits in a Transition (which is what activates the tile <ViewTransition>
  // boundaries) and the header, grid and handlers never disagree.
  test('an urgent batch update reaches the DOM only through the deferred render', () => {
    const modelById = new Map(fixtureModels.map((model) => [model.id, model]));
    const urgentCounts: (string | undefined)[] = [];
    function Probe({ value }: { value: Batch }) {
      useLayoutEffect(() => {
        const grid = document.querySelector<HTMLElement>('[data-testid="batch-grid"]');
        urgentCounts.push(grid?.dataset.tileCount);
      }, [value]);
      return null;
    }
    const onTileAction = mock();
    const view = (value: Batch) => (
      <>
        <BatchView
          batch={value}
          modelById={modelById}
          activeView={APP_VIEW_UNSORTED}
          promptsEnabled={false}
          onBatchAction={mock()}
          onTileAction={onTileAction}
          onOpenTile={mock()}
          q=""
        />
        <Probe value={value} />
      </>
    );
    const { rerender, container } = render(view(batch), { wrapper: wrap() });
    const survivor = batch.tiles[1];
    if (!survivor) throw new Error('fixture batch needs two tiles');
    const next: Batch = { ...batch, tiles: [survivor] };

    rerender(view(next));

    // The urgent commit (the Probe's layout effect) still showed two tiles;
    // the deferred render then committed the removal as one snapshot.
    expect(urgentCounts).toEqual(['2', '2']);
    const grid = container.querySelector<HTMLElement>('[data-testid="batch-grid"]');
    expect(grid?.dataset.tileCount).toBe('1');
    expect(container.querySelectorAll('button[aria-label^="Open image"]')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Archive tile' }));
    expect(onTileAction).toHaveBeenCalledWith('delete', next, survivor);
  });
});

describe('BatchView tile memoization (SSE re-render path)', () => {
  test('an SSE-style single-tile flip keeps unchanged sibling DOM identity', () => {
    // SSE hot path: only one tile in `batch.tiles` flips status; the others
    // keep the same Tile reference. With the per-tile memo'd TileRow wrapper
    // AND stable callbacks-by-ref-identity from the parent (handler props
    // memoized in App + useTogglePin no longer triggering re-render via a
    // store subscription), the sibling tile's DOM node is reused. If a
    // future regression replaces the TileRow wrapper with inline closures
    // (callback identity churn defeats the leaf-tile memo), the underlying
    // memo'd ImageTile would still skip render because its `tile` ref is
    // stable — so this is a smoke test, not the perf-load-bearing assertion.
    const stableTile = doneTile('tile-stable', 9, 'STABLE');
    const initialBatch: Batch = {
      ...batch,
      tiles: [loadingTile('tile-changing', 1), stableTile],
    };
    const onTileAction = mock();
    const onOpenTile = mock();

    const { rerender, container } = render(
      <BatchView
        batch={initialBatch}
        modelById={new Map(fixtureModels.map((model) => [model.id, model]))}
        activeView={APP_VIEW_UNSORTED}
        promptsEnabled={false}
        onBatchAction={mock()}
        onTileAction={onTileAction}
        onOpenTile={onOpenTile}
        q=""
      />,
      { wrapper: wrap() },
    );

    const stableTileButtonBefore = container.querySelector('button[aria-label^="Open image 2"]');
    expect(stableTileButtonBefore).toBeTruthy();

    const completedTile: Tile = doneTile('tile-changing', 1, 'CHANGING');
    const nextBatch: Batch = {
      ...initialBatch,
      tiles: [completedTile, stableTile],
    };

    rerender(
      <BatchView
        batch={nextBatch}
        modelById={new Map(fixtureModels.map((model) => [model.id, model]))}
        activeView={APP_VIEW_UNSORTED}
        promptsEnabled={false}
        onBatchAction={mock()}
        onTileAction={onTileAction}
        onOpenTile={onOpenTile}
        q=""
      />,
    );

    const stableTileButtonAfter = container.querySelector('button[aria-label^="Open image 2"]');
    expect(stableTileButtonAfter).toBe(stableTileButtonBefore);
  });

  test('a standalone clip that becomes a non-tail segment drops Extend/Tell Story and hands off the new batch', () => {
    // Everything a row's comparator could key on stays put — same `tiles` ref,
    // same model map, same callbacks — while batch-level fields the row
    // consumes (sequence, sequenceIndex, prompt) change underneath it.
    const videoModel = {
      ...firstModel,
      id: 'minimax-h3-i2v',
      name: 'MiniMax H3 I2V',
      supportsI2V: true,
      outputsVideo: true,
      maxCountPerBatch: 1,
    };
    const modelById = new Map([
      ...fixtureModels.map((model) => [model.id, model] as const),
      [videoModel.id, videoModel] as const,
    ]);
    const clip: Tile = {
      id: 'clip-1',
      status: 'done',
      seed: 1,
      url: '/clip.mp4',
      ext: 'mp4',
      mime: 'video/mp4',
      completedAt: Date.now() - 120_000,
    };
    const standalone: Batch = {
      ...batch,
      id: 'video-batch',
      prompt: 'old prompt',
      modelId: videoModel.id,
      modelLabel: videoModel.name,
      tiles: [clip],
    };
    const segment: Batch = {
      ...standalone,
      prompt: 'new prompt',
      sequence: { id: 'seq-1', segmentCount: 2, totalDurationFrames: 248, masterStatus: 'idle' },
      sequenceIndex: 0,
    };
    expect(segment.tiles).toBe(standalone.tiles);
    const onBatchAction = mock();
    const onTileAction = mock();
    const onOpenTile = mock();
    const onTellStoryTile = mock(() => Promise.resolve(true));
    const view = (current: Batch) => (
      <BatchView
        batch={current}
        modelById={modelById}
        activeView={APP_VIEW_UNSORTED}
        promptsEnabled={false}
        onBatchAction={onBatchAction}
        onTileAction={onTileAction}
        onOpenTile={onOpenTile}
        onTellStoryTile={onTellStoryTile}
        q=""
      />
    );

    const { rerender } = render(view(standalone), { wrapper: wrap() });
    expect(screen.getByRole('button', { name: 'Extend video 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Tell story from video 1' })).toBeTruthy();
    const frameBefore = screen.getByRole('button', { name: 'Open image 1: old prompt' });

    rerender(view(segment));

    expect(screen.queryByRole('button', { name: 'Extend video 1' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Tell story from video 1' })).toBeNull();
    const frameAfter = screen.getByRole('button', { name: 'Open image 1: new prompt' });
    // Existing DOM identity survives the re-render.
    expect(frameAfter).toBe(frameBefore);

    fireEvent.click(frameAfter);
    expect(onOpenTile).toHaveBeenCalledWith(segment, clip);
    fireEvent.click(screen.getByRole('button', { name: 'Download tile' }));
    expect(onTileAction).toHaveBeenCalledWith('download', segment, clip);
  });

  test('tile Tell Story opens the text-model note instead of the story when no text model exists', async () => {
    const videoModel = { ...firstModel, id: 'minimax-h3-i2v', name: 'MiniMax H3 I2V', supportsI2V: true, outputsVideo: true, maxCountPerBatch: 1 };
    const modelById = new Map([...fixtureModels.map((model) => [model.id, model] as const), [videoModel.id, videoModel] as const]);
    const clip: Tile = { id: 'clip-1', status: 'done', seed: 1, url: '/clip.mp4', ext: 'mp4', mime: 'video/mp4', completedAt: Date.now() - 120_000 };
    const standalone: Batch = { ...batch, id: 'video-batch', modelId: videoModel.id, modelLabel: videoModel.name, tiles: [clip] };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seedTextModelGate(client, { models: { models: [], tasks: [], defaults: { byTask: {} }, writers: {} } });
    const onTellStoryTile = mock(() => Promise.resolve(true));
    render(
      <BatchView
        batch={standalone}
        modelById={modelById}
        activeView={APP_VIEW_UNSORTED}
        promptsEnabled={false}
        onBatchAction={mock()}
        onTileAction={mock()}
        onOpenTile={mock()}
        onTellStoryTile={onTellStoryTile}
        q=""
      />,
      { wrapper: wrapperFor(client) },
    );

    const trigger = screen.getByRole('button', { name: 'Tell story from video 1' });
    fireEvent.click(trigger);

    const note = await screen.findByRole('dialog', { name: 'Tell Story needs a text model.' });
    expect(note).toBeTruthy();
    expect(onTellStoryTile).not.toHaveBeenCalled();
  });
});

describe('BatchView move scope', () => {
  test('the collection token names its current collection and retains the move handler', async () => {
    const currentCollection = { id: 'collection-1', name: 'Portraits', count: 1, archivedCount: 0, createdAt: 1 };
    const moves: unknown[] = [];
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/collections')) return Response.json({
        items: [currentCollection],
        summary: { totalCount: 1, pinnedCount: 0, unsortedCount: 0, archivedTotalCount: 0, archivedPinnedCount: 0, archivedUnsortedCount: 0 },
      });
      if (url.endsWith('/history/b1') && init?.method === 'PATCH') {
        moves.push(JSON.parse(typeof init.body === 'string' ? init.body : '{}'));
        return Response.json({ ...batch, collectionId: null });
      }
      throw new Error(`Unexpected ${url}`);
    }) as unknown as typeof fetch;
    render(
      <BatchView
        batch={{ ...batch, collectionId: currentCollection.id }}
        currentCollection={currentCollection}
        modelById={new Map(fixtureModels.map((model) => [model.id, model]))}
        activeView={APP_VIEW_UNSORTED}
        promptsEnabled={false}
        onBatchAction={mock()}
        onTileAction={mock()}
        onOpenTile={mock()}
        q=""
      />,
      { wrapper: wrap() },
    );
    const token = screen.getByRole('button', { name: 'Portraits, move to collection' });
    expect(token.getAttribute('aria-haspopup')).toBe('dialog');
    expect(token.getAttribute('aria-expanded')).toBe('false');
    expect((token as HTMLButtonElement).disabled).toBe(false);
    expect(token.hasAttribute('data-tip')).toBe(false);
    fireEvent.click(token);
    expect(await screen.findByRole('dialog', { name: 'Move to collection' })).toBeTruthy();
    expect(token.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '(Unsorted)' }));
    await waitFor(() => { expect(moves).toEqual([{ collectionId: null }]); });
  });

  test('MovePopover moves against the debounced prop scope instead of live store search', async () => {
    useAtelierStore.setState({ view: { kind: 'pinned' }, q: 'live' });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const propScopedKey = historyKeys.scoped(APP_VIEW_UNSORTED, 'debounced');
    const liveScopedKey = historyKeys.scoped({ kind: 'pinned' }, 'live');
    const initialData = {
      pages: [{ items: [batch], nextCursor: null }],
      pageParams: [null],
    };
    client.setQueryData(propScopedKey, initialData);
    client.setQueryData(liveScopedKey, initialData);
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/collections')) {
        return Response.json({
          items: [{ id: 'collection-1', name: 'Portraits', count: 1, archivedCount: 0, createdAt: 1 }],
          summary: {
            totalCount: 1,
            pinnedCount: 0,
            unsortedCount: 1,
            archivedTotalCount: 0,
            archivedPinnedCount: 0,
            archivedUnsortedCount: 0,
          },
        });
      }
      if (url.endsWith('/history/b1') && init?.method === 'PATCH') {
        return Response.json({ ...batch, collectionId: 'collection-1' });
      }
      throw new Error(`Unexpected ${url}`);
    }) as unknown as typeof fetch;

    render(
      <BatchView
        batch={batch}
        modelById={new Map(fixtureModels.map((model) => [model.id, model]))}
        activeView={APP_VIEW_UNSORTED}
        promptsEnabled={false}
        onBatchAction={mock()}
        onTileAction={mock()}
        onOpenTile={mock()}
        q="debounced"
      />,
      { wrapper: wrapperFor(client) },
    );

    fireEvent.click(screen.getByRole('button', { name: /move to collection/i }));
    fireEvent.click(await screen.findByText('Portraits'));

    await waitFor(() => {
      expect(client.getQueryData<typeof initialData>(propScopedKey)?.pages[0]?.items).toEqual([]);
    });
    expect(client.getQueryData<typeof initialData>(liveScopedKey)?.pages[0]?.items).toEqual([batch]);
  });
});

describe('BatchView generated-image edit action', () => {
  test('shows Edit for images from a reference-capable model and dispatches the concrete tile', async () => {
    const onEditTile = mock(() => Promise.resolve(true));
    render(
      <BatchView
        batch={batch}
        modelById={new Map(fixtureModels.map((model) => [model.id, model]))}
        activeView={APP_VIEW_UNSORTED}
        promptsEnabled={false}
        onBatchAction={mock()}
        onTileAction={mock()}
        onOpenTile={mock()}
        onEditTile={onEditTile}
        q=""
      />,
      { wrapper: wrap() },
    );

    // The resolved handoff settles the button's pending state.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Edit image 1' })); await Promise.resolve(); });
    expect(onEditTile).toHaveBeenCalledWith(batch, batch.tiles[0]);
  });

  test('hides Edit when the source model does not accept reference images', () => {
    const model = fixtureModels.find((candidate) => candidate.supportsReferenceImages !== true);
    if (!model) throw new Error('expected a model without reference-image support');
    render(
      <BatchView
        batch={{ ...batch, modelId: model.id, modelLabel: model.name }}
        modelById={new Map(fixtureModels.map((candidate) => [candidate.id, candidate]))}
        activeView={APP_VIEW_UNSORTED}
        promptsEnabled={false}
        onBatchAction={mock()}
        onTileAction={mock()}
        onOpenTile={mock()}
        onEditTile={mock(() => Promise.resolve(true))}
        q=""
      />,
      { wrapper: wrap() },
    );

    expect(screen.queryByRole('button', { name: 'Edit image 1' })).toBeNull();
  });
});

describe('BatchView screen-reader live status', () => {
  const modelById = new Map(fixtureModels.map((model) => [model.id, model]));

  test('an actively generating batch announces progress via role=status', async () => {
    const activeBatch: Batch = {
      ...batch,
      status: 'running',
      tiles: [loadingTile('l1', 1), doneTile('d1', 2, 'D1')],
    };
    render(
      <BatchView
        batch={activeBatch}
        modelById={modelById}
        activeView={APP_VIEW_UNSORTED}
        promptsEnabled={false}
        onBatchAction={mock()}
        onTileAction={mock()}
        onOpenTile={mock()}
        q=""
      />,
      { wrapper: wrap() },
    );
    // everActive flips on after the mount effect → ''→content transition.
    await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('Generating'); });
  });

  test('a settled (all-done) batch keeps its live region silent', () => {
    render(
      <BatchView
        batch={batch}
        modelById={modelById}
        activeView={APP_VIEW_UNSORTED}
        promptsEnabled={false}
        onBatchAction={mock()}
        onTileAction={mock()}
        onOpenTile={mock()}
        q=""
      />,
      { wrapper: wrap() },
    );
    expect(screen.getByRole('status').textContent).toBe('');
  });

  test('a loading video tile exposes determinate tile progress', () => {
    useAtelierStore.setState({ tileProgress: { l1: { progress: 0.4, msPerUnit: null, lastDelta: null, observations: 1, lastAt: Date.now() } } });
    const activeBatch: Batch = {
      ...batch,
      modelId: 'minimax-h3-i2v',
      modelLabel: 'MiniMax H3 I2V',
      status: 'running',
      tiles: [loadingTile('l1', 1)],
    };
    const videoModelById = new Map([
      ...fixtureModels.map((model) => [model.id, model] as const),
      ['minimax-h3-i2v', {
        ...firstModel,
        id: 'minimax-h3-i2v',
        name: 'MiniMax H3 I2V',
        supportsI2V: true,
        maxCountPerBatch: 1,
        defaultCount: 1,
      }],
    ]);
    render(
      <BatchView
        batch={activeBatch}
        modelById={videoModelById}
        activeView={APP_VIEW_UNSORTED}
        promptsEnabled={false}
        onBatchAction={mock()}
        onTileAction={mock()}
        onOpenTile={mock()}
        q=""
      />,
      { wrapper: wrap() },
    );

    const progress = screen.getByRole('progressbar', { name: 'Generation progress' });
    expect(progress.getAttribute('aria-valuenow')).toBe('40');
    expect(progress.getAttribute('aria-valuetext')).toBe('40%');
  });
});

describe('BatchView running clock', () => {
  test('counts render time from dispatch, not from submission', () => {
    const now = Date.now();
    const running: Batch = {
      ...batch,
      id: 'b-running',
      status: 'running',
      createdAt: now - 95_000,
      startedAt: now,
      tiles: [loadingTile('tile-running', 1)],
    };
    render(
      <BatchView
        batch={running}
        modelById={new Map(fixtureModels.map((model) => [model.id, model]))}
        activeView={APP_VIEW_UNSORTED}
        promptsEnabled={false}
        onBatchAction={mock()}
        onTileAction={mock()}
        onOpenTile={mock()}
        q=""
      />,
      { wrapper: wrap() },
    );

    expect(screen.getByText(/^0s$/)).toBeTruthy();
    expect(screen.queryByText(/^9\ds$/)).toBeNull();
  });
});

describe('BatchView live status', () => {
  function renderLive(current: Batch) {
    return render(
      <BatchView
        batch={current}
        modelById={new Map(fixtureModels.map((model) => [model.id, model]))}
        activeView={APP_VIEW_UNSORTED}
        promptsEnabled={false}
        onBatchAction={mock()}
        onTileAction={mock()}
        onOpenTile={mock()}
        q=""
      />,
      { wrapper: wrap() },
    );
  }
  const liveRegion = (container: HTMLElement) => container.querySelector('[role="status"][aria-live="polite"]')?.textContent;
  const pageRegion = () => document.querySelector('[data-atelier-queue-live]')?.textContent;
  afterEach(() => { resetAnnouncedBatchesForTests(); });

  test('hands completion to the page-level announcer once the batch it watched finishes', () => {
    const generating: Batch = { ...batch, id: 'b-live', status: 'running', tiles: [loadingTile('t-a', 1), loadingTile('t-b', 2)] };
    const view = renderLive(generating);
    expect(liveRegion(view.container)).toBe('Generating 2 images: 0 of 2 ready');

    view.rerender(
      <BatchView
        batch={{ ...generating, status: 'done', tiles: [doneTile('t-a', 1, 'A'), doneTile('t-b', 2, 'B')] }}
        modelById={new Map(fixtureModels.map((model) => [model.id, model]))}
        activeView={APP_VIEW_UNSORTED}
        promptsEnabled={false}
        onBatchAction={mock()}
        onTileAction={mock()}
        onOpenTile={mock()}
        q=""
      />,
    );
    expect(liveRegion(view.container)).toBe('');
    expect(pageRegion()).toBe('2 images ready');
  });

  test('announces an all-failed batch instead of staying silent', () => {
    const failedTile: Tile = { id: 't-f', seed: 1, status: 'failed', error: 'internal error', completedAt: 1 };
    const generating: Batch = { ...batch, id: 'b-fail', status: 'running', tiles: [loadingTile('t-f', 1)] };
    const view = renderLive(generating);
    view.rerender(
      <BatchView
        batch={{ ...generating, status: 'done', tiles: [failedTile] }}
        modelById={new Map(fixtureModels.map((model) => [model.id, model]))}
        activeView={APP_VIEW_UNSORTED}
        promptsEnabled={false}
        onBatchAction={mock()}
        onTileAction={mock()}
        onOpenTile={mock()}
        q=""
      />,
    );
    expect(liveRegion(view.container)).toBe('');
    expect(pageRegion()).toBe('1 image failed to generate');
  });
});

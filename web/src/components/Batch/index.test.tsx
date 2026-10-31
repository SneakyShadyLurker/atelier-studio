import type { Batch, Tile } from '@atelier/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { historyKeys } from '../../api/history';
import { doneTile, loadingTile } from '../../../test/fixtures/tiles';
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
    ]) {
      const controls = screen.getAllByLabelText(label);
      for (const control of controls) {
        if (!(control instanceof HTMLButtonElement)) throw new Error(`expected button for ${label}`);
        expect(control.disabled).toBe(true);
      }
    }

    // Overflow menu items are disabled under readOnlyActions (open the menu to check)
    fireEvent.click(screen.getByRole('button', { name: /more actions/i }));
    for (const name of ['Re-roll', 'Move to collection', 'Pin batch']) {
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

  test('visible action row is archive + more; overflow menu has copy, reroll, move', () => {
    renderBatch(true);
    // Direct header buttons: Archive and More actions only (no pinned star since batch.pinned=false)
    const actions = screen.getByLabelText('Archive batch').parentElement;
    if (!actions) throw new Error('action cluster not found');
    const headerLabels = Array.from(actions.querySelectorAll('button')).map((b) => b.getAttribute('aria-label'));
    expect(headerLabels).toEqual(['Archive batch', 'More actions']);
    // Overflow menu contains the collapsed actions
    fireEvent.click(screen.getByRole('button', { name: /more actions/i }));
    expect(screen.getByRole('menuitem', { name: /copy prompt/i })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /re-roll/i })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /move to collection/i })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /save to templates/i })).toBeTruthy();
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
});

describe('BatchView move scope', () => {
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

    // Move is now in the overflow menu
    fireEvent.click(screen.getByRole('button', { name: /more actions/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /move to collection/i }));
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
    useAtelierStore.setState({ tileProgress: { l1: 0.4 } });
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

    expect(screen.getByText(/· 0s$/)).toBeTruthy();
    expect(screen.queryByText(/· 9\ds$/)).toBeNull();
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

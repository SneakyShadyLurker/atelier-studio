import type { ArchivedTile } from '@atelier/shared';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import Archive from './index';

const originalMatchMedia = window.matchMedia.bind(window);

afterEach(() => {
  cleanup();
  window.matchMedia = originalMatchMedia;
});

const noop = () => undefined;

const archivedTile: ArchivedTile = {
  id: 'tile-1',
  batchId: 'batch-1',
  prompt: 'A copper observatory at dusk',
  modelLabel: 'Mock Fast',
  seed: 1,
  status: 'done',
  url: '/api/img/tile-1',
  ext: 'png',
  mime: 'image/png',
  ratio: '1:1',
  completedAt: 1,
  archivedAt: 2,
};

function renderArchive(items: readonly ArchivedTile[]) {
  return render(
    <Archive
      items={items}
      total={items.length}
      isLoading={false}
      isError={false}
      hasNextPage={false}
      isFetchingNextPage={false}
      onLoadMore={noop}
      onRetry={noop}
      onRestore={noop}
      onPermanentDelete={noop}
      onPurgeAll={noop}
      onBack={noop}
      onOpenTile={noop}
    />,
  );
}

describe('Archive header', () => {
  test('shows the shared back button and scope label; back fires onBack', () => {
    const onBack = mock(() => undefined);
    render(
      <Archive
        items={[]}
        total={3}
        isLoading={false}
        isError={false}
        hasNextPage={false}
        isFetchingNextPage={false}
        onLoadMore={noop}
        onRetry={noop}
        onRestore={noop}
        onPermanentDelete={noop}
        onPurgeAll={noop}
        onBack={onBack}
        onOpenTile={noop}
      />,
    );
    expect(screen.queryByText('3 items')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back to Unsorted' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe('Archive tile semantics', () => {
  test('uses a native button frame without nesting restore/delete actions inside it', () => {
    renderArchive([archivedTile]);

    const frame = screen.getByRole('button', { name: `Open archived image: ${archivedTile.prompt}` });
    expect(frame.tagName).toBe('BUTTON');
    expect(frame.querySelector('button')).toBeNull();
    expect(screen.getByRole('button', { name: 'Restore' })).toBeTruthy();
  });

  test('long archive grids do not mount every tile at once', () => {
    const items = Array.from({ length: 80 }, (_, index): ArchivedTile => ({
      ...archivedTile,
      id: `tile-${index}`,
      batchId: `batch-${index}`,
      url: `/api/img/tile-${index}`,
      thumbUrl: `/api/img/tile-${index}/thumb`,
    }));

    renderArchive(items);

    expect(screen.getAllByRole('button', { name: /Open archived image:/ }).length).toBeLessThan(items.length);
  });

  // The exit is the tile's <ViewTransition> (motion.css .tile-exit), driven by
  // the deferred row snapshot: the action hides the tile at once, in either
  // motion mode, and nothing waits on a timer.
  for (const reduced of [false, true]) {
    test(`an action hides the tile at once with no timer (reduced motion: ${String(reduced)})`, () => {
      const onRestore = mock(() => undefined);
      const setTimeoutMock = mock(() => 1) as unknown as typeof window.setTimeout;
      const originalSetTimeout = window.setTimeout.bind(window);
      window.matchMedia = mock((query: string) => ({
        matches: reduced && query.includes('prefers-reduced-motion'),
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => true,
      }));
      try {
        render(
          <Archive
            items={[archivedTile, { ...archivedTile, id: 'tile-2', prompt: 'A second archived image' }]}
            total={2}
            isLoading={false}
            isError={false}
            hasNextPage={false}
            isFetchingNextPage={false}
            onLoadMore={noop}
            onRetry={noop}
            onRestore={onRestore}
            onPermanentDelete={noop}
            onPurgeAll={noop}
            onBack={noop}
            onOpenTile={noop}
          />,
        );
        window.setTimeout = setTimeoutMock;

        const [restore] = screen.getAllByRole('button', { name: 'Restore' });
        if (!restore) throw new Error('missing Restore');
        fireEvent.click(restore);

        expect(onRestore).toHaveBeenCalledWith('tile-1');
        expect(setTimeoutMock).not.toHaveBeenCalled();
        expect(screen.queryByRole('button', { name: `Open archived image: ${archivedTile.prompt}` }) === null).toBe(true);
        expect(screen.queryByRole('button', { name: 'Open archived image: A second archived image' }) === null).toBe(false);
      } finally {
        window.setTimeout = originalSetTimeout;
      }
    });
  }

  test('renders archived video tiles as video with a play badge', () => {
    renderArchive([{
      ...archivedTile,
      id: 'video-1',
      url: '/api/img/video-1',
      thumbUrl: '/api/img/video-1/thumb',
      ext: 'mp4',
      mime: 'video/mp4',
    }]);

    const frame = screen.getByRole('button', { name: `Open archived image: ${archivedTile.prompt}` });
    const video = frame.querySelector('video');
    expect(video).toBeTruthy();
    expect(video?.getAttribute('poster')).toBe('/api/img/video-1/thumb');
    expect(frame.querySelector('img')).toBeNull();
    expect(screen.getByTestId('play-badge')).toBeTruthy();
  });
});

describe('Archive failed actions', () => {
  const frameName = `Open archived image: ${archivedTile.prompt}`;
  // Existence as a boolean: a failing toBeNull/toBeTruthy on a live node
  // pretty-prints its React-owned object graph on every waitFor retry, which
  // alone outlasted the test timeout and stalled the tests after it.
  const frameShown = () => screen.queryByRole('button', { name: frameName }) !== null;

  function renderWithActions(
    onRestore: (tileId: string) => unknown,
    onPermanentDelete: (tileId: string) => unknown,
  ) {
    return render(
      <Archive
        items={[archivedTile]}
        total={1}
        isLoading={false}
        isError={false}
        hasNextPage={false}
        isFetchingNextPage={false}
        onLoadMore={noop}
        onRetry={noop}
        onRestore={onRestore}
        onPermanentDelete={onPermanentDelete}
        onPurgeAll={noop}
        onBack={noop}
        onOpenTile={noop}
      />,
    );
  }

  function deferred() {
    let reject: (reason: unknown) => void = noop;
    const promise = new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; });
    return { promise, reject };
  }

  // Never call these inside an outer act(): each fireEvent is its own act, and
  // a nested act defers its commit to the outer one, so the confirm dialog the
  // first delete click opens would not exist yet for the second click.
  const triggers = {
    restore: () => { fireEvent.click(screen.getByRole('button', { name: 'Restore' })); },
    delete: () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    },
  } as const;
  const flushMicrotasks = async () => { await act(async () => { await Promise.resolve(); }); };

  for (const action of ['restore', 'delete'] as const) {
    test(`${action} rejection restores the pending tile and allows retry`, async () => {
      const handler = mock(() => Promise.reject(new Error('server said no')));
      renderWithActions(
        action === 'restore' ? handler : noop,
        action === 'delete' ? handler : noop,
      );

      triggers[action]();
      await flushMicrotasks();

      expect(handler).toHaveBeenCalledTimes(1);
      await waitFor(() => {
        expect(frameShown()).toBe(true);
      });
      // The retry below only reaches the handler once the pending id cleared.
      triggers[action]();
      await flushMicrotasks();
      expect(handler).toHaveBeenCalledTimes(2);
      await waitFor(() => {
        expect(frameShown()).toBe(true);
      });
    });

    test(`${action} rejection after the tile left brings it back`, async () => {
      const pending = deferred();
      const handler = mock(() => pending.promise);
      renderWithActions(
        action === 'restore' ? handler : noop,
        action === 'delete' ? handler : noop,
      );

      triggers[action]();
      expect(handler).toHaveBeenCalledTimes(1);
      await waitFor(() => {
        expect(frameShown()).toBe(false);
      }, { timeout: 1_000 });

      await act(async () => {
        pending.reject(new Error('server said no'));
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(frameShown()).toBe(true);
      });
    });
  }

  test('a successful restore keeps the tile hidden', async () => {
    const onRestore = mock(() => Promise.resolve());
    renderWithActions(onRestore, noop);

    triggers.restore();
    await waitFor(() => {
      expect(frameShown()).toBe(false);
    }, { timeout: 1_000 });
    expect(onRestore).toHaveBeenCalledWith('tile-1');
    // Still gone once the resolved action has settled.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(frameShown()).toBe(false);
  });

  test('a rejection after unmount does not write state', async () => {
    const pending = deferred();
    const originalError = console.error;
    const errors: unknown[] = [];
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      const view = renderWithActions(() => pending.promise, noop);
      triggers.restore();
      view.unmount();
      pending.reject(new Error('late failure'));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(errors).toEqual([]);
    } finally {
      console.error = originalError;
    }
  });
});

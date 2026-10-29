import type { ArchivedTile, Batch, HistoryPage } from '@atelier/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import App from '../src/App';
import { archiveKeys } from '../src/api/archive';
import { historyKeys } from '../src/api/history';
import Archive from '../src/components/Archive';
import ConfirmDialog from '../src/components/ConfirmDialog';
import Sidebar from '../src/components/Sidebar';
import { fixtureModels } from './fixtures/models';
import { collectionKeys } from '../src/api/collections';
import { useClearAll, clearAllConfirmCopy } from '../src/hooks/useClearAll';
import { useDeleteBatch } from '../src/hooks/useDeleteBatch';
import { useDeleteTile } from '../src/hooks/useDeleteTile';
import { usePermanentDelete } from '../src/hooks/usePermanentDelete';
import { usePurgeArchive } from '../src/hooks/usePurgeArchive';
import { useRestore } from '../src/hooks/useRestore';
import { useKeyboard } from '../src/hooks/useKeyboard';
import { APP_VIEW_ARCHIVE, APP_VIEW_UNSORTED, useAtelierStore } from '../src/store/atelier';

const originalMatchMedia = window.matchMedia.bind(window);

const archivedDone: ArchivedTile = {
  id: 'tile-archive-1',
  batchId: 'batch-archive-1',
  prompt: 'A copper observatory at dusk',
  modelLabel: 'Mock Fast',
  seed: 10,
  status: 'done',
  url: '/api/img/tile-archive-1',
  thumbUrl: '/api/img/tile-archive-1/thumb',
  ext: 'png',
  mime: 'image/png',
  ratio: '1:1',
  completedAt: 100,
  archivedAt: 200,
};

const referencedArchivedDone: ArchivedTile = {
  ...archivedDone,
  refImageIds: ['upload-ref-1'],
};

const archivedVideo: ArchivedTile = {
  ...archivedDone,
  id: 'tile-archive-video',
  url: '/api/img/tile-archive-video',
  thumbUrl: '/api/img/tile-archive-video/thumb',
  ext: 'mp4',
  mime: 'video/mp4',
};

const history: HistoryPage<Batch> = {
  items: [{
    id: 'batch-1',
    prompt: 'a brass lamp',
    ratio: '1:1',
    modelId: 'gpt-image-2.5-sunburst-cloud',
    modelLabel: 'GPT Image 2.5 Sunburst',
    createdAt: 1,
    collectionId: null,
      pinned: false,
      status: 'done',
    tiles: [archivedDone],
  }],
  nextCursor: null,
};

function wrapper(client: QueryClient) {
  return function TestWrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function sidebarWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(collectionKeys.list(), { items: [], summary: { totalCount: history.items.length, pinnedCount: 0, unsortedCount: history.items.length, archivedTotalCount: 0, archivedPinnedCount: 0, archivedUnsortedCount: 0 } });
  return wrapper(client);
}

function ConfirmKeyboardHarness(props: Parameters<typeof ConfirmDialog>[0]) {
  useKeyboard([]);
  return <ConfirmDialog {...props} />;
}

function installMatchMedia(): void {
  window.matchMedia = mock((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: mock(() => undefined),
    removeEventListener: mock(() => undefined),
    addListener: mock(() => undefined),
    removeListener: mock(() => undefined),
    dispatchEvent: mock(() => true),
  }));
}

function installUrl(search = ''): void {
  if (window.location.origin === 'null') window.location.href = 'http://localhost/';
  window.history.replaceState({}, '', `http://localhost/${search}`);
}

afterEach(() => {
  cleanup();
  mock.restore();
  window.matchMedia = originalMatchMedia;
  installUrl();
  useAtelierStore.setState({
    draft: { prompt: '', modelId: '', ratio: '1:1', durationFrames: null, count: 2, refImages: [], rollQueue: [] },
    activeBatchId: null,
    lightbox: null,
    toasts: [],
    view: APP_VIEW_UNSORTED,
  });
});

describe('Sidebar archive button', () => {
  test('selects archive, hides zero count, renders count pill, and marks active', () => {
    useAtelierStore.setState({ view: APP_VIEW_UNSORTED });
    const { rerender } = render(
      <Sidebar
        history={history}
        models={fixtureModels}
        activeBatchId={null}
        historyQ=""
        archivedCount={0}
        onSelect={() => undefined}
        onSelectView={(nextView) => { useAtelierStore.setState({ view: nextView }); }}
        onClear={() => undefined}
      />,
      { wrapper: sidebarWrapper() },
    );

    const archiveButton = screen.getByRole('button', { name: 'Archive' });
    expect(screen.queryByText('3')).toBeNull();
    fireEvent.click(archiveButton);
    expect(useAtelierStore.getState().view).toEqual(APP_VIEW_ARCHIVE);

    rerender(
      <Sidebar
        history={history}
        models={fixtureModels}
        activeBatchId={null}
        historyQ=""
        archivedCount={3}
        onSelect={() => undefined}
        onSelectView={(nextView) => { useAtelierStore.setState({ view: nextView }); }}
        onClear={() => undefined}
      />,
    );

    const activeArchiveButton = screen.getByRole('button', { name: 'Archive' });
    expect(screen.getByText('3')).toBeTruthy();
    expect(activeArchiveButton.getAttribute('aria-pressed')).toBe('true');
  });

  test('archive view hides the sidebar batch list and routes rail rows to archive scope', () => {
    useAtelierStore.setState({ view: APP_VIEW_ARCHIVE });
    render(
      <Sidebar
        history={history}
        models={fixtureModels}
        activeBatchId={null}
        historyQ=""
        archivedCount={1}
        onSelect={() => undefined}
        onSelectView={(nextView) => { useAtelierStore.setState({ view: nextView }); }}
        onClear={() => undefined}
      />,
      { wrapper: sidebarWrapper() },
    );

    // The unscoped batch list (prompts like "a brass lamp") is gone in
    // archive view — the rail is the only navigation affordance.
    expect(screen.queryByText('a brass lamp')).toBeNull();

    // Library rail rows route to archive-scoped views, not to active views.
    fireEvent.click(screen.getByRole('button', { name: /Unsorted/ }));
    expect(useAtelierStore.getState().view).toEqual({ kind: 'archive', scope: { kind: 'unsorted' } });
  });
});

describe('ConfirmDialog', () => {
  test('handles Escape, Enter, and ignores backdrop clicks when danger', async () => {
    const onConfirm = mock();
    const onCancel = mock();
    render(
      <ConfirmKeyboardHarness
        open
        title="Empty archive?"
        body="This permanently deletes 2 images from disk. This cannot be undone."
        confirmLabel="Delete all"
        cancelLabel="Cancel"
        danger
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.mouseDown(screen.getByText('This permanently deletes 2 images from disk. This cannot be undone.'));
    expect(onCancel).not.toHaveBeenCalled();

    // Dismissals ride the shared exit transition (useExitTransition), so the
    // callback lands ~160ms after the gesture; repeat gestures inside that
    // window collapse into one close.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(onCancel).toHaveBeenCalledTimes(1);

    // Enter routes by focused button: Cancel is the destructive-default
    // safe focus, so Enter from there means Cancel. Move focus to Confirm
    // first to actually confirm — prevents "Enter accepts the default" from
    // becoming a destructive footgun.
    fireEvent.keyDown(document, { key: 'Enter' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();

    screen.getByRole('button', { name: 'Delete all' }).focus();
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onConfirm).toHaveBeenCalledTimes(1);

    // role="dialog" now sits on the dismiss backdrop (DialogShell owns the
    // modal a11y attributes); the card is its child. Dismiss fires on backdrop
    // mousedown gated by event.target === currentTarget and is suppressed
    // entirely for danger confirms (closeOnBackdrop=false), so a mousedown on
    // the backdrop must NOT cancel.
    const backdrop = screen.getByRole('dialog');
    expect(backdrop.getAttribute('aria-modal')).toBe('true');
    fireEvent.mouseDown(backdrop);
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  test('non-danger confirmations can still close from the backdrop', async () => {
    const onCancel = mock();
    render(
      <ConfirmKeyboardHarness
        open
        title="Archive all?"
        body="Move everything to archive."
        confirmLabel="Archive all"
        cancelLabel="Cancel"
        onConfirm={() => undefined}
        onCancel={onCancel}
      />,
    );

    // Non-danger confirm (closeOnBackdrop=true): a press AND release on the
    // backdrop — which now carries role="dialog" — dismisses via onCancel.
    // (Both are required so a drag-select releasing over the backdrop can't
    // accidentally dismiss; see DialogShell.)
    const backdrop = screen.getByRole('dialog');
    expect(backdrop.getAttribute('aria-modal')).toBe('true');
    fireEvent.mouseDown(backdrop);
    fireEvent.mouseUp(backdrop);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test('renders nothing while closed', () => {
    render(
      <ConfirmKeyboardHarness
        open={false}
        title="Empty archive?"
        body="Noop"
        confirmLabel="Delete all"
        cancelLabel="Cancel"
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );

    expect(screen.queryByText('Empty archive?')).toBeNull();
  });

  test('captures the trigger on open and restores focus to it on close', async () => {
    function Harness({ open }: { open: boolean }) {
      return (
        <>
          <button type="button" data-testid="trigger">Open</button>
          <ConfirmDialog
            open={open}
            title="Empty archive?"
            body="This cannot be undone."
            confirmLabel="Delete all"
            cancelLabel="Cancel"
            danger
            onConfirm={() => undefined}
            onCancel={() => undefined}
          />
        </>
      );
    }
    const { rerender } = render(<Harness open={false} />);
    const trigger = screen.getByTestId('trigger');
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    rerender(<Harness open />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));

    rerender(<Harness open={false} />);
    // Restore is deferred a macrotask (must run after the inert cleanup).
    await waitFor(() => { expect(document.activeElement).toBe(trigger); });
  });
});

describe('Archive view', () => {
  test('renders empty state and disables Empty Archive when there are no items', () => {
    const onPurgeAll = mock();
    render(
      <Archive
        items={[]}
        total={0}
        isLoading={false}
        isError={false}
        onRetry={() => undefined}
        onRestore={() => undefined}
        onPermanentDelete={() => undefined}
        onPurgeAll={onPurgeAll}
        onBack={() => undefined}
        onOpenTile={() => undefined}
      />,
    );

    expect(screen.getByText('Nothing archived')).toBeTruthy();
    expect(screen.getByText('Deleted images live here for 30 days before they are removed permanently.')).toBeTruthy();
    const emptyArchive = screen.getByRole('button', { name: 'Empty Archive' });
    expect(emptyArchive.hasAttribute('disabled')).toBe(true);
    fireEvent.click(emptyArchive);
    expect(onPurgeAll).not.toHaveBeenCalled();
  });

  test('renders archived tiles and routes tile/body/button interactions', () => {
    const onOpenTile = mock();
    const onRestore = mock();
    const onPermanentDelete = mock();
    const onPurgeAll = mock();
    render(
      <Archive
        items={[archivedDone]}
        total={1}
        isLoading={false}
        isError={false}
        onRetry={() => undefined}
        onRestore={onRestore}
        onPermanentDelete={onPermanentDelete}
        onPurgeAll={onPurgeAll}
        onBack={() => undefined}
        onOpenTile={onOpenTile}
      />,
    );

    expect(screen.getByText('ARCHIVE · 1 ITEM')).toBeTruthy();
    const image = screen.getByRole('img', { name: `${archivedDone.prompt} — generated with ${archivedDone.modelLabel}` });
    expect(image.getAttribute('src')).toBe('/api/img/tile-archive-1/thumb');
    fireEvent.error(image);
    expect(image.getAttribute('src')).toBe('/api/img/tile-archive-1');

    fireEvent.click(screen.getByRole('button', { name: `Open archived image: ${archivedDone.prompt}` }));
    expect(onOpenTile).toHaveBeenCalledWith(archivedDone);

    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(onRestore).toHaveBeenCalledWith(archivedDone.id);
    expect(onOpenTile).toHaveBeenCalledTimes(1);
  });

  test('permanent delete button stops propagation and confirms before deleting', () => {
    const onOpenTile = mock();
    const onPermanentDelete = mock();
    render(
      <Archive
        items={[archivedDone]}
        total={1}
        isLoading={false}
        isError={false}
        onRetry={() => undefined}
        onRestore={() => undefined}
        onPermanentDelete={onPermanentDelete}
        onPurgeAll={() => undefined}
        onBack={() => undefined}
        onOpenTile={onOpenTile}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));
    // Permanent disk deletion now confirms first; the tile click must not
    // have bubbled to open the lightbox either.
    expect(onPermanentDelete).not.toHaveBeenCalled();
    expect(onOpenTile).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onPermanentDelete).toHaveBeenCalledWith(archivedDone.id);
  });

  test('enabled Empty Archive calls purge callback', () => {
    const onPurgeAll = mock();
    render(
      <Archive
        items={[archivedDone]}
        total={1}
        isLoading={false}
        isError={false}
        onRetry={() => undefined}
        onRestore={() => undefined}
        onPermanentDelete={() => undefined}
        onPurgeAll={onPurgeAll}
        onBack={() => undefined}
        onOpenTile={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Empty Archive' }));
    expect(onPurgeAll).toHaveBeenCalled();
  });

  test('Back to feed button calls onBack', () => {
    const onBack = mock();
    render(
      <Archive
        items={[]}
        total={0}
        isLoading={false}
        isError={false}
        onRetry={() => undefined}
        onRestore={() => undefined}
        onPermanentDelete={() => undefined}
        onPurgeAll={() => undefined}
        onBack={onBack}
        onOpenTile={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Back to feed' }));
    expect(onBack).toHaveBeenCalled();
  });

  test('archive lightbox permanent delete confirms before deleting', async () => {
    installMatchMedia();
    installUrl('?view=archive');
    const deleteCalls: string[] = [];
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/models')) return Response.json(fixtureModels);
      if (url.endsWith('/collections')) {
        return Response.json({
          items: [],
          summary: {
            totalCount: 0,
            pinnedCount: 0,
            unsortedCount: 0,
            archivedTotalCount: 1,
            archivedPinnedCount: 0,
            archivedUnsortedCount: 1,
          },
        });
      }
      if (url.includes('/history')) return Response.json({ items: [], nextCursor: null });
      if (url.includes('/prompts')) return Response.json({ error: 'not found' }, { status: 404 });
      if (url.includes('/archive/tile-archive-1') && init?.method === 'DELETE') {
        deleteCalls.push(url);
        return new Response(null, { status: 204 });
      }
      if (url.includes('/archive')) return Response.json({ items: [referencedArchivedDone], nextCursor: null, total: 1 });
      return Response.json({});
    }) as unknown as typeof fetch;

    render(<App />, { wrapper: wrapper(new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })) });

    fireEvent.click(await screen.findByRole('button', { name: `Open archived image: ${referencedArchivedDone.prompt}` }));
    expect(await screen.findByRole('button', { name: 'View reference image 1 of 1' })).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete expanded image permanently' }));

    expect(screen.getByText('Delete permanently?')).toBeTruthy();
    expect(deleteCalls).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(deleteCalls).toEqual(['/api/archive/tile-archive-1']);
    });
  });

  test('archive lightbox preserves video poster from archived thumbUrl', async () => {
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/models')) return Response.json(fixtureModels);
      if (url.endsWith('/collections')) {
        return Response.json({
          items: [],
          summary: {
            totalCount: 0,
            pinnedCount: 0,
            unsortedCount: 0,
            archivedTotalCount: 1,
            archivedPinnedCount: 0,
            archivedUnsortedCount: 1,
          },
        });
      }
      if (url.includes('/history')) return Response.json({ items: [], nextCursor: null });
      if (url.includes('/prompts')) return Response.json({ error: 'not found' }, { status: 404 });
      if (url.includes('/archive')) return Response.json({ items: [archivedVideo], nextCursor: null, total: 1 });
      return Response.json({});
    }) as unknown as typeof fetch;

    render(<App />, { wrapper: wrapper(new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })) });

    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }));
    fireEvent.click(await screen.findByRole('button', { name: `Open archived image: ${archivedVideo.prompt}` }));

    const video = document.body.querySelector('video');
    expect(video).toBeTruthy();
    expect(video?.getAttribute('poster')).toBe('/api/img/tile-archive-video/thumb?media=2');
  });
});

describe('archive-related mutation toasts', () => {
  test('single tile delete toasts Archived and refreshes archive count', async () => {
    globalThis.fetch = mock(() => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    client.setQueryData(archiveKeys.list(), { items: [] });
    const { result } = renderHook(() => useDeleteTile(), { wrapper: wrapper(client) });

    await act(async () => {
      await result.current.mutateAsync({ batchId: 'batch-1', tileId: 'tile-1' });
    });

    expect(useAtelierStore.getState().toasts[0]?.text).toBe('Archived');
    await waitFor(() => { expect(client.getQueryState(archiveKeys.list())?.isInvalidated).toBe(true); });
  });

  test('batch delete toasts Archived and refreshes archive count', async () => {
    globalThis.fetch = mock(() => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    client.setQueryData(archiveKeys.list(), { items: [] });
    const { result } = renderHook(() => useDeleteBatch(), { wrapper: wrapper(client) });

    await act(async () => {
      await result.current.mutateAsync({ batchId: 'batch-1' });
    });

    expect(useAtelierStore.getState().toasts[0]?.text).toBe('Archived');
    await waitFor(() => { expect(client.getQueryState(archiveKeys.list())?.isInvalidated).toBe(true); });
  });

  test('single tile dismiss toasts Dismissed', async () => {
    globalThis.fetch = mock(() => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    client.setQueryData(archiveKeys.list(), { items: [] });
    const { result } = renderHook(() => useDeleteTile(), { wrapper: wrapper(client) });

    await act(async () => {
      await result.current.mutateAsync({ batchId: 'batch-1', tileId: 'tile-1', intent: 'dismiss' });
    });

    expect(useAtelierStore.getState().toasts[0]?.text).toBe('Dismissed');
  });

  test('batch dismiss toasts Dismissed', async () => {
    globalThis.fetch = mock(() => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    client.setQueryData(archiveKeys.list(), { items: [] });
    const { result } = renderHook(() => useDeleteBatch(), { wrapper: wrapper(client) });

    await act(async () => {
      await result.current.mutateAsync({ batchId: 'batch-1', intent: 'dismiss' });
    });

    expect(useAtelierStore.getState().toasts[0]?.text).toBe('Dismissed');
  });

  test('clear all archives history and refreshes archive count', async () => {
    const confirmSpy = mock(() => true);
    window.confirm = confirmSpy;
    globalThis.fetch = mock(() => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    client.setQueryData(archiveKeys.list(), { items: [] });
    const { result } = renderHook(() => useClearAll(), { wrapper: wrapper(client) });

    await act(async () => {
      await result.current.mutateAsync();
    });

    // The confirm prompt moved out of the hook into a ConfirmDialog owned by
    // App; the hook itself must NOT prompt — guard the relocation explicitly.
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(clearAllConfirmCopy(APP_VIEW_UNSORTED)).toBe('Every unsorted batch moves to the Archive.');
    expect(useAtelierStore.getState().toasts[0]?.text).toBe('Archived');
    await waitFor(() => { expect(client.getQueryState(archiveKeys.list())?.isInvalidated).toBe(true); });
  });

  test('restore toasts Restored and refreshes archive and history', async () => {
    globalThis.fetch = mock(() => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    client.setQueryData(archiveKeys.list(), { items: [archivedDone] });
    client.setQueryData(historyKeys.list(), { pages: [{ items: [], nextCursor: null }], pageParams: [null] });
    const { result } = renderHook(() => useRestore(), { wrapper: wrapper(client) });

    await act(async () => {
      await result.current.mutateAsync(archivedDone.id);
    });

    expect(useAtelierStore.getState().toasts[0]?.text).toBe('Restored');
    await waitFor(() => {
      expect(client.getQueryState(archiveKeys.list())?.isInvalidated).toBe(true);
      expect(client.getQueryState(historyKeys.list())?.isInvalidated).toBe(true);
    });
  });

  test('permanent delete toasts Deleted and closes the lightbox', async () => {
    globalThis.fetch = mock(() => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    client.setQueryData(archiveKeys.list(), { items: [archivedDone] });
    useAtelierStore.getState().openLightbox(archivedDone.batchId, archivedDone.id);
    const { result } = renderHook(() => usePermanentDelete(), { wrapper: wrapper(client) });

    await act(async () => {
      await result.current.mutateAsync(archivedDone.id);
    });

    expect(useAtelierStore.getState().toasts[0]?.text).toBe('Deleted');
    expect(useAtelierStore.getState().lightbox).toBeNull();
    await waitFor(() => { expect(client.getQueryState(archiveKeys.list())?.isInvalidated).toBe(true); });
  });

  test('purge archive toasts Archive emptied and clears the archive query', async () => {
    globalThis.fetch = mock(() => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    client.setQueryData(archiveKeys.list(), { items: [archivedDone] });
    const { result } = renderHook(() => usePurgeArchive(), { wrapper: wrapper(client) });

    await act(async () => {
      await result.current.mutateAsync();
    });

    expect(useAtelierStore.getState().toasts[0]?.text).toBe('Archive emptied');
    expect(client.getQueryState(archiveKeys.list())).toBeUndefined();
  });
});

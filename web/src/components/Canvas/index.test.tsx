import type { Batch, Model } from '@atelier/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef, useLayoutEffect, type PropsWithChildren } from 'react';
import Canvas, { canvasBatchKey, type CanvasHandle } from './index';
import { flushSeenBatches, getSeenBatches, resetSeenBatches, SEEN_BATCHES_STORAGE_KEY } from '../../lib/seenBatches';
import { historyKeys, type HistoryData } from '../../api/history';
import { registerComposerYield } from '../Composer/composerYield';
import { APP_VIEW_PINNED, APP_VIEW_UNSORTED, useAtelierStore } from '../../store/atelier';

const originalMatchMedia = window.matchMedia.bind(window);

function installPhone(phone: boolean): void {
  window.matchMedia = mock((query: string) => ({
    matches: phone && query.includes('width < 768px'),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => true,
  }));
}

const canvasProps = {
  batches: [],
  modelById: new Map<string, Model>(),
  collections: [],
  activeView: APP_VIEW_UNSORTED,
  hasNextPage: false,
  isFetchingNextPage: false,
  onLoadMore: mock(),
  onBatchAction: mock(),
  promptsEnabled: false,
  onTileAction: mock(),
  onOpenTile: mock(),
  q: '',
} as const;

const model: Model = {
  id: 'gpt-image-2.6-sunburst',
  name: 'GPT Image',
  backend: 'cloud',
  tag: 'cloud',
  latency: 'slow',
  supportedRatios: ['1:1'],
  concurrencyCapPerUser: 4,
  maxCountPerBatch: 4,
  pool: 'shared',
};

function batchAt(index: number): Batch {
  return {
    id: `batch-${index}`,
    prompt: `Prompt ${index}`,
    ratio: '1:1',
    modelId: model.id,
    modelLabel: model.name,
    createdAt: index + 1,
    collectionId: null,
      pinned: false,
      status: 'done',
    tiles: [{
      id: `tile-${index}`,
      status: 'done',
      url: `/api/img/tile-${index}`,
      ext: 'png',
      mime: 'image/png',
      seed: index,
      completedAt: index + 1,
    }],
  };
}

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return function TestWrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

afterEach(() => {
  cleanup();
  flushSeenBatches();
  sessionStorage.clear();
  resetSeenBatches();
  window.matchMedia = originalMatchMedia;
  useAtelierStore.setState({ composerExpanded: false });
});

describe('Canvas passive keyboard access', () => {
  test('shares the approved hint alternatives in an empty Unsorted canvas', () => {
    render(<Canvas {...canvasProps} activeView={APP_VIEW_UNSORTED} />);
    expect(screen.getByText(/Write a prompt, pick a model, press/).textContent).toBe('Write a prompt, pick a model, press ⌘ ↵.');
    expect(screen.getByText('Write a prompt, pick a model, tap Generate.').tagName).toBe('SPAN');
    expect(screen.getAllByRole('heading', { name: 'What would you like to make?' })).toHaveLength(1);
  });

  test.each([
    { activeView: APP_VIEW_UNSORTED, title: 'Unsorted', collections: [] },
    { activeView: { kind: 'collection' as const, id: 'collection-1' }, title: 'Portraits', collections: [{ id: 'collection-1', name: 'Portraits', count: 0, archivedCount: 0, createdAt: 1 }] },
  ])('scopes a history error to $title and preserves its exact body and Retry', ({ activeView, title, collections }) => {
    const onRetry = mock();
    render(<Canvas {...canvasProps} activeView={activeView} collections={collections} error="History unavailable: try again." onRetry={onRetry} />);
    expect(screen.getByRole('heading', { name: `Couldn’t load ${title}.` })).toBeTruthy();
    expect(screen.getByText('History unavailable: try again.').tagName).toBe('P');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test.each([
    { state: 'empty', q: '', isLoading: false },
    { state: 'loading', q: '', isLoading: true },
    { state: 'no search results', q: 'harbour', isLoading: false },
  ])('keeps the named scroller focusable while $state', ({ q, isLoading }) => {
    installPhone(false);
    render(<Canvas {...canvasProps} q={q} isLoading={isLoading} />);
    const scroller = screen.getByRole('region', { name: 'Unsorted' });
    expect(scroller).toBe(screen.getByTestId('canvas-scroller'));
    expect(scroller.tabIndex).toBe(0);
    const headingId = scroller.getAttribute('aria-labelledby');
    expect(headingId && document.getElementById(headingId)?.textContent).toBe('Unsorted');
    scroller.focus();
    expect(document.activeElement).toBe(scroller);
    fireEvent.keyDown(scroller, { key: 'PageDown' });
    expect(document.activeElement).toBe(scroller);
  });
});

describe('Canvas scope-aware empty states', () => {
  test.each([
    { activeView: APP_VIEW_PINNED, title: 'Nothing pinned yet', body: 'Pin a batch from its menu to keep it here.' },
    { activeView: { kind: 'collection' as const, id: 'empty' }, title: 'This collection is empty', body: 'Move batches here from Unsorted.' },
  ])('an empty $activeView.kind scope has its own title and body, not the invitation', ({ activeView, title, body }) => {
    render(<Canvas {...canvasProps} activeView={activeView} />);
    expect(screen.getByRole('heading', { name: title })).toBeTruthy();
    expect(screen.getByText(body).tagName).toBe('P');
    expect(screen.queryByRole('heading', { name: 'What would you like to make?' })).toBeNull();
    expect(screen.queryByText(/Write a prompt/)).toBeNull();
  });
});

describe('Canvas refresh failure', () => {
  test('a failed read with rows shown is one polite status row with Retry at the newest end', () => {
    installPhone(false);
    const onRetry = mock();
    const props = { ...canvasProps, batches: [batchAt(1), batchAt(2)], modelById: new Map([[model.id, model]]), onRetry };
    const { container, rerender } = render(<Canvas {...props} error={null} />, { wrapper: wrapper() });
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    const status = screen.getByTestId('history-refresh-status');
    const live = status.querySelector('[role="status"]');
    expect(live?.getAttribute('aria-live')).toBe('polite');
    expect(live?.textContent).toBe('');

    rerender(<Canvas {...props} error="History unavailable: try again." />);
    // The rows stay; the failure does not replace them.
    expect(container.querySelector('section[data-batch-id="batch-2"]')).toBeTruthy();
    expect(screen.getByTestId('history-refresh-status')).toBe(status);
    expect(live?.textContent).toBe('Couldn’t refresh Unsorted.');
    // At the newest end: after the virtual list, not above it.
    const list = container.querySelector('[data-virtualized="canvas"]');
    expect(list && (list.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    rerender(<Canvas {...props} error={null} />);
    expect(live?.textContent).toBe('');
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  test('a failed next page stays with the load-more row, not the refresh row', () => {
    installPhone(false);
    render(<Canvas {...canvasProps} batches={[batchAt(1)]} modelById={new Map([[model.id, model]])} hasNextPage isFetchNextPageError error="History unavailable" />, { wrapper: wrapper() });
    expect(screen.getByTestId('history-refresh-status').querySelector('[role="status"]')?.textContent).toBe('');
    expect(screen.getByText('Could not load more')).toBeTruthy();
  });
});

describe('Canvas retention trigger', () => {
  function historyPages(count: number): HistoryData {
    return {
      pages: Array.from({ length: count }, (_, page) => ({
        items: Array.from({ length: 2 }, (_, row) => batchAt(1000 - page * 2 - row)),
        nextCursor: page === count - 1 ? null : `cursor-${String(page + 1)}`,
      })),
      pageParams: Array.from({ length: count }, (_, page) => (page === 0 ? null : `cursor-${String(page)}`)),
    };
  }

  function setVisibility(state: DocumentVisibilityState): void {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    document.dispatchEvent(new Event('visibilitychange'));
  }

  afterEach(() => {
    Reflect.deleteProperty(document, 'visibilityState');
  });

  test('hiding the document while the reader is at the newest end trims the active scope', () => {
    installPhone(false);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const key = historyKeys.scoped(APP_VIEW_UNSORTED, '');
    client.setQueryData(key, historyPages(5));
    render(
      <QueryClientProvider client={client}>
        <Canvas {...canvasProps} batches={[batchAt(1), batchAt(2)]} modelById={new Map([[model.id, model]])} />
      </QueryClientProvider>,
    );
    // happy-dom has no layout: every scroll metric is 0, so a scroll reads as at the end.
    fireEvent.scroll(screen.getByTestId('canvas-scroller'));
    setVisibility('hidden');
    const data = client.getQueryData<HistoryData>(key);
    expect(data?.pages).toHaveLength(3);
    expect(data?.pages[2]?.nextCursor).toBe('cursor-3');
  });

  test('a reader away from the end keeps every page when the document hides', () => {
    installPhone(false);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const key = historyKeys.scoped(APP_VIEW_UNSORTED, '');
    client.setQueryData(key, historyPages(5));
    render(
      <QueryClientProvider client={client}>
        <Canvas {...canvasProps} batches={[batchAt(1), batchAt(2)]} modelById={new Map([[model.id, model]])} />
      </QueryClientProvider>,
    );
    const scroller = screen.getByTestId('canvas-scroller');
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 5000 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 800 });
    scroller.scrollTop = 1000;
    fireEvent.scroll(scroller);
    setVisibility('hidden');
    expect(client.getQueryData<HistoryData>(key)?.pages).toHaveLength(5);
    // Far from the end the jump control is offered.
    expect(screen.getByTestId('jump-to-latest').getAttribute('data-visible')).toBe('true');
  });

  test('the jump control is hidden at the end', () => {
    installPhone(false);
    render(<Canvas {...canvasProps} batches={[batchAt(1)]} modelById={new Map([[model.id, model]])} />, { wrapper: wrapper() });
    fireEvent.scroll(screen.getByTestId('canvas-scroller'));
    expect(screen.getByTestId('jump-to-latest').getAttribute('data-visible')).toBeNull();
  });
});

describe('Canvas virtualization', () => {
  test('remeasures the leading control offset when only the next-page error flag changes', () => {
    installPhone(false);
    const batches = [batchAt(1)];
    let feedTop = 20;
    let feedReads = 0;
    const geometry = spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this.matches('[data-virtualized="canvas"]')) {
        feedReads += 1;
        return new DOMRect(0, feedTop, 900, 400);
      }
      return new DOMRect();
    });
    try {
      const props = { ...canvasProps, batches, hasNextPage: true };
      const { rerender } = render(<Canvas {...props} isFetchNextPageError={false} />, { wrapper: wrapper() });
      feedReads = 0;
      feedTop = 70;
      // Count, cursor, fetch activity and viewport stay unchanged. Only the
      // error text + visible Retry control add height above the virtual rows.
      rerender(<Canvas {...props} isFetchNextPageError />);
      expect(feedReads).toBeGreaterThan(0);
      feedReads = 0;
      feedTop = 20;
      rerender(<Canvas {...props} isFetchNextPageError={false} />);
      expect(feedReads).toBeGreaterThan(0);
    } finally {
      geometry.mockRestore();
    }
  });

  test('long feeds do not mount every batch at once', () => {
    installPhone(false);
    const batches = Array.from({ length: 60 }, (_, index) => batchAt(index));

    render(<Canvas {...canvasProps} batches={batches} modelById={new Map([[model.id, model]])} />, { wrapper: wrapper() });

    expect(screen.getAllByText(/^Prompt \d+$/).length).toBeLessThan(batches.length);
  });

  test('hydrates seen batches from sessionStorage', () => {
    installPhone(false);
    sessionStorage.setItem(SEEN_BATCHES_STORAGE_KEY, JSON.stringify({ ids: ['batch-1'] }));
    const batches = [batchAt(1), batchAt(2)];

    const { container } = render(<Canvas {...canvasProps} batches={batches} modelById={new Map([[model.id, model]])} />, { wrapper: wrapper() });

    expect(container.querySelector('section[data-batch-id="batch-1"]')?.getAttribute('data-seen')).toBe('true');
  });

  test('a row keeps the seen state it mounted with after the feed marks it', () => {
    installPhone(false);
    const batches = [batchAt(1)];

    const { container } = render(<Canvas {...canvasProps} batches={batches} modelById={new Map([[model.id, model]])} />, { wrapper: wrapper() });

    expect(getSeenBatches().has('batch-1')).toBe(true);
    expect(container.querySelector('section[data-batch-id="batch-1"]')?.getAttribute('data-seen')).toBeNull();
  });

  test('marks the oldest row as first so later rows keep their chapter spacing', () => {
    installPhone(false);
    const batches = [batchAt(1), batchAt(2)];

    const { container } = render(<Canvas {...canvasProps} batches={batches} modelById={new Map([[model.id, model]])} />, { wrapper: wrapper() });

    expect(container.querySelector('section[data-batch-id="batch-1"]')?.getAttribute('data-first')).toBe('true');
    expect(container.querySelector('section[data-batch-id="batch-2"]')?.getAttribute('data-first')).toBeNull();
  });

  test('exposes a handle that scrolls to a virtualized offscreen batch', () => {
    installPhone(false);
    const batches = Array.from({ length: 50 }, (_, index) => batchAt(index));
    const handle = createRef<CanvasHandle>();

    render(
      <Canvas {...canvasProps} batches={batches} modelById={new Map([[model.id, model]])} ref={handle} />,
      { wrapper: wrapper() },
    );

    if (!handle.current) throw new Error('missing canvas handle');
    expect(handle.current.scrollToBatch('batch-40')).toBe(true);
    expect(handle.current.scrollToBatch('missing')).toBe(false);
  });

  test('uses a string placeholder key when the virtualizer index is not hydrated', () => {
    expect(canvasBatchKey([], 7)).toBe('placeholder-7');
  });
});

describe('Canvas deferred placeholder rows', () => {
  test('a placeholder row stays read-only after the live flag clears, until its replacement commits', () => {
    installPhone(false);
    const modelById = new Map([[model.id, model]]);
    const stale = [batchAt(1)];
    const fresh = [batchAt(2)];
    // What the urgent commit shows: the deferred feed still holds the
    // placeholder row while the live `readOnlyActions` is already false.
    const urgent: { readonly batchId: string | undefined; readonly disabled: boolean | undefined }[] = [];
    function Probe({ value }: { value: readonly Batch[] }) {
      useLayoutEffect(() => {
        const row = document.querySelector<HTMLElement>('[data-batch-id]');
        const archive = row?.querySelector<HTMLButtonElement>('button[aria-label="Archive batch"]');
        urgent.push({ batchId: row?.dataset.batchId, disabled: archive?.disabled });
      }, [value]);
      return null;
    }
    const view = (batches: readonly Batch[], readOnlyActions: boolean) => (
      <>
        <Canvas {...canvasProps} batches={batches} modelById={modelById} readOnlyActions={readOnlyActions} />
        <Probe value={batches} />
      </>
    );
    const { rerender, container } = render(view(stale, true), { wrapper: wrapper() });
    // The mount commit renders no row (it waits for the scroller); the
    // placeholder row is there, read-only, once the mount settles.
    expect(container.querySelector<HTMLButtonElement>('[data-batch-id="batch-1"] button[aria-label="Archive batch"]')?.disabled).toBe(true);
    urgent.length = 0;

    rerender(view(fresh, false));

    expect(urgent).toEqual([
      { batchId: 'batch-1', disabled: true },
    ]);
    const archive = container.querySelector<HTMLButtonElement>('[data-batch-id="batch-2"] button[aria-label="Archive batch"]');
    expect(archive?.disabled).toBe(false);
  });
});

describe('Canvas scroll-collapse', () => {
  test('scrolling the feed down collapses an expanded composer on phone', () => {
    installPhone(true);
    useAtelierStore.getState().setComposerExpanded(true);
    const { container } = render(<Canvas {...canvasProps} />);
    const scroller = container.querySelector<HTMLElement>('[data-testid="canvas-scroller"]');
    if (!scroller) throw new Error('canvas scroller not found');
    fireEvent.touchMove(scroller);
    fireEvent.scroll(scroller, { target: { scrollTop: 200 } });
    expect(useAtelierStore.getState().composerExpanded).toBe(false);
  });

  test('a slow scroll of many small steps still collapses the composer', () => {
    installPhone(true);
    useAtelierStore.getState().setComposerExpanded(true);
    const { container } = render(<Canvas {...canvasProps} />);
    const scroller = container.querySelector<HTMLElement>('[data-testid="canvas-scroller"]');
    if (!scroller) throw new Error('canvas scroller not found');
    fireEvent.touchMove(scroller);
    for (let top = 10; top <= 100; top += 10) fireEvent.scroll(scroller, { target: { scrollTop: top } });
    expect(useAtelierStore.getState().composerExpanded).toBe(false);
  });

  test('scrolling back up restarts the collapse distance', () => {
    installPhone(true);
    useAtelierStore.getState().setComposerExpanded(true);
    const { container } = render(<Canvas {...canvasProps} />);
    const scroller = container.querySelector<HTMLElement>('[data-testid="canvas-scroller"]');
    if (!scroller) throw new Error('canvas scroller not found');
    fireEvent.touchMove(scroller);
    for (const top of [400, 380, 360, 370, 380]) fireEvent.scroll(scroller, { target: { scrollTop: top } });
    useAtelierStore.getState().setComposerExpanded(true);
    for (const top of [370, 360, 375]) fireEvent.scroll(scroller, { target: { scrollTop: top } });
    expect(useAtelierStore.getState().composerExpanded).toBe(true);
  });

  test('a scroll the feed makes itself never collapses the composer', () => {
    // Opening the phone composer grows its reserve and the feed keeps its end
    // in view: that scroll arrives with no reader gesture behind it.
    installPhone(true);
    useAtelierStore.getState().setComposerExpanded(true);
    const { container } = render(<Canvas {...canvasProps} />);
    const scroller = container.querySelector<HTMLElement>('[data-testid="canvas-scroller"]');
    if (!scroller) throw new Error('canvas scroller not found');
    fireEvent.scroll(scroller, { target: { scrollTop: 280 } });
    expect(useAtelierStore.getState().composerExpanded).toBe(true);
  });

  test('a tap on a feed control followed by the feed\'s own scroll never collapses the composer', () => {
    // Tapping Edit or Animate expands the composer; the feed then keeps its
    // end in view. A tap is not scrolling, so that scroll is not the reader's.
    installPhone(true);
    useAtelierStore.getState().setComposerExpanded(true);
    const { container } = render(<Canvas {...canvasProps} />);
    const scroller = container.querySelector<HTMLElement>('[data-testid="canvas-scroller"]');
    if (!scroller) throw new Error('canvas scroller not found');
    fireEvent.touchStart(scroller);
    fireEvent.pointerDown(scroller);
    fireEvent.scroll(scroller, { target: { scrollTop: 280 } });
    expect(useAtelierStore.getState().composerExpanded).toBe(true);
  });

  test('scrolling does not collapse on a desktop viewport', () => {
    installPhone(false);
    useAtelierStore.getState().setComposerExpanded(true);
    const { container } = render(<Canvas {...canvasProps} />);
    const scroller = container.querySelector<HTMLElement>('[data-testid="canvas-scroller"]');
    if (!scroller) throw new Error('canvas scroller not found');
    fireEvent.touchMove(scroller);
    fireEvent.scroll(scroller, { target: { scrollTop: 200 } });
    expect(useAtelierStore.getState().composerExpanded).toBe(true);
  });
});

describe('Canvas reader scroll yields the desktop composer', () => {
  function renderDesktopScroller(): { scroller: HTMLElement; yielded: ReturnType<typeof mock>; release: () => void } {
    installPhone(false);
    const yielded = mock();
    const release = registerComposerYield(yielded);
    const { container } = render(<Canvas {...canvasProps} />);
    const scroller = container.querySelector<HTMLElement>('[data-testid="canvas-scroller"]');
    if (!scroller) throw new Error('canvas scroller not found');
    return { scroller, yielded, release };
  }

  test('a reader scroll of more than 24 px in either direction asks the composer to yield', () => {
    const { scroller, yielded, release } = renderDesktopScroller();
    try {
      fireEvent.scroll(scroller, { target: { scrollTop: 400 } });
      fireEvent.wheel(scroller);
      fireEvent.scroll(scroller, { target: { scrollTop: 420 } });
      expect(yielded).not.toHaveBeenCalled();
      fireEvent.scroll(scroller, { target: { scrollTop: 430 } });
      expect(yielded).toHaveBeenCalledTimes(1);
      fireEvent.wheel(scroller);
      for (const top of [420, 410, 400]) fireEvent.scroll(scroller, { target: { scrollTop: top } });
      expect(yielded).toHaveBeenCalledTimes(2);
    } finally {
      release();
    }
  });

  test('keyboard scrolling is a reader scroll too', () => {
    const { scroller, yielded, release } = renderDesktopScroller();
    try {
      fireEvent.scroll(scroller, { target: { scrollTop: 400 } });
      fireEvent.keyDown(scroller, { key: 'PageDown' });
      fireEvent.scroll(scroller, { target: { scrollTop: 900 } });
      expect(yielded).toHaveBeenCalledTimes(1);
    } finally {
      release();
    }
  });

  test('a scrollbar drag is a reader scroll until the pointer lifts', () => {
    const { scroller, yielded, release } = renderDesktopScroller();
    try {
      fireEvent.scroll(scroller, { target: { scrollTop: 900 } });
      // happy-dom has no layout: give the scroller a 1000px box with an
      // overlay scrollbar (no gutter), so the strip is its last 16px.
      scroller.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800, toJSON: () => ({}) });
      Object.defineProperty(scroller, 'offsetWidth', { configurable: true, value: 1000 });
      Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 1000 });
      // A mouse press on the scroller's empty area is not a scrollbar drag.
      fireEvent.pointerDown(scroller, { pointerType: 'mouse', clientX: 500 });
      fireEvent.scroll(scroller, { target: { scrollTop: 600 } });
      expect(yielded).not.toHaveBeenCalled();
      fireEvent.pointerUp(window);
      // Neither is a touch on the strip (touch scrolls through touchmove).
      fireEvent.pointerDown(scroller, { pointerType: 'touch', clientX: 995 });
      fireEvent.scroll(scroller, { target: { scrollTop: 900 } });
      expect(yielded).not.toHaveBeenCalled();
      fireEvent.pointerUp(window);
      // A mouse press on the scrollbar strip is.
      fireEvent.pointerDown(scroller, { pointerType: 'mouse', clientX: 995 });
      fireEvent.scroll(scroller, { target: { scrollTop: 400 } });
      expect(yielded).toHaveBeenCalledTimes(1);
      fireEvent.pointerUp(window);
      // Released: the feed's own scroll afterwards is not the reader's.
      fireEvent.scroll(scroller, { target: { scrollTop: 900 } });
      expect(yielded).toHaveBeenCalledTimes(1);
    } finally {
      release();
    }
  });

  test('arrow keys a menu uses for itself are not a reader scroll', () => {
    const { scroller, yielded, release } = renderDesktopScroller();
    try {
      const menu = document.createElement('div');
      menu.setAttribute('role', 'menu');
      const item = document.createElement('button');
      menu.append(item);
      scroller.append(menu);
      fireEvent.scroll(scroller, { target: { scrollTop: 400 } });
      fireEvent.keyDown(item, { key: 'ArrowDown' });
      fireEvent.scroll(scroller, { target: { scrollTop: 900 } });
      expect(yielded).not.toHaveBeenCalled();
      menu.remove();
    } finally {
      release();
    }
  });

  test('a scroll the feed makes itself does not ask the composer to yield', () => {
    const { scroller, yielded, release } = renderDesktopScroller();
    try {
      fireEvent.scroll(scroller, { target: { scrollTop: 400 } });
      fireEvent.scroll(scroller, { target: { scrollTop: 900 } });
      expect(yielded).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });
});

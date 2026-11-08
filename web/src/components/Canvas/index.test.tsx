import type { Batch, Model } from '@atelier/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef, useLayoutEffect, type PropsWithChildren } from 'react';
import Canvas, { canvasBatchKey, type CanvasHandle } from './index';
import { flushSeenBatches, getSeenBatches, resetSeenBatches, SEEN_BATCHES_STORAGE_KEY } from '../../lib/seenBatches';
import { APP_VIEW_UNSORTED, useAtelierStore } from '../../store/atelier';

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
  test.each([APP_VIEW_UNSORTED, { kind: 'collection' as const, id: 'empty' }])('shares the approved hint alternatives in an empty $kind canvas', (activeView) => {
    render(<Canvas {...canvasProps} activeView={activeView} />);
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

    rerender(view(fresh, false));

    expect(urgent).toEqual([
      { batchId: 'batch-1', disabled: true },
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

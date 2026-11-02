import type { Batch, Model } from '@atelier/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef, type PropsWithChildren } from 'react';
import Canvas, { canvasBatchKey, type CanvasHandle } from './index';
import { APP_VIEW_UNSORTED, useAtelierStore } from '../../store/atelier';

const SEEN_BATCHES_STORAGE_KEY = 'atelier.seenBatches.v1';

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
  id: 'gpt-image-2.5-sunburst',
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
  sessionStorage.clear();
  window.matchMedia = originalMatchMedia;
  useAtelierStore.setState({ composerExpanded: false });
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

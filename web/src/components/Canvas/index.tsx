import type { Batch, Collection, DoneTile, Model, Tile } from '@atelier/shared';
import { observeElementRect, useVirtualizer } from '@tanstack/react-virtual';
import { memo, useCallback, useDeferredValue, useEffect, useEffectEvent, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, ViewTransition, type Ref } from 'react';
import { flushSync } from 'react-dom';
import { useIsPhone } from '../../hooks/useIsPhone';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { FEED_SCROLL_END_THRESHOLD_PX, FEED_VIRTUALIZER_ANCHORING, measureFeedScrollMargin, settleFeedScrollMargin, shouldAnchorRowResize, type FeedMarginState } from '../../lib/feedAnchor';
import { estimateBatchHeight, feedGeometry, readFeedChrome, readFeedContainerWidth, type FeedChrome } from '../../lib/feedEstimate';
import { fallbackVirtualRows, virtualizedHeight } from '../../lib/virtualWindow';
import { markBatchesSeen, useSeenBatches } from '../../lib/seenBatches';
import { scopeTitle } from '../../lib/viewChrome';
import { useAtelierStore, type AppView } from '../../store/atelier';
import BatchView, { type BatchAction, type TileAction, type TileHandoff } from '../Batch';
import { FeedRefreshStatus, InfiniteStatus, useStatusFootprint } from '../InfiniteStatus';
import { JumpToLatest } from '../JumpToLatest';
import { feedChangedBelow, snapshotFeedEnd, type LeftEndSnapshot } from '../JumpToLatest/marker';
import { FeedRetention } from './FeedRetention';
import { ManagedViewHeader } from '../ManagedViewHeader';
import { StateView, LoadingState } from '../StateView';
import { requestComposerYield } from '../Composer/composerYield';
import styles from './index.module.css';

interface CanvasProps {
  batches: readonly Batch[];
  modelById: ReadonlyMap<string, Model>;
  // App's single collections list. Resolved to a per-batch currentCollection
  // below so BatchView's memoized row holds for unsorted batches across collection
  // mutations (see BatchView.currentCollection).
  collections: readonly Collection[];
  // Threaded down to BatchView's useTogglePin. Previously read from the
  // Zustand store inside BatchView, which made every visible batch re-render
  // on any view change (sidebar nav, lightbox open, etc.). Passing it as a
  // prop keeps BatchView's memoized row effective for unrelated store churn.
  activeView: AppView;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError?: boolean;
  isLoading?: boolean;
  error?: string | null;
  readOnlyActions?: boolean;
  onLoadMore: () => void;
  onRetry?: () => void;
  onBatchAction: (action: BatchAction, batch: Batch) => void;
  promptsEnabled: boolean;
  onTileAction: (action: TileAction, batch: Batch, tile: Tile) => void;
  onOpenTile: (batch: Batch, tile: DoneTile) => void;
  onEditTile?: TileHandoff | undefined;
  onAnimateTile?: TileHandoff | undefined;
  onTellStoryTile?: TileHandoff | undefined;
  onCreateCardTile?: TileHandoff | undefined;
  cardPendingTileIds?: ReadonlySet<string> | undefined;
  /** Imperative handle for the one explicit scroll: a sidebar-rail click. */
  ref?: Ref<CanvasHandle> | undefined;
  // The DEBOUNCED search term (App's history query is keyed by it). Threaded
  // through so BatchView's useTogglePin scopes its optimistic cache write to
  // the SAME key the visible list reads — and so BatchView doesn't re-render
  // per keystroke off a live store.q subscription (which would defeat its memo).
  q: string;
}

/** The scope title's id; the scroller region is labelled by it. */
const FEED_HEADING_ID = 'atelier-feed-heading';

export interface CanvasHandle {
  /** Bring a batch to the top of the feed. False when it isn't loaded. */
  scrollToBatch: (batchId: string) => boolean;
}

const CANVAS_FALLBACK_BATCHES = 7;
/** A scroll this soon after a reader's drag or wheel is theirs (covers touch momentum). */
const READER_SCROLL_WINDOW_MS = 1_000;
// Keys that scroll the feed when nothing else consumes them.
const SCROLL_KEYS: ReadonlySet<string> = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End']);
// Controls that use those keys themselves.
const KEY_OWNING_SELECTOR = 'input, textarea, select, [contenteditable], [role="menu"], [role="listbox"], [role="dialog"], dialog';

interface VirtualBatchRowProps {
  index: number;
  /** Newest batch = the one the feed lands on, so it owns eager image loading. */
  isNewest: boolean;
  batch: Batch;
  modelById: ReadonlyMap<string, Model>;
  activeView: AppView;
  currentCollection?: Collection | undefined;
  seen: boolean;
  readOnlyActions: boolean;
  onBatchAction: (action: BatchAction, batch: Batch) => void;
  promptsEnabled: boolean;
  onTileAction: (action: TileAction, batch: Batch, tile: Tile) => void;
  onOpenTile: (batch: Batch, tile: DoneTile) => void;
  onEditTile?: TileHandoff | undefined;
  onAnimateTile?: TileHandoff | undefined;
  onTellStoryTile?: TileHandoff | undefined;
  onCreateCardTile?: TileHandoff | undefined;
  cardPendingTileIds?: ReadonlySet<string> | undefined;
  measureElement: (element: HTMLElement | null) => void;
  q: string;
}

export function canvasBatchKey(batches: readonly Pick<Batch, 'id'>[], index: number): string {
  return batches[index]?.id ?? `placeholder-${index}`;
}


/** Where the reader stands: at the newest end, a little above it, or more than one viewport above it. */
type FeedEndState = 'end' | 'near' | 'far';

/** The reader's first visible tile and its offset inside its row, recorded on scroll (R10). */
interface ReaderTile {
  readonly key: string;
  readonly tileId: string;
  readonly offset: number;
}

function readReaderTile(scroller: HTMLElement): ReaderTile | null {
  const top = scroller.getBoundingClientRect().top;
  for (const row of scroller.querySelectorAll<HTMLElement>('[data-index][data-batch-id]')) {
    const rowRect = row.getBoundingClientRect();
    if (rowRect.bottom <= top) continue;
    for (const tile of row.querySelectorAll<HTMLElement>('[data-feed-tile]')) {
      const tileRect = tile.getBoundingClientRect();
      if (tileRect.bottom <= top) continue;
      const key = row.dataset.batchId;
      const tileId = tile.dataset.feedTile;
      return key && tileId ? { key, tileId, offset: tileRect.top - rowRect.top } : null;
    }
    return null;
  }
  return null;
}

/** How far the recorded tile moved inside its row since it was recorded, or null when `row` does not hold it. */
function readerTileShift(anchor: ReaderTile | null, key: unknown, row: Element | undefined): number | null {
  if (!anchor || anchor.key !== key || !row) return null;
  const tile = row.querySelector(`[data-feed-tile="${CSS.escape(anchor.tileId)}"]`);
  if (!tile) return null;
  return tile.getBoundingClientRect().top - row.getBoundingClientRect().top - anchor.offset;
}

/** The virtualizer surface `pinRowSize` writes through. */
interface RowSizeSurface {
  itemSizeCache: Map<string | number | bigint, number>;
  indexFromElement: (element: Element) => number;
  resizeItem: (index: number, size: number) => void;
}

/**
 * Records a mounted row's measured size. A row whose measurement equals its
 * estimate never enters the virtualizer's size cache (resizeItem stores only
 * a non-zero delta), so its height keeps following the estimate: a tile
 * failing in it re-lays it out through the estimate, outside resizeItem and
 * the reader anchor. Pinned, the change arrives as a row resize. An equal
 * size changes no layout.
 */
function pinRowSize(instance: RowSizeSurface, row: Element, size: number): void {
  const key = row instanceof HTMLElement ? row.dataset.batchId : undefined;
  if (key === undefined || !row.isConnected) return;
  instance.resizeItem(instance.indexFromElement(row), size);
  if (!instance.itemSizeCache.has(key)) instance.itemSizeCache.set(key, size);
}

function EmptyCanvas({ view }: { view: AppView }) {
  // Only Unsorted invites a first generation: a new batch lands there, so
  // the invitation would read as broken in Pinned or a collection.
  if (view.kind === 'pinned') {
    return <StateView art="empty-canvas" title="Nothing pinned yet" body="Pin a batch from its menu to keep it here." />;
  }
  if (view.kind === 'collection') {
    return <StateView art="empty-canvas" title="This collection is empty" body="Move batches here from Unsorted." />;
  }
  return (
    <StateView
      art="empty-canvas"
      title="What would you like to make?"
      body={
        <>
          <span className={styles.keyboardHint}>Write a prompt, pick a model, press <kbd>⌘</kbd> <kbd>↵</kbd>.</span>
          <span className={styles.touchHint}>Write a prompt, pick a model, tap Generate.</span>
        </>
      }
    />
  );
}

function SearchEmptyCanvas({ q }: { q: string }) {
  return (
    <StateView
      art="empty-search"
      title="No results found"
      body={`No generations match “${q.trim()}”. Try a broader search.`}
    />
  );
}

function HistoryErrorCanvas({ error, scopeTitle, onRetry }: { error: string; scopeTitle: string; onRetry?: () => void }) {
  return <StateView art="state-error" title={`Couldn’t load ${scopeTitle}.`} body={error} {...(onRetry ? { action: { label: 'Retry', onClick: onRetry } } : {})} />;
}

function LoadingCanvas() {
  return <LoadingState label="Loading history…" />;
}

const VirtualBatchRow = memo(function VirtualBatchRow({
  index,
  isNewest,
  batch,
  modelById,
  activeView,
  currentCollection,
  seen,
  readOnlyActions,
  onBatchAction,
  promptsEnabled,
  onTileAction,
  onOpenTile,
  onEditTile,
  onAnimateTile,
  onTellStoryTile,
  onCreateCardTile,
  cardPendingTileIds,
  measureElement,
  q,
}: VirtualBatchRowProps) {
  // Entrance eligibility is fixed at mount: the effect that marks this batch
  // seen re-renders the row, and flipping `data-seen` then would cut its
  // entrance short.
  const [seenAtMount] = useState(seen);
  return (
    // The row element itself is the capture. Rows sit in normal flow inside
    // the translated window (Canvas below), so a batch that shrinks or leaves
    // moves the rows below it in the same Transition commit, a layout change
    // React measures: they move up over --dur-view, the removed batch shrinks
    // out, and a seen batch that comes back (Undo) fades in. Unnamed like the tiles: rows are keyed by batch
    // id and never remount within the feed, and a name would pair a batch
    // that Unsorted and Pinned both show across a view swap.
    <ViewTransition
      default="tile-move"
      exit="tile-exit"
      enter={seenAtMount ? 'tile-enter' : 'none'}
    >
    <div
      data-index={index}
      // Wrapped on purpose. Passing `measureElement` itself as the ref made the
      // prompt-card anchor specs (e2e/native-anchors) flaky: 4 of 102 runs vs
      // 0 of 102 wrapped.
      ref={(element) => { measureElement(element); }}
      data-batch-id={batch.id}
      className={styles.virtualBatch}
    >
      <BatchView
        batch={batch}
        modelById={modelById}
        activeView={activeView}
        currentCollection={currentCollection}
        isAboveFold={isNewest}
        isFirstBatch={index === 0}
        seen={seenAtMount}
        readOnlyActions={readOnlyActions}
        onBatchAction={onBatchAction}
        promptsEnabled={promptsEnabled}
        onTileAction={onTileAction}
        onOpenTile={onOpenTile}
        onEditTile={onEditTile}
        onAnimateTile={onAnimateTile}
        onTellStoryTile={onTellStoryTile}
        onCreateCardTile={onCreateCardTile}
        cardPendingTileIds={cardPendingTileIds}
        q={q}
      />
    </div>
    </ViewTransition>
  );
});

function Canvas({ batches: liveBatches, modelById, collections, activeView, hasNextPage, isFetchingNextPage, isFetchNextPageError = false, isLoading = false, error = null, readOnlyActions = false, onLoadMore, onRetry, onBatchAction, promptsEnabled, onTileAction, onOpenTile, onEditTile, onAnimateTile, onTellStoryTile, onCreateCardTile, cardPendingTileIds, ref, q }: CanvasProps) {
  // One render snapshot of the feed: the virtualizer, the rows and every
  // handler read it, so a batch removal or insertion commits in a Transition
  // and the batch-row boundaries animate it (removeBatchFromCache).
  // `readOnlyActions` is App's placeholder flag (keepPreviousData showing the
  // previous scope or search); it rides in the same snapshot as the rows.
  // Controls read `readOnly`: a placeholder row stays inert until the commit
  // that replaces it, though the live flag clears first.
  const liveFeed = useMemo(() => ({ batches: liveBatches, placeholder: readOnlyActions }), [liveBatches, readOnlyActions]);
  const { batches, placeholder } = useDeferredValue(liveFeed);
  const readOnly = readOnlyActions || placeholder;
  const trimmedQ = q.trim();
  const blockingError = batches.length === 0 ? error : null;
  // A failed read while rows are shown (R16). A failed next page is the
  // load-more row's own error, above the list.
  const refreshError = batches.length > 0 && !isFetchNextPageError ? error : null;
  const isPhone = useIsPhone();
  const reducedMotion = useReducedMotion();
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const virtualFeedRef = useRef<HTMLDivElement | null>(null);
  // Where the virtual list starts inside the scroller (the history status row
  // and column padding sit above it). TanStack's `scrollMargin` puts the
  // virtualizer's offsets in scroller coordinates, so scrollToIndex lands on
  // the row itself rather than that much short of it.
  const [scrollMargin, setScrollMargin] = useState(0);
  const marginStateRef = useRef<FeedMarginState>({ margin: null, owed: 0 });
  // The history status row's footprint, on the render it commits in.
  const statusFootprint = useStatusFootprint(hasNextPage);
  const seenBatchIds = useSeenBatches('canvas');
  const getBatchKey = useCallback((index: number) => canvasBatchKey(batches, index), [batches]);
  // Unmeasured rows are laid out at the estimate, so it reads the geometry
  // the grid lays out with (lib/feedEstimate). The scroller rect arrives from
  // the virtualizer's own observer; until then the flat fallback applies.
  // The lone-tile cap also reads the scope title height and the composer's
  // top (FeedChrome); they are re-read when the scroller rect or the
  // composer reserve changes, not per estimate.
  const layoutRef = useRef<{ containerWidth: number | null; chrome: FeedChrome } | null>(null);
  const refreshLayout = (scroller: HTMLElement | null) => {
    layoutRef.current = { containerWidth: scroller ? readFeedContainerWidth(scroller) : null, chrome: readFeedChrome() };
  };
  const estimateRow = useCallback((batch: Batch | undefined, first = false) => {
    layoutRef.current ??= { containerWidth: null, chrome: readFeedChrome() };
    const { containerWidth, chrome } = layoutRef.current;
    return estimateBatchHeight(batch, feedGeometry(containerWidth, isPhone, chrome), first);
  }, [isPhone]);

  // The scroller exists from the first commit; the virtualizer waits for it
  // and for the first rows (see `enabled` below). The scroller's geometry is
  // read here, before the first paint.
  const [scrollerReady, setScrollerReady] = useState(false);
  useLayoutEffect(() => {
    refreshLayout(canvasRef.current);
    setScrollerReady(true);
  }, []);
  // Set in the commit after the virtualizer first attached; it stays on.
  const [feedStarted, setFeedStarted] = useState(false);
  const virtualizerOn = scrollerReady && (feedStarted || batches.length > 0);

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual's useVirtualizer is the canonical virtualization primitive; React Compiler escape hatch.
  const batchVirtualizer = useVirtualizer({
    count: batches.length,
    // The first window is already the newest end. TanStack reads
    // `initialOffset` only while it holds no scroll offset: at creation, and
    // again after `enabled` was false. So the virtualizer starts with the
    // first render that has rows and a mounted scroller (`scrollerReady`, set
    // with the scroller's geometry before the first paint, so the estimates
    // are already the laid-out ones), at the estimated end of the list: past
    // the last row's start, so the window is the newest row plus overscan, a
    // subset of the window the landing below settles on. No row mounts and
    // leaves again (rendering from 0 mounted the oldest rows for a frame, and
    // their thumbnail downloads were aborted). Attaching writes the offset to
    // the scroller, which clamps it to the real end, and the scroll event
    // that follows hands the virtualizer the real offset (a feed too short
    // to scroll fires none: see "too short to scroll" below).
    // Once started it stays enabled, and rows render only from the commit
    // after it attached (`feedStarted`): ResizeObserver callbacks run in the
    // order the observers were created, and the width-change path in
    // `observeElementRect` below must run before the rows' own observer, or a
    // sidebar collapse re-anchors the rows first and the feed no longer reads
    // as pinned to the end (ui-polish "collapsing the sidebar").
    enabled: virtualizerOn,
    initialOffset: () => batches.reduce((total, batch, index) => total + estimateRow(batch, index === 0), scrollMargin),
    getScrollElement: () => canvasRef.current,
    // Stable batch ids, NOT indexes — the anchoring below cannot tell a prepend
    // from an append once every index has shifted.
    getItemKey: getBatchKey,
    estimateSize: (index) => estimateRow(batches[index], index === 0),
    initialRect: { width: 0, height: 900 },
    overscan: 3,
    scrollMargin,
    // A sidebar jump rests the batch just below the scroller's top edge, the
    // same 12px breathing room `.batch { scroll-margin-top }` gives focus scrolls.
    scrollPaddingStart: 12,
    ...FEED_VIRTUALIZER_ANCHORING,
    // A viewport resize must reconcile row positions and end anchoring before
    // the browser samples intersections and CSS anchor fallbacks. Keep scroll
    // notifications batched so removals still capture their ViewTransition.
    // A width change (sidebar collapse, window resize) has already re-laid
    // out every row at the new width. Their heights are read in the same
    // synchronous pass (resizeItem: measureElement skips while the anchor's
    // own scroll corrections mark the list as scrolling), so positions, total
    // height and the end anchor land before the frame paints instead of one
    // row-ResizeObserver commit later. The height is the row's own
    // offsetHeight, the library's uncached read: its measureElement without
    // a ResizeObserver entry returns the cached size, which left WebKit (whose
    // row observer skips while scrolling) painting a frame with the stale
    // total and throwing the newest batch back up mid-collapse.
    observeElementRect: (instance, callback) => {
      let subscribing = true;
      let width: number | null = null;
      const cleanup = observeElementRect(instance, (rect) => {
        const widthChanged = width !== null && rect.width !== width;
        width = rect.width;
        refreshLayout(instance.scrollElement);
        // The initial measurement runs inside the virtualizer's layout effect.
        if (subscribing) {
          callback(rect);
          return;
        }
        const pinned = widthChanged && instance.isAtEnd(FEED_SCROLL_END_THRESHOLD_PX);
        flushSync(() => {
          callback(rect);
          if (!widthChanged) return;
          for (const row of instance.elementsCache.values()) {
            pinRowSize(instance, row, row instanceof HTMLElement ? row.offsetHeight : row.getBoundingClientRect().height);
          }
        });
        // A growing list was clamped to the old scroll height; the committed
        // height now lets the end anchor reach the real end.
        if (pinned) instance.scrollToEnd();
      });
      subscribing = false;
      return cleanup;
    },
  });
  const scrollRectWidth = batchVirtualizer.scrollRect?.width ?? 0;

  // R10: TanStack anchors at row boundaries and leaves a row that spans the
  // viewport top alone. A row holds up to four tiles, so a tile above the
  // reader's in the same row (a failure collapsing to a compact card, a
  // removal) would move them; the reader's first visible tile, recorded on
  // scroll, decides (lib/feedAnchor shouldAnchorRowResize).
  const readerTileRef = useRef<ReaderTile | null>(null);
  useLayoutEffect(() => {
    batchVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, delta, instance) => shouldAnchorRowResize({
      start: item.start,
      size: item.size,
      delta,
      scrollOffset: instance.scrollOffset ?? 0,
      firstMeasure: !instance.itemSizeCache.has(item.key),
      backward: instance.scrollDirection === 'backward',
      tileShift: readerTileShift(readerTileRef.current, item.key, instance.elementsCache.get(item.key)),
    });
  }, [batchVirtualizer]);
  // Rows mount measured; their size is pinned (pinRowSize) so a later
  // estimate change cannot re-lay out a mounted row unanchored.
  const measureRow = useCallback((element: HTMLElement | null) => {
    batchVirtualizer.measureElement(element);
    if (element) pinRowSize(batchVirtualizer, element, Math.round(element.getBoundingClientRect().height));
  }, [batchVirtualizer]);
  // The virtualizer memoizes its layout on measured sizes, not on the estimate
  // function, so the rows laid out before the scroller rect arrived (at the
  // flat fallback) are re-estimated once, when the first geometry lands and
  // nothing has been measured yet. Later column changes (a sidebar collapse,
  // a resize across 480px or 920px) leave measured rows alone and let the
  // unmeasured ones pick up the new estimate as they mount: clearing the
  // measurement cache mid-resize threw the feed back by whole rows.
  const hasGeometry = scrollRectWidth > 0;
  const estimatedRef = useRef(false);
  useLayoutEffect(() => {
    if (!hasGeometry || estimatedRef.current) return;
    estimatedRef.current = true;
    batchVirtualizer.measure();
    // measure() drops every recorded size; re-pin the rows already mounted.
    for (const row of batchVirtualizer.elementsCache.values()) {
      pinRowSize(batchVirtualizer, row, Math.round(row.getBoundingClientRect().height));
    }
  }, [batchVirtualizer, hasGeometry]);
  // Rows render once the virtualizer has attached (`feedStarted`, above).
  // Until then (the mount commit and the first enabled one, both re-rendered
  // before they paint) no row renders: the fallback rows are the oldest ones,
  // and they would start their thumbnail downloads only to leave again.
  const virtualBatches = feedStarted ? batchVirtualizer.getVirtualItems() : [];
  const renderBatches = virtualBatches.length > 0
    ? virtualBatches
    : fallbackVirtualRows(
      feedStarted ? batches.length : 0,
      CANVAS_FALLBACK_BATCHES,
      (index) => estimateRow(batches[index], index === 0),
      (index) => canvasBatchKey(batches, index),
    );
  // The whole-feed estimate is only the pre-measure fallback height; with
  // virtual items the virtualizer's total is the height (lib/virtualWindow).
  const hasVirtualItems = virtualBatches.length > 0;
  const estimatedFeedHeight = useMemo(
    () => (hasVirtualItems ? 0 : batches.reduce((total, batch, index) => total + estimateRow(batch, index === 0), 0)),
    [batches, estimateRow, hasVirtualItems],
  );
  const virtualFeedHeight = virtualizedHeight(hasVirtualItems, batchVirtualizer.getTotalSize(), estimatedFeedHeight);
  // Keyed on the contiguous virtual window bounds (NOT renderBatches, which is
  // rebuilt every render). The window is contiguous, so first..last fully
  // reconstructs the same id list and the memo short-circuits unchanged scrolls.
  const firstRenderedIndex = renderBatches[0]?.index ?? -1;
  const lastRenderedIndex = renderBatches[renderBatches.length - 1]?.index ?? -1;
  const renderedBatchIds = useMemo(() => {
    if (firstRenderedIndex < 0) return '';
    const ids: string[] = [];
    for (let i = firstRenderedIndex; i <= lastRenderedIndex; i += 1) {
      const id = batches[i]?.id;
      if (typeof id === 'string') ids.push(id);
    }
    return ids.join('\0');
  }, [batches, firstRenderedIndex, lastRenderedIndex]);

  useLayoutEffect(() => {
    const scroller = canvasRef.current;
    const feed = virtualFeedRef.current;
    if (!scroller || !feed) return;
    setScrollMargin(measureFeedScrollMargin(scroller, feed, marginStateRef.current, batchVirtualizer));
  }, [batchVirtualizer, batches.length, statusFootprint, hasNextPage, isFetchingNextPage, isFetchNextPageError, isPhone]);

  const feedIsScrolling = batchVirtualizer.isScrolling;
  useLayoutEffect(() => {
    const scroller = canvasRef.current;
    if (scroller && !feedIsScrolling) settleFeedScrollMargin(scroller, marginStateRef.current, batchVirtualizer);
  }, [batchVirtualizer, feedIsScrolling]);

  // The virtualizer has attached (its layout effect ran first): rows may render.
  useLayoutEffect(() => {
    if (virtualizerOn) setFeedStarted(true);
  }, [virtualizerOn]);
  const rowsLive = feedStarted && batches.length > 0;

  // A feed too short to scroll: the clamped `initialOffset` write left the
  // scroller at 0, so no scroll event reports the real offset, and the
  // virtualizer would keep windowing from past the end. Let it read the
  // offset through its own scroll listener. Declared after useVirtualizer, so
  // its attach (the write) has run.
  useLayoutEffect(() => {
    const scroller = canvasRef.current;
    if (!rowsLive || !scroller || scroller.scrollTop > 0) return;
    scroller.dispatchEvent(new Event('scroll'));
  }, [rowsLive]);

  const landedRef = useRef(false);
  const landingRef = useRef(false);

  useImperativeHandle(ref, () => ({
    scrollToBatch: (batchId: string) => {
      const index = batches.findIndex((batch) => batch.id === batchId);
      if (index < 0) return false;
      landingRef.current = false;
      batchVirtualizer.scrollToIndex(index, { align: 'start', behavior: reducedMotion ? 'auto' : 'smooth' });
      return true;
    },
  }), [batchVirtualizer, batches, reducedMotion]);

  // Land on the newest work. The feed is bottom-anchored, so arriving at the
  // top would show the oldest batch in the page and lurch afterwards. Runs on
  // the first render with rows (the virtualizer starts at the estimated end,
  // `initialOffset` above; mount usually has no batches — the query is still
  // resolving) and never again. `scrollToEnd` is the
  // virtualizer's own path and reconciles toward the end as rows measure.
  // Following new work is the library's `followOnAppend` (lib/feedAnchor): it
  // follows only a reader within the shared end threshold, and keeps the end
  // pinned as appended rows measure taller than their estimate.
  useLayoutEffect(() => {
    if (landedRef.current || !rowsLive || !canvasRef.current) return;
    landedRef.current = true;
    landingRef.current = true;
    batchVirtualizer.scrollToEnd();
  }, [rowsLive, batchVirtualizer]);

  // Until the reader takes over, keep re-asserting the end as the measured
  // total settles: the first scrollToEnd lands on estimates, and rows (and
  // the scroller itself) can finish measuring after its reconciliation has
  // stopped. Once the reader scrolls away (handleScroll), the library's
  // followOnAppend alone decides whether new work moves them.
  const totalSize = batchVirtualizer.getTotalSize();
  useEffect(() => {
    if (!landingRef.current || batches.length === 0) return;
    batchVirtualizer.scrollToEnd();
  }, [totalSize, batches.length, batchVirtualizer]);

  // The feed's true end also moves with no row changing: the scroller's bottom
  // padding reserves the composer's live height, which grows as the composer
  // loads or the prompt wraps. A reader at the end would watch the newest
  // batch slide behind the composer, so keep them there. The padding change
  // resizes the scroller's content box, which is what this observes.
  const atEndRef = useRef(false);
  // The reader's distance from the end, as state only on a change of band:
  // the jump control (R18) and the resting trim (R7) follow it.
  const [endState, setEndState] = useState<FeedEndState>('end');
  const endStateRef = useRef<FeedEndState>('end');
  // What the feed held when the reader left the end (the jump marker).
  const [leftEnd, setLeftEnd] = useState<LeftEndSnapshot | null>(null);
  const updateEndState = (scroller: HTMLElement) => {
    const distanceFromEnd = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
    atEndRef.current = distanceFromEnd <= FEED_SCROLL_END_THRESHOLD_PX;
    const next: FeedEndState = atEndRef.current ? 'end' : distanceFromEnd > scroller.clientHeight ? 'far' : 'near';
    const previous = endStateRef.current;
    if (next === previous) return;
    endStateRef.current = next;
    if (previous === 'end') setLeftEnd(snapshotFeedEnd(liveBatches));
    if (next === 'end') setLeftEnd(null);
    setEndState(next);
  };
  const onScrollerResize = useEffectEvent((scroller: HTMLElement) => {
    refreshLayout(scroller);
    if (landingRef.current || atEndRef.current) batchVirtualizer.scrollToEnd();
    updateEndState(scroller);
  });
  useEffect(() => {
    const scroller = canvasRef.current;
    if (!scroller || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => { onScrollerResize(scroller); });
    observer.observe(scroller);
    return () => { observer.disconnect(); };
  }, []);

  // The refresh-failure row sits below the list, so a reader at the end
  // would find it under the composer: keep them at the end as it appears.
  const hasRefreshError = refreshError !== null;
  useLayoutEffect(() => {
    if (hasRefreshError && atEndRef.current) batchVirtualizer.scrollToEnd();
  }, [batchVirtualizer, hasRefreshError]);

  const jumpVisible = batches.length > 0 && !blockingError && endState === 'far';
  const jumpMarker = jumpVisible && leftEnd !== null && feedChangedBelow(leftEnd, batches);
  const jumpToLatest = () => {
    const scroller = canvasRef.current;
    if (!scroller) return;
    // Focus first: the control leaves once the feed reaches the end.
    scroller.focus({ preventScroll: true });
    landingRef.current = false;
    batchVirtualizer.scrollToEnd({ behavior: reducedMotion ? 'auto' : 'smooth' });
  };

  useEffect(() => {
    if (renderedBatchIds === '') return;
    markBatchesSeen(renderedBatchIds.split('\0'), 'canvas');
  }, [renderedBatchIds]);

  // The landing reconciliation keeps re-targeting the end while rows measure,
  // and the library does not stop it for a reader who starts scrolling: hand
  // the position back on their first gesture.
  const releaseLanding = () => {
    const scroller = canvasRef.current;
    if (!landingRef.current || !scroller) return;
    landingRef.current = false;
    batchVirtualizer.scrollToOffset(scroller.scrollTop);
  };

  // When the reader last dragged or wheeled the feed. Only scrolls inside that
  // window are theirs; the rest are this component's own (landing, keeping the
  // end above a growing composer). Taps are not scrolling: a tap on Edit or
  // Animate expands the composer, and the scroll that follows is the feed's.
  const scrollGestureAtRef = useRef(Number.NEGATIVE_INFINITY);
  const onScrollGesture = () => {
    scrollGestureAtRef.current = performance.now();
    releaseLanding();
  };
  // Keyboard scrolling is the reader's too. Only keys that scroll, and not
  // from a control that uses them itself (a menu's roving arrows, a text
  // field): the feed's own scroll after such a press is not a reader scroll.
  // Space scrolls only from the scroller; on a button it activates.
  const onScrollerKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    releaseLanding();
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    const onScroller = event.target === event.currentTarget;
    if (!SCROLL_KEYS.has(event.key) && !(event.key === ' ' && onScroller)) return;
    if (!onScroller && event.target instanceof Element && event.target.closest(KEY_OWNING_SELECTOR) !== null) return;
    scrollGestureAtRef.current = performance.now();
  };
  // A mouse press on the scroller's own scrollbar strip (not on a row, not a
  // touch, which scrolls through touchmove): every scroll until the pointer
  // lifts is the reader dragging it. An overlay scrollbar has no gutter, so
  // the strip is the last 16px of the box.
  const scrollbarDragRef = useRef(false);
  const onScrollerPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    releaseLanding();
    const scroller = event.currentTarget;
    if (event.target !== scroller || event.pointerType !== 'mouse') return;
    const strip = Math.max(16, scroller.offsetWidth - scroller.clientWidth);
    if (event.clientX < scroller.getBoundingClientRect().right - strip) return;
    scrollbarDragRef.current = true;
    const end = () => {
      scrollbarDragRef.current = false;
      window.removeEventListener('pointerup', end, true);
      window.removeEventListener('pointercancel', end, true);
    };
    window.addEventListener('pointerup', end, true);
    window.addEventListener('pointercancel', end, true);
  };

  const lastScrollTop = useRef(0);
  const downwardFromTop = useRef(0);
  const readerScrollFrom = useRef(0);
  const handleScroll = (event: React.UIEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const scroller = event.currentTarget;
    const top = scroller.scrollTop;
    const byReader = scrollbarDragRef.current || performance.now() - scrollGestureAtRef.current < READER_SCROLL_WINDOW_MS;
    // A programmatic scroll re-bases the collapse distance instead of adding
    // to it: opening the phone composer grows its reserve, the end is kept in
    // view, and that scroll must not shut the composer it was made for.
    if (!byReader || top < lastScrollTop.current) downwardFromTop.current = top;
    if (!byReader) readerScrollFrom.current = top;
    lastScrollTop.current = top;
    const distanceFromEnd = scroller.scrollHeight - scroller.clientHeight - top;
    updateEndState(scroller);
    readerTileRef.current = readReaderTile(scroller);

    // A reader who scrolls well away from the end (by script or a scrollbar
    // drag too) takes over from the landing. One estimated row of slack: while
    // rows measure, the library shifts scrollTop before the new total commits,
    // so a landing position can briefly read that far from the end.
    if (landingRef.current && distanceFromEnd > estimateRow(undefined)) {
      releaseLanding();
    }

    // The reader scrolling the feed downward collapses an expanded phone
    // composer so results come fully into view. One-way only — scrolling never
    // auto-expands. Distance accumulates from the last upward turn, so a slow
    // trackpad or touch scroll (many small events) collapses like one flick.
    // getState() avoids a store subscription that would defeat memo(Canvas).
    if (isPhone && top - downwardFromTop.current > 24 && useAtelierStore.getState().composerExpanded) {
      downwardFromTop.current = top;
      useAtelierStore.getState().setComposerExpanded(false);
    }
    // On desktop a reader scroll of more than 24 px either way asks the
    // Composer to yield the viewport (R24); the Composer decides whether it may.
    if (!isPhone && Math.abs(top - readerScrollFrom.current) > 24) {
      readerScrollFrom.current = top;
      requestComposerYield();
    }
  };

  return (
    <div className={styles.shell}>
      <div className={styles.head}>
        <ManagedViewHeader heading={scopeTitle(activeView, collections)} headingId={FEED_HEADING_ID} />
      </div>
      <div
        ref={canvasRef}
        className={styles.canvas}
        role="region"
        tabIndex={0}
        aria-labelledby={FEED_HEADING_ID}
        onScrollCapture={handleScroll}
        onWheel={onScrollGesture}
        onTouchMove={onScrollGesture}
        onTouchStart={releaseLanding}
        onPointerDown={onScrollerPointerDown}
        onKeyDown={onScrollerKeyDown}
        data-testid="canvas-scroller"
        data-state={!blockingError && (isLoading || batches.length === 0) ? 'true' : undefined}
      >
      {blockingError ? (
        <HistoryErrorCanvas error={blockingError} scopeTitle={scopeTitle(activeView, collections)} {...(onRetry ? { onRetry } : {})} />
      ) : isLoading ? (
        <LoadingCanvas />
      ) : batches.length === 0 && trimmedQ ? (
        <SearchEmptyCanvas q={trimmedQ} />
      ) : batches.length === 0 ? (
        // Keyed sibling of the feed column's boundary (unkeyed, React would
        // update one boundary in place): removing the last batch
        // deletes the whole column, so the column exits (a row boundary
        // inside it never runs) while the empty state fades in.
        <ViewTransition key="empty" default="none" enter="part-enter">
          <EmptyCanvas view={activeView} />
        </ViewTransition>
      ) : (
        // Exit only, and none for placeholder rows: their replacement belongs
        // to the view stage, as for the keyed row list below.
        <ViewTransition key="feed" default="none" exit={placeholder ? 'none' : 'tile-exit'}>
        <div className={styles.feedColumn}>
          {/* Older history loads UPWARD: the sentinel sits above the feed, and
              `anchorTo: 'end'` holds the reader's row still while the page
              prepends above them. */}
          <InfiniteStatus
            hasNextPage={hasNextPage}
            isFetchingNextPage={isFetchingNextPage}
            isFetchNextPageError={isFetchNextPageError}
            fetchNextPage={onLoadMore}
            scrollRoot={canvasRef}
            itemCount={batches.length}
            endLabel={`Start, ${String(batches.length)} ${batches.length === 1 ? 'batch' : 'batches'}`}
            enabled={!readOnly}
          />
          {/* Keyed by placeholder vs live data: the commit that replaces a
              previous scope's placeholder rows with the real ones remounts
              the list, so no row or tile boundary sits above that change and
              none plays an exit or entrance. The swap belongs to the view
              stage, not to the per-batch removal motion. */}
          <div
            key={placeholder ? 'placeholder' : 'live'}
            ref={virtualFeedRef}
            className={styles.virtualFeed}
            data-virtualized="canvas"
            style={{ height: `${virtualFeedHeight}px` }}
          >
            {/* TanStack's dynamic-size layout: one window translated to the
                first rendered row, the rows in flow inside it. A per-row
                translateY would only move the rows below a shrinking batch
                after the virtualizer re-measured it, one commit later and
                outside the removal's Transition, so they jumped. */}
            <div
              className={styles.virtualWindow}
              style={{ transform: `translateY(${String((renderBatches[0]?.start ?? 0) - (virtualBatches.length > 0 ? scrollMargin : 0))}px)` }}
            >
            {renderBatches.map((virtualBatch) => {
              const batch = batches[virtualBatch.index];
              if (!batch) return null;
              const seen = seenBatchIds.has(batch.id);
              const currentCollection = batch.collectionId === null
                ? undefined
                : collections.find((collection) => collection.id === batch.collectionId);
              return (
                <VirtualBatchRow
                  key={virtualBatch.key}
                  index={virtualBatch.index}
                  isNewest={virtualBatch.index === batches.length - 1}
                  batch={batch}
                  modelById={modelById}
                  activeView={activeView}
                  currentCollection={currentCollection}
                  seen={seen}
                  readOnlyActions={readOnly}
                  onBatchAction={onBatchAction}
                  promptsEnabled={promptsEnabled}
                  onTileAction={onTileAction}
                  onOpenTile={onOpenTile}
                  onEditTile={onEditTile}
                  onAnimateTile={onAnimateTile}
                  onTellStoryTile={onTellStoryTile}
                  onCreateCardTile={onCreateCardTile}
                  cardPendingTileIds={cardPendingTileIds}
                  measureElement={measureRow}
                  q={q}
                />
              );
            })}
            </div>
          </div>
          {/* The newest end: a failed read while rows are shown (R16). */}
          <FeedRefreshStatus
            message={refreshError === null ? null : `Couldn’t refresh ${scopeTitle(activeView, collections)}.`}
            {...(onRetry ? { onRetry } : {})}
          />
          {readOnly ? null : <FeedRetention view={activeView} q={q} atEnd={endState === 'end'} atEndRef={atEndRef} />}
        </div>
        </ViewTransition>
      )}
      </div>
      <JumpToLatest visible={jumpVisible} marker={jumpMarker} onJump={jumpToLatest} />
    </div>
  );
}

// Memoized so an App re-render that didn't change history (toast/lightbox
// state churn, etc.) doesn't reconcile the whole batch list. `batches`/
// `modelById` is memoized in App and the handler props are useCallback-stable.
export default memo(Canvas);

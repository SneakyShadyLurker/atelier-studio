import type { Batch, Collection, DoneTile, Model, Tile } from '@atelier/shared';
import { observeElementRect, useVirtualizer } from '@tanstack/react-virtual';
import { memo, useCallback, useDeferredValue, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, ViewTransition, type Ref } from 'react';
import { flushSync } from 'react-dom';
import { useIsPhone } from '../../hooks/useIsPhone';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { FEED_SCROLL_END_THRESHOLD_PX, FEED_VIRTUALIZER_ANCHORING } from '../../lib/feedAnchor';
import { fallbackVirtualRows, virtualizedHeight } from '../../lib/virtualWindow';
import { markBatchesSeen, useSeenBatches } from '../../lib/seenBatches';
import { scopeTitle } from '../../lib/viewChrome';
import { useAtelierStore, type AppView } from '../../store/atelier';
import BatchView, { type BatchAction, type TileAction, type TileHandoff } from '../Batch';
import { InfiniteStatus } from '../InfiniteStatus';
import { ManagedViewHeader } from '../ManagedViewHeader';
import { StateView, LoadingState, ErrorState } from '../StateView';
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

// Header + the batch sheet's 16px padding top and bottom; the gap is the
// sheet's 28px top margin. Measurement corrects any miss.
const BATCH_ESTIMATE_BASE = 128;
const BATCH_ESTIMATE_TILE_HEIGHT = 300;
const BATCH_ESTIMATE_GAP = 28;
const CANVAS_FALLBACK_BATCHES = 7;
/** A scroll this soon after a reader's drag or wheel is theirs (covers touch momentum). */
const READER_SCROLL_WINDOW_MS = 1_000;

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
  measureElement: (element: Element | null) => void;
  q: string;
}

export function canvasBatchKey(batches: readonly Pick<Batch, 'id'>[], index: number): string {
  return batches[index]?.id ?? `placeholder-${index}`;
}

/** Tile rows in a batch — the only thing that varies row height at a given width. */
function tileRowCount(batch: Batch | undefined): number {
  return Math.max(1, Math.ceil((batch?.tiles.length ?? 1) / 4));
}

function estimateBatchHeight(batch: Batch | undefined): number {
  return BATCH_ESTIMATE_BASE + BATCH_ESTIMATE_TILE_HEIGHT * tileRowCount(batch) + BATCH_ESTIMATE_GAP;
}

function EmptyCanvas() {
  return (
    <StateView
      art="empty-canvas"
      title="What would you like to make?"
      body={
        <>
          Write a prompt, pick a model, press <kbd>⌘</kbd> <kbd>↵</kbd>.
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

function HistoryErrorCanvas({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return <ErrorState message={error} {...(onRetry ? { onRetry } : {})} />;
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
  const isPhone = useIsPhone();
  const reducedMotion = useReducedMotion();
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const virtualFeedRef = useRef<HTMLDivElement | null>(null);
  // Where the virtual list starts inside the scroller (the history status row
  // and column padding sit above it). TanStack's `scrollMargin` puts the
  // virtualizer's offsets in scroller coordinates, so scrollToIndex lands on
  // the row itself rather than that much short of it.
  const [scrollMargin, setScrollMargin] = useState(0);
  const seenBatchIds = useSeenBatches();
  const getBatchKey = useCallback((index: number) => canvasBatchKey(batches, index), [batches]);

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual's useVirtualizer is the canonical virtualization primitive; React Compiler escape hatch.
  const batchVirtualizer = useVirtualizer({
    count: batches.length,
    getScrollElement: () => canvasRef.current,
    // Stable batch ids, NOT indexes — the anchoring below cannot tell a prepend
    // from an append once every index has shifted.
    getItemKey: getBatchKey,
    estimateSize: (index) => estimateBatchHeight(batches[index]),
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
            const size = row instanceof HTMLElement ? row.offsetHeight : row.getBoundingClientRect().height;
            instance.resizeItem(instance.indexFromElement(row), size);
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
  const virtualBatches = batchVirtualizer.getVirtualItems();
  const renderBatches = virtualBatches.length > 0
    ? virtualBatches
    : fallbackVirtualRows(
      batches.length,
      CANVAS_FALLBACK_BATCHES,
      (index) => estimateBatchHeight(batches[index]),
      (index) => canvasBatchKey(batches, index),
    );
  const estimatedFeedHeight = useMemo(
    () => batches.reduce((total, batch) => total + estimateBatchHeight(batch), 0),
    [batches],
  );
  const virtualFeedHeight = virtualizedHeight(virtualBatches.length > 0, batchVirtualizer.getTotalSize(), estimatedFeedHeight);
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
    setScrollMargin(feed.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop);
  }, [batches.length, hasNextPage, isFetchingNextPage, isFetchNextPageError, isPhone]);

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
  // the first render that actually has batches (mount usually has none — the
  // query is still resolving) and never again. `scrollToEnd` is the
  // virtualizer's own path and reconciles toward the end as rows measure.
  // Following new work is the library's `followOnAppend` (lib/feedAnchor): it
  // follows only a reader within the shared end threshold, and keeps the end
  // pinned as appended rows measure taller than their estimate.
  useLayoutEffect(() => {
    if (landedRef.current || batches.length === 0 || !canvasRef.current) return;
    landedRef.current = true;
    landingRef.current = true;
    batchVirtualizer.scrollToEnd();
  }, [batches.length, batchVirtualizer]);

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
  useEffect(() => {
    const scroller = canvasRef.current;
    if (!scroller || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (landingRef.current || atEndRef.current) batchVirtualizer.scrollToEnd();
    });
    observer.observe(scroller);
    return () => { observer.disconnect(); };
  }, [batchVirtualizer]);

  useEffect(() => {
    if (renderedBatchIds === '') return;
    markBatchesSeen(renderedBatchIds.split('\0'));
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

  const lastScrollTop = useRef(0);
  const downwardFromTop = useRef(0);
  const handleScroll = (event: React.UIEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const scroller = event.currentTarget;
    const top = scroller.scrollTop;
    const byReader = performance.now() - scrollGestureAtRef.current < READER_SCROLL_WINDOW_MS;
    // A programmatic scroll re-bases the collapse distance instead of adding
    // to it: opening the phone composer grows its reserve, the end is kept in
    // view, and that scroll must not shut the composer it was made for.
    if (!byReader || top < lastScrollTop.current) downwardFromTop.current = top;
    lastScrollTop.current = top;
    const distanceFromEnd = scroller.scrollHeight - scroller.clientHeight - top;
    atEndRef.current = distanceFromEnd <= FEED_SCROLL_END_THRESHOLD_PX;

    // A reader who scrolls well away from the end (by script or a scrollbar
    // drag too) takes over from the landing. One estimated row of slack: while
    // rows measure, the library shifts scrollTop before the new total commits,
    // so a landing position can briefly read that far from the end.
    if (landingRef.current && distanceFromEnd > estimateBatchHeight(undefined)) {
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
        aria-labelledby={FEED_HEADING_ID}
        onScrollCapture={handleScroll}
        onWheel={onScrollGesture}
        onTouchMove={onScrollGesture}
        onTouchStart={releaseLanding}
        onPointerDown={releaseLanding}
        onKeyDown={releaseLanding}
        data-testid="canvas-scroller"
        data-state={!blockingError && (isLoading || batches.length === 0) ? 'true' : undefined}
      >
      {blockingError ? (
        <HistoryErrorCanvas error={blockingError} {...(onRetry ? { onRetry } : {})} />
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
          <EmptyCanvas />
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
                  measureElement={batchVirtualizer.measureElement}
                  q={q}
                />
              );
            })}
            </div>
          </div>
        </div>
        </ViewTransition>
      )}
      </div>
    </div>
  );
}

// Memoized so an App re-render that didn't change history (toast/lightbox
// state churn, etc.) doesn't reconcile the whole batch list. `batches`/
// `modelById` is memoized in App and the handler props are useCallback-stable.
export default memo(Canvas);

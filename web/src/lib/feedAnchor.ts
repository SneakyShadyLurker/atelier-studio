/*
 * Shared virtualizer anchoring for the two batch feeds — the Canvas and the
 * Sidebar rail. They list the same batches in the same order, so they must not
 * disagree about whether the reader moves.
 *
 * The feed is bottom-anchored (see the ordering boundary in `useHistory`): it
 * reads oldest → newest so the newest batch sits against the bottom composer,
 * which is where the user's hands and attention already are. That makes new
 * work an APPEND and an older page a PREPEND, and TanStack Virtual has a
 * first-class mode for exactly this shape:
 *
 *   anchorTo: 'end'      Captures the row the reader is looking at and restores
 *                        it after the list changes, so loading older history
 *                        above the viewport moves nothing under them. Requires
 *                        a stable `getItemKey` — index keys cannot distinguish
 *                        a prepend from an append once indexes shift.
 *
 *   followOnAppend       Sticks to the newest batch when one arrives, but ONLY
 *                        if the viewport was already at the end. A reader who
 *                        scrolled up into history is never pulled back down —
 *                        which is the whole "don't yank me" contract, handed to
 *                        the library instead of hand-rolled.
 *
 *   scrollEndThreshold   How close to the end still counts as pinned. The
 *                        default (1px) is too strict for a feed whose rows are
 *                        measured asynchronously: a few pixels of settle would
 *                        read as "the user scrolled away" and silently stop the
 *                        follow. One tile-gap of slack is enough to be robust
 *                        without pinning someone who genuinely scrolled off.
 *
 *   scrollPaddingEnd     The scroller carries bottom padding so content clears
 *                        the composer, and the virtualizer's coordinate space
 *                        does not include it — so "align the last row to the
 *                        viewport end" lands short by exactly that padding,
 *                        parking the newest batch behind the composer. The
 *                        padding is a calc() off the live composer height, so
 *                        rather than measure it every frame we overshoot: the
 *                        library clamps every alignment target to the real
 *                        `scrollHeight - clientHeight`, so any value at or above
 *                        the true padding resolves to the actual end and any
 *                        composer height is handled without a measurement pass.
 */
export const FEED_SCROLL_END_THRESHOLD_PX = 80;

/** Comfortably above the tallest the composer can grow (textarea caps at 180). */
const FEED_SCROLL_PADDING_END_PX = 600;

export const FEED_VIRTUALIZER_ANCHORING = {
  anchorTo: 'end',
  followOnAppend: true,
  scrollEndThreshold: FEED_SCROLL_END_THRESHOLD_PX,
  scrollPaddingEnd: FEED_SCROLL_PADDING_END_PX,
  // A batch removal re-anchors the feed, and the scroll it fires would
  // flushSync a re-render while React's view transition for that removal is
  // still capturing; React then skips the transition (the Batch tile and
  // Canvas row boundaries). Plain batched updates keep the reflow animated.
  useFlushSync: false,
} as const;

/** Per-feed margin bookkeeping: the last measured margin and a shift still owed to the reader. */
export interface FeedMarginState {
  margin: number | null;
  owed: number;
}

/** The virtualizer surface the margin shift goes through. */
export interface FeedScrollSurface {
  readonly isScrolling: boolean;
  scrollBy: (delta: number) => void;
}

/** The project's touch gate (touch floors use the same query in CSS). */
const TOUCH_GATE = '(hover: none), (any-pointer: coarse)';

/**
 * Where a feed's virtual list starts inside its scroller (TanStack's
 * `scrollMargin`), measured after each commit. When the content above the list
 * (the history status row) changes height, the reader is owed a scroll shift of
 * the same amount so the row under them holds still. `anchorTo: 'end'` cannot
 * cover this: it re-anchors only when the row set changes, and it resolves the
 * anchor with the margin of that same render, before this measurement has
 * caught up. The first measurement only records the margin.
 */
export function measureFeedScrollMargin(
  scroller: HTMLElement,
  list: HTMLElement,
  state: FeedMarginState,
  virtualizer: FeedScrollSurface,
): number {
  const margin = list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  if (state.margin !== null) state.owed += margin - state.margin;
  state.margin = margin;
  settleFeedScrollMargin(scroller, state, virtualizer);
  return margin;
}

/**
 * Pays the owed shift through the virtualizer (`scrollBy`), whose scroll
 * reconcile would otherwise restore its own target over a raw scrollTop write.
 * On a touch device it waits while the feed scrolls: a scroll write cancels iOS
 * momentum, which is why virtual-core holds its own corrections there too, and
 * callers settle again once `isScrolling` clears. A shrink a reader at the end
 * already got, because the browser clamped scrollTop to the new maximum, is
 * dropped instead of applied a second time.
 */
export function settleFeedScrollMargin(scroller: HTMLElement, state: FeedMarginState, virtualizer: FeedScrollSurface): void {
  if (state.owed === 0) return;
  if (virtualizer.isScrolling && typeof matchMedia === 'function' && matchMedia(TOUCH_GATE).matches) return;
  const owed = state.owed;
  state.owed = 0;
  if (scroller.scrollTop <= 0) return;
  if (owed < 0 && scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 1) return;
  virtualizer.scrollBy(owed);
}

/** One row size change, as TanStack's `shouldAdjustScrollPositionOnItemSizeChange` sees it. */
export interface RowResize {
  /** The row's start and its size before this change, in scroller coordinates. */
  start: number;
  size: number;
  delta: number;
  /** The viewport top in the same coordinates. */
  scrollOffset: number;
  /** The row's first measurement (its estimate is being replaced). */
  firstMeasure: boolean;
  backward: boolean;
  /**
   * How far the reader's first visible tile moved inside this row since it
   * was recorded, or null when this row does not hold it.
   */
  tileShift: number | null;
}

/**
 * Whether a row's size change moves the scroll offset by its delta. TanStack
 * anchors at row boundaries: by default it compensates a first measurement
 * above the fold and a re-measurement of a row entirely above the fold (not
 * while scrolling backward), and leaves a row that spans the viewport top
 * alone, since a streaming row grows below the reader. A feed row holds up
 * to four tiles, so a tile above the reader's inside that same row can fail
 * to a compact card or leave. The spanning row compensates when the reader's
 * first visible tile moved inside it by more than half the change, that is
 * when the change sits above that tile; a change below it moves nothing.
 */
export function shouldAnchorRowResize(resize: RowResize): boolean {
  const { start, size, delta, scrollOffset, firstMeasure, backward, tileShift } = resize;
  if (firstMeasure) return start < scrollOffset;
  if (start + size <= scrollOffset) return !backward;
  if (start >= scrollOffset || tileShift === null || tileShift === 0) return false;
  return Math.abs(tileShift - delta) < Math.abs(tileShift);
}

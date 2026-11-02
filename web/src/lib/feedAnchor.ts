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
} as const;

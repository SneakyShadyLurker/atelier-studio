import { useEffect, useEffectEvent, useRef } from 'react';

export interface UseInfiniteScrollOptions {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError?: boolean;
  fetchNextPage: () => void;
  /** Retained for caller compatibility; intentionally NOT a dep of the observer effect. */
  itemCount: number;
  /**
   * The scroll container the sentinel lives in. The sentinel is clipped by that
   * container before it is intersected with the root, so a margin on the
   * default (viewport) root can never reach past its clip: without this, the
   * next page starts loading only once the sentinel is actually on screen.
   */
  root?: React.RefObject<HTMLElement | null>;
  rootMargin?: string;
  enabled?: boolean;
}

export interface UseInfiniteScrollResult {
  sentinelRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * Half the root's height ahead of the edge. A percentage resolves against the
 * root's own box (the scroller when one is given) and follows resizes, where a
 * pixel value frozen per render would not.
 */
const PREFETCH_ROOT_MARGIN = '50% 0px';

export function useInfiniteScroll({
  hasNextPage,
  isFetchingNextPage,
  isFetchNextPageError = false,
  fetchNextPage,
  itemCount,
  root,
  rootMargin,
  enabled = true,
}: UseInfiniteScrollOptions): UseInfiniteScrollResult {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const visibleRef = useRef(false);
  const resolvedRootMargin = rootMargin ?? PREFETCH_ROOT_MARGIN;

  // Effect Event: reads the latest fetchNextPage / isFetchingNextPage without
  // making the observer effect reactive to either. Without that isolation an
  // inline-arrow `fetchNextPage` — the shape at all three call sites — would
  // tear down and rebuild the observer on every SSE-driven parent render.
  const loadMoreIfIdle = useEffectEvent(() => {
    if (isFetchingNextPage || isFetchNextPageError) return;
    fetchNextPage();
  });

  useEffect(() => {
    if (!enabled || !hasNextPage) {
      visibleRef.current = false;
      return;
    }
    const sentinel = sentinelRef.current;
    if (!sentinel) {
      visibleRef.current = false;
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[0];
      visibleRef.current = entry?.isIntersecting === true;
      if (visibleRef.current) loadMoreIfIdle();
    }, { rootMargin: resolvedRootMargin, ...(root?.current ? { root: root.current } : {}) });
    observer.observe(sentinel);
    return () => {
      visibleRef.current = false;
      observer.disconnect();
    };
    // observer doesn't depend on count; the sentinel fires on intersection only
  }, [enabled, hasNextPage, resolvedRootMargin, root]);

  useEffect(() => {
    if (!enabled || !hasNextPage || !visibleRef.current) return;
    loadMoreIfIdle();
    // The Effect Event reads the current error. A background refetch clearing
    // only that flag must not restart the same failing pagination cursor.
  }, [enabled, hasNextPage, isFetchingNextPage, itemCount]);

  return { sentinelRef };
}

import { useEffect, useEffectEvent, useRef } from 'react';

export interface UseInfiniteScrollOptions {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError?: boolean;
  fetchNextPage: () => void;
  /** Retained for caller compatibility; intentionally NOT a dep of the observer effect. */
  itemCount: number;
  rootMargin?: string;
  enabled?: boolean;
}

export interface UseInfiniteScrollResult {
  sentinelRef: React.RefObject<HTMLDivElement | null>;
}

function viewportRootMargin(): string {
  return `${String(Math.round(window.innerHeight * 0.5))}px 0px`;
}

export function useInfiniteScroll({
  hasNextPage,
  isFetchingNextPage,
  isFetchNextPageError = false,
  fetchNextPage,
  itemCount,
  rootMargin,
  enabled = true,
}: UseInfiniteScrollOptions): UseInfiniteScrollResult {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const visibleRef = useRef(false);
  const resolvedRootMargin = rootMargin ?? viewportRootMargin();

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
    }, { rootMargin: resolvedRootMargin });
    observer.observe(sentinel);
    return () => {
      visibleRef.current = false;
      observer.disconnect();
    };
    // observer doesn't depend on count; the sentinel fires on intersection only
  }, [enabled, hasNextPage, resolvedRootMargin]);

  useEffect(() => {
    if (!enabled || !hasNextPage || !visibleRef.current) return;
    loadMoreIfIdle();
    // The Effect Event reads the current error. A background refetch clearing
    // only that flag must not restart the same failing pagination cursor.
  }, [enabled, hasNextPage, isFetchingNextPage, itemCount]);

  return { sentinelRef };
}

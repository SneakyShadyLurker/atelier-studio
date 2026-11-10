import { useDeferredValue } from 'react';
import { useInfiniteScroll } from '../../hooks/useInfiniteScroll';
import styles from './index.module.css';

export interface InfiniteStatusProps {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError?: boolean;
  fetchNextPage: () => void;
  itemCount: number;
  endLabel: string;
  /** The scroll container holding this row; the prefetch margin is measured against it. */
  scrollRoot?: React.RefObject<HTMLElement | null>;
  rootMargin?: string;
  enabled?: boolean;
}

/**
 * The row's footprint: the full reserve while more can load, the compact end
 * state once nothing can follow. It commits in the deferred render, the same
 * render in which a parent drawing its rows from `useDeferredValue` (Canvas,
 * Archive) commits the last page, so the row never shrinks a commit before the
 * page it ends on. Fetching reads the live flags. A feed that measures what
 * sits above its list keys that measurement on this same value.
 */
export function useStatusFootprint(hasNextPage: boolean): 'pending' | 'end' {
  return useDeferredValue(hasNextPage ? 'pending' : 'end');
}

export function InfiniteStatus({
  hasNextPage,
  isFetchingNextPage,
  isFetchNextPageError = false,
  fetchNextPage,
  itemCount,
  endLabel,
  scrollRoot,
  rootMargin,
  enabled = true,
}: InfiniteStatusProps) {
  const { sentinelRef } = useInfiniteScroll({
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    fetchNextPage,
    itemCount,
    enabled,
    ...(scrollRoot ? { root: scrollRoot } : {}),
    ...(rootMargin !== undefined ? { rootMargin } : {}),
  });
  const footprint = useStatusFootprint(hasNextPage);

  if (!enabled) return null;
  if (!hasNextPage && itemCount === 0) return null;

  // Sentinel + fallback button stay mounted whenever hasNextPage so the
  // IntersectionObserver retains a stable target across loading transitions
  // and so AT users don't lose focus mid-activation on the fallback button.
  // The aria-live region is restricted to the text-only label so the focusable
  // control sits outside it.
  const state: 'loading' | 'end' | 'idle' =
    hasNextPage && isFetchingNextPage ? 'loading'
      : !hasNextPage ? 'end'
        : 'idle';

  return (
    <div className={styles.root} data-footprint={footprint} data-error={isFetchNextPageError ? 'true' : undefined}>
      <div className={styles.hairline} data-state={state} aria-hidden="true" />
      <div role="status" aria-live="polite" className={styles.status}>
        {state === 'loading' ? 'Loading more' : isFetchNextPageError ? 'Could not load more' : state === 'end' ? endLabel : ''}
      </div>
      {hasNextPage ? (
        <>
          <div ref={sentinelRef} className={styles.sentinel} aria-hidden="true" />
          <button
            type="button"
            className={styles.fallbackButton}
            onClick={() => { if (!isFetchingNextPage) fetchNextPage(); }}
            aria-disabled={isFetchingNextPage || undefined}
            aria-busy={isFetchingNextPage || undefined}
          >
            {isFetchNextPageError ? 'Retry loading more' : 'Load more'}
          </button>
        </>
      ) : null}
    </div>
  );
}

interface FeedRefreshStatusProps {
  /** The failure to announce, or null while the last read succeeded. */
  message: string | null;
  onRetry?: () => void;
}

/**
 * The feed's newest-end status row for a failed read while rows are shown
 * (R16), in the load-more row's error vocabulary. The polite live region
 * stays mounted, empty and without a footprint, so the failure is announced
 * when it arrives and the row leaves on the next successful read.
 */
export function FeedRefreshStatus({ message, onRetry }: FeedRefreshStatusProps) {
  const failed = message !== null;
  return (
    <div className={styles.refresh} data-footprint="end" data-error={failed ? 'true' : undefined} data-testid="history-refresh-status">
      {failed ? <div className={styles.hairline} aria-hidden="true" /> : null}
      <div role="status" aria-live="polite" className={styles.status}>{message ?? ''}</div>
      {failed && onRetry ? (
        <button type="button" className={styles.fallbackButton} onClick={onRetry}>Retry</button>
      ) : null}
    </div>
  );
}

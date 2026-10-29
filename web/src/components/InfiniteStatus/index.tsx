import { useInfiniteScroll } from '../../hooks/useInfiniteScroll';
import styles from './index.module.css';

export interface InfiniteStatusProps {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError?: boolean;
  fetchNextPage: () => void;
  itemCount: number;
  endLabel: string;
  rootMargin?: string;
  enabled?: boolean;
}

export function InfiniteStatus({
  hasNextPage,
  isFetchingNextPage,
  isFetchNextPageError = false,
  fetchNextPage,
  itemCount,
  endLabel,
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
    ...(rootMargin !== undefined ? { rootMargin } : {}),
  });

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
    <div className={styles.root} data-error={isFetchNextPageError ? 'true' : undefined}>
      <div className={styles.hairline} data-state={state} aria-hidden="true" />
      <div role="status" aria-live="polite">
        {state === 'loading' ? 'LOADING MORE' : isFetchNextPageError ? 'COULD NOT LOAD MORE' : state === 'end' ? endLabel : ''}
      </div>
      {hasNextPage ? (
        <>
          <div ref={sentinelRef} className={styles.sentinel} aria-hidden="true" />
          <button
            type="button"
            className={styles.fallbackButton}
            onClick={() => { fetchNextPage(); }}
            disabled={isFetchingNextPage}
            aria-busy={isFetchingNextPage}
          >
            {isFetchNextPageError ? 'Retry loading more' : 'Load more'}
          </button>
        </>
      ) : null}
    </div>
  );
}

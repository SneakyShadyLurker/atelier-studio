import { useCallback, useMemo } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { Batch } from '@atelier/shared';
import { historyOpts } from '../api/history';
import type { AppView } from '../store/atelier';
import { useCollections } from './useCollections';
import { useHistoryRefresh } from './useHistoryRefresh';

export function useHistory(view: AppView = { kind: 'unsorted' }, q = '') {
  // The feed query only backs feed views. For non-feed views (Prompt Library,
  // Archive) `applyHistoryScopeParams` emits no collectionId filter, so the
  // request would resolve to EVERY collection's batches. Left enabled, that
  // unscoped result becomes the keepPreviousData placeholder when the user
  // returns to the Unsorted feed — flashing collection content under Unsorted
  // until the correctly-scoped fetch lands. Gate it off so the feed observer
  // only ever holds genuine feed-scope data.
  const isFeedView = view.kind === 'unsorted' || view.kind === 'pinned' || view.kind === 'collection';
  const isCollectionView = view.kind === 'collection';
  const collectionsQuery = useCollections({ enabled: isCollectionView });
  const isValidCollectionId = isCollectionView
    ? collectionsQuery.data?.items.some((collection) => collection.id === view.id) ?? false
    : true;
  const enabled = isFeedView && (!isCollectionView || (collectionsQuery.isSuccess && isValidCollectionId));
  const query = useInfiniteQuery(historyOpts(view, q, enabled));
  const refresh = useHistoryRefresh(view, q, query.data, enabled && !query.isPlaceholderData);

  // THE ordering boundary. Wire + cache are `created_at DESC` (newest first) and
  // the cursor paginates backwards through that; the FEED reads the other way —
  // oldest at the top, newest against the bottom composer, so a queued burst
  // grows downward from the batch currently generating. Flip once here rather
  // than in the cache: the server ordering and cursor stay untouched, a new
  // batch becomes an APPEND and an older page becomes a PREPEND, which is
  // exactly the shape `anchorTo: 'end'` + `followOnAppend` are built for.
  // Everything downstream of this line is oldest-first.
  //
  // Memoized against `query.data` so the array's reference stays stable across
  // renders that didn't change history. Without this, every App.tsx render
  // allocates a fresh `batches` array — Canvas, Sidebar, useKeyboard, and
  // Lightbox all see new prop refs and re-run effects / re-bind listeners on
  // every SSE tile event during a generation. `flatMap` already returns a fresh
  // array, so reversing it in place is safe.
  const batches = useMemo<readonly Batch[]>(
    () => (query.data?.pages.flatMap((page) => page.items) ?? []).reverse(),
    [query.data],
  );

  const { refetch: refetchHistory } = query;
  const { refetch: refetchActive, isError: isRefreshError } = refresh;
  const refetch = useCallback<typeof refetchHistory>(async (options) => {
    // Manual Retry retains the authoritative history refetch and its result
    // contract. Refresh then rechecks current targets, so jobs completed by
    // that GET clear the refresh failure without another POST.
    const result = await refetchHistory(options);
    if (isRefreshError) await refetchActive(options);
    return result;
  }, [refetchHistory, isRefreshError, refetchActive]);

  return {
    batches,
    isError: query.isError || refresh.isError,
    error: query.error ?? refresh.error,
    hasNextPage: query.hasNextPage,
    // isLoading is true only when pending with no cached/placeholder data —
    // with keepPreviousData a scope/search switch keeps the prior results
    // visible (isPlaceholderData), so the spinner shows only on a cold load.
    isLoading: query.isLoading,
    isPlaceholderData: query.isPlaceholderData,
    isFetching: query.isFetching,
    isFetchingNextPage: query.isFetchingNextPage,
    isFetchNextPageError: query.isFetchNextPageError,
    fetchNextPage: query.fetchNextPage,
    refetch,
  };
}

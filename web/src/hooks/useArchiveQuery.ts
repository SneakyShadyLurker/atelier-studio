import { useMemo } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { ArchivedTile } from '@atelier/shared';
import { archiveOpts } from '../api/archive';
import type { ArchiveScope } from '../store/atelier';

export function useArchiveQuery(scope: ArchiveScope = { kind: 'all' }, enabled = true) {
  const query = useInfiniteQuery(archiveOpts(scope, enabled));

  // One pass over pages, both values stable across renders that didn't
  // change archive state. `total` ships only on the first (cursor-less)
  // page — later pages carry null; pick the freshest non-null (page 0,
  // refetched on every archive mutation). Falls back to 0 pre-response.
  const { items, total } = useMemo<{ items: readonly ArchivedTile[]; total: number }>(() => {
    const pages = query.data?.pages;
    return {
      items: pages?.flatMap((page) => page.items) ?? [],
      total: pages?.find((page) => page.total != null)?.total ?? 0,
    };
  }, [query.data]);

  return {
    items,
    total,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    hasNextPage: query.hasNextPage,
    isFetching: query.isFetching,
    isFetchingNextPage: query.isFetchingNextPage,
    isFetchNextPageError: query.isFetchNextPageError,
    fetchNextPage: query.fetchNextPage,
    refetch: query.refetch,
  };
}

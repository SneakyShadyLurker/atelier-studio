import type { ArchivedTile, ArchivePage } from '@atelier/shared';
import { infiniteQueryOptions } from '@tanstack/react-query';
import { ApiError, apiImageUrl, apiPath, isArchivePage, requestJsonValidated, requestNoContent } from './client';
import type { ArchiveScope } from '../store/atelier';
import { deleteKeepingUploads } from './history';

const ARCHIVE_ALL_SCOPE: ArchiveScope = { kind: 'all' };

export const archiveKeys = {
  all: () => ['archive'] as const,
  scoped: (scope: ArchiveScope) => [...archiveKeys.all(), 'list', scope] as const,
  list: () => archiveKeys.scoped(ARCHIVE_ALL_SCOPE),
};

export const archiveOpts = (scope: ArchiveScope = ARCHIVE_ALL_SCOPE, enabled = true) =>
  infiniteQueryOptions({
    queryKey: archiveKeys.scoped(scope),
    queryFn: ({ pageParam }) => fetchArchivePage(pageParam, 60, scope),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled,
    // No keepPreviousData here (unlike historyOpts): Archive exposes
    // irreversible permanent-delete + Empty-Archive controls, so a stale
    // previous-scope row left clickable during a scope switch is a data-loss
    // footgun. Archive keeps a spinner on scope switch; its switches are rare.
    // Per per-query staleTime convention in `code_style.md`: list is server-
    // authoritative on mutate, 30s focus refetch is the right tier.
    staleTime: 30_000,
    retry: (failureCount, error) => {
      if (error instanceof ApiError && !error.retryable) return false;
      return failureCount < 2;
    },
  });

function normalizeArchivedTile(tile: ArchivedTile): ArchivedTile {
  return {
    ...tile,
    url: apiImageUrl(tile.url),
    ...(tile.thumbUrl ? { thumbUrl: apiImageUrl(tile.thumbUrl) } : {}),
  };
}

export function fetchArchivePage(
  cursor: string | null | undefined,
  limit = 60,
  scope: ArchiveScope = ARCHIVE_ALL_SCOPE,
): Promise<ArchivePage> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set('cursor', cursor);
  if (scope.kind === 'unsorted') params.set('collectionId', 'null');
  else if (scope.kind === 'pinned') params.set('pinned', 'true');
  else if (scope.kind === 'collection') params.set('collectionId', scope.id);
  return requestJsonValidated(`/archive?${params.toString()}`, {}, isArchivePage).then((page) => ({
    ...page,
    items: page.items.map(normalizeArchivedTile),
  }));
}

export function restoreArchive(tileId: string): Promise<void> {
  return requestNoContent(apiPath('/archive/:tileId/restore', { tileId }), { method: 'POST' });
}

export function permanentDelete(tileId: string): Promise<void> {
  return deleteKeepingUploads(apiPath('/archive/:tileId', { tileId }));
}

export function purgeArchive(): Promise<void> {
  return deleteKeepingUploads('/archive');
}

import type { Query, QueryClient, QueryKey } from '@tanstack/react-query';
import { historyKeys } from '../api/history';
import { withTaggedPages, writeHistoryScope, type HistoryData } from './historyCache';
import { HISTORY_WRITE_MUTATION_KEY } from './historyWrites';

// Bounded retention of live history pages. Every page a reader scrolled
// through stays in the cache (and in every refetch of the scope) until the
// scope is collected, so a long session re-reads hundreds of rows on each
// focus or settle. The trim keeps the newest pages, where the feed opens.

/** Pages a trimmed scope keeps. */
export const HISTORY_RETAINED_PAGES = 3;
/** Rows the kept pages may hold before the scope is re-read and repacked. */
export const HISTORY_RETAINED_ROW_CAP = 240;

export type TrimResult = 'trimmed' | 'blocked' | 'noop';

function rowCount(pages: HistoryData['pages']): number {
  return pages.reduce((count, page) => count + page.items.length, 0);
}

function historyWriting(queryClient: QueryClient): boolean {
  return queryClient.isMutating({ mutationKey: HISTORY_WRITE_MUTATION_KEY }) > 0;
}

/**
 * Trims one cached history scope to its newest `keepPages` pages. Blocked
 * while the scope fetches (a refetch or next page would land over the
 * slice) or a history write is pending (its rollback and settle read work on
 * the pages it saw). The kept pages keep their cursors, so the last one
 * still continues where it ended, and the write keeps the last server read's
 * clock and pending invalidation. Kept pages grown past the row cap by
 * streamed inserts invalidate the scope once so a re-read repacks them.
 */
export function trimHistoryPages(queryClient: QueryClient, key: QueryKey, keepPages: number = HISTORY_RETAINED_PAGES): TrimResult {
  const query = queryClient.getQueryCache().find<HistoryData>({ queryKey: key, exact: true });
  const data = query?.state.data;
  if (!query || !data) return 'noop';
  const slice = data.pages.length > keepPages;
  const kept = slice ? data.pages.slice(0, keepPages) : data.pages;
  const repack = rowCount(kept) > HISTORY_RETAINED_ROW_CAP && !query.state.isInvalidated;
  if (!slice && !repack) return 'noop';
  if (query.state.fetchStatus === 'fetching' || historyWriting(queryClient)) return 'blocked';
  if (slice) {
    writeHistoryScope(queryClient, key, (current) => withTaggedPages(
      { ...current, pageParams: current.pageParams.slice(0, keepPages) },
      current.pages.slice(0, keepPages),
    ));
  }
  if (repack) void queryClient.invalidateQueries({ queryKey: key, exact: true });
  return 'trimmed';
}

function isHistoryScope(query: Query): boolean {
  return query.queryKey[0] === historyKeys.all()[0] && query.queryKey.length === 2;
}

const installed = new WeakSet<QueryClient>();

/**
 * Trims a history scope when it loses its last observer (the reader left it).
 * A trim blocked by a fetch or a pending history write is retried when that
 * fetch settles or the last history write settles, provided the scope still
 * has no observer. Installed once per client; lives as long as the client.
 */
export function installHistoryRetention(queryClient: QueryClient): void {
  if (installed.has(queryClient)) return;
  installed.add(queryClient);
  const queryCache = queryClient.getQueryCache();
  // Blocked trims by query hash.
  const pending = new Map<string, Query>();
  const attempt = (query: Query) => {
    pending.delete(query.queryHash);
    if (query.getObserversCount() > 0 || queryCache.get(query.queryHash) !== query) return;
    if (trimHistoryPages(queryClient, query.queryKey) === 'blocked') pending.set(query.queryHash, query);
  };
  queryCache.subscribe((event) => {
    const query = event.query as Query;
    if (!isHistoryScope(query)) return;
    if (event.type === 'observerRemoved' && query.getObserversCount() === 0) {
      attempt(query);
    } else if (event.type === 'updated' && pending.has(query.queryHash) && query.state.fetchStatus === 'idle') {
      attempt(query);
    } else if (event.type === 'removed') {
      pending.delete(query.queryHash);
    }
  });
  queryClient.getMutationCache().subscribe(() => {
    if (pending.size === 0 || historyWriting(queryClient)) return;
    for (const query of [...pending.values()]) attempt(query);
  });
}

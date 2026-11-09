import type { QueryClient } from '@tanstack/react-query';
import { archiveKeys } from '../api/archive';
import { collectionKeys } from '../api/collections';
import { historyKeys } from '../api/history';
import { libraryCoverageKeys } from '../api/libraryCoverage';
import { libraryDiagnosisKeys } from '../api/libraryDiagnosis';
import { promptKeys } from '../api/prompts';
import { HISTORY_WRITE_MUTATION_KEY } from './historyWrites';

interface InvalidateLibraryOptions {
  historyRefetchType?: 'active' | 'all' | 'inactive' | 'none';
}

// A history re-read deferred behind other in-flight writes, per client. It
// runs once the MutationCache reports no pending history write: two writes
// whose settle windows overlap can each see the other as pending and both
// defer, so neither onSettled can be trusted to be "the last".
// The subscription lives as long as the client does.
const deferredReads = new WeakMap<QueryClient, { pending: boolean }>();

function historyWriting(queryClient: QueryClient): boolean {
  return queryClient.isMutating({ mutationKey: HISTORY_WRITE_MUTATION_KEY }) > 0;
}

function deferHistoryRead(queryClient: QueryClient): void {
  let entry = deferredReads.get(queryClient);
  if (!entry) {
    const created = { pending: false };
    queryClient.getMutationCache().subscribe(() => {
      if (!created.pending || historyWriting(queryClient)) return;
      created.pending = false;
      void queryClient.invalidateQueries({ queryKey: historyKeys.all() });
    });
    deferredReads.set(queryClient, created);
    entry = created;
  }
  entry.pending = true;
}

// Mark every history scope stale without reading it now: a GET sent while a
// history write is pending could land pre-commit state over that write's
// optimistic patch. The read runs once no history write is pending.
export function invalidateHistoryBehindWrites(queryClient: QueryClient): Promise<void> {
  deferHistoryRead(queryClient);
  return queryClient.invalidateQueries({ queryKey: historyKeys.all(), refetchType: 'none' });
}

// The library re-read every settled history write (and a sibling tab's
// message) runs. While another history write is still in flight, the read
// only marks history stale: a GET sent now could return pre-commit state and
// land over that write's optimistic patch. The refetch then runs once when the
// last of those writes has settled. A settling write still counts as pending
// here, so "another" means a count above one.
export function invalidateLibrary(
  queryClient: QueryClient,
  options: InvalidateLibraryOptions = {},
): Promise<unknown[]> {
  const otherWritesPending = queryClient.isMutating({ mutationKey: HISTORY_WRITE_MUTATION_KEY }) > 1;
  if (options.historyRefetchType === undefined) {
    if (otherWritesPending) deferHistoryRead(queryClient);
    else {
      // This read covers whatever an earlier settle deferred.
      const deferred = deferredReads.get(queryClient);
      if (deferred) deferred.pending = false;
    }
  }
  const historyRefetchType = options.historyRefetchType ?? (otherWritesPending ? 'none' : undefined);
  return Promise.all([
    queryClient.invalidateQueries({
      queryKey: historyKeys.all(),
      ...(historyRefetchType ? { refetchType: historyRefetchType } : {}),
    }),
    queryClient.invalidateQueries({ queryKey: archiveKeys.all() }),
    queryClient.invalidateQueries({ queryKey: collectionKeys.list() }),
  ]);
}

export function invalidatePromptLibrary(queryClient: QueryClient): Promise<unknown[]> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: promptKeys.all() }),
    queryClient.invalidateQueries({ queryKey: libraryDiagnosisKeys.all() }),
    queryClient.invalidateQueries({ queryKey: libraryCoverageKeys.current() }),
  ]);
}

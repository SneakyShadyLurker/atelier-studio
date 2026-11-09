import type { QueryClient } from '@tanstack/react-query';

// Native TanStack mutation identity shared by all writes that can change the
// paginated history projection. Streaming generation deliberately stays out.
export const HISTORY_WRITE_MUTATION_KEY = ['history-write'] as const;

/**
 * The newest history write the client has seen (0 when none). A read that
 * started before a write and lands after it carries pre-commit state; callers
 * capture this before the request and discard the response when it moved.
 */
export function lastHistoryWriteId(queryClient: QueryClient): number {
  return queryClient.getMutationCache().findAll({ mutationKey: HISTORY_WRITE_MUTATION_KEY })
    .reduce((latest, mutation) => Math.max(latest, mutation.mutationId), 0);
}

import { HISTORY_REFRESH_MAX_IDS, type Batch } from '@atelier/shared';
import { HistoryRefreshResponseSchema, type HistoryRefreshRequest, type HistoryRefreshResponse } from '@atelier/shared/wire-schemas';
import { requestJsonValidated } from './client';
import { applyHistoryScopeParams, normalizeBatch } from './history';
import { mapWithConcurrency } from '../lib/mapWithConcurrency';
import type { AppView } from '../store/atelier';

export const historyRefreshKeys = {
  all: () => ['history-refresh'] as const,
  scoped: (view: AppView, q: string) => [...historyRefreshKeys.all(), { view, q }] as const,
};

export interface HistoryRefreshTargets {
  batchIds: readonly string[];
  storyIds: readonly string[];
}

export function historyRefreshTargets(batches: readonly Batch[], pendingStoryId?: string): HistoryRefreshTargets {
  const batchIds = new Set<string>();
  const storyIds = new Set<string>();
  if (pendingStoryId) storyIds.add(pendingStoryId);
  for (const batch of batches) {
    if (batch.status !== 'done' || batch.tiles.some((tile) => tile.status === 'loading') || batch.sequence?.masterStatus === 'stitching' || batch.story?.status === 'rendering') batchIds.add(batch.id);
    if (batch.story?.status === 'rendering') storyIds.add(batch.story.id);
  }
  return { batchIds: [...batchIds], storyIds: [...storyIds] };
}

export async function refreshHistory(
  targets: HistoryRefreshTargets,
  view: AppView,
  q: string,
  signal: AbortSignal,
): Promise<HistoryRefreshResponse> {
  const params = new URLSearchParams();
  applyHistoryScopeParams(params, view);
  const collectionId = params.get('collectionId');
  const scope = {
    ...(collectionId === null ? {} : { collectionId }),
    ...(params.has('pinned') ? { pinned: true as const } : {}),
    ...(q.trim() ? { q: q.trim() } : {}),
  };
  const count = Math.ceil(Math.max(targets.batchIds.length, targets.storyIds.length) / HISTORY_REFRESH_MAX_IDS);
  const parts = await mapWithConcurrency(Array.from({ length: count }, (_, index) => index), 3, async (index) => {
    signal.throwIfAborted();
    const start = index * HISTORY_REFRESH_MAX_IDS;
    const body: HistoryRefreshRequest = {
      ...scope,
      batchIds: [...targets.batchIds.slice(start, start + HISTORY_REFRESH_MAX_IDS)],
      storyIds: [...targets.storyIds.slice(start, start + HISTORY_REFRESH_MAX_IDS)],
    };
    const response = await requestJsonValidated('/history/refresh', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    }, (value): value is HistoryRefreshResponse => HistoryRefreshResponseSchema.safeParse(value).success);
    signal.throwIfAborted();
    return response;
  });
  const items = new Map(parts.flatMap((part) => part.items).map((batch) => [batch.id, normalizeBatch(batch)]));
  return { items: [...items.values()], missingBatchIds: [...new Set(parts.flatMap((part) => part.missingBatchIds))].filter((id) => !items.has(id)) };
}

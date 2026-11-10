import type { Batch } from '@atelier/shared';

/** What the feed held when the reader left its newest end. */
export interface LeftEndSnapshot {
  readonly newestCreatedAt: number;
  /** Batches that still had a loading tile. */
  readonly loading: ReadonlySet<string>;
}

const isLoading = (batch: Pick<Batch, 'tiles'>) => batch.tiles.some((tile) => tile.status === 'loading');

/** Records the feed (oldest first) as the reader leaves the end. */
export function snapshotFeedEnd(batches: readonly Pick<Batch, 'id' | 'createdAt' | 'tiles'>[]): LeftEndSnapshot {
  const loading = new Set<string>();
  for (const batch of batches) if (isLoading(batch)) loading.add(batch.id);
  return { newestCreatedAt: batches[batches.length - 1]?.createdAt ?? Number.NEGATIVE_INFINITY, loading };
}

/**
 * Whether a batch arrived or finished since the snapshot: a newer batch at
 * the end, or a batch that was loading then and no longer is. Older pages
 * and removals do not count.
 */
export function feedChangedBelow(snapshot: LeftEndSnapshot, batches: readonly Pick<Batch, 'id' | 'createdAt' | 'tiles'>[]): boolean {
  const newest = batches[batches.length - 1];
  if (newest && newest.createdAt > snapshot.newestCreatedAt) return true;
  if (snapshot.loading.size === 0) return false;
  for (const batch of batches) {
    if (snapshot.loading.has(batch.id) && !isLoading(batch)) return true;
  }
  return false;
}

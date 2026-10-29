import type { Batch } from '@atelier/shared';

export interface ActiveModelCounts {
  runningTiles: number;
  queuedBatches: number;
}

// Structural page shape — both the SSE-path (api/history.ts) and mutation-path
// (hooks/historyCache.ts) HistoryPageWithLoading types satisfy this.
interface ActiveByModelPage {
  items: readonly Batch[];
  activeByModel?: Record<string, ActiveModelCounts>;
}

export function activeByModelFromBatches(batches: readonly Batch[]): Record<string, ActiveModelCounts> {
  const counts: Record<string, ActiveModelCounts> = {};
  for (const batch of batches) {
    if (batch.status !== 'running' && batch.status !== 'queued') continue;
    const current = counts[batch.modelId] ?? { runningTiles: 0, queuedBatches: 0 };
    if (batch.status === 'queued') {
      current.queuedBatches += 1;
    } else {
      for (const tile of batch.tiles) {
        if (tile.status === 'loading') current.runningTiles += 1;
      }
    }
    counts[batch.modelId] = current;
  }
  return counts;
}

export function activeByModelFromPages(pages: readonly ActiveByModelPage[]): Record<string, ActiveModelCounts> {
  const totals: Record<string, ActiveModelCounts> = {};
  for (const page of pages) {
    const pageCounts = page.activeByModel ?? activeByModelFromBatches(page.items);
    for (const [modelId, counts] of Object.entries(pageCounts)) {
      const current = totals[modelId] ?? { runningTiles: 0, queuedBatches: 0 };
      current.runningTiles += counts.runningTiles;
      current.queuedBatches += counts.queuedBatches;
      totals[modelId] = current;
    }
  }
  return totals;
}

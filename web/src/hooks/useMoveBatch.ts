import type { ActiveScope } from './scopedHistoryMutation';
import { useScopedBatchPatch } from './scopedHistoryMutation';

interface MoveBatchInput {
  batchId: string;
  collectionId: string | null;
}

export function useMoveBatch(scope: Partial<ActiveScope> = {}) {
  return useScopedBatchPatch<MoveBatchInput>(scope, {
    toPatch: (input) => ({ collectionId: input.collectionId }),
    toOptimistic: (input) => ({ collectionId: input.collectionId }),
  });
}

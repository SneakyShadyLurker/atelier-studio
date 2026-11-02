import type { ActiveScope } from './scopedHistoryMutation';
import { useScopedBatchPatch } from './scopedHistoryMutation';

interface TogglePinInput {
  batchId: string;
  pinned: boolean;
}

export function useTogglePin(scope: Partial<ActiveScope> = {}) {
  return useScopedBatchPatch<TogglePinInput>(scope, {
    toPatch: (input) => ({ pinned: input.pinned }),
    toOptimistic: (input) => ({ pinned: input.pinned }),
  });
}

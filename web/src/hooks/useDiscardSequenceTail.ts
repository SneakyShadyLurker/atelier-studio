import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../api/client';
import { historyKeys } from '../api/history';
import { discardSequenceTail } from '../api/sequences';
import { describeError } from '../lib/errorCopy';
import { useAtelierStore } from '../store/atelier';
import { HISTORY_WRITE_MUTATION_KEY } from './historyWrites';

export function useDiscardSequenceTail() {
  const queryClient = useQueryClient();
  const addToast = useAtelierStore((state) => state.addToast);
  return useMutation({
    mutationKey: HISTORY_WRITE_MUTATION_KEY,
    mutationFn: discardSequenceTail,
    onSuccess: () => {
      addToast('Tail discarded', 'soft');
      void queryClient.invalidateQueries({ queryKey: historyKeys.all() });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409 && error.message === 'sequence-in-flight') {
        addToast('Wait for the render to finish before discarding the tail.', 'soft');
        return;
      }
      addToast(describeError(error, 'Could not discard the tail.'), 'error');
    },
  });
}

import { useMutation, type MutationKey, type UseMutationResult } from '@tanstack/react-query';
import { describeError } from '../lib/errorCopy';
import { useAtelierStore } from '../store/atelier';

interface ToastMutationOptions<TData, TVars> {
  mutationKey?: MutationKey;
  mutationFn: (vars: TVars) => Promise<TData>;
  /** Fallback copy for the error toast when the thrown error has no friendly message. */
  errorFallback: string;
  /** Optional success toast; omit for mutations that only invalidate silently. */
  successToast?: string | ((data: TData, vars: TVars) => string);
  /** Bespoke success side effects (cache eviction, navigation, store resets); runs before the toast. */
  onSuccess?: (data: TData, vars: TVars) => unknown;
  onSettled?: () => unknown;
}

// Opt-in factory for the common "mutate → success toast / describeError error
// toast" boilerplate shared by the simple archive/collection/history
// mutations. Deliberately NOT a global MutationCache onError: a global default
// fires for EVERY mutation (generate, prompt-library, optimistic delete/
// restore/reorder, ...) — many of which have bespoke error handling — so it
// would double up toasts and require a meta opt-out on every hook. As a local
// factory it is opt-in and cannot regress untouched hooks. Hooks with
// optimistic onMutate/rollback or custom onError keep using useMutation
// directly.
export function useToastMutation<TData, TVars = void>(
  options: ToastMutationOptions<TData, TVars>,
): UseMutationResult<TData, Error, TVars> {
  const addToast = useAtelierStore((state) => state.addToast);
  return useMutation<TData, Error, TVars>({
    ...(options.mutationKey ? { mutationKey: options.mutationKey } : {}),
    mutationFn: options.mutationFn,
    onSuccess: async (data, vars) => {
      await options.onSuccess?.(data, vars);
      if (options.successToast !== undefined) {
        addToast(typeof options.successToast === 'function' ? options.successToast(data, vars) : options.successToast);
      }
    },
    onError: (error) => { addToast(describeError(error, options.errorFallback), 'error'); },
    ...(options.onSettled ? { onSettled: options.onSettled } : {}),
  });
}

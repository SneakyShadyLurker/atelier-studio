import { useMutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AiFillBackend,
  TextBackendSettingsResponse,
  TextBackendWorkload,
  TextReasoningEffort,
} from '@atelier/shared';
import { textBackendReasoningEfforts } from '@atelier/shared';
import { putTextBackend, textBackendKeys, textBackendsOpts } from '../api/textBackends';

export function useTextBackends() {
  return useQuery(textBackendsOpts());
}

interface SetTextBackendVars {
  readonly workload: TextBackendWorkload;
  /** null clears the override (back to automatic routing). */
  readonly backend: AiFillBackend | null;
  /** Omitted keeps an effort the backend still accepts; null resets it to the default. */
  readonly effort?: TextReasoningEffort | null;
}

interface SetTextBackendContext {
  readonly prev: TextBackendSettingsResponse | undefined;
}

const setTextBackendMutationKey = ['text-backends', 'set'] as const;

/**
 * Workloads with a save in flight. Each save writes the backend, so a row
 * stays locked until its save settles; otherwise a slower earlier write could
 * land last and restore a pin the user had already changed.
 */
export function usePendingTextBackendWorkloads(): ReadonlySet<TextBackendWorkload> {
  const workloads = useMutationState<TextBackendWorkload | undefined>({
    filters: { mutationKey: setTextBackendMutationKey, status: 'pending' },
    select: (mutation) => (mutation.state.variables as SetTextBackendVars | undefined)?.workload,
  });
  return new Set(workloads.filter((workload) => workload !== undefined));
}

export function useSetTextBackend() {
  const queryClient = useQueryClient();
  return useMutation<TextBackendSettingsResponse, Error, SetTextBackendVars, SetTextBackendContext>({
    mutationKey: setTextBackendMutationKey,
    mutationFn: ({ workload, backend, effort }) => putTextBackend(workload, backend, effort),
    onMutate: async ({ workload, backend, effort }) => {
      await queryClient.cancelQueries({ queryKey: textBackendKeys.all() });
      const prev = queryClient.getQueryData<TextBackendSettingsResponse>(textBackendKeys.all());
      if (prev) {
        // exactOptionalPropertyTypes: a cleared override must drop the key
        // entirely rather than be set to undefined.
        const { [workload]: _cleared, ...rest } = prev.overrides;
        const { [workload]: prevEffort, ...restEfforts } = prev.efforts;
        // Mirrors the server: an effort belongs to the pin and survives a
        // backend change only while the new backend still accepts it.
        const nextEffort = backend === null
          ? null
          : effort !== undefined
            ? effort
            : prevEffort !== undefined && textBackendReasoningEfforts(backend).includes(prevEffort)
              ? prevEffort
              : null;
        queryClient.setQueryData<TextBackendSettingsResponse>(textBackendKeys.all(), {
          ...prev,
          overrides: backend === null ? rest : { ...rest, [workload]: backend },
          efforts: nextEffort === null ? restEfforts : { ...restEfforts, [workload]: nextEffort },
        });
      }
      return { prev };
    },
    onSuccess: (response) => {
      queryClient.setQueryData(textBackendKeys.all(), response);
    },
    onError: (_error, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(textBackendKeys.all(), ctx.prev);
    },
    onSettled: () => {
      return queryClient.invalidateQueries({ queryKey: textBackendKeys.all() });
    },
  });
}

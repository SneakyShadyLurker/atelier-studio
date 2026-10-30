import { useMutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TaskRow, TextModelsResponse, TextTask } from '@atelier/shared';
import { putTaskPick, textModelKeys, textModelsOpts, type TaskPickBody } from '../api/textModels';

export function useTextModels() {
  return useQuery(textModelsOpts());
}

/** Selector for `useQuery({ ...textModelsOpts(), select: textModelLabel(id) })`. */
export function textModelLabel(id: string) {
  return (data: TextModelsResponse): string | undefined =>
    data.models.find((model) => model.id === id)?.displayName;
}

interface SetTaskPickVars extends TaskPickBody {
  readonly task: TextTask;
}

interface SetTaskPickContext {
  readonly prev: TextModelsResponse | undefined;
}

const setTaskPickMutationKey = ['text-models', 'set'] as const;

/**
 * Tasks with a save in flight. Each save writes the pick, so a row stays
 * locked until its save settles; otherwise a slower earlier write could land
 * last and restore a pick the user had already changed.
 */
export function usePendingTaskPicks(): ReadonlySet<TextTask> {
  const tasks = useMutationState<TextTask | undefined>({
    filters: { mutationKey: setTaskPickMutationKey, status: 'pending' },
    select: (mutation) => (mutation.state.variables as SetTaskPickVars | undefined)?.task,
  });
  return new Set(tasks.filter((task) => task !== undefined));
}

// Mirrors the server closely enough for the optimistic frame; the PUT
// response replaces it. An effort belongs to the pick and survives a model
// change only while the new model still accepts it.
function optimisticRow(prev: TextModelsResponse, row: TaskRow, { modelId, effort }: TaskPickBody): TaskRow {
  if (modelId === null) {
    const fallback = prev.defaults.byTask[row.task] ?? prev.defaults.default;
    return fallback === undefined ? { task: row.task } : { task: row.task, effectiveModelId: fallback };
  }
  const levels = prev.models.find((model) => model.id === modelId)?.reasoningLevels ?? [];
  const nextEffort = effort !== undefined
    ? effort
    : row.effort !== undefined && levels.includes(row.effort) ? row.effort : null;
  return nextEffort === null
    ? { task: row.task, pick: modelId, effectiveModelId: modelId, pickState: 'active' }
    : { task: row.task, pick: modelId, effort: nextEffort, effectiveModelId: modelId, pickState: 'active' };
}

export function useSetTaskPick() {
  const queryClient = useQueryClient();
  return useMutation<TextModelsResponse, Error, SetTaskPickVars, SetTaskPickContext>({
    mutationKey: setTaskPickMutationKey,
    mutationFn: ({ task, modelId, effort }) => putTaskPick(task, effort === undefined ? { modelId } : { modelId, effort }),
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: textModelKeys.all() });
      const prev = queryClient.getQueryData<TextModelsResponse>(textModelKeys.all());
      if (prev) {
        queryClient.setQueryData<TextModelsResponse>(textModelKeys.all(), {
          ...prev,
          tasks: prev.tasks.map((row) => (row.task === vars.task ? optimisticRow(prev, row, vars) : row)),
        });
      }
      return { prev };
    },
    onSuccess: (response) => {
      queryClient.setQueryData(textModelKeys.all(), response);
    },
    onError: (_error, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(textModelKeys.all(), ctx.prev);
    },
    onSettled: () => {
      return queryClient.invalidateQueries({ queryKey: textModelKeys.all() });
    },
  });
}

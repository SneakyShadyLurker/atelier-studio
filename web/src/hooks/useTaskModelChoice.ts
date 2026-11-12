import { useState } from 'react';
import type { TaskRow, TextModelsResponse, TextReasoningEffort, TextTask } from '@atelier/shared';
import {
  DEFAULT_PICK,
  defaultModelId,
  groupModelsByProvider,
  rowPick,
  type EffortValue,
  type ProviderGroup,
} from '../lib/textModelPick';
import { useSetTaskPick, useTextModels } from './useTextModels';

interface Choice {
  readonly modelId: string;
  readonly effort: EffortValue;
}

export type TaskModelChoiceState =
  | { readonly kind: 'ready' }
  /** A locked prompt writer wins over any pick, so there is nothing to choose. */
  | { readonly kind: 'locked'; readonly writerName: string }
  /** The listing is loading or failed: the server's routing applies. */
  | { readonly kind: 'unavailable' };

export interface TaskModelChoice {
  readonly state: TaskModelChoiceState;
  /** DEFAULT_PICK ('') or a model id. */
  readonly modelId: string;
  readonly effort: EffortValue;
  readonly groups: readonly ProviderGroup[];
  /** Name of the model "Use default" resolves to, when known. */
  readonly defaultName: string | undefined;
  /** Levels the selected model offers; null while "Use default" is selected. */
  readonly effortLevels: readonly TextReasoningEffort[] | null;
  readonly setModelId: (modelId: string) => void;
  readonly setEffort: (effort: EffortValue) => void;
  /** Saves the choice when it differs from the saved pick; never when locked or unavailable. */
  readonly commit: () => Promise<void>;
  /** Drops the local edits, back to the saved pick. Call when the dialog opens. */
  readonly reset: () => void;
}

const UNAVAILABLE: TaskModelChoiceState = { kind: 'unavailable' };
const READY: TaskModelChoiceState = { kind: 'ready' };

/**
 * A dialog's local choice of the text model and reasoning level for one task,
 * seeded from the user's saved pick. The owner calls `reset()` as the dialog
 * opens, so edits abandoned with a cancelled dialog never come back.
 */
export function useTaskModelChoice(task: TextTask, imageModelId: string | undefined): TaskModelChoice {
  const settings = useTextModels();
  const setPick = useSetTaskPick();
  const [edits, setEdits] = useState<Choice | null>(null);
  const reset = () => { setEdits(null); };

  // Read defensively, like useTextModelGate: a stub body without these arrays
  // must leave the dialog usable on the server's routing.
  const data: TextModelsResponse | undefined = settings.data;
  const listed: unknown = data?.models;
  const rows: unknown = data?.tasks;
  if (data === undefined || !Array.isArray(listed) || !Array.isArray(rows)) {
    return {
      state: UNAVAILABLE,
      modelId: DEFAULT_PICK,
      effort: 'default',
      groups: [],
      defaultName: undefined,
      effortLevels: null,
      setModelId: () => undefined,
      setEffort: () => undefined,
      commit: () => Promise.resolve(),
      reset,
    };
  }

  const byId = new Map(data.models.map((model) => [model.id, model]));
  const row: TaskRow = data.tasks.find((candidate) => candidate.task === task) ?? { task };
  const locked: unknown = data.lockedWriters;
  const writerId = imageModelId === undefined ? undefined : data.writers[imageModelId];
  const state: TaskModelChoiceState = imageModelId !== undefined && writerId !== undefined
    && Array.isArray(locked) && locked.includes(imageModelId)
    ? { kind: 'locked', writerName: byId.get(writerId)?.displayName ?? 'the shared prompt writer' }
    : READY;

  const defaultId = defaultModelId(data, row, byId, imageModelId);
  // An offline pick stays the selected (unselectable) option rather than
  // showing as the default: "Use default" is then a real change that clears it.
  const { picked, effort: savedEffort } = rowPick(row, byId);
  const saved: Choice = picked !== undefined
    ? { modelId: picked.id, effort: savedEffort }
    : { modelId: DEFAULT_PICK, effort: 'default' };
  const choice = edits ?? saved;
  const chosen = choice.modelId === DEFAULT_PICK ? undefined : byId.get(choice.modelId);
  // An effort belongs to a model the task can use right now.
  const selected = chosen?.status === 'offline' ? undefined : chosen;

  return {
    state,
    modelId: choice.modelId,
    effort: choice.effort,
    groups: groupModelsByProvider(data.models),
    defaultName: defaultId === undefined ? undefined : byId.get(defaultId)?.displayName,
    effortLevels: selected === undefined ? null : selected.reasoningLevels,
    setModelId: (modelId) => {
      if (modelId === DEFAULT_PICK) {
        setEdits({ modelId, effort: 'default' });
        return;
      }
      const next = byId.get(modelId);
      // Offline models are listed but not selectable: the server refuses them.
      if (next === undefined || next.status === 'offline') return;
      // An effort survives the switch only while the new model offers it.
      const effort = choice.effort !== 'default' && next.reasoningLevels.includes(choice.effort) ? choice.effort : 'default';
      setEdits({ modelId, effort });
    },
    setEffort: (effort) => {
      if (selected === undefined) return;
      if (effort !== 'default' && !selected.reasoningLevels.includes(effort)) return;
      setEdits({ modelId: choice.modelId, effort });
    },
    commit: async () => {
      // An untouched dialog saves nothing: it must not clear a pick that is only offline.
      if (state.kind !== 'ready' || edits === null) return;
      // Compared with the stored row, not with what the dialog showed: a pick
      // the listing no longer names shows as the default, and choosing
      // "Use default" after trying another model still has to clear it.
      const storedModelId = row.pick ?? DEFAULT_PICK;
      const storedEffort: EffortValue = row.effort ?? 'default';
      if (choice.modelId === storedModelId && choice.effort === storedEffort) return;
      await setPick.mutateAsync({
        task,
        modelId: choice.modelId === DEFAULT_PICK ? null : choice.modelId,
        effort: choice.effort === 'default' ? null : choice.effort,
      });
    },
    reset,
  };
}

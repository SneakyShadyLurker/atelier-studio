import type { PublicTextModel, TaskRow, TextModelsResponse, TextReasoningEffort } from '@atelier/shared';
import { TEXT_REASONING_EFFORT_LABELS } from '@atelier/shared';

// The selection rules of a per-task text-model pick, shared by Settings →
// "Your text models" and the template draft dialog.

// Model ids are never empty, so '' stands for "Use default".
export const DEFAULT_PICK = '';
export type EffortValue = 'default' | TextReasoningEffort;

export interface PickOption<TValue extends string> {
  readonly value: TValue;
  readonly label: string;
  readonly group?: string;
  readonly hint?: string;
  readonly disabled?: boolean;
}

export interface ProviderGroup {
  readonly providerName: string;
  readonly models: readonly PublicTextModel[];
}

/** Models grouped by provider in first-appearance order. */
export function groupModelsByProvider(models: readonly PublicTextModel[]): readonly ProviderGroup[] {
  const byProvider = new Map<string, PublicTextModel[]>();
  for (const model of models) {
    const group = byProvider.get(model.providerName);
    if (group) group.push(model);
    else byProvider.set(model.providerName, [model]);
  }
  return [...byProvider].map(([providerName, group]) => ({ providerName, models: group }));
}

export function defaultPickLabel(defaultName: string | undefined): string {
  return defaultName === undefined ? 'Use default' : `Use default (${defaultName})`;
}

// Offline models stay listed but dimmed, since the server refuses to save them.
export function modelOptions(models: readonly PublicTextModel[], defaultName: string | undefined): readonly PickOption<string>[] {
  return [
    { value: DEFAULT_PICK, label: defaultPickLabel(defaultName) },
    ...groupModelsByProvider(models).flatMap(({ providerName, models: group }) => group.map((model) => (model.status === 'offline'
      ? { value: model.id, label: model.displayName, group: providerName, hint: 'offline', disabled: true }
      : { value: model.id, label: model.displayName, group: providerName }))),
  ];
}

export function effortOptions(levels: readonly TextReasoningEffort[]): readonly PickOption<EffortValue>[] {
  return [
    { value: 'default', label: 'Default' },
    ...levels.map((value) => ({ value, label: TEXT_REASONING_EFFORT_LABELS[value] })),
  ];
}

function usable(byId: ReadonlyMap<string, PublicTextModel>, id: string | undefined): id is string {
  const model = id === undefined ? undefined : byId.get(id);
  return model !== undefined && model.status !== 'offline';
}

/**
 * The model "Use default" resolves to. With an image model whose listed writer
 * is online, that writer (the resolver's next step after the user's pick).
 * Without a usable pick the server's effective model already is the default
 * (after its own fallbacks); otherwise the first listed fallback that is not
 * offline, as the resolver skips those.
 */
export function defaultModelId(
  data: TextModelsResponse,
  row: TaskRow,
  byId: ReadonlyMap<string, PublicTextModel>,
  imageModelId?: string,
): string | undefined {
  const writer = imageModelId === undefined ? undefined : data.writers[imageModelId];
  if (usable(byId, writer)) return writer;
  const configured = [data.defaults.byTask[row.task], data.defaults.default].find((id) => usable(byId, id));
  return row.pick === undefined || row.pickState === 'offline' ? row.effectiveModelId ?? configured : configured;
}

export interface RowPick {
  /** The user's pick, when the listing names it. */
  readonly picked: PublicTextModel | undefined;
  /** The pick is offline and the task falls back to the default. */
  readonly offlinePick: boolean;
  /** The pick the task actually uses; an effort belongs only to this one. */
  readonly activePick: PublicTextModel | undefined;
  /** Only an effort the active pick still offers is in use. */
  readonly effort: EffortValue;
}

export function rowPick(row: TaskRow, byId: ReadonlyMap<string, PublicTextModel>): RowPick {
  // A pick the response does not list shows as the default instead of breaking the caller.
  const picked = row.pick === undefined ? undefined : byId.get(row.pick);
  const offlinePick = picked !== undefined && row.pickState === 'offline';
  const activePick = picked !== undefined && !offlinePick ? picked : undefined;
  const effort: EffortValue = activePick !== undefined && row.effort !== undefined && activePick.reasoningLevels.includes(row.effort)
    ? row.effort
    : 'default';
  return { picked, offlinePick, activePick, effort };
}

import type { PublicTextModel, TaskRow, TextModelsResponse, TextReasoningEffort } from '@atelier/shared';
import { TEXT_REASONING_EFFORT_LABELS } from '@atelier/shared';

// The selection rules and vocabulary of text-model picks, shared by Text
// models (Your picks and Shared setup) and the template draft dialog.

// Model ids are never empty, so '' stands for "follow the shared setup" on a
// personal pick (and for "no model" on a shared assignment).
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

/** Menu option of an unset personal pick: it follows the shared setup. */
export function sharedSetupLabel(inheritedName: string | undefined): string {
  return inheritedName === undefined ? 'Shared setup' : `Shared setup (${inheritedName})`;
}

/** Menu option of an unset shared feature assignment: it follows the default model. */
export function defaultModelLabel(defaultName: string | undefined): string {
  return defaultName === undefined ? 'Default model' : `Default model (${defaultName})`;
}

export const NO_DEFAULT_LABEL = 'No default';
export const NO_WRITER_LABEL = 'No writer';
export const EFFORT_FIXED_LABEL = 'Effort fixed by the model';

/**
 * What a model chip shows. An inherited value is quiet and, when it names a
 * model, leads with a decorative ↳; `text` is the visible words only.
 */
export interface ChipValue {
  readonly text: string;
  readonly quiet: boolean;
  readonly inherited: boolean;
}

/** Chip of an unset personal pick: the inherited model, or "Shared setup" when nothing resolves. */
export function personalUnsetChip(inheritedName: string | undefined): ChipValue {
  return inheritedName === undefined
    ? { text: 'Shared setup', quiet: true, inherited: false }
    : { text: inheritedName, quiet: true, inherited: true };
}

/** Chip of an unset shared feature: the default model, or "No model" when no default is set. */
export function sharedUnsetChip(defaultName: string | undefined): ChipValue {
  return defaultName === undefined
    ? { text: 'No model', quiet: true, inherited: false }
    : { text: defaultName, quiet: true, inherited: true };
}

/** Chip text of an effort: "Default effort" or "<Level> effort". */
export function effortChipLabel(effort: EffortValue): string {
  return effort === 'default' ? 'Default effort' : `${TEXT_REASONING_EFFORT_LABELS[effort]} effort`;
}

/** A stored effort counts only while the model still offers it; otherwise it shows as Default effort. */
export function offeredEffort(levels: readonly TextReasoningEffort[], stored: TextReasoningEffort | undefined): EffortValue {
  return stored !== undefined && levels.includes(stored) ? stored : 'default';
}

// Offline models stay listed but dimmed, since the server refuses to save them.
export function modelOptions(models: readonly PublicTextModel[], inheritedName: string | undefined): readonly PickOption<string>[] {
  return [
    { value: DEFAULT_PICK, label: sharedSetupLabel(inheritedName) },
    ...groupModelsByProvider(models).flatMap(({ providerName, models: group }) => group.map((model) => (model.status === 'offline'
      ? { value: model.id, label: model.displayName, group: providerName, hint: 'offline', disabled: true }
      : { value: model.id, label: model.displayName, group: providerName }))),
  ];
}

export function effortOptions(levels: readonly TextReasoningEffort[]): readonly PickOption<EffortValue>[] {
  return [
    { value: 'default', label: 'Default effort' },
    ...levels.map((value) => ({ value, label: TEXT_REASONING_EFFORT_LABELS[value] })),
  ];
}

function usable(byId: ReadonlyMap<string, PublicTextModel>, id: string | undefined): id is string {
  const model = id === undefined ? undefined : byId.get(id);
  return model !== undefined && model.status !== 'offline';
}

/**
 * The model an unset personal pick inherits ("Shared setup"). With an image model whose listed writer
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
  const effort: EffortValue = activePick === undefined ? 'default' : offeredEffort(activePick.reasoningLevels, row.effort);
  return { picked, offlinePick, activePick, effort };
}

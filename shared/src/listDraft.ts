import type { ListChangeWire, ListOptionWire, UnplacedListChangeWire, UnplacedListReasonWire } from './promptToolSchemas';

/*
 * The variable-list draft's change set: how the model's answer becomes
 * options and placed changes against the rows the request carried (the base),
 * and how an accepted subset of those changes is applied. Shared by the api,
 * which cleans and places the answer, and the web app, which reviews and
 * applies it. Pure and deterministic.
 */

export type ListOptionDraft = ListOptionWire;
export type ListChange = ListChangeWire;
export type UnplacedListChange = UnplacedListChangeWire;
export type UnplacedListReason = UnplacedListReasonWire;
type AddChange = Extract<ListChange, { op: 'add' }>;
type RowChange = Exclude<ListChange, AddChange>;
/** A placed edit or remove before its id is known. */
type PlacedRowChange =
  | { op: 'edit'; index: number; value: string; weight: number; why: string }
  | { op: 'remove'; index: number; why: string };

/** The most options one draft adds or writes. */
export const LIST_DRAFT_MAX_ADDS = 100;
/** The most operations of a rework answer that are read. */
export const LIST_REWORK_MAX_OPERATIONS = 500;
/** The longest option value, in UTF-16 units. */
export const LIST_OPTION_VALUE_MAX_CHARS = 2_000;

const DEFAULT_WEIGHT = 1;
const MAX_WEIGHT = 100;

/** Lookup equality: trimmed and case-insensitive. */
export function lookupKey(value: string): string {
  return value.trim().toLowerCase();
}

/** A proposed weight as an integer 0..100, or `fallback` when it is not a finite number. */
function cleanWeight(weight: unknown, fallback: number): number {
  if (typeof weight !== 'number' || !Number.isFinite(weight)) return fallback;
  return Math.round(Math.min(MAX_WEIGHT, Math.max(0, weight)));
}

/** A proposed value trimmed, or null when it is not a string or is blank. */
function trimmedValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

const fitsValueLimit = (value: string): boolean => value.length <= LIST_OPTION_VALUE_MAX_CHARS;

/** Whether `changes` is a valid change set against a base of `baseCount` rows (spec R1.5). */
export function isListChangeSet(baseCount: number, changes: readonly ListChange[]): boolean {
  let lastIndex = -1;
  let inAdds = false;
  for (const [position, change] of changes.entries()) {
    if (change.id !== position) return false;
    if (change.op === 'add') {
      inAdds = true;
      continue;
    }
    if (inAdds) return false;
    const { index } = change;
    if (!Number.isInteger(index) || index < 0 || index >= baseCount || index <= lastIndex) return false;
    lastIndex = index;
  }
  return true;
}

/**
 * The rows an accepted subset of `changes` leaves (spec R1.6): the base rows
 * in order, an accepted remove dropping its row and an accepted edit copying
 * it with the new value and weight, then one `makeAdded` row per accepted add
 * in change order. Every other row is the identical input object.
 */
export function applyListChanges<Row extends { value: string; weight: number }>(
  rows: readonly Row[],
  changes: readonly ListChange[],
  acceptedIds: readonly number[],
  makeAdded: (change: AddChange) => Row,
): Row[] {
  const accepted = new Set(acceptedIds);
  const byIndex = new Map<number, RowChange>();
  const adds: AddChange[] = [];
  for (const change of changes) {
    if (!accepted.has(change.id)) continue;
    if (change.op === 'add') adds.push(change);
    else byIndex.set(change.index, change);
  }
  const result: Row[] = [];
  for (const [index, row] of rows.entries()) {
    const change = byIndex.get(index);
    if (change === undefined) result.push(row);
    else if (change.op === 'edit') result.push({ ...row, value: change.value, weight: change.weight });
  }
  for (const add of adds) result.push(makeAdded(add));
  return result;
}

export interface ListCandidate { value: unknown; weight: unknown }

/** Positions in `candidates` that survive cleaning, with their cleaned option. */
function cleanCandidates(
  candidates: readonly ListCandidate[],
  taken: readonly string[],
  limit: number,
): { at: number; option: ListOptionDraft }[] {
  const seen = new Set(taken.map(lookupKey));
  const kept: { at: number; option: ListOptionDraft }[] = [];
  for (const [at, candidate] of candidates.entries()) {
    if (kept.length >= limit) break;
    const value = trimmedValue(candidate.value);
    if (value === null || !fitsValueLimit(value)) continue;
    const key = lookupKey(value);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push({ at, option: { value, weight: cleanWeight(candidate.weight, DEFAULT_WEIGHT) } });
  }
  return kept;
}

/**
 * Proposed new options cleaned (spec R2.4): values trimmed, blank and
 * over-long ones skipped, weights integers 0..100 (1 when not a number), the
 * first of lookup-equal values kept and any lookup-equal to `taken` dropped,
 * then cut to `limit`.
 */
export function cleanListCandidates(
  candidates: readonly ListCandidate[],
  taken: readonly string[],
  limit: number,
): ListOptionDraft[] {
  return cleanCandidates(candidates, taken, limit).map(({ option }) => option);
}

interface RawOperation {
  why: string;
  op: 'edit' | 'remove' | 'add';
  n: unknown;
  find: unknown;
  value: unknown;
  weight: unknown;
}

function readOperation(member: unknown): RawOperation | null {
  if (typeof member !== 'object' || member === null || Array.isArray(member)) return null;
  const { why, op, n, find, value, weight } = member as Record<string, unknown>;
  if (op !== 'edit' && op !== 'remove' && op !== 'add') return null;
  return { why: typeof why === 'string' ? why.trim() : '', op, n, find, value, weight };
}

type Target = { index: number } | { reason: 'missing' | 'ambiguous' };

/** Spec R2.7: row `n` when it is in range and `find` is blank or names it; else the one row `find` names. */
function resolveTarget(base: readonly ListOptionDraft[], n: unknown, find: unknown): Target {
  const findKey = typeof find === 'string' ? lookupKey(find) : '';
  if (typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= base.length) {
    const row = base[n - 1];
    if (row !== undefined && (findKey === '' || lookupKey(row.value) === findKey)) return { index: n - 1 };
  }
  if (findKey === '') return { reason: 'missing' };
  const matches: number[] = [];
  for (const [index, row] of base.entries()) {
    if (lookupKey(row.value) === findKey) matches.push(index);
    if (matches.length > 1) return { reason: 'ambiguous' };
  }
  const [only] = matches;
  return only === undefined ? { reason: 'missing' } : { index: only };
}

/**
 * Places a rework answer's operations against `base` (spec R2.7). Reads at
 * most LIST_REWORK_MAX_OPERATIONS members of `rawOperations` before narrowing
 * any; a member that is not an object or has an unknown `op` is skipped. Edits
 * and removes come first, ascending by row; adds follow in the model's order,
 * cleaned after every edit and cut to `addLimit`. Unplaced operations are
 * listed in arrival order.
 */
export function placeListOperations(
  base: readonly ListOptionDraft[],
  rawOperations: readonly unknown[],
  addLimit: number,
): { changes: ListChange[]; unplaced: UnplacedListChange[] } {
  const rowChanges = new Map<number, PlacedRowChange>();
  const editedKeys = new Set<string>();
  const editedValues: string[] = [];
  const unplaced: UnplacedListChange[] = [];
  const addOperations: RawOperation[] = [];

  for (const member of rawOperations.slice(0, LIST_REWORK_MAX_OPERATIONS)) {
    const operation = readOperation(member);
    if (operation === null) continue;
    if (operation.op === 'add') {
      addOperations.push(operation);
      continue;
    }
    const { op, why } = operation;
    const proposedValue = op === 'edit' ? trimmedValue(operation.value) : null;
    const proposedWeight = op === 'edit' ? cleanWeight(operation.weight, Number.NaN) : Number.NaN;
    const unplace = (reason: UnplacedListReason): void => {
      unplaced.push({
        op,
        find: typeof operation.find === 'string' ? operation.find : '',
        value: proposedValue,
        weight: Number.isNaN(proposedWeight) ? null : proposedWeight,
        why,
        reason,
      });
    };

    const target = resolveTarget(base, operation.n, operation.find);
    if ('reason' in target) {
      unplace(target.reason);
      continue;
    }
    const { index } = target;
    const row = base[index];
    if (row === undefined) continue;
    if (rowChanges.has(index)) {
      unplace('overlap');
      continue;
    }
    if (op === 'remove') {
      rowChanges.set(index, { op: 'remove', index, why });
      continue;
    }

    const value = proposedValue ?? row.value;
    const weight = Number.isNaN(proposedWeight) ? row.weight : proposedWeight;
    if (value === row.value && weight === row.weight) continue;
    if (!fitsValueLimit(value)) continue;
    const key = lookupKey(value);
    // A weight-only or case-only edit brings no new value into the list, so it
    // cannot add a duplicate, whatever the base already holds twice.
    if (key !== lookupKey(row.value)) {
      const clashesWithBase = base.some((other, at) => at !== index && lookupKey(other.value) === key);
      if (clashesWithBase || editedKeys.has(key)) {
        unplace('duplicate');
        continue;
      }
      editedKeys.add(key);
      editedValues.push(value);
    }
    rowChanges.set(index, { op: 'edit', index, value, weight, why });
  }

  const taken = [...base.map((row) => row.value), ...editedValues];
  const adds = cleanCandidates(addOperations, taken, Math.max(0, addLimit));

  const changes: ListChange[] = [];
  for (const index of [...rowChanges.keys()].sort((a, b) => a - b)) {
    const change = rowChanges.get(index);
    if (change === undefined) continue;
    changes.push({ id: changes.length, ...change });
  }
  for (const { at, option } of adds) {
    changes.push({ id: changes.length, op: 'add', value: option.value, weight: option.weight, why: addOperations[at]?.why ?? '' });
  }
  return { changes, unplaced };
}

/** `text` cut to at most `max` UTF-16 units without splitting a surrogate pair. */
function cutUtf16(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, Math.max(0, max));
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

/**
 * The name a created list gets (spec R2.5): trimmed, whitespace runs as `_`,
 * cut to `maxChars`; while it equals one of `existing` exactly, the stem is
 * cut so that stem plus `_2`, `_3`, … fits and the first unused one wins.
 * Null for a blank proposal.
 */
export function uniqueListName(proposed: string, existing: readonly string[], maxChars: number): string | null {
  const normalized = proposed.trim().replace(/\s+/gu, '_');
  if (normalized === '') return null;
  const taken = new Set(existing);
  const stem = cutUtf16(normalized, maxChars);
  if (stem !== '' && !taken.has(stem)) return stem;
  for (let k = 2; ; k += 1) {
    const suffix = `_${k}`;
    const candidate = `${cutUtf16(stem, maxChars - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

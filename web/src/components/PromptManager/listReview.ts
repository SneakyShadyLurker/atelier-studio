import type { DraftListChanges, ListChange, UnplacedListChange } from '@atelier/shared';
import { applyListChanges } from '@atelier/shared/list-draft';
import { diffWordRuns, type WordRun } from '@atelier/shared/template-rework';
import { DIFF_MAX_EDIT_LENGTH } from '../../lib/trackedTemplate';
import type { OptionDraft } from './draftStore';
import { acceptedIds } from './reviewDecisions';

/*
 * A variable-list draft under review (spec list-draft-review R5): the placed
 * changes against the editor's rows as they were sent (the base), and the
 * user's decisions. Every change starts accepted (D4). Pure.
 */

export type ListReviewMode = 'extend' | 'rework';

/** One non-blank editor row as the request carried it: its key, trimmed value and weight. */
export interface ListBaseRow {
  readonly key: string;
  readonly value: string;
  readonly weight: number;
}

export interface ListReview {
  /** Add options or Rework: the mode "Rework again" reopens on. */
  readonly mode: ListReviewMode;
  readonly base: readonly ListBaseRow[];
  readonly changes: readonly ListChange[];
  readonly unplaced: readonly UnplacedListChange[];
  readonly summary: string | null;
  /** The instructions the draft was asked with ('' when left blank); prefill for "Rework again". */
  readonly instructions: string;
  /** Ids of rejected changes, ascending, without duplicates. */
  readonly rejected: readonly number[];
}

type EditChange = Extract<ListChange, { op: 'edit' }>;
type RemoveChange = Extract<ListChange, { op: 'remove' }>;
type AddChange = Extract<ListChange, { op: 'add' }>;

const isBlank = (row: { value: string }): boolean => row.value.trim() === '';

/** The editor's non-blank rows in order, values trimmed: the base a draft is sent (spec Terms). */
export function baseOf(rows: readonly OptionDraft[]): ListBaseRow[] {
  return rows.filter((row) => !isBlank(row)).map((row) => ({ key: row.key, value: row.value.trim(), weight: row.weight }));
}

/** Whether the editor's non-blank rows still equal `base`, in order, by key, exact value and weight (spec Terms, Fresh). */
export function isFresh(base: readonly ListBaseRow[], rows: readonly OptionDraft[]): boolean {
  const now = baseOf(rows);
  return now.length === base.length && now.every((row, index) => {
    const sent = base[index];
    return row.key === sent?.key && row.value === sent.value && row.weight === sent.weight;
  });
}

export function reviewFromResponse(
  base: readonly ListBaseRow[],
  mode: ListReviewMode,
  instructions: string,
  payload: DraftListChanges,
): ListReview {
  return {
    mode,
    base,
    changes: payload.changes,
    unplaced: payload.unplaced,
    summary: payload.summary,
    instructions,
    rejected: [],
  };
}

/**
 * The editor's rows with the accepted changes applied (spec R5.7). The
 * non-blank rows are the base, in order: an edited row keeps its key, tags and
 * expanded state and shows its new weight; a removed one goes. Blank rows keep
 * their place; added rows, new and untagged, follow every existing row.
 */
export function applyReview(rows: readonly OptionDraft[], review: ListReview, newKey: () => string): OptionDraft[] {
  const base = rows.filter((row) => !isBlank(row));
  const accepted = acceptedIds(review);
  const acceptedSet = new Set(accepted);
  const edited = new Set<string>();
  for (const change of review.changes) {
    if (change.op !== 'edit' || !acceptedSet.has(change.id)) continue;
    const key = base[change.index]?.key;
    if (key !== undefined) edited.add(key);
  }
  const survivors = applyListChanges(base, review.changes, accepted, (add): OptionDraft => ({
    key: newKey(),
    value: add.value,
    tagIds: [],
    excludeTagIds: [],
    weight: add.weight,
    weightInput: String(add.weight),
    expanded: false,
  })).map((row) => (edited.has(row.key) ? { ...row, weightInput: String(row.weight) } : row));
  const baseKeys = new Set(base.map((row) => row.key));
  const byKey = new Map(survivors.map((row) => [row.key, row]));
  const next: OptionDraft[] = [];
  for (const row of rows) {
    if (isBlank(row)) {
      next.push(row);
      continue;
    }
    const survivor = byKey.get(row.key);
    if (survivor !== undefined) next.push(survivor);
  }
  for (const row of survivors) if (!baseKeys.has(row.key)) next.push(row);
  return next;
}

/** The review against rows whose saved keys a save just settled (spec R5.9). */
export function remapReviewKeys(review: ListReview, keys: ReadonlyMap<string, string>): ListReview {
  if (!review.base.some((row) => keys.has(row.key))) return review;
  return { ...review, base: review.base.map((row) => {
    const key = keys.get(row.key);
    return key === undefined ? row : { ...row, key };
  }) };
}

/** One line of the sheet. */
export type ListRow =
  | { readonly kind: 'same'; readonly index: number; readonly row: ListBaseRow }
  /** `runs` is null for a weight-only edit (the value is unchanged). */
  | { readonly kind: 'edit'; readonly index: number; readonly row: ListBaseRow; readonly change: EditChange; readonly runs: readonly WordRun[] | null }
  | { readonly kind: 'remove'; readonly index: number; readonly row: ListBaseRow; readonly change: RemoveChange }
  | { readonly kind: 'add'; readonly change: AddChange };

export type ListSegment =
  | ListRow
  /** A run of unchanged rows behind "Show N unchanged options"; `start` is its first base index. */
  | { readonly kind: 'fold'; readonly start: number; readonly rows: readonly Extract<ListRow, { kind: 'same' }>[] };

/** Unchanged runs longer than this many rows fold away (spec R5.2). */
export const LIST_FOLD_MIN_ROWS = 7;

/** An edited value's word runs, or the old value struck beside the new one when no diff is found. */
function editRuns(before: string, after: string): readonly WordRun[] | null {
  if (before === after) return null;
  return diffWordRuns(before, after, DIFF_MAX_EDIT_LENGTH)
    ?? [{ kind: 'del', text: before }, { kind: 'ins', text: after }];
}

/**
 * The sheet's lines (spec R5.2): the base rows in order, each unchanged or
 * carrying its edit or removal, then the added rows. Computed from the base
 * and the changes only, never from the decisions.
 */
export function segmentList(review: Pick<ListReview, 'base' | 'changes'>): ListSegment[] {
  const byIndex = new Map<number, EditChange | RemoveChange>();
  const adds: AddChange[] = [];
  for (const change of review.changes) {
    if (change.op === 'add') adds.push(change);
    else byIndex.set(change.index, change);
  }
  const segments: ListSegment[] = [];
  let run: Extract<ListRow, { kind: 'same' }>[] = [];
  const flush = () => {
    const first = run[0];
    if (first !== undefined && run.length >= LIST_FOLD_MIN_ROWS) segments.push({ kind: 'fold', start: first.index, rows: run });
    else segments.push(...run);
    run = [];
  };
  for (const [index, row] of review.base.entries()) {
    const change = byIndex.get(index);
    if (change === undefined) {
      run.push({ kind: 'same', index, row });
      continue;
    }
    flush();
    segments.push(change.op === 'edit'
      ? { kind: 'edit', index, row, change, runs: editRuns(row.value, change.value) }
      : { kind: 'remove', index, row, change });
  }
  flush();
  for (const change of adds) segments.push({ kind: 'add', change });
  return segments;
}

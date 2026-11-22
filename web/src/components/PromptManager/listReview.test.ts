import { describe, expect, test } from 'bun:test';
import type { DraftListChanges, ListChange } from '@atelier/shared';
import type { OptionDraft } from './draftStore';
import {
  applyReview,
  baseOf,
  isFresh,
  remapReviewKeys,
  reviewFromResponse,
  segmentList,
  type ListReview,
} from './listReview';
import { setDecision } from './reviewDecisions';

function row(key: string, value: string, weight = 1, extra: Partial<OptionDraft> = {}): OptionDraft {
  return { key, value, tagIds: [], excludeTagIds: [], weight, weightInput: String(weight), expanded: false, ...extra };
}
const blank = (key: string) => row(key, '');

function review(rows: readonly OptionDraft[], changes: ListChange[], mode: 'extend' | 'rework' = 'rework'): ListReview {
  const payload: DraftListChanges = { kind: 'changes', baseCount: baseOf(rows).length, changes, unplaced: [], summary: null };
  return reviewFromResponse(baseOf(rows), mode, 'shorter', payload);
}

function keys(): () => string {
  let next = 0;
  return () => `draft:added-${String(next++)}`;
}

describe('baseOf', () => {
  test('keeps non-blank rows in order with trimmed values', () => {
    expect(baseOf([blank('b0'), row('a', '  a red scarf '), row('b', 'a blue scarf', 3), blank('b1')])).toEqual([
      { key: 'a', value: 'a red scarf', weight: 1 },
      { key: 'b', value: 'a blue scarf', weight: 3 },
    ]);
  });
});

// R5.9: a review is shown only while the rows still match its base.
describe('isFresh', () => {
  const rows = [row('a', 'a red scarf'), blank('x'), row('b', 'a blue scarf', 2)];
  const base = baseOf(rows);

  test('holds for the same rows, with blank rows anywhere and untrimmed values', () => {
    expect(isFresh(base, rows)).toBe(true);
    expect(isFresh(base, [blank('y'), row('a', ' a red scarf'), row('b', 'a blue scarf', 2), blank('z')])).toBe(true);
  });

  test('a changed key, value, case, weight, order or count is stale', () => {
    expect(isFresh(base, [row('a2', 'a red scarf'), row('b', 'a blue scarf', 2)])).toBe(false);
    expect(isFresh(base, [row('a', 'a red scarf!'), row('b', 'a blue scarf', 2)])).toBe(false);
    expect(isFresh(base, [row('a', 'A red scarf'), row('b', 'a blue scarf', 2)])).toBe(false);
    expect(isFresh(base, [row('a', 'a red scarf'), row('b', 'a blue scarf', 3)])).toBe(false);
    expect(isFresh(base, [row('b', 'a blue scarf', 2), row('a', 'a red scarf')])).toBe(false);
    expect(isFresh(base, [row('a', 'a red scarf')])).toBe(false);
    expect(isFresh(base, [...rows, row('c', 'a green scarf')])).toBe(false);
  });

  test('tags and the expanded state do not count', () => {
    expect(isFresh(base, [row('a', 'a red scarf', 1, { tagIds: ['t'], expanded: true }), row('b', 'a blue scarf', 2)])).toBe(true);
  });
});

// R5.7: Apply writes the accepted changes into the editor's rows.
describe('applyReview', () => {
  const tagged = row('a', 'a red scarf', 1, { tagIds: ['warm'], excludeTagIds: ['cold'], expanded: true });
  const changes: ListChange[] = [
    { id: 0, op: 'edit', index: 0, value: 'red scarf', weight: 5, why: 'Shorter.' },
    { id: 1, op: 'remove', index: 1, why: 'Near duplicate.' },
    { id: 2, op: 'add', value: 'a green scarf', weight: 1, why: '' },
    { id: 3, op: 'add', value: 'a grey scarf', weight: 4, why: '' },
  ];

  test('an edited row keeps its key, tags and expanded state and shows the new weight', () => {
    const white = row('c', 'a white scarf');
    const rows = [tagged, row('b', 'a blue scarf'), white];
    const next = applyReview(rows, review(rows, changes), keys());
    expect(next).toEqual([
      { ...tagged, value: 'red scarf', weight: 5, weightInput: '5' },
      white,
      row('draft:added-0', 'a green scarf'),
      row('draft:added-1', 'a grey scarf', 4),
    ]);
    // Untouched rows are the very objects the editor held.
    expect(next[1]).toBe(rows[2]);
  });

  test('blank rows before, between and after the base keep their places; adds follow every row', () => {
    const rows = [blank('x0'), tagged, blank('x1'), row('b', 'a blue scarf'), row('c', 'a white scarf'), blank('x2')];
    const next = applyReview(rows, review(rows, changes), keys());
    expect(next.map((r) => r.key)).toEqual(['x0', 'a', 'x1', 'c', 'x2', 'draft:added-0', 'draft:added-1']);
    expect(next[0]).toBe(rows[0]);
    expect(next[2]).toBe(rows[2]);
    expect(next[4]).toBe(rows[5]);
  });

  test('a rejected change leaves its row as it was', () => {
    const rows = [tagged, row('b', 'a blue scarf'), row('c', 'a white scarf')];
    let open = review(rows, changes);
    open = setDecision(open, 0, 'rejected');
    open = setDecision(open, 2, 'rejected');
    const next = applyReview(rows, open, keys());
    expect(next.map((r) => r.value)).toEqual(['a red scarf', 'a white scarf', 'a grey scarf']);
    expect(next[0]).toBe(tagged);
  });

  test('a weight-only edit keeps the value and shows the weight', () => {
    const rows = [row('a', 'a red scarf', 1, { weightInput: '1' })];
    const next = applyReview(rows, review(rows, [{ id: 0, op: 'edit', index: 0, value: 'a red scarf', weight: 0, why: '' }]), keys());
    expect(next).toEqual([row('a', 'a red scarf', 0)]);
  });

  test('removing every option leaves only the blank rows; the input is not mutated', () => {
    const rows = [row('a', 'a red scarf'), blank('x')];
    const before = JSON.stringify(rows);
    const next = applyReview(rows, review(rows, [{ id: 0, op: 'remove', index: 0, why: '' }]), keys());
    expect(next).toEqual([blank('x')]);
    expect(JSON.stringify(rows)).toBe(before);
  });
});

describe('remapReviewKeys', () => {
  test('renames settled base keys only, so the review stays fresh against settled rows', () => {
    const rows = [row('draft:1', 'a red scarf'), row('saved', 'a blue scarf')];
    const open = review(rows, [{ id: 0, op: 'remove', index: 1, why: '' }]);
    const settled = new Map([['draft:1', 'server-1']]);
    const remapped = remapReviewKeys(open, settled);
    expect(remapped.base.map((r) => r.key)).toEqual(['server-1', 'saved']);
    expect(remapped.changes).toBe(open.changes);
    expect(isFresh(remapped.base, [row('server-1', 'a red scarf'), row('saved', 'a blue scarf')])).toBe(true);
    expect(remapReviewKeys(open, new Map([['other', 'x']]))).toBe(open);
  });
});

// R5.2: the sheet's lines.
describe('segmentList', () => {
  const values = Array.from({ length: 12 }, (_, i) => `scarf ${String(i + 1)}`);
  const rows = values.map((value, i) => row(`k${String(i)}`, value));

  test('base rows in order, then adds; a run of more than 6 unchanged rows folds', () => {
    const segments = segmentList(review(rows, [
      { id: 0, op: 'remove', index: 1, why: '' },
      { id: 1, op: 'edit', index: 9, value: 'scarf ten', weight: 1, why: '' },
      { id: 2, op: 'add', value: 'scarf thirteen', weight: 1, why: '' },
    ]));
    expect(segments.map((s) => s.kind)).toEqual(['same', 'remove', 'fold', 'edit', 'same', 'same', 'add']);
    const fold = segments[2];
    if (fold?.kind !== 'fold') throw new Error('expected a fold');
    expect(fold.start).toBe(2);
    expect(fold.rows).toHaveLength(7);
  });

  test('six unchanged rows stay open', () => {
    const segments = segmentList(review(rows.slice(0, 7), [{ id: 0, op: 'remove', index: 6, why: '' }]));
    expect(segments.map((s) => s.kind)).toEqual(['same', 'same', 'same', 'same', 'same', 'same', 'remove']);
  });

  test('an extend review folds the whole list above its additions', () => {
    const segments = segmentList(review(rows, [{ id: 0, op: 'add', value: 'scarf thirteen', weight: 2, why: '' }], 'extend'));
    expect(segments.map((s) => s.kind)).toEqual(['fold', 'add']);
  });

  test('an edit carries word runs; a weight-only edit carries none', () => {
    const segments = segmentList(review([row('a', 'a red wool scarf'), row('b', 'a blue scarf')], [
      { id: 0, op: 'edit', index: 0, value: 'a red silk scarf', weight: 1, why: '' },
      { id: 1, op: 'edit', index: 1, value: 'a blue scarf', weight: 5, why: '' },
    ]));
    const [edit, weightOnly] = segments;
    if (edit?.kind !== 'edit' || weightOnly?.kind !== 'edit') throw new Error('expected edits');
    expect(edit.runs?.filter((r) => r.kind !== 'same').map((r) => `${r.kind}:${r.text}`)).toEqual(['del:wool', 'ins:silk']);
    expect(weightOnly.runs).toBeNull();
  });
});

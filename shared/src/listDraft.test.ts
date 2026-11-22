import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import * as z from 'zod/mini';
import {
  applyListChanges,
  cleanListCandidates,
  isListChangeSet,
  LIST_DRAFT_MAX_ADDS,
  LIST_OPTION_VALUE_MAX_CHARS,
  LIST_REWORK_MAX_OPERATIONS,
  lookupKey,
  placeListOperations,
  uniqueListName,
  type ListChange,
  type ListOptionDraft,
} from './listDraft';
import { DraftVariableListResponseSchema } from './promptToolSchemas';

const runs = { numRuns: 1000 };

const opt = (value: string, weight = 1): ListOptionDraft => ({ value, weight });
const base3: ListOptionDraft[] = [opt('red'), opt('Red', 2), opt('blue')];

describe('constants', () => {
  test('the draft limits', () => {
    expect(LIST_DRAFT_MAX_ADDS).toBe(100);
    expect(LIST_REWORK_MAX_OPERATIONS).toBe(500);
    expect(LIST_OPTION_VALUE_MAX_CHARS).toBe(2_000);
  });

  test('lookupKey trims and folds case', () => {
    expect(lookupKey('  A Red Scarf ')).toBe('a red scarf');
  });
});

describe('DraftVariableListResponseSchema', () => {
  const valid = (value: unknown): boolean => z.safeParse(DraftVariableListResponseSchema, value).success;

  test('accepts the three answers', () => {
    expect(valid({ kind: 'clarify', question: 'Which colours?' })).toBe(true);
    expect(valid({ kind: 'list', name: 'hair_color', options: [{ value: 'auburn', weight: 1 }] })).toBe(true);
    expect(valid({ kind: 'list', name: null, options: [] })).toBe(true);
    expect(valid({
      kind: 'changes',
      baseCount: 2,
      changes: [
        { id: 0, op: 'edit', index: 0, value: 'a red scarf', weight: 3, why: 'warmer' },
        { id: 1, op: 'remove', index: 1, why: 'off topic' },
        { id: 2, op: 'add', value: 'a blue scarf', weight: 1, why: '' },
      ],
      unplaced: [{ op: 'edit', find: 'green', value: null, weight: 4, why: 'x', reason: 'missing' }],
      summary: null,
    })).toBe(true);
  });

  test('rejects the old shape, a weight outside 0..100 and an unknown reason', () => {
    expect(valid({ kind: 'entries', entries: ['a'] })).toBe(false);
    expect(valid({ kind: 'list', name: null, options: [{ value: 'a', weight: 101 }] })).toBe(false);
    expect(valid({ kind: 'list', name: null, options: [{ value: 'a', weight: 1.5 }] })).toBe(false);
    expect(valid({
      kind: 'changes', baseCount: 0, changes: [], summary: null,
      unplaced: [{ op: 'remove', find: 'a', value: null, weight: null, why: '', reason: 'too_long' }],
    })).toBe(false);
    expect(valid({ kind: 'changes', baseCount: 1, changes: [{ id: 0, op: 'remove', why: '' }], unplaced: [], summary: null })).toBe(false);
  });
});

describe('isListChangeSet', () => {
  const edit = (id: number, index: number): ListChange => ({ id, op: 'edit', index, value: `v${index}`, weight: 1, why: '' });
  const remove = (id: number, index: number): ListChange => ({ id, op: 'remove', index, why: '' });
  const add = (id: number): ListChange => ({ id, op: 'add', value: `a${id}`, weight: 1, why: '' });

  test('holds for an empty set and for edits and removes ascending, then adds', () => {
    expect(isListChangeSet(0, [])).toBe(true);
    expect(isListChangeSet(3, [edit(0, 0), remove(1, 2), add(2), add(3)])).toBe(true);
    expect(isListChangeSet(0, [add(0)])).toBe(true);
  });

  test('fails on ids out of order or not contiguous', () => {
    expect(isListChangeSet(3, [edit(1, 0)])).toBe(false);
    expect(isListChangeSet(3, [edit(0, 0), remove(2, 1)])).toBe(false);
  });

  test('fails on an index out of range or not an integer', () => {
    expect(isListChangeSet(2, [remove(0, 2)])).toBe(false);
    expect(isListChangeSet(2, [remove(0, -1)])).toBe(false);
    expect(isListChangeSet(2, [remove(0, 0.5)])).toBe(false);
  });

  test('fails on two changes for one row, a descending index or an add before a row change', () => {
    expect(isListChangeSet(3, [edit(0, 1), remove(1, 1)])).toBe(false);
    expect(isListChangeSet(3, [edit(0, 2), remove(1, 1)])).toBe(false);
    expect(isListChangeSet(3, [add(0), remove(1, 1)])).toBe(false);
  });
});

describe('cleanListCandidates', () => {
  test('trims, skips blank and over-long values, and keeps the first of lookup-equal ones', () => {
    const long = 'x'.repeat(LIST_OPTION_VALUE_MAX_CHARS + 1);
    const result = cleanListCandidates([
      { value: '  a red scarf ', weight: 1 },
      { value: '   ', weight: 1 },
      { value: long, weight: 1 },
      { value: 'A RED SCARF', weight: 5 },
      { value: 'x'.repeat(LIST_OPTION_VALUE_MAX_CHARS), weight: 1 },
      { value: 42, weight: 1 },
    ], [], 10);
    expect(result).toEqual([opt('a red scarf'), opt('x'.repeat(LIST_OPTION_VALUE_MAX_CHARS))]);
  });

  test('rounds and clamps weights and defaults a non-number to 1', () => {
    const result = cleanListCandidates([
      { value: 'a', weight: 2.6 },
      { value: 'b', weight: -4 },
      { value: 'c', weight: 250 },
      { value: 'd', weight: Number.NaN },
      { value: 'e', weight: '3' },
      { value: 'f', weight: null },
      { value: 'g', weight: Number.POSITIVE_INFINITY },
    ], [], 10);
    expect(result.map((o) => o.weight)).toEqual([3, 0, 100, 1, 1, 1, 1]);
  });

  test('drops values taken under lookup equality and cuts to the limit after cleaning', () => {
    const result = cleanListCandidates(
      [{ value: 'Blue', weight: 1 }, { value: 'green', weight: 1 }, { value: 'teal', weight: 1 }, { value: 'navy', weight: 1 }],
      [' blue '],
      2,
    );
    expect(result).toEqual([opt('green'), opt('teal')]);
    expect(cleanListCandidates([{ value: 'a', weight: 1 }], [], 0)).toEqual([]);
  });
});

describe('placeListOperations: targets (R2.7 worked examples)', () => {
  const place = (ops: unknown[], base = base3, limit = 10) => placeListOperations(base, ops, limit);

  test('row n is the target when find names it', () => {
    const { changes, unplaced } = place([{ why: 'w', op: 'remove', n: 2, find: 'red', value: null, weight: null }]);
    expect(changes).toEqual([{ id: 0, op: 'remove', index: 1, why: 'w' }]);
    expect(unplaced).toEqual([]);
  });

  test('a row number out of range falls back to find; several matches are ambiguous', () => {
    const { changes, unplaced } = place([{ why: 'w', op: 'remove', n: 9, find: 'red', value: null, weight: null }]);
    expect(changes).toEqual([]);
    expect(unplaced).toEqual([{ op: 'remove', find: 'red', value: null, weight: null, why: 'w', reason: 'ambiguous' }]);
  });

  test('a row number out of range falls back to find; one match is the target', () => {
    const { changes } = place([{ why: '', op: 'remove', n: 9, find: 'blue', value: null, weight: null }]);
    expect(changes).toEqual([{ id: 0, op: 'remove', index: 2, why: '' }]);
  });

  test('a blank find trusts row n; a find that names another row wins over n', () => {
    expect(place([{ why: '', op: 'remove', n: 3, find: '  ', value: null, weight: null }]).changes)
      .toEqual([{ id: 0, op: 'remove', index: 2, why: '' }]);
    expect(place([{ why: '', op: 'remove', n: 1, find: 'BLUE', value: null, weight: null }]).changes)
      .toEqual([{ id: 0, op: 'remove', index: 2, why: '' }]);
  });

  test('no match is missing, and an unplaced edit carries what it proposed', () => {
    const { changes, unplaced } = place([
      { why: 'w', op: 'edit', n: null, find: 'green', value: ' lime ', weight: 7.4 },
      { why: 'w', op: 'edit', n: 0, find: null, value: null, weight: null },
    ]);
    expect(changes).toEqual([]);
    expect(unplaced).toEqual([
      { op: 'edit', find: 'green', value: 'lime', weight: 7, why: 'w', reason: 'missing' },
      { op: 'edit', find: '', value: null, weight: null, why: 'w', reason: 'missing' },
    ]);
  });

  test('a second operation on a row already holding a placed change is overlap', () => {
    const { changes, unplaced } = place([
      { why: 'a', op: 'edit', n: 3, find: 'blue', value: 'navy', weight: null },
      { why: 'b', op: 'remove', n: 3, find: 'blue', value: null, weight: null },
    ]);
    expect(changes).toEqual([{ id: 0, op: 'edit', index: 2, value: 'navy', weight: 1, why: 'a' }]);
    expect(unplaced).toEqual([{ op: 'remove', find: 'blue', value: null, weight: null, why: 'b', reason: 'overlap' }]);
  });

  test('members that are not objects or carry an unknown op are skipped', () => {
    const { changes, unplaced } = place([null, 'remove', 7, [], { op: 'rename', n: 1 }, { op: 'remove', n: 3, find: 'blue' }]);
    expect(changes).toEqual([{ id: 0, op: 'remove', index: 2, why: '' }]);
    expect(unplaced).toEqual([]);
  });
});

describe('placeListOperations: edits', () => {
  const base = [opt('a red scarf'), opt('a blue scarf', 3), opt('a green hat')];
  const edit = (n: number, find: string, value: unknown, weight: unknown, why = 'w') => ({ why, op: 'edit', n, find, value, weight });

  test('a weight-only edit keeps the value; a value-only edit keeps the weight', () => {
    const { changes } = placeListOperations(base, [edit(2, 'a blue scarf', null, 5), edit(1, 'a red scarf', '  a crimson scarf ', null)], 0);
    expect(changes).toEqual([
      { id: 0, op: 'edit', index: 0, value: 'a crimson scarf', weight: 1, why: 'w' },
      { id: 1, op: 'edit', index: 1, value: 'a blue scarf', weight: 5, why: 'w' },
    ]);
  });

  test('a blank value is weight-only, and the weight is cleaned', () => {
    const { changes } = placeListOperations(base, [edit(3, 'a green hat', '   ', 130)], 0);
    expect(changes).toEqual([{ id: 0, op: 'edit', index: 2, value: 'a green hat', weight: 100, why: 'w' }]);
  });

  test('an edit that changes nothing is skipped and leaves the row free', () => {
    const { changes, unplaced } = placeListOperations(base, [
      edit(1, 'a red scarf', 'a red scarf', 1),
      edit(1, 'a red scarf', null, null),
      { why: 'r', op: 'remove', n: 1, find: 'a red scarf' },
    ], 0);
    expect(changes).toEqual([{ id: 0, op: 'remove', index: 0, why: 'r' }]);
    expect(unplaced).toEqual([]);
  });

  test('a case-only change is an edit', () => {
    const { changes } = placeListOperations(base, [edit(1, 'a red scarf', 'A Red Scarf', null)], 0);
    expect(changes).toEqual([{ id: 0, op: 'edit', index: 0, value: 'A Red Scarf', weight: 1, why: 'w' }]);
  });

  test('a new value over the length limit is skipped and leaves the row free', () => {
    const { changes, unplaced } = placeListOperations(base, [
      edit(1, 'a red scarf', 'x'.repeat(LIST_OPTION_VALUE_MAX_CHARS + 1), null),
      edit(1, 'a red scarf', 'a wool scarf', null),
    ], 0);
    expect(changes).toEqual([{ id: 0, op: 'edit', index: 0, value: 'a wool scarf', weight: 1, why: 'w' }]);
    expect(unplaced).toEqual([]);
  });

  test('a new value equal to another base row or an earlier placed edit is duplicate', () => {
    const { changes, unplaced } = placeListOperations(base, [
      edit(1, 'a red scarf', 'A BLUE SCARF', null, 'one'),
      edit(1, 'a red scarf', 'a wool scarf', null, 'two'),
      edit(3, 'a green hat', 'a Wool Scarf', 2, 'three'),
    ], 0);
    expect(changes).toEqual([{ id: 0, op: 'edit', index: 0, value: 'a wool scarf', weight: 1, why: 'two' }]);
    expect(unplaced).toEqual([
      { op: 'edit', find: 'a red scarf', value: 'A BLUE SCARF', weight: null, why: 'one', reason: 'duplicate' },
      { op: 'edit', find: 'a green hat', value: 'a Wool Scarf', weight: 2, why: 'three', reason: 'duplicate' },
    ]);
  });

  test('a weight-only or case-only edit of a value the base holds twice is placed', () => {
    const twice = [opt('a red scarf'), opt('A Red Scarf'), opt('a green hat')];
    const { changes, unplaced } = placeListOperations(twice, [
      edit(1, 'a red scarf', null, 0, 'park'),
      edit(2, 'a red scarf', 'A RED SCARF', null, 'case'),
    ], 0);
    expect(changes).toEqual([
      { id: 0, op: 'edit', index: 0, value: 'a red scarf', weight: 0, why: 'park' },
      { id: 1, op: 'edit', index: 1, value: 'A RED SCARF', weight: 1, why: 'case' },
    ]);
    expect(unplaced).toEqual([]);
  });

  test('a remove ignores value and weight; edits and removes come out ascending by row', () => {
    const { changes } = placeListOperations(base, [
      { why: 'c', op: 'remove', n: 3, find: 'a green hat', value: 'ignored', weight: 9 },
      edit(1, 'a red scarf', 'a silk scarf', null, 'a'),
    ], 0);
    expect(changes).toEqual([
      { id: 0, op: 'edit', index: 0, value: 'a silk scarf', weight: 1, why: 'a' },
      { id: 1, op: 'remove', index: 2, why: 'c' },
    ]);
  });
});

describe('placeListOperations: adds', () => {
  const base = [opt('a red scarf'), opt('a blue scarf')];
  const add = (value: unknown, weight: unknown = 1, why = '') => ({ why, op: 'add', n: null, find: null, value, weight });

  test('adds follow row changes in model order, cleaned against base, edits and earlier adds', () => {
    const { changes } = placeListOperations(base, [
      add('a wool scarf', 2, 'warm'),
      add(' A RED SCARF '),
      { why: 'e', op: 'edit', n: 2, find: 'a blue scarf', value: 'a navy scarf', weight: null },
      add('a navy scarf'),
      add('a Wool Scarf'),
      add('a silk scarf', 'x'),
      add('   '),
    ], 10);
    expect(changes).toEqual([
      { id: 0, op: 'edit', index: 1, value: 'a navy scarf', weight: 1, why: 'e' },
      { id: 1, op: 'add', value: 'a wool scarf', weight: 2, why: 'warm' },
      { id: 2, op: 'add', value: 'a silk scarf', weight: 1, why: '' },
    ]);
  });

  test('adds are cut to the add limit; a limit of 0 drops them all', () => {
    const ops = [add('one'), add('two'), add('three')];
    expect(placeListOperations(base, ops, 2).changes.map((c) => c.op === 'add' ? c.value : '')).toEqual(['one', 'two']);
    expect(placeListOperations(base, ops, 0).changes).toEqual([]);
  });
});

describe('placeListOperations: the operation cap', () => {
  test('reads at most 500 members: 500 malformed ones hide the valid one after them', () => {
    const malformed = Array.from({ length: LIST_REWORK_MAX_OPERATIONS }, () => ({ op: 'unknown' }));
    const valid = { why: '', op: 'remove', n: 1, find: 'red' };
    expect(placeListOperations([opt('red')], [...malformed, valid], 10)).toEqual({ changes: [], unplaced: [] });
    expect(placeListOperations([opt('red')], [...malformed.slice(1), valid], 10).changes).toHaveLength(1);
  });
});

// ---- properties -----------------------------------------------------------

// Small alphabets so values collide under lookup equality often; proposed
// values also come from outside the base alphabet so edits and adds can land.
const baseValueArb = fc.constantFrom('red', 'Red', 'blue', 'green', 'a red scarf', 'teal');
const proposedValueArb = fc.constantFrom('red', ' Red ', 'BLUE', 'teal', 'navy', 'Navy ', 'navy', 'olive', 'OLIVE', 'olive', '', '  ');
const weightArb = fc.oneof(fc.integer({ min: 0, max: 100 }), fc.constant(null), fc.double(), fc.constant('3'));
const baseArb = fc.array(fc.record({ value: baseValueArb, weight: fc.integer({ min: 0, max: 3 }) }), { maxLength: 8, size: 'medium' });
const operationArb = fc.oneof(
  {
    weight: 9,
    arbitrary: fc.record({
      why: fc.oneof(fc.string({ maxLength: 4 }), fc.constant(null)),
      op: fc.constantFrom('edit', 'edit', 'remove', 'add', 'add', 'rename'),
      n: fc.oneof({ weight: 4, arbitrary: fc.integer({ min: 1, max: 8 }) }, fc.integer({ min: -1, max: 10 }), fc.constant(null), fc.constant(1.5)),
      find: fc.oneof({ weight: 3, arbitrary: fc.constant(null) }, baseValueArb, proposedValueArb),
      value: fc.oneof({ weight: 3, arbitrary: proposedValueArb }, fc.constant(null)),
      weight: weightArb,
    }),
  },
  { weight: 1, arbitrary: fc.constantFrom(null, 'edit', 3, []) },
);

describe('placeListOperations: properties (R2.7)', () => {
  const scenarioArb = fc.record({
    base: baseArb,
    operations: fc.array(operationArb, { minLength: 1, maxLength: 14, size: 'medium' }),
    addLimit: fc.integer({ min: 0, max: 5 }),
  }).chain((s) => {
    const placed = placeListOperations(s.base, s.operations, s.addLimit);
    return fc.record({
      scenario: fc.constant(s),
      placed: fc.constant(placed),
      accepted: fc.subarray(placed.changes.map((c) => c.id)),
    });
  });

  test('the result is a valid change set with unique in-range targets', () => {
    fc.assert(fc.property(scenarioArb, ({ scenario, placed }) => {
      expect(isListChangeSet(scenario.base.length, placed.changes)).toBe(true);
      const targets = placed.changes.flatMap((c) => c.op === 'add' ? [] : [c.index]);
      expect(new Set(targets).size).toBe(targets.length);
      for (const index of targets) expect(index >= 0 && index < scenario.base.length).toBe(true);
      expect(placed.changes.filter((c) => c.op === 'add').length).toBeLessThanOrEqual(scenario.addLimit);
    }), runs);
  });

  test('surviving adds keep the model order', () => {
    fc.assert(fc.property(scenarioArb, ({ scenario, placed }) => {
      const addValues = scenario.operations.flatMap((op) =>
        typeof op === 'object' && op !== null && !Array.isArray(op) && op.op === 'add' && typeof op.value === 'string' ? [op.value.trim()] : []);
      let from = 0;
      for (const change of placed.changes) {
        if (change.op !== 'add') continue;
        const at = addValues.indexOf(change.value, from);
        expect(at).toBeGreaterThanOrEqual(from);
        from = at + 1;
      }
    }), runs);
  });

  test('for every accepted subset a value an edit or an add brought in is held by no other row', () => {
    fc.assert(fc.property(scenarioArb, ({ scenario, placed, accepted }) => {
      const acceptedIds = new Set(accepted);
      // An edit brings a value in when it changes the row's lookup key.
      const renamed = new Set(placed.changes.flatMap((c) => (
        c.op === 'edit' && acceptedIds.has(c.id) && lookupKey(c.value) !== lookupKey(scenario.base[c.index]?.value ?? '')
          ? [c.index]
          : [])));
      const marked = scenario.base.map((row, index) => ({ ...row, brought: renamed.has(index) }));
      const result = applyListChanges(marked, placed.changes, accepted, (add) => ({ value: add.value, weight: add.weight, brought: true }));
      const keys = result.map((row) => lookupKey(row.value));
      for (const [at, row] of result.entries()) {
        if (!row.brought) continue;
        expect(keys.filter((key) => key === keys[at])).toHaveLength(1);
      }
    }), runs);
  });
});

describe('applyListChanges', () => {
  interface Row { key: string; value: string; weight: number; tags: string[] }
  const rows: [Row, Row, Row] = [
    { key: 'k0', value: 'red', weight: 1, tags: ['t'] },
    { key: 'k1', value: 'blue', weight: 2, tags: [] },
    { key: 'k2', value: 'green', weight: 1, tags: [] },
  ];
  const changes: ListChange[] = [
    { id: 0, op: 'edit', index: 0, value: 'crimson', weight: 4, why: '' },
    { id: 1, op: 'remove', index: 2, why: '' },
    { id: 2, op: 'add', value: 'teal', weight: 1, why: '' },
  ];
  const makeAdded = (add: Extract<ListChange, { op: 'add' }>): Row => ({ key: `new-${add.id}`, value: add.value, weight: add.weight, tags: [] });

  test('applies an accepted subset, keeping every other field of an edited row', () => {
    const result = applyListChanges(rows, changes, [2, 0], makeAdded);
    expect(result).toEqual([
      { key: 'k0', value: 'crimson', weight: 4, tags: ['t'] },
      rows[1],
      rows[2],
      { key: 'new-2', value: 'teal', weight: 1, tags: [] },
    ]);
    expect(result[1]).toBe(rows[1]);
  });

  test('accepting nothing returns the base rows unchanged', () => {
    const result = applyListChanges(rows, changes, [], makeAdded);
    expect(result).toHaveLength(3);
    expect(result).toEqual(rows);
    result.forEach((row, i) => {
      expect(row === rows[i]).toBe(true);
    });
  });
});

describe('applyListChanges: property (R1.6)', () => {
  interface Row { key: number; value: string; weight: number; extra: { tag: number } }

  // A valid change set: a random subset of rows gets an edit or a remove, then adds.
  const caseArb = fc.integer({ min: 0, max: 8 }).chain((size) => fc.record({
    rows: fc.constant(Array.from({ length: size }, (_, i): Row => ({ key: i, value: `v${i}`, weight: i % 3, extra: { tag: i } }))),
    rowOps: fc.array(fc.constantFrom<'keep' | 'edit' | 'remove'>('keep', 'edit', 'remove'), { minLength: size, maxLength: size }),
    adds: fc.array(fc.record({ value: fc.string({ maxLength: 6 }), weight: fc.integer({ min: 0, max: 100 }) }), { maxLength: 4 }),
  })).chain(({ rows, rowOps, adds }) => {
    const changes: ListChange[] = [];
    rowOps.forEach((op, index) => {
      if (op === 'edit') changes.push({ id: changes.length, op: 'edit', index, value: `e${index}`, weight: 50, why: '' });
      if (op === 'remove') changes.push({ id: changes.length, op: 'remove', index, why: '' });
    });
    for (const add of adds) changes.push({ id: changes.length, op: 'add', value: add.value, weight: add.weight, why: '' });
    return fc.record({
      rows: fc.constant(rows),
      changes: fc.constant(changes),
      accepted: fc.shuffledSubarray(changes.map((c) => c.id)),
    });
  });

  const makeAdded = (add: Extract<ListChange, { op: 'add' }>): Row => ({ key: 1000 + add.id, value: add.value, weight: add.weight, extra: { tag: -1 } });

  test('the result is the base with accepted edits and removes, then accepted adds; nothing is mutated', () => {
    fc.assert(fc.property(caseArb, ({ rows, changes, accepted }) => {
      expect(isListChangeSet(rows.length, changes)).toBe(true);
      const before = structuredClone(rows);
      const changesBefore = structuredClone(changes);
      const acceptedSet = new Set(accepted);
      const result = applyListChanges(rows, changes, accepted, makeAdded);

      const expected: Row[] = [];
      const identical: boolean[] = [];
      rows.forEach((row, index) => {
        const change = changes.find((c) => c.op !== 'add' && c.index === index && acceptedSet.has(c.id));
        if (change?.op === 'remove') return;
        if (change?.op === 'edit') {
          expected.push({ ...row, value: change.value, weight: change.weight });
          identical.push(false);
        } else {
          expected.push(row);
          identical.push(true);
        }
      });
      const acceptedAdds = changes.filter((c) => c.op === 'add' && acceptedSet.has(c.id));
      for (const add of acceptedAdds) if (add.op === 'add') expected.push(makeAdded(add));

      expect(result).toEqual(expected);
      identical.forEach((same, i) => {
        const original = rows.find((row) => row.key === result[i]?.key);
        // An untouched row is the input object; an edited one is a copy that keeps its other fields.
        expect(result[i] === original).toBe(same);
        expect(result[i]?.extra === original?.extra).toBe(true);
      });
      const removes = changes.filter((c) => c.op === 'remove' && acceptedSet.has(c.id)).length;
      expect(result.length).toBe(rows.length - removes + acceptedAdds.length);
      expect(rows).toEqual(before);
      expect(changes).toEqual(changesBefore);

      const reordered = applyListChanges(rows, changes, [...accepted].reverse(), makeAdded);
      expect(reordered).toEqual(result);
    }), runs);
  });
});

describe('uniqueListName (R2.5)', () => {
  test('trims, joins whitespace runs with _ and keeps a free name', () => {
    expect(uniqueListName('  hair   color\tstyle ', [], 64)).toBe('hair_color_style');
  });

  test('a taken name gets the first free numeric suffix; matching is exact', () => {
    expect(uniqueListName('hair_color', ['hair_color', 'hair_color_2'], 64)).toBe('hair_color_3');
    expect(uniqueListName('hair_color', ['Hair_Color'], 64)).toBe('hair_color');
  });

  test('the stem is cut so the suffix fits the limit', () => {
    const long = 'n'.repeat(64);
    expect(uniqueListName(long, [long], 64)).toBe(`${'n'.repeat(62)}_2`);
    const taken = [long, ...Array.from({ length: 8 }, (_, i) => `${'n'.repeat(62)}_${i + 2}`)];
    expect(uniqueListName(long, taken, 64)).toBe(`${'n'.repeat(61)}_10`);
    expect(uniqueListName('n'.repeat(80), [], 64)).toBe(long);
  });

  test('a blank proposal is null', () => {
    expect(uniqueListName('  \n ', ['x'], 64)).toBeNull();
  });

  const blankArb = fc.array(fc.constantFrom(' ', '\t', '\n', ' ', ' '), { maxLength: 6 }).map((parts) => parts.join(''));
  const nameArb = fc.oneof(
    fc.string({ maxLength: 80 }),
    fc.string({ unit: 'grapheme', maxLength: 40 }),
    fc.constantFrom('hair_color', 'n'.repeat(64), 'n'.repeat(70), ' hair color '),
  );

  test('property: a blank proposal returns null', () => {
    fc.assert(fc.property(blankArb, fc.array(fc.string()), (proposed, existing) => {
      expect(uniqueListName(proposed, existing, 64)).toBeNull();
    }), runs);
  });

  test('property: a non-blank proposal returns a non-blank name within the limit that is not taken', () => {
    // Existing sets built from the proposal itself force the suffix path,
    // including stems cut to fit `_10` and beyond.
    const caseArb = nameArb
      .filter((name) => name.trim() !== '')
      .chain((proposed) => {
        const normalized = proposed.trim().replace(/\s+/gu, '_');
        const derived = [normalized, normalized.slice(0, 64), ...Array.from({ length: 12 }, (_, i) => `${normalized.slice(0, 64 - String(i + 2).length - 1)}_${i + 2}`)];
        return fc.record({
          proposed: fc.constant(proposed),
          existing: fc.tuple(fc.subarray(derived), fc.array(fc.string({ maxLength: 66 }), { maxLength: 5 })).map(([a, b]) => [...a, ...b]),
          maxChars: fc.constantFrom(64, 64, 12, 6),
        });
      });
    fc.assert(fc.property(caseArb, ({ proposed, existing, maxChars }) => {
      const name = uniqueListName(proposed, existing, maxChars);
      expect(name).not.toBeNull();
      if (name === null) return;
      expect(name.trim()).not.toBe('');
      expect(name.length).toBeLessThanOrEqual(maxChars);
      expect(existing).not.toContain(name);
    }), runs);
  });
});

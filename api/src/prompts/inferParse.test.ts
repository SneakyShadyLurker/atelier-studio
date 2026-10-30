import { describe, expect, test } from 'bun:test';
import { parseInferPayload, RESCUE_RESPONSE_FORMAT } from './inferParse';

describe('parseInferPayload', () => {
  test('extracts ops from fenced/prose-wrapped JSON', () => {
    const r = parseInferPayload('noise ```json\n{"ops":[{"op":"createDimension","name":"X","tags":["a"]}]}\n``` end');
    expect(r?.length).toBe(1);
    expect(r?.[0]).toEqual({ op: 'createDimension', name: 'X', tags: ['a'] });
  });

  test('rejects mixed malformed/valid ops rather than silently discarding suggestions', () => {
    const r = parseInferPayload('{"ops":[{"op":"nope"},{"op":"addTags","dimIdx":1,"tags":["z"]}]}');
    expect(r).toBeNull();
  });

  test('returns null on unparseable / non-object', () => {
    expect(parseInferPayload('garbage')).toBeNull();
    expect(parseInferPayload('{"ops":"x"}')).toBeNull();
  });

  test('enforces per-op count caps (tags <= 50)', () => {
    const big = JSON.stringify({ ops: [{ op: 'createDimension', name: 'X', tags: Array(60).fill('t') }] });
    expect(parseInferPayload(big)).toBeNull();
  });
});

test('parseInferPayload accepts addOption op', () => {
  const raw = JSON.stringify({
    ops: [{ op: 'addOption', listIdx: 0, value: 'vintage rocker jacket', tags: [{ dimName: 'era', label: 'modern' }] }],
  });
  const ops = parseInferPayload(raw);
  expect(ops).toEqual([
    { op: 'addOption', listIdx: 0, value: 'vintage rocker jacket', tags: [{ dimName: 'era', label: 'modern' }] },
  ]);
});

test('parseInferPayload rejects addOption with empty value', () => {
  const raw = JSON.stringify({
    ops: [{ op: 'addOption', listIdx: 0, value: '', tags: [{ dimName: 'era', label: 'modern' }] }],
  });
  expect(parseInferPayload(raw)).toBeNull();
});

test('parseInferPayload rejects addOption with empty tags', () => {
  const raw = JSON.stringify({
    ops: [{ op: 'addOption', listIdx: 0, value: 'x', tags: [] }],
  });
  expect(parseInferPayload(raw)).toBeNull();
});

test('an intentionally empty proposal remains valid, invalid-only output fails', () => {
  expect(parseInferPayload('{"ops":[]}')).toEqual([]);
  expect(parseInferPayload('{"ops":[{"op":"assignOptionTags","listIdx":0,"optionIdx":"bad","tags":[{"dimName":"Genre","label":"Fantasy"}]}]}')).toBeNull();
});

test('normalizes every indexed operation and strips extra object and tag-reference keys without dropping ops', () => {
  const ops = [
    { op: 'createDimension', name: ' D ', tags: [' x '], note: 'ignored' },
    { op: 'addTags', dimIdx: '0', tags: [' y '], note: 'ignored' },
    { op: 'renameDimension', dimIdx: '003', newName: ' Renamed ', extra: true },
    { op: 'mergeDimensions', fromIdx: '0', intoIdx: '2', tagMap: { x: ' y ' }, extra: true },
    { op: 'assignOptionTags', listIdx: '1', optionIdx: '00', tags: [{ dimName: ' D ', label: ' x ', note: 'ignored' }], extra: true },
    { op: 'addOption', listIdx: '2', value: ' new ', tags: [{ dimName: ' D ', label: ' y ', ignored: {} }], extra: true },
  ];
  expect(parseInferPayload(JSON.stringify({ ops, note: 'ignored envelope metadata' }))).toEqual([
    { op: 'createDimension', name: 'D', tags: ['x'] },
    { op: 'addTags', dimIdx: 0, tags: ['y'] },
    { op: 'renameDimension', dimIdx: 3, newName: 'Renamed' },
    { op: 'mergeDimensions', fromIdx: 0, intoIdx: 2, tagMap: { x: 'y' } },
    { op: 'assignOptionTags', listIdx: 1, optionIdx: 0, tags: [{ dimName: 'D', label: 'x' }] },
    { op: 'addOption', listIdx: 2, value: 'new', tags: [{ dimName: 'D', label: 'y' }] },
  ]);
});

for (const [op, key] of [
  [{ op: 'addTags', dimIdx: 0, tags: ['x'] }, 'dimIdx'],
  [{ op: 'renameDimension', dimIdx: 0, newName: 'D' }, 'dimIdx'],
  [{ op: 'mergeDimensions', fromIdx: 0, intoIdx: 1, tagMap: {} }, 'fromIdx'],
  [{ op: 'mergeDimensions', fromIdx: 0, intoIdx: 1, tagMap: {} }, 'intoIdx'],
  [{ op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'D', label: 'x' }] }, 'listIdx'],
  [{ op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'D', label: 'x' }] }, 'optionIdx'],
  [{ op: 'addOption', listIdx: 0, value: 'x', tags: [{ dimName: 'D', label: 'x' }] }, 'listIdx'],
] as const) {
  test(`${op.op}.${key} rejects malformed indices and fails the complete proposal`, () => {
    for (const value of [null, true, false, '', ' ', '1.5', '-1', '-0', -1, 0.5, '+1', '1e2', 'NaN', 'Infinity', Number.MAX_SAFE_INTEGER + 1, String(Number.MAX_SAFE_INTEGER + 1)]) {
      expect(parseInferPayload(JSON.stringify({ ops: [{ op: 'createDimension', name: 'D', tags: ['x'] }, { ...op, [key]: value }] }))).toBeNull();
    }
  });
}

test('safe integer edges normalize while semantic shape errors and existing caps still fail whole payloads', () => {
  expect(parseInferPayload(JSON.stringify({ ops: [{ op: 'addTags', dimIdx: String(Number.MAX_SAFE_INTEGER), tags: ['x'] }] })))
    .toEqual([{ op: 'addTags', dimIdx: Number.MAX_SAFE_INTEGER, tags: ['x'] }]);
  for (const malformed of [
    { op: 'mergeDimensions', fromIdx: '0', intoIdx: '1', tagMap: { x: null } },
    { op: 'assignOptionTags', listIdx: '0', optionIdx: '1', tags: [{ label: 'x' }] },
    { op: 'createDimension', name: 'D'.repeat(65), tags: ['x'] },
    { op: 'addOption', listIdx: '0', value: 'x', tags: Array.from({ length: 51 }, () => ({ dimName: 'D', label: 'x' })) },
  ]) expect(parseInferPayload(JSON.stringify({ ops: [{ op: 'createDimension', name: 'D', tags: ['x'] }, malformed] }))).toBeNull();
  expect(parseInferPayload(JSON.stringify({ ops: Array.from({ length: 501 }, () => ({ op: 'addTags', dimIdx: '0', tags: ['x'] })) }))).toBeNull();
});

test('strict rescue output schema stays canonical and numeric despite lenient index inputs', () => {
  expect(RESCUE_RESPONSE_FORMAT).toMatchObject({ type: 'json_schema', json_schema: { strict: true, schema: {
    additionalProperties: false,
    properties: { ops: { minItems: 1, maxItems: 1, items: {
      additionalProperties: false,
      properties: { listIdx: { type: 'integer', minimum: 0 }, tags: { items: { additionalProperties: false } } },
    } } },
  } } });
  expect(JSON.stringify(RESCUE_RESPONSE_FORMAT.json_schema.schema)).not.toContain('anyOf');
});

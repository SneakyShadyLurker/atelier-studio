import { describe, expect, test } from 'bun:test';
import { parseInferPayload } from './inferParse';

describe('parseInferPayload', () => {
  test('extracts ops from fenced/prose-wrapped JSON', () => {
    const r = parseInferPayload('noise ```json\n{"ops":[{"op":"createDimension","name":"X","tags":["a"]}]}\n``` end');
    expect(r?.length).toBe(1);
    expect(r?.[0]).toEqual({ op: 'createDimension', name: 'X', tags: ['a'] });
  });

  test('drops malformed ops, keeps valid ones', () => {
    const r = parseInferPayload('{"ops":[{"op":"nope"},{"op":"addTags","dimIdx":1,"tags":["z"]}]}');
    expect(r).toEqual([{ op: 'addTags', dimIdx: 1, tags: ['z'] }]);
  });

  test('returns null on unparseable / non-object', () => {
    expect(parseInferPayload('garbage')).toBeNull();
    expect(parseInferPayload('{"ops":"x"}')).toBeNull();
  });

  test('enforces per-op count caps (tags <= 50)', () => {
    const big = JSON.stringify({ ops: [{ op: 'createDimension', name: 'X', tags: Array(60).fill('t') }] });
    expect(parseInferPayload(big)).toEqual([]);
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
  expect(parseInferPayload(raw)).toEqual([]);
});

test('parseInferPayload rejects addOption with empty tags', () => {
  const raw = JSON.stringify({
    ops: [{ op: 'addOption', listIdx: 0, value: 'x', tags: [] }],
  });
  expect(parseInferPayload(raw)).toEqual([]);
});

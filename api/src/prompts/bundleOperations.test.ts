import { expect, test } from 'bun:test';
import { mappedTagLabel, orderedOperations, tagIdentity } from './bundleOperations';
import type { RawInferOp } from './inferTypes';

test('grouped model operations retain original order and appended manual operations follow', () => {
  const makeOp = (name: string): RawInferOp => ({ op: 'createDimension', name, tags: ['x'] });
  const a = makeOp('A'); const b = makeOp('B'); const c = makeOp('C'); const rescue = makeOp('Rescue');
  const ops = [a, b, c, rescue];
  expect(orderedOperations([
    { key: 'A', ops: [a, c], opOrder: [0, 2], dependsOn: ['B'] },
    { key: 'B', ops: [b], opOrder: [1], dependsOn: ['A'] },
    { key: 'rescue', ops: [rescue], dependsOn: [] },
  ])).toEqual(ops);
  expect(orderedOperations([{ key: 'manual', ops: [...ops].reverse(), dependsOn: [] }])).toEqual([...ops].reverse());
});

test('tag keys separate spaced values and mapping reads only own properties', () => {
  expect(tagIdentity('Hair color', 'dark brown')).not.toBe(tagIdentity('Hair', 'color dark brown'));
  for (const label of ['constructor', 'toString']) {
    expect(mappedTagLabel({}, label)).toBe(label);
    expect(mappedTagLabel({ [label]: 'mapped' }, label)).toBe('mapped');
  }
});

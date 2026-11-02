import { describe, expect, test } from 'bun:test';
import { parseVarToken } from '@atelier/shared';
import { occurrenceKeyOf } from '../src/lib/subjectKey';

describe('parseVarToken', () => {
  test('bare name → null subject', () => {
    expect(parseVarToken('face')).toEqual({ listName: 'face', subject: null });
  });
  test('subject suffix parsed and stripped', () => {
    expect(parseVarToken('face@1')).toEqual({ listName: 'face', subject: 1 });
  });
  test('multi-digit subject', () => {
    expect(parseVarToken('outfit@12')).toEqual({ listName: 'outfit', subject: 12 });
  });
  test('trailing @ with no digits stays in name', () => {
    expect(parseVarToken('weird@')).toEqual({ listName: 'weird@', subject: null });
  });
});

describe('occurrenceKeyOf', () => {
  test('scene-level key (null subject)', () => {
    expect(occurrenceKeyOf('face', null, 0)).toBe('face#0');
  });
  test('subject-scoped key', () => {
    expect(occurrenceKeyOf('face', 1, 0)).toBe('face@1#0');
  });
  test('second occurrence of a subject slot', () => {
    expect(occurrenceKeyOf('face', 1, 1)).toBe('face@1#1');
  });
});

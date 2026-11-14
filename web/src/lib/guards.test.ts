import { describe, expect, test } from 'bun:test';
import { isRecord } from './guards';

describe('isRecord', () => {
  test('true for plain objects and arrays, false for null/primitives', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord([])).toBe(true); // typeof [] === 'object'
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord('x')).toBe(false);
    expect(isRecord(3)).toBe(false);
  });
});

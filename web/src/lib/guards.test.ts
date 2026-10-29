import { describe, expect, test } from 'bun:test';
import { isNumber, isRecord, isStringArray } from './guards';

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

describe('isStringArray', () => {
  test('true only for arrays of strings', () => {
    expect(isStringArray([])).toBe(true);
    expect(isStringArray(['a', 'b'])).toBe(true);
    expect(isStringArray(['a', 1])).toBe(false);
    expect(isStringArray('ab')).toBe(false);
    expect(isStringArray(null)).toBe(false);
  });
});

describe('isNumber', () => {
  test('true for finite numbers only', () => {
    expect(isNumber(0)).toBe(true);
    expect(isNumber(-1.5)).toBe(true);
    expect(isNumber(Number.NaN)).toBe(false);
    expect(isNumber(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isNumber('1')).toBe(false);
    expect(isNumber(null)).toBe(false);
  });
});

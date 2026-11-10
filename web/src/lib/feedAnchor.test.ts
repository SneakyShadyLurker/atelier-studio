import { describe, expect, test } from 'bun:test';
import { shouldAnchorRowResize, type RowResize } from './feedAnchor';

// A 1000px row starting at 2000, the reader's viewport top at 2400 (inside it).
const spanning: RowResize = { start: 2000, size: 1000, delta: -300, scrollOffset: 2400, firstMeasure: false, backward: false, tileShift: null };

describe('row resize anchoring', () => {
  test('a row above the viewport keeps the library default', () => {
    const above = { ...spanning, start: 1000, size: 1000 };
    expect(shouldAnchorRowResize(above)).toBe(true);
    expect(shouldAnchorRowResize({ ...above, backward: true })).toBe(false);
  });

  test('a first measurement above the fold compensates in either direction', () => {
    expect(shouldAnchorRowResize({ ...spanning, firstMeasure: true, backward: true })).toBe(true);
    expect(shouldAnchorRowResize({ ...spanning, firstMeasure: true, start: 2500 })).toBe(false);
  });

  test('a row below the viewport top never moves the reader', () => {
    expect(shouldAnchorRowResize({ ...spanning, start: 2400, tileShift: -300 })).toBe(false);
    expect(shouldAnchorRowResize({ ...spanning, start: 2600, tileShift: -300 })).toBe(false);
  });

  test('a spanning row compensates when the change sits above the reader’s tile', () => {
    // An earlier tile shrank by 300px: the reader's tile moved up by the same amount.
    expect(shouldAnchorRowResize({ ...spanning, tileShift: -300 })).toBe(true);
    // A tile above was removed while the reader scrolls up: still theirs to keep.
    expect(shouldAnchorRowResize({ ...spanning, tileShift: -300, backward: true })).toBe(true);
  });

  test('a spanning row leaves the reader alone when the change sits below their tile', () => {
    expect(shouldAnchorRowResize({ ...spanning, tileShift: 0 })).toBe(false);
    expect(shouldAnchorRowResize({ ...spanning, tileShift: 1 })).toBe(false);
  });

  test('a spanning row without a recorded tile keeps the default (no adjustment)', () => {
    expect(shouldAnchorRowResize({ ...spanning, tileShift: null })).toBe(false);
  });
});

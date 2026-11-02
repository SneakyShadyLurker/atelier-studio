import { describe, expect, test } from 'bun:test';
import { formatClock } from './clock';

describe('formatClock', () => {
  test('formats sub-minute durations with zero-padded seconds', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(5)).toBe('0:05');
    expect(formatClock(59)).toBe('0:59');
  });

  test('formats multi-minute durations as m:ss instead of raw seconds', () => {
    expect(formatClock(60)).toBe('1:00');
    expect(formatClock(740)).toBe('12:20');
  });

  test('floors fractional seconds and clamps negatives to zero', () => {
    expect(formatClock(12.9)).toBe('0:12');
    expect(formatClock(-30)).toBe('0:00');
  });
});

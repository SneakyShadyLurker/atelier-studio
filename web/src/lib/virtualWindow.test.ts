import { describe, expect, test } from 'bun:test';
import { fallbackVirtualRows, virtualizedHeight } from './virtualWindow';

describe('virtualWindow', () => {
  test('height uses the measured total only once virtual items exist', () => {
    expect(virtualizedHeight(true, 120, 864)).toBe(120);
    expect(virtualizedHeight(false, 0, 864)).toBe(864);
  });

  test('fallback rows stack per-index estimates and cap at the fallback count', () => {
    const heights = [100, 50, 30, 10];
    expect(fallbackVirtualRows(heights.length, 3, (index) => heights[index] ?? 0, (index) => `row-${index}`)).toEqual([
      { key: 'row-0', index: 0, start: 0 },
      { key: 'row-1', index: 1, start: 100 },
      { key: 'row-2', index: 2, start: 150 },
    ]);
    expect(fallbackVirtualRows(1, 3, () => 20, (index) => index)).toEqual([{ key: 0, index: 0, start: 0 }]);
  });
});

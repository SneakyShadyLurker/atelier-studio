import { describe, expect, test } from 'bun:test';
import { formatClock } from './clock';
import { I2V_ESTIMATED_RENDER_MS } from './i2v';

describe('i2v estimate', () => {
  test('the render estimate renders as a clean clock value', () => {
    expect(formatClock(I2V_ESTIMATED_RENDER_MS / 1000)).toBe('12:00');
  });
});

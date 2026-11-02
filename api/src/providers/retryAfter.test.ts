import { describe, expect, test } from 'bun:test';
import { parseRetryAfterMs } from './retryAfter';

describe('parseRetryAfterMs', () => {
  test('delta-seconds value', () => {
    expect(parseRetryAfterMs('60')).toBe(60_000);
  });
  test('HTTP-date value in the future is positive', () => {
    const now = Date.now();
    const future = new Date(now + 120_000).toUTCString();
    const ms = parseRetryAfterMs(future, now);
    expect(ms).toBeDefined();
    expect(ms ?? 0).toBeGreaterThan(60_000);
  });
  test('HTTP-date value in the past clamps to 0', () => {
    expect(parseRetryAfterMs(new Date(0).toUTCString())).toBe(0);
  });
  test('absent value → undefined', () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs('  ')).toBeUndefined();
  });
  test('garbage value → undefined', () => {
    expect(parseRetryAfterMs('soon')).toBeUndefined();
  });
});

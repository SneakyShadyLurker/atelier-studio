import { describe, expect, test } from 'bun:test';
import { mapWithConcurrency } from './mapWithConcurrency';

describe('mapWithConcurrency', () => {
  test('preserves result order regardless of completion order', async () => {
    const out = await mapWithConcurrency([10, 1, 5], 2, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return `${i}:${ms}`;
    });
    expect(out).toEqual(['0:10', '1:1', '2:5']);
  });

  test('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 10 }, (_, i) => i), 3, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  test('passes the correct index to each task', async () => {
    const seen: number[] = [];
    await mapWithConcurrency(['a', 'b', 'c'], 1, (_item, i) => { seen.push(i); return Promise.resolve(); });
    expect(seen).toEqual([0, 1, 2]);
  });

  test('empty input resolves to an empty array', async () => {
    expect(await mapWithConcurrency([], 3, () => Promise.resolve(1))).toEqual([]);
  });

  test('a limit at or above the item count runs them all at once', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency([1, 2, 3], 8, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
    });
    expect(peak).toBe(3);
  });

  test('rejects if a task rejects (Promise.all parity)', async () => {
    let err: unknown;
    try {
      await mapWithConcurrency([1, 2, 3], 2, (n) => (n === 2 ? Promise.reject(new Error('boom')) : Promise.resolve(n)));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('boom');
  });
});

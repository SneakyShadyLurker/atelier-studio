import { afterEach, describe, expect, test } from 'bun:test';
import {
  acquireLocalTiles,
  localTilesInFlight,
  releaseLocalTiles,
  resetConcurrencyForTests,
} from '../orchestrator/concurrency';

afterEach(() => {
  resetConcurrencyForTests();
});

describe('local pool semaphore', () => {
  test('global cap of 1 is enforced across all users', () => {
    expect(localTilesInFlight()).toBe(0);

    const first = acquireLocalTiles(1, 1);
    expect(first.ok).toBe(true);
    expect(localTilesInFlight()).toBe(1);

    // Second user trying to acquire while another is in flight — global, not
    // per-user, so user identity doesn't help.
    const second = acquireLocalTiles(1, 1);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('global');
    expect(localTilesInFlight()).toBe(1);
  });

  test('batch larger than cap is rejected atomically (no partial acquire)', () => {
    const before = localTilesInFlight();
    const res = acquireLocalTiles(4, 1);
    expect(res.ok).toBe(false);
    expect(localTilesInFlight()).toBe(before);
  });

  test('release frees a slot for the next acquire', () => {
    acquireLocalTiles(1, 1);
    expect(localTilesInFlight()).toBe(1);

    releaseLocalTiles('any-user', 1);
    expect(localTilesInFlight()).toBe(0);

    const after = acquireLocalTiles(1, 1);
    expect(after.ok).toBe(true);
  });

  test('release floors at zero on over-release', () => {
    releaseLocalTiles('any-user', 5);
    expect(localTilesInFlight()).toBe(0);
  });

  test('zero-count acquire is a no-op and always succeeds', () => {
    const res = acquireLocalTiles(0, 1);
    expect(res.ok).toBe(true);
    expect(localTilesInFlight()).toBe(0);
  });
});

import { afterEach, describe, expect, test } from 'bun:test';
import {
  acquireByokTiles,
  acquireTiles,
  byokTilesInFlight,
  createReservationReleaser,
  releaseByokTiles,
  releaseTiles,
  resetConcurrencyForTests,
  tilesInFlight,
} from './concurrency';

afterEach(() => {
  resetConcurrencyForTests();
});

describe('shared (CLIProxyAPI) counter', () => {
  test('blocks when global cap is reached', () => {
    expect(acquireTiles('alice', 4, 5, 4)).toEqual({ ok: true });
    expect(acquireTiles('bob', 1, 5, 4)).toEqual({ ok: true });
    expect(acquireTiles('carol', 1, 5, 4)).toEqual({ ok: false, reason: 'global' });
  });

  test('blocks when per-user cap is reached', () => {
    expect(acquireTiles('alice', 4, 5, 4)).toEqual({ ok: true });
    expect(acquireTiles('alice', 1, 5, 4)).toEqual({ ok: false, reason: 'per-user' });
  });

  test('release returns slots to the global counter', () => {
    acquireTiles('alice', 3, 5, 4);
    expect(tilesInFlight()).toBe(3);
    releaseTiles('alice', 3);
    expect(tilesInFlight()).toBe(0);
  });
});

describe('BYOK counter', () => {
  test('no global cap — two users can each saturate their own per-user cap', () => {
    expect(acquireByokTiles('alice', 8, 8)).toEqual({ ok: true });
    expect(acquireByokTiles('bob', 8, 8)).toEqual({ ok: true });
    expect(byokTilesInFlight('alice')).toBe(8);
    expect(byokTilesInFlight('bob')).toBe(8);
  });

  test('blocks when per-user cap is reached', () => {
    expect(acquireByokTiles('alice', 8, 8)).toEqual({ ok: true });
    expect(acquireByokTiles('alice', 1, 8)).toEqual({ ok: false, reason: 'per-user' });
  });

  test('release returns slots to the per-user counter', () => {
    acquireByokTiles('alice', 4, 8);
    expect(byokTilesInFlight('alice')).toBe(4);
    releaseByokTiles('alice', 4);
    expect(byokTilesInFlight('alice')).toBe(0);
  });

  test('over-release is floored at zero', () => {
    releaseByokTiles('alice', 5);
    expect(byokTilesInFlight('alice')).toBe(0);
  });
});

describe('counter independence', () => {
  test('BYOK acquires do not consume the CLIProxyAPI global counter', () => {
    expect(acquireByokTiles('alice', 8, 8)).toEqual({ ok: true });
    expect(tilesInFlight()).toBe(0);
    // Shared cap still has its full 5 slots even though Alice has 8 BYOK tiles
    // running in parallel.
    expect(acquireTiles('alice', 4, 5, 4)).toEqual({ ok: true });
    expect(tilesInFlight()).toBe(4);
  });

  test('CLIProxyAPI acquires do not consume the BYOK counter', () => {
    expect(acquireTiles('alice', 4, 5, 4)).toEqual({ ok: true });
    expect(byokTilesInFlight('alice')).toBe(0);
    // Per-user BYOK cap still has its full 8 slots even though Alice has 4
    // CLIProxyAPI tiles running.
    expect(acquireByokTiles('alice', 8, 8)).toEqual({ ok: true });
    expect(byokTilesInFlight('alice')).toBe(8);
  });
});

describe('createReservationReleaser', () => {
  test('releaseOne releases one slot per call and kicks, stopping at zero', () => {
    let released = 0;
    let kicks = 0;
    const r = createReservationReleaser(2, (n) => { released += n; }, () => { kicks += 1; });
    r.releaseOne();
    r.releaseOne();
    r.releaseOne(); // exhausted — no-op
    expect(released).toBe(2);
    expect(kicks).toBe(2);
  });

  test('releaseRemaining releases all held slots once then becomes a no-op', () => {
    let released = 0;
    let kicks = 0;
    const r = createReservationReleaser(3, (n) => { released += n; }, () => { kicks += 1; });
    r.releaseRemaining();
    r.releaseRemaining(); // already zero — no-op
    expect(released).toBe(3);
    expect(kicks).toBe(1);
  });

  test('releaseOne then releaseRemaining never over-releases past the reservation', () => {
    let released = 0;
    const r = createReservationReleaser(3, (n) => { released += n; }, () => undefined);
    r.releaseOne();        // 1, outstanding 2
    r.releaseRemaining();  // +2, outstanding 0
    r.releaseOne();        // no-op
    r.releaseRemaining();  // no-op
    expect(released).toBe(3);
  });
});

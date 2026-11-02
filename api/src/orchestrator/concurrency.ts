// Tile-level semaphores. Three independent counter sets, picked at the call
// site based on which upstream the request consumes.
//
// Shared (CLIProxyAPI / server-side key, e.g. gpt-image-2.5-sunburst):
//   - global cap (default 5). Server-wide ceiling on concurrent upstream
//     calls; protects shared rate limits and bounds physical resource usage.
//   - per-user cap (default 4). Bounded fairness so a single user who maxes
//     out their batch capacity always leaves at least `(global - per-user)`
//     slots free for everyone else.
//
// BYOK (user's own API key, e.g. Google Gemini):
//   - per-user cap only (default 8). No server-wide ceiling: each user spends
//     their own upstream quota, so one user's activity cannot starve another.
//
// Local (single-GPU ComfyUI host on the LAN):
//   - global cap (default 1). The GPU runs one prompt at a time, so we
//     serialize at the entry. No per-user component — every user shares the
//     same scarce hardware.
//
// SSOT: all three are instances of ONE `createCounterPool` mechanism. The
// all-or-nothing acquire, the global-vs-per-user atomic pair, and the
// defensive cap-at-zero floor (a double-release surfaces as a static-cap
// regression, not an unbounded leak) are implemented exactly once. Before
// this consolidation the invariant was hand-copied across six functions and
// could drift per pool with no structural guard.
//
// Acquire is atomic in the JS single-threaded model: the read-modify-write of
// a pool's counters happens with no awaits between them, so concurrent
// requests cannot observe stale state and double-spend the cap.
//
// In-memory by design; resets at boot. v1 ships single-process Bun, so the
// counts are authoritative — a multi-instance api would silently break every
// cap. v2 migration path: SQLite or Redis with atomic check-and-increment.

import type { Pool } from '@atelier/shared';
import { decUserFloored, incUser } from './userCounter';

export type AcquireResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'global' | 'per-user' };

interface CounterPool {
  // `maxTotal`/`maxPerUser` undefined ⇒ that dimension is uncapped for this
  // pool (byok has no global ceiling; local has no per-user component).
  acquire(userId: string, count: number, maxTotal: number | undefined, maxPerUser: number | undefined): AcquireResult;
  release(userId: string, count: number): void;
  total(): number;
  user(userId: string): number;
  reset(): void;
}

function createCounterPool(): CounterPool {
  let inFlightTotal = 0;
  const inFlightByUser = new Map<string, number>();
  return {
    acquire(userId, count, maxTotal, maxPerUser) {
      if (count <= 0) return { ok: true };
      if (maxTotal !== undefined && inFlightTotal + count > maxTotal) {
        return { ok: false, reason: 'global' };
      }
      const userCount = inFlightByUser.get(userId) ?? 0;
      if (maxPerUser !== undefined && userCount + count > maxPerUser) {
        return { ok: false, reason: 'per-user' };
      }
      inFlightTotal += count;
      incUser(inFlightByUser, userId, count);
      return { ok: true };
    },
    release(userId, count) {
      if (count <= 0) return;
      inFlightTotal = Math.max(0, inFlightTotal - count);
      decUserFloored(inFlightByUser, userId, count);
    },
    total: () => inFlightTotal,
    user: (userId) => inFlightByUser.get(userId) ?? 0,
    reset() {
      inFlightTotal = 0;
      inFlightByUser.clear();
    },
  };
}

const sharedPool = createCounterPool();
const byokPool = createCounterPool();
const localPool = createCounterPool();
// Local has no per-user dimension; a single constant key carries the global
// count through the same mechanism (releaseLocalTiles ignores its userId).
const LOCAL_KEY = '';

export function acquireTiles(
  userId: string,
  count: number,
  maxTotal: number,
  maxPerUser: number,
): AcquireResult {
  return sharedPool.acquire(userId, count, maxTotal, maxPerUser);
}

export function releaseTiles(userId: string, count: number): void {
  sharedPool.release(userId, count);
}

export function acquireByokTiles(
  userId: string,
  count: number,
  maxPerUser: number,
): AcquireResult {
  return byokPool.acquire(userId, count, undefined, maxPerUser);
}

export function releaseByokTiles(userId: string, count: number): void {
  byokPool.release(userId, count);
}

export function acquireLocalTiles(count: number, maxGlobal: number): AcquireResult {
  return localPool.acquire(LOCAL_KEY, count, maxGlobal, undefined);
}

export function releaseLocalTiles(_userId: string, count: number): void {
  // userId param kept so the release callsite can stay a uniform
  // `(userId, count) => void` signature across all three pools.
  localPool.release(LOCAL_KEY, count);
}

export function tilesInFlight(): number {
  return sharedPool.total();
}

export function byokTilesInFlight(userId: string): number {
  return byokPool.user(userId);
}

export function localTilesInFlight(): number {
  return localPool.total();
}

export function resetConcurrencyForTests(): void {
  sharedPool.reset();
  byokPool.reset();
  localPool.reset();
}

// Structural caps descriptor — `globalCap` is null for the byok pool (per-user
// only). Passed in by the caller (which reads config) so this module stays free
// of config/registry deps.
export interface TileCaps {
  readonly globalCap: number | null;
  readonly perUserCap: number;
}

// Single owner of the pool -> semaphore dispatch. The per-pool arity (byok =
// per-user only; local = global only; shared = both) lived in two parallel
// switch ladders in the generate route; keeping it here means adding a pool is
// a one-file change.
export function acquireForPool(pool: Pool, userId: string, count: number, caps: TileCaps): AcquireResult {
  switch (pool) {
    case 'byok':
      return acquireByokTiles(userId, count, caps.perUserCap);
    case 'local':
      if (caps.globalCap === null) throw new Error('local pool requires a global cap');
      return acquireLocalTiles(count, caps.globalCap);
    case 'shared':
      if (caps.globalCap === null) throw new Error('shared pool requires a global cap');
      return acquireTiles(userId, count, caps.globalCap, caps.perUserCap);
    default: {
      const _exhaustive: never = pool;
      throw new Error(`unknown pool: ${String(_exhaustive)}`);
    }
  }
}

export function releaseForPool(pool: Pool, userId: string, count: number): void {
  switch (pool) {
    case 'byok':
      releaseByokTiles(userId, count);
      break;
    case 'local':
      releaseLocalTiles(userId, count);
      break;
    case 'shared':
      releaseTiles(userId, count);
      break;
    default: {
      const _exhaustive: never = pool;
      throw new Error(`unknown pool: ${String(_exhaustive)}`);
    }
  }
}

export interface ReservationReleaser {
  // Release exactly one reserved slot (per-tile settle). No-op once exhausted.
  readonly releaseOne: () => void;
  // Release every still-held slot at once (sync setup failure / teardown).
  readonly releaseRemaining: () => void;
}

// Owns the `outstanding`-guarded slot-release accounting for one batch
// reservation. Both generate.ts call sites (queued-entry start + inline POST)
// reserved `initialOutstanding` slots up front; releaseOne/releaseRemaining are
// the only legal ways to give them back, and the guard makes every release
// idempotent so a double-settle or a settle-after-teardown cannot over-release
// (the slot-leak class the duplicated copies risked drifting into).
export function createReservationReleaser(
  initialOutstanding: number,
  releaseSlots: (count: number) => void,
  kick: () => void,
): ReservationReleaser {
  let outstanding = initialOutstanding;
  return {
    releaseOne: () => {
      if (outstanding > 0) {
        outstanding -= 1;
        releaseSlots(1);
        kick();
      }
    },
    releaseRemaining: () => {
      if (outstanding > 0) {
        releaseSlots(outstanding);
        outstanding = 0;
        kick();
      }
    },
  };
}

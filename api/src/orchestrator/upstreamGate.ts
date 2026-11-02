// Per-pool dequeue gate. When the circuit breaker for a pool is open
// (upstream confirmed down), the gate pauses dequeuing instead of draining
// the backlog into fast-fails.
//
// consumePause(pool) — the dequeue gate. Returns 'run' when the pool is
//   healthy OR when a probe token is available (one-shot, set by the probe
//   timer). Returns 'pause' otherwise.
//
// isPaused(pool) — non-consuming predicate for admission gating. Does NOT
//   touch the probe token.
//
// noteBreakerState(pool, state) — called by the circuit-breaker decorator
//   after each policy execute. 'open' activates the gate; 'closed' clears it
//   and kicks the dequeue loop; 'half-open' is treated as still open.
//
// The probe timer self-reschedules while open. On ceiling (now - openedAt >=
// maxPauseMs) it fails the queued backlog instead of issuing a probe token,
// then clears the gate.
//
// In-memory by design; resets at boot. Timers are injectable for tests.

import type { Pool } from '@atelier/shared';

export interface UpstreamGateWiring {
  kickPool(pool: Pool): void;
  failQueued(pool: Pool, reason: 'service unavailable'): void;
  halfOpenAfterMs: number;
  maxPauseMs: number;
  threshold: number;
}

interface Timers {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

const realTimers: Timers = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => { clearTimeout(h as ReturnType<typeof setTimeout>); },
};

interface PoolState {
  open: boolean;
  openedAt: number;
  probeToken: boolean;
  probeHandle: unknown;
}

let timers: Timers = realTimers;
let wiring: UpstreamGateWiring | null = null;
const states = new Map<Pool, PoolState>();

export function configureUpstreamGate(w: UpstreamGateWiring): void {
  wiring = w;
  // Backfill: if a circuit breaker opened before wiring was installed (boot
  // race — kickQueues fired before configureUpstreamGate), schedule probes for
  // any pool that is already open but has no live probe timer.
  for (const [pool, s] of states) {
    if (s.open && s.probeHandle === null) scheduleProbe(pool);
  }
}

export function setUpstreamGateTimersForTests(t: Timers): void {
  timers = t;
}

function stateFor(pool: Pool): PoolState {
  let s = states.get(pool);
  if (!s) {
    s = { open: false, openedAt: 0, probeToken: false, probeHandle: null };
    states.set(pool, s);
  }
  return s;
}

function clearOpen(pool: Pool): void {
  const s = stateFor(pool);
  s.open = false;
  s.openedAt = 0;
  s.probeToken = false;
  if (s.probeHandle !== null) {
    timers.clearTimer(s.probeHandle);
    s.probeHandle = null;
  }
}

function scheduleProbe(pool: Pool): void {
  const s = stateFor(pool);
  if (s.probeHandle !== null || !wiring) return;
  const w = wiring;
  s.probeHandle = timers.setTimer(() => {
    s.probeHandle = null;
    if (!s.open) return;
    if (timers.now() - s.openedAt >= w.maxPauseMs) {
      clearOpen(pool);
      w.failQueued(pool, 'service unavailable');
      return;
    }
    s.probeToken = true;
    w.kickPool(pool);
    scheduleProbe(pool);
  }, w.halfOpenAfterMs);
}

export function noteBreakerState(pool: Pool, state: 'open' | 'half-open' | 'closed'): void {
  const s = stateFor(pool);
  if (state === 'closed') {
    if (s.open) {
      clearOpen(pool);
      wiring?.kickPool(pool);
    }
    return;
  }
  if (state === 'open') {
    if (!s.open) {
      s.open = true;
      s.openedAt = timers.now();
      scheduleProbe(pool);
    }
  }
  // 'half-open' -> treat as still open; no change
}

export function consumePause(pool: Pool): 'run' | 'pause' {
  const s = stateFor(pool);
  if (!s.open) return 'run';
  if (s.probeToken) {
    s.probeToken = false;
    return 'run';
  }
  return 'pause';
}

export function isPaused(pool: Pool): boolean {
  return stateFor(pool).open;
}

export function resetUpstreamGateForTests(): void {
  for (const pool of [...states.keys()]) clearOpen(pool);
  states.clear();
  timers = realTimers;
  wiring = null;
}

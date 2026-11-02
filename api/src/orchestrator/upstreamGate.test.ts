import { afterEach, describe, expect, test } from 'bun:test';
import {
  configureUpstreamGate, consumePause, isPaused, noteBreakerState,
  resetUpstreamGateForTests, setUpstreamGateTimersForTests,
} from './upstreamGate';

function fakeTimers() {
  const pending = new Map<number, { at: number; fn: () => void }>();
  let id = 0;
  let now = 0;
  setUpstreamGateTimersForTests({
    now: () => now,
    setTimer: (fn, ms) => { const t = ++id; pending.set(t, { at: now + ms, fn }); return t; },
    clearTimer: (t) => { pending.delete(t as number); },
  });
  return {
    advance(ms: number) {
      now += ms;
      for (const [t, e] of [...pending]) { if (e.at <= now) { pending.delete(t); e.fn(); } }
    },
  };
}

afterEach(() => { resetUpstreamGateForTests(); });

describe('UpstreamGate', () => {
  test('closed pool always runs', () => {
    expect(consumePause('shared')).toBe('run');
    expect(isPaused('shared')).toBe(false);
  });

  test('open pauses; probe token lets exactly one through', () => {
    const kicks: string[] = [];
    configureUpstreamGate({ kickPool: (p) => { kicks.push(p); }, failQueued: (_p, _r) => { /* probe tests don't fail */ }, halfOpenAfterMs: 1000, maxPauseMs: 60_000, threshold: 5 });
    const timers = fakeTimers();
    noteBreakerState('shared', 'open');
    expect(isPaused('shared')).toBe(true);
    expect(consumePause('shared')).toBe('pause');
    timers.advance(1000);
    expect(kicks).toEqual(['shared']);
    expect(consumePause('shared')).toBe('run');
    expect(consumePause('shared')).toBe('pause');
  });

  test('closed clears pause and kicks', () => {
    const kicks: string[] = [];
    configureUpstreamGate({ kickPool: (p) => { kicks.push(p); }, failQueued: (_p, _r) => { /* ceiling test covers this */ }, halfOpenAfterMs: 1000, maxPauseMs: 60_000, threshold: 5 });
    fakeTimers();
    noteBreakerState('shared', 'open');
    noteBreakerState('shared', 'closed');
    expect(isPaused('shared')).toBe(false);
    expect(consumePause('shared')).toBe('run');
    expect(kicks).toEqual(['shared']);
  });

  test('ceiling fails queued after maxPause', () => {
    const failed: [string, string][] = [];
    configureUpstreamGate({ kickPool: (_p) => { /* not exercised here */ }, failQueued: (p, r) => { failed.push([p, r]); }, halfOpenAfterMs: 1000, maxPauseMs: 5000, threshold: 5 });
    const timers = fakeTimers();
    noteBreakerState('shared', 'open');
    timers.advance(1000);
    timers.advance(1000);
    timers.advance(1000);
    timers.advance(1000);
    timers.advance(1000); // now=5000 >= ceiling
    expect(failed).toEqual([['shared', 'service unavailable']]);
    expect(isPaused('shared')).toBe(false);
  });

  test('breaker open before wiring still recovers once configured (backfill)', () => {
    const kicks: string[] = [];
    const timers = fakeTimers();           // sets the timer seam first
    noteBreakerState('shared', 'open');    // wiring is null here -> no probe scheduled yet
    expect(isPaused('shared')).toBe(true);
    configureUpstreamGate({ kickPool: (p) => { kicks.push(p); }, failQueued: (_p, _r) => { /* ceiling not reached in this test */ }, halfOpenAfterMs: 1000, maxPauseMs: 60_000, threshold: 5 });
    timers.advance(1000);                   // backfilled probe timer fires
    expect(kicks).toEqual(['shared']);
  });

  test('repeated open while already open does not double-schedule', () => {
    const kicks: string[] = [];
    configureUpstreamGate({ kickPool: (p) => { kicks.push(p); }, failQueued: (_p, _r) => { /* not exercised here */ }, halfOpenAfterMs: 1000, maxPauseMs: 60_000, threshold: 5 });
    const timers = fakeTimers();
    noteBreakerState('shared', 'open');
    noteBreakerState('shared', 'open'); // decorator reports open again
    timers.advance(1000);
    expect(kicks).toEqual(['shared']); // exactly one probe kick, not two
  });
});

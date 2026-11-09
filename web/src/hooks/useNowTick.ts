import { useSyncExternalStore } from 'react';

const DEFAULT_TICK_MS = 1_000;

interface TickStore {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => number;
}

interface MutableTickStore extends TickStore {
  now: number;
  intervalId: number | null;
  readonly listeners: Set<() => void>;
}

const stores = new Map<number, MutableTickStore>();

function emit(store: MutableTickStore): void {
  store.now = Date.now();
  for (const listener of store.listeners) listener();
}

// Clocks only run while the page is visible: a hidden tab has nothing to
// repaint, so its readouts wait and catch up with one emit when it is shown.
function pageHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

function startTicking(store: MutableTickStore, intervalMs: number): void {
  if (store.intervalId !== null || store.listeners.size === 0 || pageHidden()) return;
  store.intervalId = window.setInterval(() => { emit(store); }, intervalMs);
}

function stopTicking(store: MutableTickStore): void {
  if (store.intervalId === null) return;
  window.clearInterval(store.intervalId);
  store.intervalId = null;
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    for (const [intervalMs, store] of stores) {
      if (pageHidden()) stopTicking(store);
      else if (store.listeners.size > 0) {
        emit(store);
        startTicking(store, intervalMs);
      }
    }
  });
}

function createStore(intervalMs: number): MutableTickStore {
  const store: MutableTickStore = {
    now: Date.now(),
    intervalId: null,
    listeners: new Set<() => void>(),
    subscribe(listener) {
      store.listeners.add(listener);
      const freshNow = Date.now();
      if (freshNow !== store.now) {
        store.now = freshNow;
        listener();
      }
      startTicking(store, intervalMs);
      return () => {
        store.listeners.delete(listener);
        // Stop the timer when idle, but keep the store in the map. Deleting it
        // would let a component that captured this store at render time (before
        // its subscribe effect commits) resubscribe to an orphaned store while a
        // fresh store is created for the same cadence — leaking duplicate
        // intervals. Only a fixed handful of cadences exist, so retaining them
        // is bounded.
        if (store.listeners.size === 0) stopTicking(store);
      };
    },
    getSnapshot() {
      return store.now;
    }
  };
  return store;
}

function getStore(intervalMs: number): TickStore {
  const existing = stores.get(intervalMs);
  if (existing) return existing;
  const store = createStore(intervalMs);
  stores.set(intervalMs, store);
  return store;
}

export function useNowTick(intervalMs = DEFAULT_TICK_MS): number {
  const store = getStore(intervalMs);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

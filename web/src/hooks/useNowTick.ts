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
      store.intervalId ??= window.setInterval(() => { emit(store); }, intervalMs);
      return () => {
        store.listeners.delete(listener);
        if (store.listeners.size === 0 && store.intervalId !== null) {
          // Stop the timer when idle, but keep the store in the map. Deleting it
          // would let a component that captured this store at render time (before
          // its subscribe effect commits) resubscribe to an orphaned store while a
          // fresh store is created for the same cadence — leaking duplicate
          // intervals. Only a fixed handful of cadences exist, so retaining them
          // is bounded.
          window.clearInterval(store.intervalId);
          store.intervalId = null;
        }
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

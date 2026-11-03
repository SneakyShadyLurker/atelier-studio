import { useSyncExternalStore } from 'react';

export const SEEN_BATCHES_STORAGE_KEY = 'atelier.seenBatches.v1';

export const SEEN_BATCHES_MAX_ENTRIES = 500;
const FLUSH_DEBOUNCE_MS = 250;

interface StoredSeen {
  ids: string[];
}

function isStoredSeen(value: unknown): value is StoredSeen {
  return (
    typeof value === 'object'
    && value !== null
    && Array.isArray((value as { ids?: unknown }).ids)
    && (value as { ids: unknown[] }).ids.every((id) => typeof id === 'string')
  );
}

export function loadSeenBatches(): Set<string> {
  try {
    const raw = sessionStorage.getItem(SEEN_BATCHES_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!isStoredSeen(parsed)) return new Set();
    return new Set(parsed.ids);
  } catch {
    return new Set();
  }
}

// Trailing-edge debounce: SessionStorage writes are synchronous on the main
// thread and the JSON serialise of a 500-entry UUID array is ~40 KB. During
// quick scroll-through the store is marked many times in a single frame;
// only the final state needs to land. flushSeenBatches() is wired to
// pagehide/beforeunload so the set survives navigation.
let pendingFlush: ReturnType<typeof setTimeout> | null = null;
let pendingSet: ReadonlySet<string> | null = null;

function scheduleFlush(set: ReadonlySet<string>): void {
  pendingSet = set;
  if (pendingFlush !== null) return;
  pendingFlush = setTimeout(() => {
    pendingFlush = null;
    const target = pendingSet;
    pendingSet = null;
    if (target) persistSeenBatchesNow(target);
  }, FLUSH_DEBOUNCE_MS);
}

export function flushSeenBatches(): void {
  if (pendingFlush !== null) {
    clearTimeout(pendingFlush);
    pendingFlush = null;
  }
  const target = pendingSet;
  pendingSet = null;
  if (target) persistSeenBatchesNow(target);
}

if (typeof window !== 'undefined') {
  // pagehide is the canonical "going away" signal; beforeunload is the
  // belt-and-braces for browsers that fire it but not pagehide.
  window.addEventListener('pagehide', flushSeenBatches);
  window.addEventListener('beforeunload', flushSeenBatches);
}

// One module store over the hydrated set, shared by every feed that gates
// entrances on it (Canvas, Sidebar rail). Snapshots are immutable: a mark that
// adds an id swaps in a new Set and notifies, so `useSyncExternalStore` reads
// stay pure. Callers mark from effects only (StrictMode), and capture a row's
// eligibility once at mount so a later mark never cancels a playing entrance.
let snapshot: ReadonlySet<string> | null = null;
const listeners = new Set<() => void>();

export function getSeenBatches(): ReadonlySet<string> {
  snapshot ??= loadSeenBatches();
  return snapshot;
}

export function subscribeSeenBatches(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useSeenBatches(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeSeenBatches, getSeenBatches, getSeenBatches);
}

export function markBatchesSeen(ids: Iterable<string>): void {
  const current = getSeenBatches();
  let next: Set<string> | null = null;
  for (const id of ids) {
    if ((next ?? current).has(id)) continue;
    next ??= new Set(current);
    next.add(id);
  }
  if (next === null) return;
  if (next.size > SEEN_BATCHES_MAX_ENTRIES) {
    // Insertion order is FIFO: drop the oldest ids first.
    const iter = next.values();
    const toDelete = next.size - SEEN_BATCHES_MAX_ENTRIES;
    for (let i = 0; i < toDelete; i += 1) {
      const oldest = iter.next();
      if (oldest.done) break;
      next.delete(oldest.value);
    }
  }
  snapshot = next;
  scheduleFlush(next);
  for (const listener of [...listeners]) listener();
}

export function markBatchSeen(id: string): void {
  markBatchesSeen([id]);
}

/** Drops the in-memory snapshot; the next read hydrates from sessionStorage again. */
export function resetSeenBatches(): void {
  snapshot = null;
}

function persistSeenBatchesNow(set: ReadonlySet<string>): void {
  try {
    sessionStorage.setItem(SEEN_BATCHES_STORAGE_KEY, JSON.stringify({ ids: Array.from(set) }));
  } catch {
    // sessionStorage can be unavailable or full; seen flags are best-effort.
  }
}

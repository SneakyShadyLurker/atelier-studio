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

// Throttle with the trailing value: SessionStorage writes are synchronous on
// the main thread and the JSON serialise of a 500-entry UUID array is ~40 KB.
// During quick scroll-through the store is marked many times in a single
// frame; one write per window, of the newest set, is enough. The pending
// timer is deliberately not reset by later marks, so a steady stream of marks
// cannot postpone the write indefinitely. flushSeenBatches() runs on pagehide
// and when the page is hidden so the set survives navigation.
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
  // pagehide is the canonical "going away" signal; a hidden visibility state
  // is the last reliable moment on mobile, where pagehide may never fire.
  window.addEventListener('pagehide', flushSeenBatches);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSeenBatches();
  });
}

// One module store, hydrated once from sessionStorage, with a view per feed.
// A batch is "seen" by a surface once that surface has rendered it (or it
// was persisted by an earlier page load), so a row's entrance plays once per
// surface and never on a virtual remount or a reload. The views are separate
// on purpose: the rail renders live rows and marks a new batch in its urgent
// commit, while the Canvas renders its deferred snapshot a commit later, so a
// shared set made every new batch "seen" before the Canvas row ever mounted
// and its entrance never played. Snapshots are immutable: a mark that adds an
// id swaps in a new Set and notifies that surface's subscribers, so
// `useSyncExternalStore` reads stay pure. Callers mark from effects only
// (StrictMode), and capture a row's eligibility once at mount so a later mark
// never cancels a playing entrance. Marking is LRU: an id that is rendered
// again moves to the young end, so the cap evicts batches the reader left
// behind, never ones still on screen. The persisted set is the union.
export type SeenSurface = 'canvas' | 'rail';

let baseline: ReadonlySet<string> | null = null;
let snapshot: ReadonlySet<string> | null = null;
const surfaceSnapshots = new Map<SeenSurface, ReadonlySet<string>>();
const surfaceListeners = new Map<SeenSurface, Set<() => void>>();

function hydratedBaseline(): ReadonlySet<string> {
  baseline ??= loadSeenBatches();
  return baseline;
}

/** The persisted union across surfaces. */
export function getSeenBatches(): ReadonlySet<string> {
  snapshot ??= hydratedBaseline();
  return snapshot;
}

function surfaceSet(surface: SeenSurface): ReadonlySet<string> {
  let set = surfaceSnapshots.get(surface);
  if (!set) {
    set = new Set(hydratedBaseline());
    surfaceSnapshots.set(surface, set);
  }
  return set;
}

function listenersFor(surface: SeenSurface): Set<() => void> {
  let set = surfaceListeners.get(surface);
  if (!set) {
    set = new Set();
    surfaceListeners.set(surface, set);
  }
  return set;
}

export function subscribeSeenBatches(listener: () => void, surface: SeenSurface = 'canvas'): () => void {
  const set = listenersFor(surface);
  set.add(listener);
  return () => { set.delete(listener); };
}

const surfaceStores = new Map<SeenSurface, { subscribe: (listener: () => void) => () => void; read: () => ReadonlySet<string> }>();

function storeFor(surface: SeenSurface) {
  let store = surfaceStores.get(surface);
  if (!store) {
    store = { subscribe: (listener) => subscribeSeenBatches(listener, surface), read: () => surfaceSet(surface) };
    surfaceStores.set(surface, store);
  }
  return store;
}

/** The ids this surface has rendered (plus the persisted set). */
export function useSeenBatches(surface: SeenSurface = 'canvas'): ReadonlySet<string> {
  const store = storeFor(surface);
  return useSyncExternalStore(store.subscribe, store.read, store.read);
}

/** Adds `ids` to `current` at the young end; null when nothing moved. */
function withMarked(current: ReadonlySet<string>, ids: readonly string[]): { next: Set<string>; grew: boolean } | null {
  let next: Set<string> | null = null;
  let grew = false;
  // The youngest id; an id that is already youngest needs no move.
  let last: string | undefined;
  for (const id of ids) {
    const target = next ?? current;
    if (target.has(id)) {
      last ??= lastOf(target);
      if (id === last) continue;
      // Already seen: move to the young end (a Set keeps insertion order).
      next ??= new Set(current);
      next.delete(id);
      next.add(id);
    } else {
      next ??= new Set(current);
      next.add(id);
      grew = true;
    }
    last = id;
  }
  if (next === null) return null;
  if (next.size > SEEN_BATCHES_MAX_ENTRIES) {
    // Insertion order is oldest first: drop from the old end.
    const iter = next.values();
    const toDelete = next.size - SEEN_BATCHES_MAX_ENTRIES;
    for (let i = 0; i < toDelete; i += 1) {
      const oldest = iter.next();
      if (oldest.done) break;
      next.delete(oldest.value);
    }
  }
  return { next, grew };
}

export function markBatchesSeen(ids: Iterable<string>, surface: SeenSurface = 'canvas'): void {
  const list = [...ids];
  const union = withMarked(getSeenBatches(), list);
  if (union) {
    snapshot = union.next;
    scheduleFlush(union.next);
  }
  const own = withMarked(surfaceSet(surface), list);
  if (!own) return;
  surfaceSnapshots.set(surface, own.next);
  // Reordering alone changes no membership, and subscribers read membership only.
  if (own.grew) for (const listener of [...listenersFor(surface)]) listener();
}

function lastOf(set: ReadonlySet<string>): string | undefined {
  let last: string | undefined;
  for (const id of set) last = id;
  return last;
}

export function markBatchSeen(id: string, surface: SeenSurface = 'canvas'): void {
  markBatchesSeen([id], surface);
}

/** Drops the in-memory snapshots; the next read hydrates from sessionStorage again. */
export function resetSeenBatches(): void {
  baseline = null;
  snapshot = null;
  surfaceSnapshots.clear();
}

function persistSeenBatchesNow(set: ReadonlySet<string>): void {
  try {
    sessionStorage.setItem(SEEN_BATCHES_STORAGE_KEY, JSON.stringify({ ids: Array.from(set) }));
  } catch {
    // sessionStorage can be unavailable or full; seen flags are best-effort.
  }
}

export const SEEN_BATCHES_STORAGE_KEY = 'atelier.seenBatches.v1';

const MAX_ENTRIES = 500;
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
// quick scroll-through the same Set is mutated many times in a single frame;
// only the final state needs to land. flushSeenBatches() is wired to
// pagehide/beforeunload so the set survives navigation.
let pendingFlush: ReturnType<typeof setTimeout> | null = null;
let pendingSet: Set<string> | null = null;

function scheduleFlush(set: Set<string>): void {
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

export function markBatchSeen(set: Set<string>, id: string): void {
  if (set.has(id)) return;
  set.add(id);
  if (set.size > MAX_ENTRIES) {
    const iter = set.values();
    const toDelete = set.size - MAX_ENTRIES;
    for (let i = 0; i < toDelete; i += 1) {
      const next = iter.next();
      if (next.done) break;
      set.delete(next.value);
    }
  }
  scheduleFlush(set);
}

function persistSeenBatchesNow(set: Set<string>): void {
  try {
    sessionStorage.setItem(SEEN_BATCHES_STORAGE_KEY, JSON.stringify({ ids: Array.from(set) }));
  } catch {
    // sessionStorage can be unavailable or full; seen flags are best-effort.
  }
}

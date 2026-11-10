/*
 * Session media cache. Authenticated media answers `Cache-Control: private,
 * no-store` on purpose (account isolation, api/src/routes/_artifact-response.ts),
 * so the browser downloads a thumbnail again every time the virtualized feed
 * remounts its tile. This cache keeps each downloaded thumbnail as an object
 * URL in page memory for the life of the page: feed tiles, clip posters, the
 * Lightbox placeholder and the sidebar share one copy, and a remount repaints
 * from memory. Nothing is persisted and request headers are unchanged; an
 * account switch is a full navigation (sessionScope.ts), which drops it all.
 *
 * Rules (feed-polish R8):
 * - one fetch per URL; concurrent consumers share it (refcounted retain);
 * - a byte-capped LRU over every retained entry, evicting unreferenced entries
 *   oldest first; an entry in use is never evicted and is admitted even over
 *   the cap (what is mounted bounds that total);
 * - an entry above a quarter of the cap is dropped on its last release;
 * - object URLs are revoked on eviction;
 * - a transient failure (503, network error) retries twice, a 503 after its
 *   Retry-After (capped), before the consumer sees `error`;
 * - the fetch is aborted when its last consumer leaves;
 * - `data:` and `blob:` URLs bypass the cache (they are already in memory).
 *
 * A release is applied after the current task: React runs an effect's cleanup
 * and its next setup back to back (StrictMode, a dependency change), and that
 * pair must not abort and restart the download.
 */

export type MediaStatus = 'loading' | 'ready' | 'error';

/** Stable per state change, so it can back `useSyncExternalStore`. */
export interface MediaSnapshot {
  status: MediaStatus;
  /** The object URL once `status` is `ready`. */
  src: string | undefined;
}

export interface RetainOptions {
  priority?: RequestPriority | undefined;
}

interface Entry {
  url: string;
  snapshot: MediaSnapshot;
  bytes: number;
  refs: number;
  attempts: number;
  priority: RequestPriority;
  controller: AbortController | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
}

const MB = 1024 * 1024;
const MAX_RETRIES = 2;
const DEFAULT_MAX_RETRY_AFTER_MS = 5000;
const DEFAULT_BACKOFF_MS = 400;

function defaultCapBytes(): number {
  const memory = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return memory !== undefined && memory <= 4 ? 64 * MB : 192 * MB;
}

let capBytes = defaultCapBytes();
let backoffMs = DEFAULT_BACKOFF_MS;
let maxRetryAfterMs = DEFAULT_MAX_RETRY_AFTER_MS;
let totalBytes = 0;
// Insertion order is recency: a touch re-inserts the entry at the end.
const entries = new Map<string, Entry>();
// Listeners outlive entries: a consumer subscribes before it retains, and an
// evicted URL that comes back must still reach the same subscribers.
const listeners = new Map<string, Set<() => void>>();

const LOADING: MediaSnapshot = Object.freeze({ status: 'loading', src: undefined });
const ERROR: MediaSnapshot = Object.freeze({ status: 'error', src: undefined });

export function isMediaCacheable(url: string): boolean {
  return !url.startsWith('data:') && !url.startsWith('blob:');
}

function listenersOf(url: string): Set<() => void> {
  let set = listeners.get(url);
  if (!set) {
    set = new Set();
    listeners.set(url, set);
  }
  return set;
}

function notify(url: string): void {
  for (const listener of [...(listeners.get(url) ?? [])]) listener();
}

function setSnapshot(entry: Entry, snapshot: MediaSnapshot): void {
  entry.snapshot = snapshot;
  notify(entry.url);
}

function touch(entry: Entry): void {
  entries.delete(entry.url);
  entries.set(entry.url, entry);
}

function drop(entry: Entry): void {
  if (entries.get(entry.url) !== entry) return;
  entries.delete(entry.url);
  entry.controller?.abort();
  entry.controller = null;
  if (entry.retryTimer !== null) clearTimeout(entry.retryTimer);
  entry.retryTimer = null;
  if (entry.snapshot.status === 'ready' && entry.snapshot.src) URL.revokeObjectURL(entry.snapshot.src);
  totalBytes -= entry.bytes;
  entry.bytes = 0;
  notify(entry.url);
}

function evict(): void {
  if (totalBytes <= capBytes) return;
  for (const entry of [...entries.values()]) {
    if (totalBytes <= capBytes) return;
    if (entry.refs > 0) continue;
    drop(entry);
  }
}

function retryAfterMs(response: Response): number {
  const header = response.headers.get('Retry-After');
  if (header === null) return backoffMs;
  const seconds = Number(header);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  return Math.min(Math.max(Number.isFinite(delay) ? delay : backoffMs, 0), maxRetryAfterMs);
}

function scheduleRetry(entry: Entry, delay: number): void {
  if (entry.attempts > MAX_RETRIES) {
    entry.controller = null;
    setSnapshot(entry, ERROR);
    return;
  }
  entry.retryTimer = setTimeout(() => {
    entry.retryTimer = null;
    if (entries.get(entry.url) === entry) start(entry);
  }, delay);
}

function start(entry: Entry): void {
  const controller = new AbortController();
  entry.controller = controller;
  entry.attempts += 1;
  const signal = controller.signal;
  const current = () => !signal.aborted && entries.get(entry.url) === entry && entry.controller === controller;
  let request: Promise<Response>;
  try {
    // Whatever `fetch` hands back (a stub may answer synchronously) or throws
    // settles through the same path below.
    request = Promise.resolve(fetch(entry.url, { credentials: 'same-origin', priority: entry.priority, signal }));
  } catch (error) {
    request = Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
  request
    .then(async (response) => {
      if (!current()) return;
      if (response.status === 503) {
        scheduleRetry(entry, retryAfterMs(response));
        return;
      }
      if (!response.ok) {
        entry.controller = null;
        setSnapshot(entry, ERROR);
        return;
      }
      const blob = await response.blob();
      if (!current()) return;
      entry.controller = null;
      entry.bytes = blob.size;
      totalBytes += blob.size;
      setSnapshot(entry, { status: 'ready', src: URL.createObjectURL(blob) });
      evict();
    })
    .catch(() => {
      // An abort is the last consumer leaving; anything else (a network
      // error, a body read cut short) is transient.
      if (!current()) return;
      scheduleRetry(entry, backoffMs * 2 ** (entry.attempts - 1));
    });
}

function settleRelease(entry: Entry): void {
  if (entry.refs > 0 || entries.get(entry.url) !== entry) return;
  if (entry.snapshot.status !== 'ready' || entry.bytes > capBytes / 4) drop(entry);
  else evict();
}

/** The cached state for `url`, or undefined when nothing is held for it. */
export function getMediaSnapshot(url: string): MediaSnapshot | undefined {
  const entry = entries.get(url);
  if (!entry) return undefined;
  // A read is a use: the entry a remount repaints from is the freshest.
  if (entry.snapshot.status === 'ready') touch(entry);
  return entry.snapshot;
}

export function subscribeMedia(url: string, listener: () => void): () => void {
  const set = listenersOf(url);
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0 && listeners.get(url) === set) listeners.delete(url);
  };
}

/**
 * Registers a consumer of `url` and starts its download when nothing is held
 * for it. Returns the release; call it once when the consumer goes away.
 */
export function retainMedia(url: string, options: RetainOptions = {}): () => void {
  if (!isMediaCacheable(url)) return () => undefined;
  let entry = entries.get(url);
  if (entry) {
    touch(entry);
    // A higher priority asked for while queued only helps the next attempt.
    if (options.priority === 'high') entry.priority = 'high';
  } else {
    entry = {
      url,
      snapshot: LOADING,
      bytes: 0,
      refs: 0,
      attempts: 0,
      priority: options.priority ?? 'auto',
      controller: null,
      retryTimer: null,
    };
    entries.set(url, entry);
    start(entry);
    notify(url);
  }
  entry.refs += 1;
  const held = entry;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.refs -= 1;
    if (held.refs === 0) queueMicrotask(() => { settleRelease(held); });
  };
}

/** Starts a fresh attempt for an errored entry that still has consumers. */
export function retryMedia(url: string): void {
  const entry = entries.get(url);
  if (entry?.snapshot.status !== 'error') return;
  entry.attempts = 0;
  setSnapshot(entry, LOADING);
  start(entry);
}

/** Bytes held by every retained entry (ready entries only carry bytes). */
export function mediaCacheBytes(): number {
  return totalBytes;
}

export function resetMediaCacheForTests(options: { capBytes?: number; backoffMs?: number; maxRetryAfterMs?: number } = {}): void {
  for (const entry of [...entries.values()]) drop(entry);
  entries.clear();
  listeners.clear();
  totalBytes = 0;
  capBytes = options.capBytes ?? defaultCapBytes();
  backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  maxRetryAfterMs = options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
}

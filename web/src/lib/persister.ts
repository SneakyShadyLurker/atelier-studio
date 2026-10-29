import type { Batch, Tile } from '@atelier/shared';
import type { Query } from '@tanstack/react-query';
import type { PersistedClient, Persister } from '@tanstack/react-query-persist-client';
import { del, get, keys, set } from 'idb-keyval';
import { isDefaultHistoryScopeKey } from '../api/history';
import { isRecord } from './guards';
import { ROLL_QUEUE_STORAGE_KEY_PREFIX, rollQueueStorageKey } from './rollQueuePersist';
import { isSessionLocked } from './sessionScope';

const IDB_KEY_PREFIX = 'atelier-rq-cache-v1';
const PERSIST_DEBOUNCE_MS = 1_000;

/**
 * Schema-version buster for the IndexedDB cache. Bump this whenever ANY
 * persisted query's response shape changes:
 *   - shared/src/index.ts wire types (Model, Batch, Tile, ArchivedTile,
 *     CollectionsResponse, HistoryPage<Batch>)
 *   - shouldDehydrateQuery's key-shape expectations (historyKeys,
 *     modelKeys, collectionKeys factory output)
 *
 * Forgetting to bump means clients hydrate stale-shape data into the
 * QueryClient for up to maxAge after a deploy. `isValidPersistedClient`
 * adds a structural backstop (drops blobs whose envelope is corrupt or
 * incompatible), but it only checks SHAPE, not field semantics — the
 * buster is still the contract for wire-type changes.
 *
 * NOT derived from package.json version (which is "0.0.0" and never bumps).
 * Decoupled on purpose.
 */
// v6: prompt-library data joined the persisted cache. Bumping keeps old IDB
// payloads aligned with the expanded persisted query-key set.
// v7: history query data now carries a client-only loadingTileCount tag for
// poll scheduling; old persisted payloads can hydrate without that tag.
// v9: history loading metadata now includes client-observed loading batch
// timestamps; old persisted pages need a server refresh for poll-cap semantics.
// v10: variable_options now carry a weight field; old persisted prompt-library
// payloads lack it and need a server refresh.
// v11: archived tiles now carry reference-image provenance in shared wire data.
// v12: batch-level prompt-library provenance is now persisted (was dropped on
// hydration, so the collection/provenance chip flickered until the refetch).
// v13: done/history/archive tiles may hydrate as video/mp4 media, not just images.
// v14: history batches carry video-sequence membership and master state.
// v15: durable video fields (durationFrames, i2vSourceUploadId) and story
// metadata survive persistence; earlier payloads dropped them, so a hydrated
// re-roll changed clip length or failed source validation.
// v16: discard media URLs issued before the authenticated-media cache revision,
// so history reloads URLs carrying the fixed media query key.
export const PERSIST_CACHE_VERSION = '16';

// Cap the persisted slice of the default Unsorted history scope. The live
// in-session cache keeps every fetched page (TanStack `maxPages` can't bound
// it — `historyCache.upsertNewBatch` optimistically prepends into pages[0]
// and head-eviction would corrupt pagination). We only ever
// drop the TAIL of the *persisted copy*, never the live cache: pages[0] (the
// upsertNewBatch target) and every kept page's `nextCursor` stay intact, so
// hydration resumes `fetchNextPage` from page N seamlessly. This bounds the
// IndexedDB blob for power users without touching any live path.
const MAX_PERSISTED_HISTORY_PAGES = 5;
// Durable batch fields only; transient queue state (queueLengthAhead) stays out.
// The one list: the persisted type, the key set and the projection derive from it.
const PERSISTED_HISTORY_BATCH_FIELDS = [
  'id',
  'prompt',
  'ratio',
  'modelId',
  'modelLabel',
  'createdAt',
  'collectionId',
  'pinned',
  'status',
  'tiles',
  'provenance',
  'sequenceId',
  'sequenceIndex',
  'sequence',
  'durationFrames',
  'i2vSourceUploadId',
  'story',
] as const satisfies readonly (keyof Batch)[];
type PersistedHistoryBatch = Pick<Batch, (typeof PERSISTED_HISTORY_BATCH_FIELDS)[number]>;
const PERSISTED_HISTORY_BATCH_KEYS: ReadonlySet<PropertyKey> = new Set(PERSISTED_HISTORY_BATCH_FIELDS);

const PERSISTED_HISTORY_PAGE_KEYS = new Set<PropertyKey>(['items', 'nextCursor']);

let persistTimer: ReturnType<typeof setTimeout> | undefined;
let latestClient: { key: string; client: PersistedClient } | undefined;
let activeIdbKey: string | undefined;

function scopedIdbKey(cacheScope: string): string {
  return `${IDB_KEY_PREFIX}:${cacheScope}`;
}

export async function preparePersistenceScope(cacheScope: string): Promise<void> {
  if (isSessionLocked()) return;
  clearPendingPersist();
  const currentKey = scopedIdbKey(cacheScope);
  const currentRollQueueKey = rollQueueStorageKey(cacheScope);
  activeIdbKey = currentKey;
  try {
    const storedKeys = await keys();
    if (isSessionLocked()) return;
    await Promise.all(storedKeys
      .filter((key): key is string => typeof key === 'string'
        && (key === IDB_KEY_PREFIX || (key.startsWith(`${IDB_KEY_PREFIX}:`) && key !== currentKey)))
      .map((key) => del(key)));
  } catch (error) {
    console.warn('Failed to prepare scoped QueryClient cache', error);
  }
  if (isSessionLocked()) return;
  try {
    for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
      const key = sessionStorage.key(index);
      if (
        key !== null
        && (key === ROLL_QUEUE_STORAGE_KEY_PREFIX
          || (key.startsWith(`${ROLL_QUEUE_STORAGE_KEY_PREFIX}:`) && key !== currentRollQueueKey))
      ) {
        sessionStorage.removeItem(key);
      }
    }
  } catch (error) {
    console.warn('Failed to prepare scoped roll queue', error);
  }
}

export async function removePersistedQueryClient(cacheScope?: string): Promise<void> {
  clearPendingPersist();
  try {
    const storedKeys = cacheScope === undefined ? await keys() : [scopedIdbKey(cacheScope)];
    await Promise.all(storedKeys
      .filter((key): key is string => typeof key === 'string'
        && (key === IDB_KEY_PREFIX || key.startsWith(`${IDB_KEY_PREFIX}:`)))
      .map((key) => del(key)));
  } catch (error) {
    console.warn('Failed to remove QueryClient cache', error);
  }
}

async function writeClient(key: string, client: PersistedClient): Promise<void> {
  if (isSessionLocked() || key !== activeIdbKey) return;
  try {
    await set(key, client);
  } catch (error) {
    console.warn('Failed to persist QueryClient cache', error);
  }
}

function clearPendingPersist(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = undefined;
  }
  latestClient = undefined;
}

async function flushLatestClient(): Promise<void> {
  const client = latestClient;
  latestClient = undefined;
  if (client) {
    await writeClient(client.key, client.client);
  }
}

export async function flushPersisterForTests(): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = undefined;
  }
  await flushLatestClient();
}

function boundPersistedHistory(client: PersistedClient): PersistedClient {
  const original = client.clientState.queries;
  const queries = original.map((entry) => {
    if (!isDefaultHistoryScopeKey(entry.queryKey)) return entry;
    const data = entry.state.data;
    if (!isRecord(data) || !Array.isArray(data.pages)) return entry;
    const boundedPages = data.pages.length > MAX_PERSISTED_HISTORY_PAGES
      ? data.pages.slice(0, MAX_PERSISTED_HISTORY_PAGES)
      : data.pages;
    const pages = scrubHistoryPagesForPersist(boundedPages);
    const pageParams = data.pages.length > MAX_PERSISTED_HISTORY_PAGES && Array.isArray(data.pageParams)
      ? data.pageParams.slice(0, MAX_PERSISTED_HISTORY_PAGES)
      : data.pageParams;
    if (pages === data.pages && pageParams === data.pageParams) return entry;
    return { ...entry, state: { ...entry.state, data: { ...data, pages, pageParams } } };
  });
  // Unchanged entries are returned by-reference, so a per-index identity
  // check tells us whether any page slice actually happened (avoids a
  // closure-mutated flag, which TS CFA can't narrow and eslint flags).
  if (queries.every((entry, i) => entry === original[i])) return client;
  return { ...client, clientState: { ...client.clientState, queries } };
}

function scrubHistoryPagesForPersist(pages: readonly unknown[]): readonly unknown[] {
  const scrubbed = pages.map((page) => scrubHistoryPageForPersist(page));
  const allSame = scrubbed.every((next, i) => Object.is(next, pages[i]));
  return allSame ? pages : scrubbed;
}

function scrubHistoryPageForPersist(page: unknown): unknown {
  if (!isRecord(page)) return page;
  const rawItems = page.items;
  const items = Array.isArray(rawItems) ? scrubHistoryBatchesForPersist(rawItems) : rawItems;
  const hasOnlyPersistedKeys = Object.keys(page).every((key) => PERSISTED_HISTORY_PAGE_KEYS.has(key));
  if (hasOnlyPersistedKeys && items === rawItems) return page;
  return { items, nextCursor: page.nextCursor };
}

function scrubHistoryBatchesForPersist(batches: readonly unknown[]): readonly unknown[] {
  const scrubbed = batches.map((batch) => scrubBatchForPersist(batch));
  const allSame = scrubbed.every((next, i) => Object.is(next, batches[i]));
  return allSame ? batches : scrubbed;
}

function scrubBatchForPersist(batch: unknown): unknown {
  if (!isRecord(batch)) return batch;
  const hasOnlyPersistedKeys = Object.keys(batch).every((key) => PERSISTED_HISTORY_BATCH_KEYS.has(key));
  if (hasOnlyPersistedKeys) return batch;
  if (!isBatchForPersist(batch)) return batch;
  return projectBatchForPersist(batch);
}

function projectBatchForPersist(batch: Batch): PersistedHistoryBatch {
  const projected: Partial<Record<keyof PersistedHistoryBatch, unknown>> = {};
  for (const key of PERSISTED_HISTORY_BATCH_FIELDS) {
    if (batch[key] !== undefined) projected[key] = batch[key];
  }
  // Every required field is present: isBatchForPersist checked them first.
  return projected as PersistedHistoryBatch;
}

function isBatchForPersist(batch: Record<PropertyKey, unknown>): batch is Batch & Record<PropertyKey, unknown> {
  return typeof batch.id === 'string'
    && typeof batch.prompt === 'string'
    && typeof batch.ratio === 'string'
    && typeof batch.modelId === 'string'
    && typeof batch.modelLabel === 'string'
    && typeof batch.createdAt === 'number'
    && (typeof batch.collectionId === 'string' || batch.collectionId === null)
    && typeof batch.pinned === 'boolean'
    && (batch.status === 'queued' || batch.status === 'running' || batch.status === 'done')
    && (batch.queueLengthAhead === undefined || typeof batch.queueLengthAhead === 'number')
    && (batch.durationFrames === undefined || typeof batch.durationFrames === 'number')
    && (batch.i2vSourceUploadId === undefined || typeof batch.i2vSourceUploadId === 'string')
    && (batch.story === undefined || isRecord(batch.story))
    && Array.isArray(batch.tiles);
}

// Only the foreground tab persists. With two open tabs on the same origin both
// share one IDB row at IDB_KEY; without this gate the slower flush stomps the
// faster one — a stale snapshot from a backgrounded second tab can overwrite a
// fresh post-SSE optimistic update from the active tab. Gating on visibility
// keeps writes monotonic for the user's actual focus. `flushPersisterForTests`
// bypasses this so deterministic tests still flush.
function isForegroundTab(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible';
}

let lifecycleListenersAttached = false;

// Best-effort flush at tab teardown / hidden transition so single-tab use
// doesn't lose the last debounced update when the user closes the tab during
// the 1 s persist window. Multi-tab safety still holds: the just-hidden tab
// gets one final flush of its latest state, after which the foreground tab
// takes over normal writes — at worst the other tab overwrites within 1 s.
function attachLifecycleFlushOnce(): void {
  if (lifecycleListenersAttached) return;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  lifecycleListenersAttached = true;

  const flushNow = () => {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = undefined;
    }
    if (latestClient) void flushLatestClient();
  };

  window.addEventListener('pagehide', flushNow);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushNow();
  });
}

export function createIDBPersister(cacheScope: string): Persister {
  const idbKey = scopedIdbKey(cacheScope);
  activeIdbKey = idbKey;
  attachLifecycleFlushOnce();
  return {
    persistClient: (client: PersistedClient) => {
      if (isSessionLocked() || idbKey !== activeIdbKey) return;
      latestClient = { key: idbKey, client: boundPersistedHistory(client) };
      if (persistTimer) {
        clearTimeout(persistTimer);
      }
      persistTimer = setTimeout(() => {
        persistTimer = undefined;
        if (!isForegroundTab()) {
          // Drop the buffered update entirely in the hidden state — the
          // pagehide/visibilitychange flush captures the last frame before
          // the tab actually leaves the foreground, so dropping here is
          // safe and avoids racing the foreground tab on shared IDB rows.
          latestClient = undefined;
          return;
        }
        void flushLatestClient();
      }, PERSIST_DEBOUNCE_MS);
    },
    restoreClient: async () => {
      if (isSessionLocked() || idbKey !== activeIdbKey) return undefined;
      const restored = await get<unknown>(idbKey);
      if (isSessionLocked() || idbKey !== activeIdbKey) return undefined;
      if (!isValidPersistedClient(restored)) {
        // Corrupt, truncated, or incompatible-shape payload (e.g. a wire
        // type changed without a PERSIST_CACHE_VERSION bump). Return
        // undefined so the provider starts clean; its onSuccess invalidate
        // then revalidates against the server — strictly better than
        // hydrating malformed objects into the QueryClient for maxAge.
        return undefined;
      }
      return restored;
    },
    removeClient: async () => {
      if (isSessionLocked()) return;
      if (idbKey === activeIdbKey) clearPendingPersist();
      try {
        await del(idbKey);
      } catch (error) {
        console.warn('Failed to remove QueryClient cache', error);
      }
    },
  };
}

function isCollectionsKey(key: readonly unknown[]): boolean {
  return key[0] === 'collections';
}

function isPromptLibraryKey(key: readonly unknown[]): boolean {
  return key[0] === 'prompts' && key[1] === 'library';
}


// Structural backstop for the IndexedDB blob. Validates only the envelope
// TanStack rehydrates — not field semantics (the buster owns wire-shape
// changes). A single malformed query entry condemns the whole client: a
// clean rebuild + revalidate is cheap and always correct, hydrating
// half-garbage is not.
function isValidPersistedClient(value: unknown): value is PersistedClient {
  if (!isRecord(value)) return false;
  if (typeof value.timestamp !== 'number') return false;
  if (typeof value.buster !== 'string') return false;
  const clientState = value.clientState;
  if (!isRecord(clientState)) return false;
  if (!Array.isArray(clientState.queries) || !Array.isArray(clientState.mutations)) return false;
  return clientState.queries.every(
    (entry) => isRecord(entry) && Array.isArray(entry.queryKey) && isRecord(entry.state),
  );
}

function isLoadingTile(value: unknown): value is Tile {
  return isRecord(value) && value.status === 'loading';
}

function pageHasNoLoadingTiles(page: unknown): boolean {
  if (!isRecord(page) || !Array.isArray(page.items)) return false;
  return !page.items.some((batch) => {
    if (!isRecord(batch) || !Array.isArray(batch.tiles)) return false;
    return batch.tiles.some(isLoadingTile);
  });
}

function isPersistableHistoryPage(query: Query): boolean {
  if (!isDefaultHistoryScopeKey(query.queryKey)) return false;
  const data = query.state.data;
  if (!isRecord(data) || !Array.isArray(data.pages)) return false;
  if (data.pages.length === 0) return false;
  // Every cached page must be free of loading tiles. A generation in flight
  // anywhere in the cached history (not just page 1) means we wait for the
  // tiles to resolve before persisting, otherwise hydration would surface
  // tiles stuck mid-stream.
  return data.pages.every(pageHasNoLoadingTiles);
}

export function shouldDehydrateQuery(query: Query): boolean {
  if (query.state.status !== 'success') return false;
  const key = query.queryKey;
  if (!Array.isArray(key)) return false;
  // Models intentionally excluded: `Model.availability` is live data refreshed
  // every 30s by `modelsOpts.refetchInterval`. A persisted snapshot would
  // hydrate stale offline/online status, defeating the live signal.
  return isCollectionsKey(key) || isPromptLibraryKey(key) || isPersistableHistoryPage(query);
}

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Batch, Tile } from '@atelier/shared';
import type { Query, QueryKey } from '@tanstack/react-query';
import type { PersistedClient } from '@tanstack/react-query-persist-client';
import { promptKeys } from '../api/prompts';
import { buildHistoricalRequest } from './historicalGeneration';
import { invalidateSessionScope, resetSessionScopeForTests } from './sessionScope';

const IDB_KEY = 'atelier-rq-cache-v1:scope-a';
const LEGACY_IDB_KEY = 'atelier-rq-cache-v1';
const idbStore = new Map<string, unknown>();
let readOverride: (() => Promise<unknown>) | undefined;

void mock.module('idb-keyval', () => ({
  del: (key: string): Promise<void> => {
    idbStore.delete(key);
    return Promise.resolve();
  },
  get: <T>(key: string): Promise<T | undefined> => readOverride
    ? readOverride() as Promise<T | undefined>
    : Promise.resolve(idbStore.get(key) as T | undefined),
  set: (key: string, value: unknown): Promise<void> => {
    idbStore.set(key, value);
    return Promise.resolve();
  },
  keys: (): Promise<string[]> => Promise.resolve([...idbStore.keys()]),
}));

const { get, set } = await import('idb-keyval');
const { createIDBPersister, flushPersisterForTests, preparePersistenceScope, PERSIST_CACHE_VERSION, shouldDehydrateQuery } = await import('./persister');

type QueryStatus = Query['state']['status'];

function syntheticQuery(queryKey: QueryKey, status: QueryStatus, data?: unknown): Query {
  return { queryKey, state: { status, data } } as Query;
}

function persistedClient(buster: string): PersistedClient {
  return {
    buster,
    timestamp: buster.length,
    clientState: {
      mutations: [],
      queries: [],
    },
  };
}

const doneTile: Tile = {
  id: 'tile-done',
  seed: 1,
  status: 'done',
  url: '/api/img/tile-done',
  thumbUrl: '/api/img/tile-done/thumb',
  ext: 'png',
  mime: 'image/png',
  completedAt: 1,
};

const loadingTile: Tile = {
  id: 'tile-loading',
  seed: 2,
  status: 'loading',
};

function batchWith(tiles: readonly Tile[]): Batch {
  return {
    id: 'batch-1',
    prompt: 'photoreal espresso setup',
    ratio: '1:1',
    modelId: 'gpt-image-2.5-sunburst',
    modelLabel: 'GPT Image 2.5 Sunburst',
    createdAt: 1,
    collectionId: null,
      pinned: false,
      status: 'done',
    tiles,
  };
}

function historyData(pages: readonly Batch[][]): { pages: { items: readonly Batch[] }[]; pageParams: null[] } {
  return {
    pages: pages.map((items) => ({ items })),
    pageParams: pages.map(() => null),
  };
}

beforeEach(async () => {
  await flushPersisterForTests();
  resetSessionScopeForTests();
  readOverride = undefined;
  idbStore.clear();
  sessionStorage.clear();
});
afterEach(() => { resetSessionScopeForTests(); });

describe('createIDBPersister', () => {
  test('uses a new buster after sequence fields joined persisted history', () => {
    expect(PERSIST_CACHE_VERSION).toBe('17');
  });

  test('debounces persistClient', async () => {
    const persister = createIDBPersister('scope-a');
    const oldClient = persistedClient('old');
    await set(IDB_KEY, oldClient);

    for (const buster of ['one', 'two', 'three', 'four', 'five']) {
      await persister.persistClient(persistedClient(buster));
    }

    expect(await get<PersistedClient>(IDB_KEY)).toEqual(oldClient);
    await flushPersisterForTests();
    expect(await get<PersistedClient>(IDB_KEY)).toEqual(persistedClient('five'));
  });

  test('removeClient cancels pending write', async () => {
    const persister = createIDBPersister('scope-a');
    await persister.persistClient(persistedClient('pending'));
    await persister.removeClient();

    await flushPersisterForTests();
    expect(await get<PersistedClient>(IDB_KEY)).toBeUndefined();
  });

  test('session retirement blocks pending and late writes without erasing saved state', async () => {
    const persister = createIDBPersister('scope-a');
    await set(IDB_KEY, persistedClient('saved'));
    await persister.persistClient(persistedClient('pending'));
    invalidateSessionScope();
    await persister.persistClient(persistedClient('late'));
    await flushPersisterForTests();
    await persister.removeClient();
    expect(await get<PersistedClient>(IDB_KEY)).toEqual(persistedClient('saved'));
    expect(await persister.restoreClient()).toBeUndefined();
  });

  test('a restore that settles after retirement cannot hydrate the runtime', async () => {
    const persister = createIDBPersister('scope-a');
    let finishRead: ((client: PersistedClient) => void) | undefined;
    readOverride = () => new Promise((resolve) => { finishRead = resolve; });
    const restoring = persister.restoreClient();
    invalidateSessionScope();
    finishRead?.(persistedClient('late'));
    expect(await restoring).toBeUndefined();
  });

  test('an old persister cannot redirect pending or late writes into another scope', async () => {
    const old = createIDBPersister('scope-a');
    await old.persistClient(persistedClient('a'));
    const current = createIDBPersister('scope-b');
    await flushPersisterForTests();
    await current.persistClient(persistedClient('b'));
    await old.persistClient(persistedClient('late-a'));
    await old.removeClient();
    await flushPersisterForTests();
    expect(await get<PersistedClient>('atelier-rq-cache-v1:scope-b')).toEqual(persistedClient('b'));
    expect(await old.restoreClient()).toBeUndefined();
  });
});

describe('preparePersistenceScope', () => {
  test('deletes legacy and other-user caches while preserving the current scope', async () => {
    await set(LEGACY_IDB_KEY, persistedClient('legacy'));
    await set('atelier-rq-cache-v1:scope-a', persistedClient('a'));
    await set('atelier-rq-cache-v1:scope-b', persistedClient('b'));
    sessionStorage.setItem('atelier.rollQueue.v1', 'legacy');
    sessionStorage.setItem('atelier.rollQueue.v1:scope-a', 'alice');
    sessionStorage.setItem('atelier.rollQueue.v1:scope-b', 'bob');
    await preparePersistenceScope('scope-b');
    expect(await get<unknown>(LEGACY_IDB_KEY)).toBeUndefined();
    expect(await get<unknown>('atelier-rq-cache-v1:scope-a')).toBeUndefined();
    expect(await get<PersistedClient>('atelier-rq-cache-v1:scope-b')).toEqual(persistedClient('b'));
    expect(sessionStorage.getItem('atelier.rollQueue.v1')).toBeNull();
    expect(sessionStorage.getItem('atelier.rollQueue.v1:scope-a')).toBeNull();
    expect(sessionStorage.getItem('atelier.rollQueue.v1:scope-b')).toBe('bob');
  });
});

describe('shouldDehydrateQuery', () => {
  test('does NOT persist models queries (live availability would go stale)', () => {
    // Models carry live availability from the server's background health
    // probe; persisting the snapshot would hydrate stale offline/online
    // status on next mount.
    expect(shouldDehydrateQuery(syntheticQuery(['models', 'list'], 'success', []))).toBe(false);
  });

  test('persists successful collections queries', () => {
    expect(shouldDehydrateQuery(syntheticQuery(['collections', 'list'], 'success', { items: [] }))).toBe(true);
  });

  test('persists successful prompt library queries', () => {
    expect(
      shouldDehydrateQuery(
        syntheticQuery(promptKeys.library(), 'success', {
          templates: [],
          variableLists: [],
          dimensions: [],
        }),
      ),
    ).toBe(true);
  });

  test('persists default unsorted first page when no tiles are loading', () => {
    expect(
      shouldDehydrateQuery(
        syntheticQuery(
          ['history', { view: { kind: 'unsorted' }, q: '' }],
          'success',
          historyData([[batchWith([doneTile])]]),
        ),
      ),
    ).toBe(true);
  });

  test('does not persist default unsorted first page with a loading tile', () => {
    expect(
      shouldDehydrateQuery(
        syntheticQuery(
          ['history', { view: { kind: 'unsorted' }, q: '' }],
          'success',
          historyData([[batchWith([doneTile, loadingTile])]]),
        ),
      ),
    ).toBe(false);
  });

  test('persists default unsorted across multiple pages when no tiles are loading', () => {
    // Auto-load on scroll (InfiniteStatus sentinel) makes >1 page the common
    // case. The previous "exactly one page" gate silently killed persistence
    // as soon as the user scrolled. Multi-page persistence is bounded by
    // localStorage/IDB caps; at 30 batches/page × metadata-only payloads it
    // stays well under 1 MB in realistic sessions.
    expect(
      shouldDehydrateQuery(
        syntheticQuery(
          ['history', { view: { kind: 'unsorted' }, q: '' }],
          'success',
          historyData([[batchWith([doneTile])], [batchWith([doneTile])]]),
        ),
      ),
    ).toBe(true);
  });

  test('does not persist when any cached page has a loading tile', () => {
    // The loading-tile guard now scans every cached page, not just page 1.
    expect(
      shouldDehydrateQuery(
        syntheticQuery(
          ['history', { view: { kind: 'unsorted' }, q: '' }],
          'success',
          historyData([[batchWith([doneTile])], [batchWith([doneTile, loadingTile])]]),
        ),
      ),
    ).toBe(false);
  });

  test('does not persist unsorted searches', () => {
    expect(
      shouldDehydrateQuery(
        syntheticQuery(
          ['history', { view: { kind: 'unsorted' }, q: 'espresso' }],
          'success',
          historyData([[batchWith([doneTile])]]),
        ),
      ),
    ).toBe(false);
  });

  test('does not persist pinned views', () => {
    expect(
      shouldDehydrateQuery(
        syntheticQuery(
          ['history', { view: { kind: 'pinned' }, q: '' }],
          'success',
          historyData([[batchWith([doneTile])]]),
        ),
      ),
    ).toBe(false);
  });

  test('does not persist collection views', () => {
    expect(
      shouldDehydrateQuery(
        syntheticQuery(
          ['history', { view: { kind: 'collection', id: 'collection-1' }, q: '' }],
          'success',
          historyData([[batchWith([doneTile])]]),
        ),
      ),
    ).toBe(false);
  });

  test('does not persist error queries', () => {
    expect(shouldDehydrateQuery(syntheticQuery(['models', 'list'], 'error', []))).toBe(false);
  });

  test('does not persist pending queries', () => {
    expect(shouldDehydrateQuery(syntheticQuery(['models', 'list'], 'pending', []))).toBe(false);
  });

  test('does not persist unrelated queries', () => {
    expect(shouldDehydrateQuery(syntheticQuery(['archive'], 'success', []))).toBe(false);
  });
});

function clientWithHistory(queryKey: QueryKey, pageCount: number): PersistedClient {
  const pages = Array.from({ length: pageCount }, (_, i) => ({
    items: [batchWith([{ ...doneTile, id: `t-${i}` }])],
  }));
  const pageParams = pages.map((_, i) => (i === 0 ? null : `cursor-${i}`));
  return {
    buster: 'b',
    timestamp: 1,
    clientState: {
      mutations: [],
      queries: [{ queryKey, queryHash: 'h', state: { status: 'success', data: { pages, pageParams } } }],
    },
  } as unknown as PersistedClient;
}

function storedHistoryData(client: PersistedClient): { pages: unknown[]; pageParams: unknown[] } {
  const q = client.clientState.queries[0];
  if (!q) throw new Error('no query persisted');
  return q.state.data as { pages: unknown[]; pageParams: unknown[] };
}

const DEFAULT_SCOPE_KEY: QueryKey = ['history', { view: { kind: 'unsorted' }, q: '' }];

describe('boundPersistedHistory (via persistClient)', () => {
  test('caps the persisted default-Unsorted slice to the newest 5 pages', async () => {
    const persister = createIDBPersister('scope-a');
    const input = clientWithHistory(DEFAULT_SCOPE_KEY, 8);
    await persister.persistClient(input);
    await flushPersisterForTests();

    const stored = await get<PersistedClient>(IDB_KEY);
    if (!stored) throw new Error('expected a persisted client');
    const data = storedHistoryData(stored);
    expect(data.pages.length).toBe(5);
    expect(data.pageParams.length).toBe(5);
    // Newest pages kept (page 0 = upsertNewBatch target), tail dropped.
    expect((data.pages[0] as { items: Batch[] }).items[0]?.tiles[0]?.id).toBe('t-0');
    expect((data.pages[4] as { items: Batch[] }).items[0]?.tiles[0]?.id).toBe('t-4');
    // Live input object must NOT be mutated (it aliases the live cache).
    expect(storedHistoryData(input).pages.length).toBe(8);
  });

  test('passes a <=5-page default-Unsorted client through unchanged', async () => {
    const persister = createIDBPersister('scope-a');
    const input = clientWithHistory(DEFAULT_SCOPE_KEY, 3);
    await persister.persistClient(input);
    await flushPersisterForTests();

    expect(await get<PersistedClient>(IDB_KEY)).toEqual(input);
  });

  test('strips transient history metadata before persisting', async () => {
    const persister = createIDBPersister('scope-a');
    const batch = { ...batchWith([doneTile]), queueLengthAhead: 3 };
    const input = {
      buster: 'b',
      timestamp: 1,
      clientState: {
        mutations: [],
        queries: [
          {
            queryKey: DEFAULT_SCOPE_KEY,
            queryHash: 'h',
            state: {
              status: 'success',
              data: {
                pages: [
                  {
                    items: [batch],
                    nextCursor: null,
                    loadingTileCount: 0,
                    loadingBatches: ['foo'],
                    hasLoadingTiles: false,
                  },
                ],
                pageParams: [null],
              },
            },
          },
        ],
      },
    } as unknown as PersistedClient;

    await persister.persistClient(input);
    await flushPersisterForTests();

    const stored = await get<PersistedClient>(IDB_KEY);
    if (!stored) throw new Error('expected a persisted client');
    const page = storedHistoryData(stored).pages[0] as {
      items: (Batch & { queueLengthAhead?: number })[];
      loadingTileCount?: number;
      loadingBatches?: unknown;
      hasLoadingTiles?: boolean;
    };

    expect(page.items[0]?.queueLengthAhead).toBeUndefined();
    expect(page.loadingTileCount).toBeUndefined();
    expect(page.loadingBatches).toBeUndefined();
    expect(page.hasLoadingTiles).toBeUndefined();
  });

  test('round-trips video sequence membership and master state', async () => {
    const persister = createIDBPersister('scope-a');
    const sequenceBatch: Batch = {
      ...batchWith([doneTile]),
      sequenceId: 'sequence-1',
      sequenceIndex: 1,
      sequence: {
        id: 'sequence-1',
        segmentCount: 2,
        totalDurationFrames: 248,
        masterStatus: 'stitching',
        masterUpdatedAt: 42,
      },
    };
    const input = {
      buster: 'b',
      timestamp: 1,
      clientState: {
        mutations: [],
        queries: [{
          queryKey: DEFAULT_SCOPE_KEY,
          queryHash: 'h',
          state: {
            status: 'success',
            data: {
              pages: [{ items: [{ ...sequenceBatch, queueLengthAhead: 2 }], nextCursor: null }],
              pageParams: [null],
            },
          },
        }],
      },
    } as unknown as PersistedClient;

    await persister.persistClient(input);
    await flushPersisterForTests();

    const stored = await get<PersistedClient>(IDB_KEY);
    if (!stored) throw new Error('expected a persisted client');
    const persistedBatch = (storedHistoryData(stored).pages[0] as { items: Batch[] }).items[0];
    expect(persistedBatch?.sequenceId).toBe('sequence-1');
    expect(persistedBatch?.sequenceIndex).toBe(1);
    expect(persistedBatch?.sequence).toEqual(sequenceBatch.sequence);
  });

  async function persistRoundTrip(batch: Batch & Record<string, unknown>): Promise<Batch & Record<string, unknown>> {
    const persister = createIDBPersister('scope-a');
    const input = {
      buster: 'b',
      timestamp: 1,
      clientState: {
        mutations: [],
        queries: [{
          queryKey: DEFAULT_SCOPE_KEY,
          queryHash: 'h',
          state: { status: 'success', data: { pages: [{ items: [batch], nextCursor: null }], pageParams: [null] } },
        }],
      },
    } as unknown as PersistedClient;
    await persister.persistClient(input);
    await flushPersisterForTests();
    const restored = await persister.restoreClient();
    if (!restored) throw new Error('expected a persisted client');
    const item = (storedHistoryData(restored).pages[0] as { items: (Batch & Record<string, unknown>)[] }).items[0];
    if (!item) throw new Error('expected a persisted batch');
    return item;
  }

  test('a hydrated non-default T2V batch re-rolls with its clip length', async () => {
    const restored = await persistRoundTrip({
      ...batchWith([{ ...doneTile, mime: 'video/mp4', ext: 'mp4' }]),
      modelId: 'ltx-t2v',
      durationFrames: 362,
      queueLengthAhead: 4,
    });

    expect(restored.queueLengthAhead).toBeUndefined();
    expect(buildHistoricalRequest(restored, { kind: 'reroll' })).toMatchObject({ modelId: 'ltx-t2v', durationFrames: 362 });
  });

  test('a hydrated I2V batch re-rolls with its source upload and clip length', async () => {
    const restored = await persistRoundTrip({
      ...batchWith([{ ...doneTile, mime: 'video/mp4', ext: 'mp4' }]),
      modelId: 'minimax-h3-i2v',
      durationFrames: 243,
      i2vSourceUploadId: 'upload-src',
      motionPrompt: 'Slow camera orbit, preserving the subject.',
      transientFlag: true,
    });

    expect(restored.transientFlag).toBeUndefined();
    expect(buildHistoricalRequest(restored, { kind: 'reroll' })).toMatchObject({
      modelId: 'minimax-h3-i2v',
      durationFrames: 243,
      i2vSourceUploadId: 'upload-src',
      motionPrompt: 'Slow camera orbit, preserving the subject.',
    });
  });

  test('story metadata needed for status and polling survives persistence', async () => {
    const story = {
      id: 'story-1',
      status: 'rendering' as const,
      segmentIndex: 0,
      segmentCount: 3,
      logline: 'A lighthouse keeper finds a map',
      etaMs: 90_000,
    };
    const restored = await persistRoundTrip({ ...batchWith([doneTile]), story, queueLengthAhead: 1 });

    expect(restored.story).toEqual(story);
    expect(restored.queueLengthAhead).toBeUndefined();
  });

  test('does not trim non-default history scopes', async () => {
    const persister = createIDBPersister('scope-a');
    const input = clientWithHistory(['history', { view: { kind: 'collection', id: 'c1' }, q: '' }], 8);
    await persister.persistClient(input);
    await flushPersisterForTests();

    const stored = await get<PersistedClient>(IDB_KEY);
    if (!stored) throw new Error('expected a persisted client');
    expect(storedHistoryData(stored).pages.length).toBe(8);
  });
});

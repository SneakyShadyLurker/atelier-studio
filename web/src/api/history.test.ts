import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { Batch, HistoryPage } from '@atelier/shared';
import { MAX_DELETE_KEEP_UPLOADS } from '@atelier/shared';
import {
  __resetFirstSeenLoadingForTest,
  __resetStuckToastDedupeForTest,
  clearHistory,
  deleteBatch,
  deleteTile,
  hasActiveStory,
  historyOpts,
  pendingStoryPollDecision,
} from './history';
import { ApiError } from './client';
import { holdUploadsForUndo, initialAtelierState, useAtelierStore } from '../store/atelier';
import { permanentDelete, purgeArchive } from './archive';

// Minimal tile fixtures — only fields required by TileBase / the discriminant
const loadingTile = { id: 't1', seed: 1, status: 'loading' as const };
const doneTile = {
  id: 't2',
  seed: 2,
  status: 'done' as const,
  url: '/img/x.png',
  ext: 'png' as const,
  mime: 'image/png' as const,
  completedAt: 1000,
};

// Minimal Batch fixture
const originalDateNow = Date.now;

afterEach(() => {
  Date.now = originalDateNow;
  __resetFirstSeenLoadingForTest();
  __resetStuckToastDedupeForTest();
  useAtelierStore.setState({ toasts: [], pendingStory: null });
});

function makeBatch(tiles: Batch['tiles'], createdAt = Date.now(), id = 'b1'): Batch {
  return {
    id,
    prompt: 'test',
    ratio: '1:1',
    modelId: 'gpt-image-2.5-sunburst',
    modelLabel: 'GPT Image 2.5 Sunburst',
    createdAt,
    collectionId: null,
      pinned: false,
      status: 'done',
    tiles,
  };
}

type RefetchQuery =
  | {
    state: {
      data: {
        pages: (HistoryPage<Batch> & {
          hasLoadingTiles?: boolean;
          loadingTileCount?: number;
          loadingBatches?: readonly { batchId: string; startedAt: number }[];
        })[];
        loadingTileCount?: number;
      };
      errorUpdateCount?: number;
      fetchFailureCount?: number;
      dataUpdatedAt?: number;
    };
  }
  | { state: { data: undefined; errorUpdateCount?: number; fetchFailureCount?: number; dataUpdatedAt?: number } };

// Helper: extract refetchInterval and invoke it with the given pages.
function callRefetchInterval(
  pages: HistoryPage<Batch>[] | undefined,
  fetchFailureCount = 0,
  errorUpdateCount = 0,
  dataUpdatedAt: number = Date.now(),
): number | false {
  const opts = historyOpts();
  const fn = opts.refetchInterval as
    | ((query: RefetchQuery) => number | false)
    | undefined;
  if (typeof fn !== 'function') {
    throw new Error('refetchInterval is not defined on historyOpts');
  }
  const query: RefetchQuery =
    pages === undefined
      ? { state: { data: undefined, errorUpdateCount, fetchFailureCount, dataUpdatedAt } }
      : { state: { data: { pages }, errorUpdateCount, fetchFailureCount, dataUpdatedAt } };
  return fn(query);
}

describe('historyOpts refetchInterval', () => {
  test('returns 3000 when at least one tile has status loading', () => {
    const pages: HistoryPage<Batch>[] = [
      { items: [makeBatch([loadingTile, doneTile])], nextCursor: null },
    ];
    expect(callRefetchInterval(pages)).toBe(3000);
  });

  test('keeps polling for queued batches whose tiles are still loading', () => {
    const queued = { ...makeBatch([loadingTile]), status: 'queued' as const, queueLengthAhead: 2 };
    const pages: HistoryPage<Batch>[] = [
      { items: [queued], nextCursor: null },
    ];
    expect(callRefetchInterval(pages)).toBe(3000);
  });

  test('returns false when all tiles are terminal (no loading tiles)', () => {
    const pages: HistoryPage<Batch>[] = [
      { items: [makeBatch([doneTile])], nextCursor: null },
    ];
    expect(callRefetchInterval(pages)).toBe(false);
  });

  test('detects rendering story decorations and keeps polling between segments', () => {
    const rendering = {
      ...makeBatch([doneTile]),
      story: {
        id: 'story-active',
        status: 'rendering' as const,
        segmentIndex: 0,
        segmentCount: 3,
        logline: 'An active story.',
        etaMs: 60_000,
      },
    };
    const done = { ...rendering, story: { ...rendering.story, status: 'done' as const } };
    const renderingPages = [{ items: [rendering], nextCursor: null }];

    expect(hasActiveStory(renderingPages)).toBe(true);
    expect(hasActiveStory([{ items: [done], nextCursor: null }])).toBe(false);
    expect(callRefetchInterval(renderingPages)).toBe(3000);
  });

  test('pending stories poll until decorated history appears, then clear the gate', () => {
    Date.now = () => 10_000;
    const pending = { id: 'story-pending', until: 20_000 };
    useAtelierStore.getState().setPendingStory(pending);

    expect(pendingStoryPollDecision([], pending, Date.now())).toBe('poll');
    expect(callRefetchInterval([])).toBe(3000);
    expect(useAtelierStore.getState().pendingStory).toEqual(pending);

    const decorated = {
      ...makeBatch([doneTile]),
      story: {
        id: pending.id,
        status: 'done' as const,
        segmentIndex: 0,
        segmentCount: 2,
        logline: 'A completed story.',
        etaMs: 60_000,
      },
    };
    const pages = [{ items: [decorated], nextCursor: null }];
    expect(pendingStoryPollDecision(pages, pending, Date.now())).toBe('clear');
    expect(callRefetchInterval(pages)).toBe(false);
    expect(useAtelierStore.getState().pendingStory).toBeNull();
  });

  test('clears an expired pending story and resumes normal polling rules', () => {
    Date.now = () => 20_000;
    useAtelierStore.getState().setPendingStory({ id: 'story-expired', until: 20_000 });

    expect(callRefetchInterval([])).toBe(false);
    expect(useAtelierStore.getState().pendingStory).toBeNull();
  });

  test('returns false when query.state.data is undefined', () => {
    expect(callRefetchInterval(undefined)).toBe(false);
  });

  test('keeps polling multi-page history caches while a tile is loading', () => {
    // A loading tile hydrated from cache or a later page may have no live SSE
    // subscription; the fallback poll must not be gated on page count.
    const pages: HistoryPage<Batch>[] = [
      { items: [makeBatch([loadingTile], Date.now(), 'loading-page')], nextCursor: 'cursor' },
      { items: [makeBatch([doneTile], Date.now(), 'old-page')], nextCursor: null },
    ];
    expect(callRefetchInterval(pages)).toBe(3000);
  });

  test('keeps polling when the only loading tile sits on a later cached page', () => {
    const pages: HistoryPage<Batch>[] = [
      { items: [makeBatch([doneTile], Date.now(), 'head-page')], nextCursor: 'cursor' },
      { items: [makeBatch([loadingTile], Date.now(), 'deep-loading')], nextCursor: null },
    ];
    expect(callRefetchInterval(pages)).toBe(3000);
  });

  test('stops polling multi-page history caches once every tile is terminal', () => {
    const pages: HistoryPage<Batch>[] = [
      { items: [makeBatch([doneTile], Date.now(), 'head-terminal')], nextCursor: 'cursor' },
      { items: [makeBatch([doneTile], Date.now(), 'deep-terminal')], nextCursor: null },
    ];
    expect(callRefetchInterval(pages)).toBe(false);
  });

  test('multi-page caches back off on stalled loading batches and honour the stuck cap', () => {
    const batchAt = 50_000;
    const pages: HistoryPage<Batch>[] = [
      { items: [makeBatch([doneTile], batchAt, 'head-done')], nextCursor: 'cursor' },
      { items: [makeBatch([loadingTile], batchAt, 'deep-stalled')], nextCursor: null },
    ];

    Date.now = () => batchAt + 25_000;
    expect(callRefetchInterval(pages)).toBe(10_000);

    Date.now = () => batchAt + 90_000;
    expect(callRefetchInterval(pages)).toBe(30_000);

    // First observed at batchAt + 25 s; past the 30-minute client-observed cap
    // the poll stops and the stuck toast fires once.
    Date.now = () => batchAt + 25_000 + 31 * 60_000;
    expect(callRefetchInterval(pages)).toBe(false);
    expect(useAtelierStore.getState().toasts.map((toast) => toast.text)).toEqual([
      'Generation seems stuck — refresh to retry.',
    ]);
  });

  test('returns false after persistent refetch errors even with loading tiles', () => {
    const pages: HistoryPage<Batch>[] = [
      { items: [makeBatch([loadingTile])], nextCursor: null },
    ];
    expect(callRefetchInterval(pages, 4)).toBe(false);
  });

  test('uses client-observed loading time instead of server createdAt for the stuck cap', () => {
    Date.now = () => 10 * 60_000;
    const pages: HistoryPage<Batch>[] = [
      { items: [makeBatch([loadingTile], 0, 'stuck-batch')], nextCursor: null },
    ];

    expect(callRefetchInterval(pages)).toBe(3000);
    expect(useAtelierStore.getState().toasts).toHaveLength(0);

    Date.now = () => 41 * 60_000;
    expect(callRefetchInterval(pages)).toBe(false);
    expect(useAtelierStore.getState().toasts.map((toast) => toast.text)).toEqual([
      'Generation seems stuck — refresh to retry.',
    ]);

    expect(callRefetchInterval(pages)).toBe(false);
    expect(useAtelierStore.getState().toasts).toHaveLength(1);
  });

  test('a long queue wait never counts toward the stuck cap', () => {
    Date.now = () => 0;
    const queued: Batch = { ...makeBatch([loadingTile], 0, 'long-queue'), status: 'queued' };
    expect(callRefetchInterval([{ items: [queued], nextCursor: null }])).not.toBe(false);

    // Still queued 45 minutes later: keep polling, no stuck toast.
    Date.now = () => 45 * 60_000;
    expect(callRefetchInterval([{ items: [queued], nextCursor: null }])).not.toBe(false);
    expect(useAtelierStore.getState().toasts).toHaveLength(0);

    // Dispatched now: the stuck clock starts here, not at submission.
    const running: Batch = { ...queued, status: 'running', startedAt: 45 * 60_000 };
    expect(callRefetchInterval([{ items: [running], nextCursor: null }])).toBe(3000);
    Date.now = () => 70 * 60_000;
    expect(callRefetchInterval([{ items: [running], nextCursor: null }])).not.toBe(false);
    expect(useAtelierStore.getState().toasts).toHaveLength(0);
  });

  test('keeps polling fresh loading batches even when another batch exceeded the cap', () => {
    Date.now = () => 0;
    const pages: HistoryPage<Batch>[] = [
      {
        items: [makeBatch([loadingTile], 0, 'stuck-batch-with-fresh')],
        nextCursor: null,
      },
    ];

    expect(callRefetchInterval(pages)).toBe(3000);

    // Fresh batch created within the last 20 s → stallMs < 20 000 ms →
    // baseline 3 s cadence regardless of the stuck-batch presence. (The
    // earlier 31-minute time advance was incompatible with the new
    // mostRecentProgressFromPages stall signal — `fresh-batch` would have
    // looked 60 s stale, dropping the cadence to the 10 s backoff tier.)
    Date.now = () => 30 * 60_000 + 10_000;
    expect(callRefetchInterval([{
      items: [
        makeBatch([loadingTile], 0, 'stuck-batch-with-fresh'),
        makeBatch([loadingTile], 30 * 60_000, 'fresh-batch'),
      ],
      nextCursor: null,
    }])).toBe(3000);
    expect(useAtelierStore.getState().toasts.map((toast) => toast.text)).toEqual([
      'Generation seems stuck — refresh to retry.',
    ]);
  });

  test('keeps polling after old errors once fetch failures have recovered', () => {
    const pages: HistoryPage<Batch>[] = [
      { items: [makeBatch([loadingTile])], nextCursor: null },
    ];
    expect(callRefetchInterval(pages, 0, 4)).toBe(3000);
  });

  test('uses tagged loading metadata to short-circuit the count walk', () => {
    // Tagged metadata (loadingTileCount + loadingBatches) is enough to drive
    // the "should we poll?" decision in the per-render `select` hot path
    // without re-walking every batch's tiles. The adaptive-backoff signal
    // (mostRecentProgressFromPages) does walk items once per polling tick
    // (every 3–30 s) — that's the slow path, not the hot path. The contract
    // walks in refetchInterval; the
    // perf invariant only protects `select`.
    const opts = historyOpts();
    const fn = opts.refetchInterval as
      | ((query: RefetchQuery) => number | false)
      | undefined;
    if (typeof fn !== 'function') {
      throw new Error('refetchInterval is not defined on historyOpts');
    }
    const query: RefetchQuery = {
      state: {
        data: {
          pages: [{
            loadingTileCount: 1,
            hasLoadingTiles: true,
            loadingBatches: [{ batchId: 'tagged-loading', startedAt: Date.now() }],
            items: [makeBatch([loadingTile], Date.now(), 'tagged-loading')],
            nextCursor: null,
          }],
        },
        errorUpdateCount: 0,
        dataUpdatedAt: Date.now(),
      },
    };

    expect(fn(query)).toBe(3000);
  });

  test('recomputes v8 persisted loading pages that lack loadingBatches metadata', () => {
    Date.now = () => 0;
    const pages: NonNullable<RefetchQuery['state']['data']>['pages'] = [
      { items: [makeBatch([loadingTile], -24 * 60 * 60_000, 'legacy-loading')], nextCursor: null, loadingTileCount: 1 },
    ];

    expect(callRefetchInterval(pages)).toBe(3000);

    Date.now = () => 31 * 60_000;
    expect(callRefetchInterval(pages)).toBe(false);
    expect(useAtelierStore.getState().toasts.map((toast) => toast.text)).toEqual([
      'Generation seems stuck — refresh to retry.',
    ]);
  });

  test('clears stuck-toast dedupe after a batch leaves loading and can toast if it becomes stuck again', () => {
    Date.now = () => 0;
    const loadingPages: HistoryPage<Batch>[] = [
      { items: [makeBatch([loadingTile], 0, 'recovering-batch')], nextCursor: null },
    ];
    expect(callRefetchInterval(loadingPages)).toBe(3000);

    Date.now = () => 31 * 60_000;
    expect(callRefetchInterval(loadingPages)).toBe(false);
    expect(useAtelierStore.getState().toasts).toHaveLength(1);

    const terminalPages: HistoryPage<Batch>[] = [
      { items: [makeBatch([doneTile], 31 * 60_000, 'recovering-batch')], nextCursor: null },
    ];
    expect(callRefetchInterval(terminalPages)).toBe(false);
    useAtelierStore.setState({ toasts: [] });

    Date.now = () => 32 * 60_000;
    expect(callRefetchInterval(loadingPages)).toBe(3000);

    Date.now = () => 63 * 60_000;
    expect(callRefetchInterval(loadingPages)).toBe(false);
    expect(useAtelierStore.getState().toasts.map((toast) => toast.text)).toEqual([
      'Generation seems stuck — refresh to retry.',
    ]);
  });

  test('ignores the top-level loading count because query.state.data is raw TanStack data', () => {
    const pages: (HistoryPage<Batch> & { loadingTileCount?: number; hasLoadingTiles?: boolean })[] = [
      { items: [makeBatch([doneTile])], nextCursor: null, loadingTileCount: 0, hasLoadingTiles: false },
    ];
    const opts = historyOpts();
    const fn = opts.refetchInterval as
      | ((query: RefetchQuery) => number | false)
      | undefined;
    if (typeof fn !== 'function') {
      throw new Error('refetchInterval is not defined on historyOpts');
    }

    expect(fn({ state: { data: { pages, loadingTileCount: 1 }, fetchFailureCount: 0, dataUpdatedAt: Date.now() } })).toBe(false);
  });

  test('refetchIntervalInBackground is unset so background tabs do not poll (SSE-on-focus convergence)', () => {
    const opts = historyOpts();
    expect(opts.refetchIntervalInBackground).toBeUndefined();
  });

  test('threads TanStack cancellation signal into the history fetch', async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    globalThis.fetch = mock((_input: RequestInfo | URL, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      return Response.json({ items: [], nextCursor: null });
    }) as unknown as typeof fetch;

    const opts = historyOpts();
    const queryFn = opts.queryFn;
    if (!queryFn) throw new Error('history queryFn missing');
    await queryFn({
      client: {} as never,
      meta: undefined,
      pageParam: null,
      queryKey: opts.queryKey,
      signal: controller.signal,
      direction: 'forward',
    });

    expect(observedSignal).toBe(controller.signal);
  });

  test('adaptive backoff: 3s when fresh, 10s after 20s stall, 30s after 60s stall', () => {
    // The stall signal is the most recent tile
    // completion (or batch createdAt baseline) across loading batches —
    // NOT query.state.dataUpdatedAt, which is bumped by every optimistic
    // SSE write. Test it by holding a batch with one loading tile and one
    // done tile (with a fixed completedAt) and advancing Date.now between
    // calls.
    const batchAt = 50_000;
    const completedAt = 100_000;
    const mixed: HistoryPage<Batch>[] = [
      {
        items: [
          makeBatch(
            [loadingTile, { ...doneTile, completedAt }],
            batchAt,
            'mixed-progress',
          ),
        ],
        nextCursor: null,
      },
    ];

    // Now = completedAt → stallMs = 0 → 3 s baseline.
    Date.now = () => completedAt;
    expect(callRefetchInterval(mixed)).toBe(3000);

    // Now = completedAt + 25 s → first backoff tier (10 s).
    Date.now = () => completedAt + 25_000;
    expect(callRefetchInterval(mixed)).toBe(10_000);

    // Now = completedAt + 90 s → ceiling tier (30 s).
    Date.now = () => completedAt + 90_000;
    expect(callRefetchInterval(mixed)).toBe(30_000);
  });
});

describe('thread deletes hold the composer\'s attached uploads', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    useAtelierStore.setState({ draft: initialAtelierState.draft });
  });

  async function deleteUrls(run: () => Promise<void>): Promise<string> {
    let url = '';
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      url = input instanceof Request ? input.url : input.toString();
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as unknown as typeof fetch;
    await run();
    return url;
  }

  test('sends ready ref chips and the I2V source as keepUploads', async () => {
    useAtelierStore.setState({
      draft: {
        ...initialAtelierState.draft,
        refImages: [
          { clientId: 'c1', serverId: 'u1', status: 'ready', mime: 'image/png', sizeBytes: 1, previewUrl: '' },
          { clientId: 'c2', status: 'uploading', mime: 'image/png', sizeBytes: 1, previewUrl: '' },
        ],
        i2vSourceUploadId: 'u2',
      },
    });

    expect(await deleteUrls(() => deleteBatch('b1'))).toEndWith('/history/b1?keepUploads=u1%2Cu2');
    expect(await deleteUrls(() => permanentDelete('t1'))).toEndWith('/archive/t1?keepUploads=u1%2Cu2');
    expect(await deleteUrls(() => clearHistory({ kind: 'unsorted' }))).toContain('keepUploads=u1%2Cu2');
  });

  test('holds uploads a pending Undo can restore until the hold is released', async () => {
    const release = holdUploadsForUndo(['u3']);
    expect(await deleteUrls(() => deleteBatch('b1'))).toEndWith('/history/b1?keepUploads=u3');
    release();
    expect(await deleteUrls(() => deleteBatch('b1'))).toEndWith('/history/b1');
  });

  test('omits the parameter when nothing is attached', async () => {
    expect(await deleteUrls(() => deleteBatch('b1'))).toEndWith('/history/b1');
  });
});

describe('thread deletes send large hold sets as a JSON body', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    useAtelierStore.setState({ draft: initialAtelierState.draft });
  });

  interface SentDelete { url: string; method: string | undefined; contentType: string | null; body: unknown }

  async function sentDelete(run: () => Promise<void>): Promise<SentDelete> {
    const captured: { sent?: SentDelete } = {};
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      captured.sent = {
        url: input instanceof Request ? input.url : input.toString(),
        method: init?.method,
        contentType: new Headers(init?.headers).get('Content-Type'),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : init?.body ?? null,
      };
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as unknown as typeof fetch;
    await run();
    if (!captured.sent) throw new Error('no DELETE was sent');
    return captured.sent;
  }

  const ids = (n: number, prefix = 'h') => Array.from({ length: n }, (_, i) => `${prefix}-${String(i)}`);

  function holdMany(n: number): () => void {
    return holdUploadsForUndo(ids(n));
  }

  const routes: readonly { name: string; run: () => Promise<void>; path: string; scope?: string }[] = [
    { name: 'clearHistory (unsorted)', run: () => clearHistory({ kind: 'unsorted' }), path: '/api/history', scope: 'collectionId=null' },
    { name: 'clearHistory (pinned)', run: () => clearHistory({ kind: 'pinned' }), path: '/api/history', scope: 'pinned=true' },
    { name: 'clearHistory (collection)', run: () => clearHistory({ kind: 'collection', id: 'c1' }), path: '/api/history', scope: 'collectionId=c1' },
    { name: 'deleteBatch', run: () => deleteBatch('b1'), path: '/api/history/b1' },
    { name: 'deleteTile', run: () => deleteTile('b1', 't1'), path: '/api/history/b1/t1' },
    { name: 'permanentDelete', run: () => permanentDelete('t1'), path: '/api/archive/t1' },
    { name: 'purgeArchive', run: () => purgeArchive(), path: '/api/archive' },
  ];

  for (const route of routes) {
    for (const count of [65, 200]) {
      test(`${route.name}: ${String(count)} holds travel in the body, all ids preserved, scope kept`, async () => {
        const release = holdMany(count);
        try {
          const sent = await sentDelete(route.run);
          const url = new URL(sent.url, 'http://localhost');
          expect(url.pathname).toBe(route.path);
          expect(url.searchParams.has('keepUploads')).toBe(false);
          if (route.scope) expect(url.search).toBe(`?${route.scope}`);
          else expect(url.search).toBe('');
          expect(sent.method).toBe('DELETE');
          expect(sent.contentType).toBe('application/json');
          expect(sent.body).toEqual({ keepUploads: ids(count) });
        } finally {
          release();
        }
      });
    }

    test(`${route.name}: up to 64 holds stay on the query, no body`, async () => {
      const release = holdMany(64);
      try {
        const sent = await sentDelete(route.run);
        const url = new URL(sent.url, 'http://localhost');
        expect(url.pathname).toBe(route.path);
        expect(url.searchParams.get('keepUploads')?.split(',')).toEqual(ids(64));
        if (route.scope) expect(url.search.startsWith(`?${route.scope}&`)).toBe(true);
        expect(sent.body).toBeNull();
        expect(sent.contentType).toBeNull();
      } finally {
        release();
      }
    });

    test(`${route.name}: no holds sends neither query nor body`, async () => {
      const sent = await sentDelete(route.run);
      const url = new URL(sent.url, 'http://localhost');
      expect(url.pathname).toBe(route.path);
      expect(url.searchParams.has('keepUploads')).toBe(false);
      expect(url.search).toBe(route.scope ? `?${route.scope}` : '');
      expect(sent.body).toBeNull();
    });
  }

  test('merges overlapping holds without duplicates', async () => {
    const releaseA = holdUploadsForUndo(ids(50, 'x'));
    const releaseB = holdUploadsForUndo([...ids(50, 'x').slice(25), ...ids(40, 'y')]);
    try {
      const sent = await sentDelete(() => deleteBatch('b1'));
      expect(sent.body).toEqual({ keepUploads: [...ids(50, 'x'), ...ids(40, 'y')] });
    } finally {
      releaseA();
      releaseB();
    }
  });

  test('past MAX_DELETE_KEEP_UPLOADS every id is still sent, leaving the bound to the server', async () => {
    const release = holdMany(MAX_DELETE_KEEP_UPLOADS + 1);
    try {
      const sent = await sentDelete(() => deleteBatch('b1'));
      expect(sent.body).toEqual({ keepUploads: ids(MAX_DELETE_KEEP_UPLOADS + 1) });
    } finally {
      release();
    }
  });

  test('a server rejection of an oversized hold set surfaces as an error', async () => {
    const release = holdMany(MAX_DELETE_KEEP_UPLOADS + 1);
    globalThis.fetch = mock(() => Promise.resolve(Response.json(
      { error: 'validation failed', issues: [{ path: ['keepUploads'], message: 'too many' }] },
      { status: 400 },
    ))) as unknown as typeof fetch;
    try {
      let thrown: unknown;
      try {
        await deleteBatch('b1');
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ApiError);
      expect((thrown as ApiError).status).toBe(400);
    } finally {
      release();
    }
  });
});

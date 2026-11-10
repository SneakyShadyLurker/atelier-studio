import { afterEach, expect, mock, test } from 'bun:test';
import type { Batch, Model, Tile } from '@atelier/shared';

/*
 * R14: while one batch streams, nothing else in the feed or the sidebar may
 * re-render. The app runs compiled (test/setup.ts), so this counts what React
 * actually commits: a DevTools-style hook, installed before react-dom loads,
 * walks each committed tree and records every function component that
 * performed work. Subtrees React reused untouched (same child pointer as the
 * previous tree) are skipped, so a bailed-out row never counts.
 */

interface Fiber {
  tag: number;
  type: unknown;
  flags: number;
  memoizedProps: Record<string, unknown> | null;
  alternate: Fiber | null;
  child: Fiber | null;
  sibling: Fiber | null;
}

const PERFORMED_WORK = 1;
const renders: { name: string; props: Record<string, unknown> }[] = [];

function visit(fiber: Fiber): void {
  const previous = fiber.alternate;
  if (typeof fiber.type === 'function' && (previous === null || (fiber.flags & PERFORMED_WORK) !== 0)) {
    renders.push({ name: (fiber.type as { name: string }).name, props: fiber.memoizedProps ?? {} });
  }
  if (previous !== null && fiber.child === previous.child) return;
  for (let child = fiber.child; child !== null; child = child.sibling) visit(child);
}

(globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown }).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
  supportsFiber: true,
  isDisabled: false,
  renderers: new Map(),
  inject: () => 1,
  checkDCE: () => undefined,
  onScheduleFiberRoot: () => undefined,
  onCommitFiberUnmount: () => undefined,
  onPostCommitFiberRoot: () => undefined,
  onCommitFiberRoot: (_id: number, root: { current: Fiber }) => { visit(root.current); },
};

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { act, cleanup, render, screen } = await import('@testing-library/react');
const { useAtelierStore, initialAtelierState } = await import('./store/atelier');
const { historyKeys } = await import('./api/history');
const { updateBatchTile } = await import('./hooks/historyCache');
const { default: App } = await import('./App');

const originalFetch = globalThis.fetch;
const originalMatchMedia = window.matchMedia.bind(window);

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  window.matchMedia = originalMatchMedia;
  useAtelierStore.setState(initialAtelierState, true);
});

const model: Model = { id: 'm', name: 'M', backend: 'cloud', tag: 'cloud', latency: 'fast', pool: 'shared', supportedRatios: ['1:1'], concurrencyCapPerUser: 4, maxCountPerBatch: 4 };
const i2v: Model = { ...model, id: 'v', name: 'V', supportsI2V: true, outputsVideo: true };

const settled: Batch = {
  id: 'batch-settled',
  prompt: 'A settled batch',
  ratio: '1:1',
  modelId: model.id,
  modelLabel: model.name,
  createdAt: 1_000,
  collectionId: null,
  pinned: false,
  status: 'done',
  tiles: [{ id: 'tile-settled', seed: 1, status: 'done', url: '/api/img/tile-settled', ext: 'png', mime: 'image/png', completedAt: 1_000 }],
};
const streaming: Batch = {
  id: 'batch-streaming',
  prompt: 'A streaming batch',
  ratio: '1:1',
  modelId: model.id,
  modelLabel: model.name,
  createdAt: 2_000,
  startedAt: 2_000,
  collectionId: null,
  pinned: false,
  status: 'running',
  tiles: [
    { id: 'tile-a', seed: 2, status: 'loading' },
    { id: 'tile-b', seed: 3, status: 'loading' },
  ],
};

function propsOf(props: Record<string, unknown>): { batchId?: string; tileId?: string } {
  const batch = props.batch as Batch | undefined;
  const tile = props.tile as Tile | undefined;
  return { ...(batch ? { batchId: batch.id } : {}), ...(tile ? { tileId: tile.id } : {}) };
}

function settledRenders(): Record<string, number> {
  const counts: Record<string, number> = { BatchView: 0, TileRowImpl: 0, ImageTile: 0, SidebarFeedRow: 0 };
  for (const { name, props } of renders) {
    if (!(name in counts)) continue;
    const { batchId, tileId } = propsOf(props);
    if (batchId === settled.id || tileId === 'tile-settled') counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

test('streaming one batch re-renders no other batch row, tile or sidebar row', async () => {
  useAtelierStore.setState(initialAtelierState, true);
  if (window.location.origin === 'null') window.location.href = 'http://localhost/';
  window.history.replaceState({}, '', 'http://localhost/');
  window.matchMedia = mock((media: string) => ({ matches: false, media, onchange: null, addEventListener: mock(), removeEventListener: mock(), addListener: mock(), removeListener: mock(), dispatchEvent: () => true }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  globalThis.fetch = mock((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/models')) return Promise.resolve(Response.json([model, i2v]));
    if (url.endsWith('/collections')) return Promise.resolve(Response.json({ items: [], summary: { totalCount: 2, pinnedCount: 0, unsortedCount: 2, archivedTotalCount: 0, archivedPinnedCount: 0, archivedUnsortedCount: 0 } }));
    if (url.endsWith('/prompts')) return Promise.resolve(Response.json({ templates: [], variableLists: [], dimensions: [] }));
    if (url.includes('/history')) return Promise.resolve(Response.json({ items: [streaming, settled], nextCursor: null }));
    return Promise.resolve(Response.json({}));
  }) as unknown as typeof fetch;

  render(<QueryClientProvider client={client}><App /></QueryClientProvider>);
  await screen.findAllByRole('button', { name: 'Open batch: A settled batch' });
  // Let mount-time effects (seen marks, measurements, queries) settle first.
  for (let tick = 0; tick < 5; tick += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  // The settled batch is mounted in both the feed and the rail.
  expect(Object.values(settledRenders()).every((count) => count > 0)).toBe(true);
  renders.length = 0;

  // The stream: progress and previews land in the store, terminal tiles in
  // the history cache (useGenerate's write paths).
  const store = useAtelierStore.getState();
  for (let step = 1; step <= 3; step += 1) {
    await act(async () => {
      store.setTileProgress('tile-a', { progress: step / 4 });
      store.setTilePreview('tile-a', { url: `data:image/png;base64,${String(step)}`, index: step });
      await Promise.resolve();
    });
  }
  await act(async () => {
    updateBatchTile(client, historyKeys.list(), streaming.id, { id: 'tile-a', seed: 0, status: 'done', url: '/api/img/tile-a', ext: 'png', mime: 'image/png', completedAt: 3_000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await act(async () => {
    updateBatchTile(client, historyKeys.list(), streaming.id, { id: 'tile-b', seed: 0, status: 'failed', error: 'timed out', completedAt: 3_100 });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  // The streaming batch did re-render, so the probe is live.
  expect(renders.some(({ name, props }) => name === 'BatchView' && propsOf(props).batchId === streaming.id)).toBe(true);
  expect(settledRenders()).toEqual({ BatchView: 0, TileRowImpl: 0, ImageTile: 0, SidebarFeedRow: 0 });
  client.clear();
});

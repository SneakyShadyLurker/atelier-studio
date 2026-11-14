import { beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import * as bus from '../orchestrator/bus';
import * as queue from '../orchestrator/queue';
import { parseSseText, testRuntime } from './helpers';
import { encodeSseFrame } from '../lifecycle/sse';
import { MAX_EVENT_STREAMS_PER_BATCH, setBatchesEventsSnapshotRaceHookForTests } from '../routes/batches.events';

const USER_ID = 'events-user';
const OTHER_USER_ID = 'other-user';
const QUEUED_BATCH_ID = '00000000-0000-4000-8000-000000000101';
const DONE_BATCH_ID = '00000000-0000-4000-8000-000000000102';
const CROSS_USER_BATCH_ID = '00000000-0000-4000-8000-000000000103';
type IntervalCallback = Parameters<typeof setInterval>[0];

beforeEach(() => {
  bus.resetForTests();
  queue.resetQueueForTests();
});

test('GET /api/batches/:id/events replays queued batch state for the owner', async () => {
  const runtime = testRuntime();
  const { db } = runtime;
  seedUser(db, USER_ID);
  insertBatch(db, {
    id: QUEUED_BATCH_ID,
    userId: USER_ID,
    status: 'queued',
    pool: 'shared',
    createdAt: 1_000,
  });
  insertLoadingTile(db, QUEUED_BATCH_ID, USER_ID, '00000000-0000-4000-8000-000000000201', 0);
  queue.enqueue('shared', {
    batchId: QUEUED_BATCH_ID,
    userId: USER_ID,
    modelId: 'mock-slow',
    count: 1,
    queuedAt: 1_000,
  });

  const res = await runtime.fetch(`/api/batches/${QUEUED_BATCH_ID}/events`, {
    headers: { 'Remote-User': USER_ID },
  });

  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const reader = res.body?.getReader();
  if (!reader) throw new Error('expected stream body');
  const chunk = await reader.read();
  await reader.cancel();
  const chunkValue = chunk.value instanceof Uint8Array ? chunk.value : new Uint8Array();
  const text = new TextDecoder().decode(chunkValue);
  const frames = parseSseText(text);
  expect(frames[0]).toEqual({
    event: 'batch',
    data: {
      batchId: QUEUED_BATCH_ID,
      createdAt: 1_000,
      status: 'queued',
      queueLengthAhead: 0,
      tiles: [{ tileId: '00000000-0000-4000-8000-000000000201', tileIndex: 0, seed: 100 }],
    },
  });
});

test('GET /api/batches/:id/events drops optional keepalive comments under back-pressure', async () => {
  const runtime = testRuntime();
  const { db } = runtime;
  seedUser(db, USER_ID);
  const batchId = '00000000-0000-4000-8000-000000000106';
  insertBatch(db, {
    id: batchId,
    userId: USER_ID,
    status: 'running',
    pool: 'shared',
    createdAt: 6_000,
  });
  insertLoadingTile(db, batchId, USER_ID, '00000000-0000-4000-8000-000000000601', 0);

  const largeBufferedFrame = new TextEncoder().encode(`:${'x'.repeat(1024 * 1024)}\n\n`);
  bus.broadcastTerminal(batchId, { bytes: largeBufferedFrame, key: null });

  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const keepalive = { callback: null as (() => void) | null };
  globalThis.setInterval = ((callback: IntervalCallback) => {
    keepalive.callback = typeof callback === 'function' ? () => { callback(); } : null;
    return 1 as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  globalThis.clearInterval = (() => undefined);
  try {
    const res = await runtime.fetch(`/api/batches/${batchId}/events`, {
      headers: { 'Remote-User': USER_ID },
    });
    expect(res.status).toBe(200);
    const callback = keepalive.callback;
    if (!callback) throw new Error('expected keepalive interval');

    callback();
    bus.closeBatch(batchId);

    const text = await res.text();
    expect(text).not.toContain(':keepalive\n\n');
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test('GET /api/batches/:id/events closes stream scaffolding when subscribe fails', async () => {
  const runtime = testRuntime();
  const { db } = runtime;
  seedUser(db, USER_ID);
  const batchId = '00000000-0000-4000-8000-000000000108';
  insertBatch(db, {
    id: batchId,
    userId: USER_ID,
    status: 'running',
    pool: 'shared',
    createdAt: 8_000,
  });
  insertLoadingTile(db, batchId, USER_ID, '00000000-0000-4000-8000-000000000801', 0);

  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const intervalToken = 7 as unknown as ReturnType<typeof setInterval>;
  let scheduledKeepalive = false;
  let clearCalls = 0;
  globalThis.setInterval = ((callback: IntervalCallback) => {
    scheduledKeepalive = typeof callback === 'function';
    return intervalToken;
  }) as typeof setInterval;
  globalThis.clearInterval = ((token: ReturnType<typeof setInterval>) => {
    if (token === intervalToken) clearCalls += 1;
  }) as typeof clearInterval;
  try {
    bus.failNextSubscribeForTests(new Error('synthetic replay failure'));
    const res = await runtime.fetch(`/api/batches/${batchId}/events`, {
      headers: { 'Remote-User': USER_ID },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    expect(scheduledKeepalive).toBe(true);
    expect(clearCalls).toBe(1);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test('GET /api/batches/:id/events emits one batch event when buffered and snapshot batch frames overlap', async () => {
  const runtime = testRuntime();
  const { db } = runtime;
  seedUser(db, USER_ID);
  const batchId = '00000000-0000-4000-8000-000000000107';
  insertBatch(db, {
    id: batchId,
    userId: USER_ID,
    status: 'running',
    pool: 'shared',
    createdAt: 7_000,
  });
  insertLoadingTile(db, batchId, USER_ID, '00000000-0000-4000-8000-000000000701', 0);
  bus.broadcastTerminal(batchId, {
    bytes: encodeSseFrame('batch', {
      batchId,
      status: 'running',
      tiles: [{ tileId: '00000000-0000-4000-8000-000000000701', tileIndex: 0, seed: 100 }],
    }),
    key: { event: 'batch' },
  });

  const res = await runtime.fetch(`/api/batches/${batchId}/events`, {
    headers: { 'Remote-User': USER_ID },
  });
  expect(res.status).toBe(200);
  bus.closeBatch(batchId);

  const frames = parseSseText(await res.text());
  expect(frames.filter((frame) => frame.event === 'batch')).toHaveLength(1);
});

test('GET /api/batches/:id/events replays terminal tile events and done for late subscribers', async () => {
  const runtime = testRuntime();
  const { db } = runtime;
  seedUser(db, USER_ID);
  insertBatch(db, {
    id: DONE_BATCH_ID,
    userId: USER_ID,
    status: 'done',
    pool: 'shared',
    createdAt: 2_000,
  });
  insertDoneTile(db, DONE_BATCH_ID, USER_ID, '00000000-0000-4000-8000-000000000301', 0, 2_100);
  insertFailedTile(db, DONE_BATCH_ID, USER_ID, '00000000-0000-4000-8000-000000000302', 1, 2_200);

  const res = await runtime.fetch(`/api/batches/${DONE_BATCH_ID}/events`, {
    headers: { 'Remote-User': USER_ID },
  });

  expect(res.status).toBe(200);
  const frames = parseSseText(await res.text());
  expect(frames.map((frame) => frame.event)).toEqual(['batch', 'tile', 'tile', 'done']);
  const doneFrame = frames[1];
  const failedFrame = frames[2];
  if (!doneFrame || !failedFrame) throw new Error('expected terminal tile frames');
  expect(doneFrame.data).toMatchObject({
    tileId: '00000000-0000-4000-8000-000000000301',
    tileIndex: 0,
    status: 'done',
    url: '/api/img/00000000-0000-4000-8000-000000000301',
    thumbUrl: '/api/img/00000000-0000-4000-8000-000000000301/thumb',
    ext: 'png',
    mime: 'image/png',
    completedAt: 2_100,
  });
  expect(failedFrame.data).toMatchObject({
    tileId: '00000000-0000-4000-8000-000000000302',
    tileIndex: 1,
    status: 'failed',
    error: 'internal error',
    completedAt: 2_200,
  });
  expect(frames[3]).toEqual({ event: 'done', data: { batchId: DONE_BATCH_ID } });
});

test('GET /api/batches/:id/events returns 404 for another user batch', async () => {
  const runtime = testRuntime();
  const { db } = runtime;
  seedUser(db, USER_ID);
  seedUser(db, OTHER_USER_ID);
  insertBatch(db, {
    id: CROSS_USER_BATCH_ID,
    userId: USER_ID,
    status: 'queued',
    pool: 'shared',
    createdAt: 3_000,
  });

  const res = await runtime.fetch(`/api/batches/${CROSS_USER_BATCH_ID}/events`, {
    headers: { 'Remote-User': OTHER_USER_ID },
  });

  expect(res.status).toBe(404);
});

test('GET /api/batches/:id/events replays completed rows even after the live bus is empty', async () => {
  const runtime = testRuntime();
  const { db } = runtime;
  seedUser(db, USER_ID);
  const batchId = '00000000-0000-4000-8000-000000000104';
  insertBatch(db, {
    id: batchId,
    userId: USER_ID,
    status: 'done',
    pool: 'shared',
    createdAt: 4_000,
  });
  insertDoneTile(db, batchId, USER_ID, '00000000-0000-4000-8000-000000000401', 0, 4_100);
  insertDoneTile(db, batchId, USER_ID, '00000000-0000-4000-8000-000000000402', 1, 4_200);
  insertDoneTile(db, batchId, USER_ID, '00000000-0000-4000-8000-000000000403', 2, 4_300);
  bus.closeBatch(batchId);

  const res = await runtime.fetch(`/api/batches/${batchId}/events`, {
    headers: { 'Remote-User': USER_ID },
  });

  expect(res.status).toBe(200);
  const frames = parseSseText(await res.text());
  expect(frames.map((frame) => frame.event)).toEqual(['batch', 'tile', 'tile', 'tile', 'done']);
  expect(frames.slice(1, 4).map((frame) => (frame.data as { tileIndex: number }).tileIndex)).toEqual([0, 1, 2]);
});

test('GET /api/batches/:id/events omits archived tiles from replay', async () => {
  const runtime = testRuntime();
  const { db } = runtime;
  seedUser(db, USER_ID);
  const batchId = '00000000-0000-4000-8000-000000000105';
  insertBatch(db, {
    id: batchId,
    userId: USER_ID,
    status: 'done',
    pool: 'shared',
    createdAt: 5_000,
  });
  insertDoneTile(db, batchId, USER_ID, '00000000-0000-4000-8000-000000000501', 0, 5_100);
  insertDoneTile(db, batchId, USER_ID, '00000000-0000-4000-8000-000000000502', 1, 5_200);
  db.query('UPDATE tiles SET archived_at = ? WHERE id = ?')
    .run(5_300, '00000000-0000-4000-8000-000000000501');

  const res = await runtime.fetch(`/api/batches/${batchId}/events`, {
    headers: { 'Remote-User': USER_ID },
  });

  expect(res.status).toBe(200);
  const frames = parseSseText(await res.text());
  expect(frames.map((frame) => frame.event)).toEqual(['batch', 'tile', 'done']);
  expect((frames[1]?.data as { tileId: string }).tileId).toBe('00000000-0000-4000-8000-000000000502');
  expect((frames[0]?.data as { tiles: { tileId: string; tileIndex: number; seed: number }[] }).tiles).toEqual([
    { tileId: '00000000-0000-4000-8000-000000000502', tileIndex: 1, seed: 101 },
  ]);
});

test('GET /api/batches/:id/events caps concurrently open streams per batch', async () => {
  const runtime = testRuntime();
  const { db } = runtime;
  seedUser(db, USER_ID);
  const batchId = '00000000-0000-4000-8000-000000000901';
  const otherBatchId = '00000000-0000-4000-8000-000000000902';
  for (const [index, id] of [batchId, otherBatchId].entries()) {
    insertBatch(db, { id, userId: USER_ID, status: 'running', pool: 'shared', createdAt: 9_000 + index });
    insertLoadingTile(db, id, USER_ID, `00000000-0000-4000-8000-00000000095${index}`, 0);
  }
  const open = (id: string, signal?: AbortSignal) => runtime.fetch(`/api/batches/${id}/events`, {
    headers: { 'Remote-User': USER_ID },
    ...(signal ? { signal } : {}),
  });
  const controllers = Array.from({ length: 8 }, () => new AbortController());
  const streams: Response[] = [];
  try {
    for (const controller of controllers) {
      const res = await open(batchId, controller.signal);
      expect(res.status).toBe(200);
      streams.push(res);
    }

    const rejected = await open(batchId);
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get('Retry-After')).toBe('5');
    expect(await rejected.json()).toEqual({
      error: 'too many event streams',
      code: 'QUEUE_FULL',
      retry_after_seconds: 5,
    });

    // Another batch of the same user keeps its own allowance.
    const other = await open(otherBatchId);
    expect(other.status).toBe(200);
    streams.push(other);

    // A client disconnect frees its slot for a new stream.
    controllers[0]?.abort();
    const readmitted = await open(batchId);
    expect(readmitted.status).toBe(200);
    streams.push(readmitted);
    expect((await open(batchId)).status).toBe(429);

    // So does a reader cancel.
    await streams[1]?.body?.cancel();
    const afterCancel = await open(batchId);
    expect(afterCancel.status).toBe(200);
    streams.push(afterCancel);
  } finally {
    for (const controller of controllers) controller.abort();
    await Promise.all(streams.map(async (res) => { await res.body?.cancel().catch(() => undefined); }));
  }
});

test('GET /api/batches/:id/events streams on a terminal batch release their slot when they close', async () => {
  const runtime = testRuntime();
  const { db } = runtime;
  seedUser(db, USER_ID);
  const batchId = '00000000-0000-4000-8000-000000000903';
  insertBatch(db, { id: batchId, userId: USER_ID, status: 'done', pool: 'shared', createdAt: 9_100 });
  insertDoneTile(db, batchId, USER_ID, '00000000-0000-4000-8000-000000000960', 0, 9_200);

  const responses = await Promise.all(Array.from({ length: 12 }, () => runtime.fetch(`/api/batches/${batchId}/events`, {
    headers: { 'Remote-User': USER_ID },
  })));
  for (const res of responses) {
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('event: done');
  }
});

test('GET /api/batches/:id/events releases the slot of a stream whose setup fails', async () => {
  const runtime = testRuntime({ LOG_LEVEL: 'silent' });
  const { db } = runtime;
  seedUser(db, USER_ID);
  const batchId = '00000000-0000-4000-8000-000000000904';
  insertBatch(db, { id: batchId, userId: USER_ID, status: 'running', pool: 'shared', createdAt: 9_300 });
  insertLoadingTile(db, batchId, USER_ID, '00000000-0000-4000-8000-000000000970', 0);
  const open = () => runtime.fetch(`/api/batches/${batchId}/events`, { headers: { 'Remote-User': USER_ID } });

  for (let attempt = 0; attempt < MAX_EVENT_STREAMS_PER_BATCH; attempt += 1) {
    bus.failNextSubscribeForTests(new Error('synthetic subscribe failure'));
    expect(await (await open()).text()).toBe('');
  }
  setBatchesEventsSnapshotRaceHookForTests(() => { throw new Error('synthetic snapshot failure'); });
  try {
    for (let attempt = 0; attempt < MAX_EVENT_STREAMS_PER_BATCH; attempt += 1) {
      expect((await open()).status).toBe(500);
    }
  } finally {
    setBatchesEventsSnapshotRaceHookForTests(null);
  }

  const streams: Response[] = [];
  try {
    for (let attempt = 0; attempt < MAX_EVENT_STREAMS_PER_BATCH; attempt += 1) {
      const res = await open();
      expect(res.status).toBe(200);
      streams.push(res);
    }
    expect((await open()).status).toBe(429);
  } finally {
    await Promise.all(streams.map(async (res) => { await res.body?.cancel().catch(() => undefined); }));
  }
});

function seedUser(db: Database, userId: string): void {
  db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run(userId, 1);
}

function insertBatch(
  db: Database,
  row: {
    id: string;
    userId: string;
    status: 'queued' | 'running' | 'done';
    pool: 'shared' | 'byok' | 'local';
    createdAt: number;
  },
): void {
  db.query(
    `INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, status, pool)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.userId, 'prompt', '1:1', 'mock-slow', 'Mock Slow', row.createdAt, row.status, row.pool);
}

function insertLoadingTile(db: Database, batchId: string, userId: string, tileId: string, tileIndex: number): void {
  db.query(
    `INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status)
     VALUES (?, ?, ?, ?, ?, 'loading')`,
  ).run(tileId, batchId, userId, tileIndex, 100 + tileIndex);
}

function insertDoneTile(
  db: Database,
  batchId: string,
  userId: string,
  tileId: string,
  tileIndex: number,
  completedAt: number,
): void {
  db.query(
    `INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, ext, mime, completed_at)
     VALUES (?, ?, ?, ?, ?, 'done', 'png', 'image/png', ?)`,
  ).run(tileId, batchId, userId, tileIndex, 100 + tileIndex, completedAt);
}

function insertFailedTile(
  db: Database,
  batchId: string,
  userId: string,
  tileId: string,
  tileIndex: number,
  completedAt: number,
): void {
  db.query(
    `INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, error, completed_at)
     VALUES (?, ?, ?, ?, ?, 'failed', 'internal error', ?)`,
  ).run(tileId, batchId, userId, tileIndex, 100 + tileIndex, completedAt);
}

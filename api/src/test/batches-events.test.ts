import { beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import * as bus from '../orchestrator/bus';
import * as queue from '../orchestrator/queue';
import { parseSseText, testRuntime } from './helpers';
import { encodeSseFrame } from '../lifecycle/sse';

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

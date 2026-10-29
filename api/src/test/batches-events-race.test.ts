import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { encodeSseFrame, terminalFrame, type TerminalFrame } from '../lifecycle/sse';
import * as bus from '../orchestrator/bus';
import * as queue from '../orchestrator/queue';
import { setBatchesEventsSnapshotRaceHookForTests } from '../routes/batches.events';
import { parseSseText, testRuntime } from './helpers';

const USER_ID = 'race-user';
function keyless(bytes: Uint8Array): TerminalFrame {
  return { bytes, key: null };
}

beforeEach(() => {
  bus.resetForTests();
  queue.resetQueueForTests();
});

afterEach(() => {
  setBatchesEventsSnapshotRaceHookForTests(null);
});

// The route's `start` callback runs synchronously: snapshot DB, subscribe to
// the bus, then replay. After `start` returns, the subscriber is still live
// until the route emits `done` and closes. By keeping at least one tile in
// `loading` state at snapshot time the batch stays non-terminal so the
// subscriber survives long enough to receive simulated live broadcasts.

test('GET /api/batches/:id/events drops a live broadcast for a tile already replayed from the DB snapshot', async () => {
  const runtime = testRuntime();
  const { db } = runtime;
  seedUser(db, USER_ID);
  const batchId = '00000000-0000-4000-8000-00000000a001';
  const replayedTileId = '00000000-0000-4000-8000-00000000a101';
  const stillLoadingTileId = '00000000-0000-4000-8000-00000000a102';
  insertBatch(db, { id: batchId, userId: USER_ID, status: 'running', pool: 'shared', createdAt: 1_000 });
  insertDoneTile(db, batchId, USER_ID, replayedTileId, 0, 1_100);
  insertLoadingTile(db, batchId, USER_ID, stillLoadingTileId, 1);

  const res = await runtime.fetch(`/api/batches/${batchId}/events`, {
    headers: { 'Remote-User': USER_ID },
  });
  expect(res.status).toBe(200);

  // Simulate the audit's race: the orchestrator's `broadcastTerminal` for
  // the already-terminal-at-snapshot tile fires AFTER our route subscribed.
  // The dedup wrapper must drop it because the tile id is already in
  // `replayedTerminalTileIds`. Without the fix, the consumer would observe
  // a duplicate `tile` frame.
  bus.broadcastTerminal(batchId, terminalFrame('tile', terminalTilePayload(replayedTileId, 0, 1_100)));

  // Now drive the loading tile to terminal via a real live broadcast +
  // close the stream.
  bus.broadcastTerminal(batchId, terminalFrame('tile', terminalTilePayload(stillLoadingTileId, 1, 1_200)));
  bus.broadcastTerminal(batchId, terminalFrame('done', { batchId }));
  bus.closeBatch(batchId);

  const frames = parseSseText(await res.text());
  const tileFrames = frames.filter((frame) => frame.event === 'tile');
  const tileIds = tileFrames.map((frame) => (frame.data as { tileId: string }).tileId);
  expect(tileIds).toEqual([replayedTileId, stillLoadingTileId]);
  expect(tileIds.filter((id) => id === replayedTileId).length).toBe(1);
  expect(frames.filter((frame) => frame.event === 'done').length).toBe(1);
});

test('GET /api/batches/:id/events emits a live broadcast for a tile that was loading at snapshot time', async () => {
  const runtime = testRuntime();
  const { db } = runtime;
  seedUser(db, USER_ID);
  const batchId = '00000000-0000-4000-8000-00000000a002';
  const tileId = '00000000-0000-4000-8000-00000000a201';
  insertBatch(db, { id: batchId, userId: USER_ID, status: 'running', pool: 'shared', createdAt: 2_000 });
  insertLoadingTile(db, batchId, USER_ID, tileId, 0);

  const res = await runtime.fetch(`/api/batches/${batchId}/events`, {
    headers: { 'Remote-User': USER_ID },
  });
  expect(res.status).toBe(200);

  // The snapshot saw the tile as loading; replay did not emit a terminal
  // for it. After subscribe, the orchestrator flips the tile to terminal
  // and broadcasts. The live sink must propagate that frame (no
  // over-dedup).
  bus.broadcastTerminal(batchId, terminalFrame('tile', terminalTilePayload(tileId, 0, 2_100)));
  bus.broadcastTerminal(batchId, terminalFrame('done', { batchId }));
  bus.closeBatch(batchId);

  const frames = parseSseText(await res.text());
  expect(frames.map((frame) => frame.event)).toEqual(['batch', 'tile', 'done']);
  expect(frames[1]?.data).toMatchObject({ tileId, status: 'done' });
});

test('GET /api/batches/:id/events drops a duplicate live broadcast for a tile the live sink already emitted', async () => {
  const runtime = testRuntime();
  const { db } = runtime;
  seedUser(db, USER_ID);
  const batchId = '00000000-0000-4000-8000-00000000a003';
  const tileId = '00000000-0000-4000-8000-00000000a301';
  insertBatch(db, { id: batchId, userId: USER_ID, status: 'running', pool: 'shared', createdAt: 3_000 });
  insertLoadingTile(db, batchId, USER_ID, tileId, 0);

  const res = await runtime.fetch(`/api/batches/${batchId}/events`, {
    headers: { 'Remote-User': USER_ID },
  });
  expect(res.status).toBe(200);

  const tileFrame = terminalFrame('tile', terminalTilePayload(tileId, 0, 3_100));
  // First broadcast: tile not in seen set (loading at snapshot) → emitted
  // and added.
  bus.broadcastTerminal(batchId, tileFrame);
  // Second broadcast (defensive lock-in): dedup must drop it.
  bus.broadcastTerminal(batchId, tileFrame);
  bus.broadcastTerminal(batchId, terminalFrame('done', { batchId }));
  bus.closeBatch(batchId);

  const frames = parseSseText(await res.text());
  expect(frames.map((frame) => frame.event)).toEqual(['batch', 'tile', 'done']);
});

test('GET /api/batches/:id/events deduplicates a live `done` against the replayed `done` for a terminal batch', async () => {
  const runtime = testRuntime();
  const { db } = runtime;
  seedUser(db, USER_ID);
  const batchId = '00000000-0000-4000-8000-00000000a004';
  const tileId = '00000000-0000-4000-8000-00000000a401';
  insertBatch(db, { id: batchId, userId: USER_ID, status: 'done', pool: 'shared', createdAt: 4_000 });
  insertDoneTile(db, batchId, USER_ID, tileId, 0, 4_100);

  // A terminal batch at snapshot time: the replay path emits `done` and
  // closes the stream synchronously inside `start`. Any subsequent live
  // broadcast is rejected because the subscriber was already detached on
  // close. Defense in depth: even if it weren't, `batchDoneEmitted` would
  // drop the duplicate.
  const res = await runtime.fetch(`/api/batches/${batchId}/events`, {
    headers: { 'Remote-User': USER_ID },
  });
  expect(res.status).toBe(200);

  bus.broadcastTerminal(batchId, terminalFrame('done', { batchId }));

  const frames = parseSseText(await res.text());
  expect(frames.map((frame) => frame.event)).toEqual(['batch', 'tile', 'done']);
});

test('GET /api/batches/:id/events captures a terminal broadcast that races between subscribe and snapshot', async () => {
  // Audit T2-001: regression guard for the subscribe-first ordering. Drive
  // the race by inserting a `loading` row into the DB AFTER the orchestrator
  // would have already broadcast its terminal — i.e. the broadcast fires
  // BEFORE the snapshot reads the row. The route subscribes first, so the
  // live frame lands in `pendingLive`; the snapshot sees the tile as loading
  // (no replay terminal); the pending drain emits the terminal exactly once.
  const runtime = testRuntime();
  const { db } = runtime;
  seedUser(db, USER_ID);
  const batchId = '00000000-0000-4000-8000-00000000a006';
  const tileId = '00000000-0000-4000-8000-00000000a601';
  insertBatch(db, { id: batchId, userId: USER_ID, status: 'running', pool: 'shared', createdAt: 6_000 });
  insertLoadingTile(db, batchId, USER_ID, tileId, 0);

  // Pre-broadcast the terminal frame BEFORE the route subscribes. Without
  // subscribe-first, this frame would be dropped (no subscriber when
  // broadcast fires) and the DB snapshot still shows the tile as loading,
  // so the consumer would observe NO terminal frame for that tile ever.
  // With subscribe-first, the subscribe callback drains the bus's terminal
  // buffer into the just-attached sink — confirming the frame survives the
  // race.
  bus.broadcastTerminal(batchId, terminalFrame('tile', terminalTilePayload(tileId, 0, 6_100)));

  const res = await runtime.fetch(`/api/batches/${batchId}/events`, {
    headers: { 'Remote-User': USER_ID },
  });
  expect(res.status).toBe(200);

  // Drive the batch to completion via a real live `done`.
  bus.broadcastTerminal(batchId, terminalFrame('done', { batchId }));
  bus.closeBatch(batchId);

  const frames = parseSseText(await res.text());
  const tileFrames = frames.filter((frame) => frame.event === 'tile');
  expect(tileFrames.length).toBe(1);
  expect((tileFrames[0]?.data as { tileId: string }).tileId).toBe(tileId);
  expect((tileFrames[0]?.data as { status: string }).status).toBe('done');
  expect(frames.filter((frame) => frame.event === 'done').length).toBe(1);
});

test('GET /api/batches/:id/events drains a tile terminal that races between tile and batch snapshots', async () => {
  const runtime = testRuntime();
  const { db } = runtime;
  seedUser(db, USER_ID);
  const batchId = '00000000-0000-4000-8000-00000000a007';
  const tileId = '00000000-0000-4000-8000-00000000a701';
  insertBatch(db, { id: batchId, userId: USER_ID, status: 'running', pool: 'shared', createdAt: 7_000 });
  insertLoadingTile(db, batchId, USER_ID, tileId, 0);

  // The route subscribes before reading SQLite, so these buffered frames are
  // captured in pendingLive. The hook then simulates the worker commit after
  // queryTiles() returned `loading` but before batchIsTerminal() runs.
  bus.broadcastTerminal(batchId, terminalFrame('tile', terminalTilePayload(tileId, 0, 7_100)));
  bus.broadcastTerminal(batchId, terminalFrame('done', { batchId }));
  setBatchesEventsSnapshotRaceHookForTests(() => {
    db.query(
      "UPDATE tiles SET status = 'done', ext = 'png', mime = 'image/png', completed_at = ? WHERE id = ?",
    ).run(7_100, tileId);
    db.query("UPDATE batches SET status = 'done' WHERE id = ?").run(batchId);
  });

  const res = await runtime.fetch(`/api/batches/${batchId}/events`, {
    headers: { 'Remote-User': USER_ID },
  });

  expect(res.status).toBe(200);
  const frames = parseSseText(await res.text());
  expect(frames.map((frame) => frame.event)).toEqual(['batch', 'tile', 'done']);
  expect(frames[1]?.data).toMatchObject({ tileId, status: 'done' });
});

test('GET /api/batches/:id/events does not dedup partial frames for the same tile id', async () => {
  const runtime = testRuntime();
  const { db } = runtime;
  seedUser(db, USER_ID);
  const batchId = '00000000-0000-4000-8000-00000000a005';
  const tileId = '00000000-0000-4000-8000-00000000a501';
  insertBatch(db, { id: batchId, userId: USER_ID, status: 'running', pool: 'shared', createdAt: 5_000 });
  insertLoadingTile(db, batchId, USER_ID, tileId, 0);

  const res = await runtime.fetch(`/api/batches/${batchId}/events`, {
    headers: { 'Remote-User': USER_ID },
  });
  expect(res.status).toBe(200);

  // Keyless frames (partials are advisory and may race freely) pass through
  // dedup untouched.
  bus.broadcastTerminal(batchId, keyless(encodeSseFrame('tile', {
    tileId,
    tileIndex: 0,
    status: 'partial',
    preview: 'data:image/png;base64,AAA',
    index: 0,
  })));
  bus.broadcastTerminal(batchId, keyless(encodeSseFrame('tile', {
    tileId,
    tileIndex: 0,
    status: 'partial',
    preview: 'data:image/png;base64,BBB',
    index: 1,
  })));
  bus.broadcastTerminal(batchId, terminalFrame('tile', terminalTilePayload(tileId, 0, 5_100)));
  bus.broadcastTerminal(batchId, terminalFrame('done', { batchId }));
  bus.closeBatch(batchId);

  const frames = parseSseText(await res.text());
  const events = frames.map((frame) => frame.event);
  expect(events).toEqual(['batch', 'tile', 'tile', 'tile', 'done']);
  expect((frames[1]?.data as { status: string }).status).toBe('partial');
  expect((frames[2]?.data as { status: string }).status).toBe('partial');
  expect((frames[3]?.data as { status: string }).status).toBe('done');
});

function terminalTilePayload(tileId: string, tileIndex: number, completedAt: number) {
  return {
    tileId,
    tileIndex,
    status: 'done' as const,
    url: `/api/img/${tileId}`,
    thumbUrl: `/api/img/${tileId}/thumb`,
    ext: 'png' as const,
    mime: 'image/png' as const,
    completedAt,
  };
}

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

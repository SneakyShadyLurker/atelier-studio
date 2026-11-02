import { Hono } from 'hono';
import type {
  BatchEvent,
  BatchStatus,
  DoneEvent,
  GptModerationReason,
  MediaExt,
  MediaMime,
  Pool,
  TileErrorCategory,
  TileStatus,
} from '@atelier/shared';
import type { AppEnv } from '../server-env';
import { tileModeration } from '../db/moderation';
import {
  KEEPALIVE_MS,
  encodeSseComment,
  sseHeaders,
  terminalFrame,
  type TerminalFrame,
  type TerminalTileEvent,
} from '../lifecycle/sse';
import * as bus from '../orchestrator/bus';
import * as queue from '../orchestrator/queue';
import { refImageIdsForBatch } from '../orchestrator/refImages';
import { doneTileEvent } from '../orchestrator/tileEvents';
import { parseParams } from './_http';
import { UuidParamSchema } from './history.schema';

type SnapshotRaceHook = () => void;
let snapshotRaceHookForTests: SnapshotRaceHook | null = null;

export function setBatchesEventsSnapshotRaceHookForTests(hook: SnapshotRaceHook | null): void {
  snapshotRaceHookForTests = hook;
}

interface BatchEventRow {
  id: string;
  user_id: string;
  status: BatchStatus;
  pool: Pool;
  created_at: number;
  started_at: number | null;
}

interface TileEventRow {
  id: string;
  tile_index: number;
  seed: number;
  status: TileStatus;
  ext: MediaExt | null;
  mime: MediaMime | null;
  error: TileErrorCategory | null;
  moderation_reason: GptModerationReason | null;
  moderation_categories: string | null;
  completed_at: number | null;
}

export const batchesEventsRoutes = new Hono<AppEnv>().get('/batches/:batchId/events', (c) => {
  const params = parseParams(c, UuidParamSchema);
  if (!params.ok) return params.response;

  const batch = c.var.db
    .query<BatchEventRow, [string, string]>(
      'SELECT id, user_id, status, pool, created_at, started_at FROM batches WHERE id = ? AND user_id = ?',
    )
    .get(params.value.batchId, c.var.userId);
  if (!batch) return c.body(null, 404);

  // Subscribe to the bus BEFORE taking the DB snapshot, then drain the
  // snapshot through replay, then drain any live frames captured in the
  // subscribe→snapshot window. This closes the race window where the
  // orchestrator could broadcast a terminal frame between snapshot and
  // subscribe and lose it to a not-yet-attached subscriber. See audit T2-001
  // in docs/superpowers/audit/01-concurrency.md.
  const replayedTerminalTileIds = new Set<string>();
  let batchDoneEmitted = false;
  let batchEventEmitted = false;

  let closeStream: () => void = () => undefined;
  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      let closed = false;
      let keepalive: ReturnType<typeof setInterval> | null = null;
      let unsubscribe: () => void = () => undefined;

      const close = () => {
        if (closed) return;
        closed = true;
        if (keepalive !== null) clearInterval(keepalive);
        unsubscribe();
        c.req.raw.signal.removeEventListener('abort', close);
        try {
          controller.close();
        } catch {
          /* stream may already be closed by the runtime */
        }
      };
      closeStream = close;

      // writeTerminal: snapshot-replay sink. Bypasses dedup since the snapshot
      // is the canonical source — its frames are unconditional. Bookkeeping
      // is updated so subsequent live frames (via emitTerminal) dedup
      // against what we emitted from the snapshot.
      const writeTerminal = (frame: TerminalFrame) => {
        if (closed) return;
        const key = frame.key;
        if (key?.event === 'tile') replayedTerminalTileIds.add(key.tileId);
        if (key?.event === 'done') batchDoneEmitted = true;
        if (key?.event === 'batch') batchEventEmitted = true;
        try {
          controller.enqueue(frame.bytes);
        } catch {
          close();
        }
      };
      // Live-broadcast sink: until the snapshot is replayed, frames go into a
      // pending buffer; after replay we drain them through the same dedup
      // path. Drop a frame whose dedup key (carried on the bus message) was
      // already emitted (from snapshot replay or an earlier broadcast on this
      // stream): a terminal tile, a duplicate `done` or `batch`. With
      // `replayBuffered: true` the bus may replay a `batch` frame the
      // snapshot also emits, so both are deduped to keep exactly one batch
      // frame per stream. Keyless frames (queue status) pass through.
      let drainingPending = false;
      const pendingLive: TerminalFrame[] = [];
      const emitTerminal = (frame: TerminalFrame) => {
        if (closed) return;
        const key = frame.key;
        if (key?.event === 'tile') {
          if (replayedTerminalTileIds.has(key.tileId)) return;
          replayedTerminalTileIds.add(key.tileId);
        }
        if (key?.event === 'done') {
          if (batchDoneEmitted) return;
          batchDoneEmitted = true;
        }
        if (key?.event === 'batch') {
          if (batchEventEmitted) return;
          batchEventEmitted = true;
        }
        try {
          controller.enqueue(frame.bytes);
        } catch {
          close();
        }
      };
      const enqueueTerminal = (frame: TerminalFrame) => {
        if (closed) return;
        if (drainingPending) {
          pendingLive.push(frame);
          return;
        }
        emitTerminal(frame);
      };
      const enqueueOptional = (makeFrame: () => Uint8Array) => {
        if (closed || (controller.desiredSize ?? 1) <= 0) return;
        try {
          controller.enqueue(makeFrame());
        } catch {
          close();
        }
      };

      // Step 1: subscribe first with bus-buffered replay enabled. Any
      // terminal frame the orchestrator broadcast between when the route
      // handler ran and when this `start` callback fires is captured in the
      // bus's per-batch terminalBuffer; replayBuffered=true drains it into
      // `enqueueTerminal` synchronously. Since drainingPending is set first,
      // those frames go into pendingLive and are drained AFTER the DB
      // snapshot finishes populating replayedTerminalTileIds — the dedup
      // then drops the ones already covered by snapshot replay, and emits
      // the ones the snapshot missed (the actual race-window frames).
      drainingPending = true;
      c.req.raw.signal.addEventListener('abort', close, { once: true });
      keepalive = setInterval(() => {
        enqueueOptional(() => encodeSseComment());
      }, KEEPALIVE_MS);
      try {
        unsubscribe = bus.subscribe(batch.id, { enqueueTerminal, enqueueOptional, close }, { replayBuffered: true });
      } catch {
        close();
        return;
      }

      // Step 2: snapshot DB AFTER subscribing. Any broadcastTerminal that
      // fired during step 1 is now in pendingLive.
      const snapshotTiles = queryTiles(c.var.db, batch);
      snapshotRaceHookForTests?.();
      const snapshotIsBatchTerminal = batchIsTerminal(c.var.db, batch.id);
      for (const tile of snapshotTiles) {
        if (terminalTileEvent(tile)) replayedTerminalTileIds.add(tile.id);
      }

      // Step 3: replay the snapshot directly (writeTerminal bypasses dedup;
      // replayedTerminalTileIds was already populated above so any matching
      // pendingLive frame gets dropped below).
      replayBatch(c.var.db, batch, snapshotTiles, writeTerminal);
      // Step 4: drain pendingLive through emitTerminal BEFORE closing a
      // terminal snapshot. A tile can commit and broadcast after queryTiles()
      // but before batchIsTerminal(); in that window the snapshot still says
      // `loading` while the terminal query says the batch is complete. Closing
      // first would discard the buffered tile frame and send `done` alone.
      // Draining here lets dedup run against the now-populated
      // replayedTerminalTileIds / batchDoneEmitted. Then switch the subscriber
      // to direct-emit mode for ongoing frames.
      drainingPending = false;
      for (const frame of pendingLive) emitTerminal(frame);
      pendingLive.length = 0;
      if (snapshotIsBatchTerminal) {
        if (!batchDoneEmitted) {
          writeTerminal(terminalFrame('done', { batchId: batch.id } satisfies DoneEvent));
        }
        close();
      }
    },
    cancel: () => {
      closeStream();
    },
  }, new ByteLengthQueuingStrategy({ highWaterMark: 1024 * 1024 }));

  return c.body(stream, 200, sseHeaders());
});

function queryTiles(db: AppEnv['Variables']['db'], batch: BatchEventRow): TileEventRow[] {
  return db
    .query<TileEventRow, [string, string]>(
      `SELECT id, tile_index, seed, status, ext, mime, error, moderation_reason, moderation_categories, completed_at
         FROM tiles
        WHERE batch_id = ? AND user_id = ?
          AND archived_at IS NULL
        ORDER BY tile_index ASC`,
    )
    .all(batch.id, batch.user_id);
}

function replayBatch(
  db: AppEnv['Variables']['db'],
  batch: BatchEventRow,
  tiles: TileEventRow[],
  enqueue: (frame: TerminalFrame) => void,
): void {
  const queuePosition = batch.status === 'queued' ? queue.positionOf(batch.pool, batch.id) : -1;
  const refImageIds = refImageIdsForBatch(db, batch.id);
  const batchEvent: BatchEvent = {
    batchId: batch.id,
    createdAt: batch.created_at,
    ...(batch.started_at !== null ? { startedAt: batch.started_at } : {}),
    status: batch.status,
    tiles: tiles.map((tile) => ({
      tileId: tile.id,
      tileIndex: tile.tile_index,
      seed: tile.seed,
    })),
    ...(queuePosition >= 0 ? { queueLengthAhead: queuePosition } : {}),
    ...(refImageIds.length > 0 ? { refImageIds } : {}),
  };
  enqueue(terminalFrame('batch', batchEvent));

  for (const tile of tiles) {
    const event = terminalTileEvent(tile);
    if (event) enqueue(terminalFrame('tile', event));
  }
}

function terminalTileEvent(tile: TileEventRow): TerminalTileEvent | null {
  if (tile.status === 'done' && tile.ext && tile.mime && tile.completed_at !== null) {
    return doneTileEvent(tile, tile.ext, tile.mime, tile.completed_at);
  }
  if (tile.status === 'failed' && tile.error && tile.completed_at !== null) {
    const moderation = tileModeration(tile);
    return {
      tileId: tile.id,
      tileIndex: tile.tile_index,
      status: 'failed',
      error: tile.error,
      ...(moderation ? { moderation } : {}),
      completedAt: tile.completed_at,
    };
  }
  return null;
}

function batchIsTerminal(db: AppEnv['Variables']['db'], batchId: string): boolean {
  const row = db
    .query<{ loading: number }, [string]>(
      "SELECT COUNT(*) AS loading FROM tiles WHERE batch_id = ? AND status = 'loading'",
    )
    .get(batchId);
  return (row?.loading ?? 0) === 0;
}

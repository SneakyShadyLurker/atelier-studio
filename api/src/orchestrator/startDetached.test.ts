import { beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import pino from 'pino';
import type { Config } from '../config';
import { migrate } from '../db/migrate';
import { runBatchPipeline, type PreparedBatch } from '../orchestrator';
import type { Pool } from '@atelier/shared';
import type { RegistryEntry } from '../providers/registry';
import type { Provider } from '../providers/types';
import * as bus from './bus';
import { createReservationReleaser } from './concurrency';
import { startOrchestratorDetached, type StartDetachedContext } from './startDetached';

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db, '/tmp');
  bus.resetForTests();
});

function preparedFixture(): PreparedBatch & { userId: string; pool: Pool; count: number } {
  db.run("INSERT OR IGNORE INTO users (id, created_at) VALUES ('u1', ?)", [Date.now()]);
  db.run(
    `INSERT INTO batches (id, user_id, prompt, model_id, model_label, ratio, created_at, status, pool)
     VALUES ('b1', 'u1', 'p', 'gpt-image-2.5-sunburst', 'GPT Image 2.5 Sunburst', '1:1', ?, 'running', 'shared')`,
    [Date.now()],
  );
  db.run(
    `INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status)
     VALUES ('t1', 'b1', 'u1', 0, 0, 'loading')`,
  );
  return {
    batch: {
      id: 'b1',
      user_id: 'u1',
      prompt: 'p',
      ratio: '1:1',
      model_id: 'gpt-image-2.5-sunburst',
      model_label: 'GPT Image 2.5 Sunburst',
      created_at: Date.now(),
      archived_at: null,
      collection_id: null,
      pinned: 0,
      status: 'running',
      pool: 'shared',
      template_id: null,
      roll_seed: null,
      roll_pins: null,
      i2v_source_upload_id: null,
      motion_prompt: null,
      duration_frames: null,
      sequence_id: null,
      sequence_index: null,
      context_frames: 0,
      started_at: Date.now(),
      idempotency_key: null,
    },
    tiles: [{
      id: 't1',
      batch_id: 'b1',
      user_id: 'u1',
      tile_index: 0,
      seed: 0,
      status: 'loading',
      ext: null,
      mime: null,
      error: null,
      completed_at: null,
      archived_at: null,
    }],
    userId: 'u1',
    pool: 'shared',
    count: 1,
  };
}

function ctx(overrides: Partial<StartDetachedContext> = {}): StartDetachedContext {
  const provider: Provider = {
    id: 'gpt-image-2.5-sunburst',
    backend: 'cloud',
    async *generate() {
      await Promise.resolve();
      yield { status: 'failed' as const, error: 'unused', seed: 0, index: 0 };
    },
  };
  const registryEntry: RegistryEntry = {
    model: {
      id: 'gpt-image-2.5-sunburst',
      name: 'GPT Image 2.5 Sunburst',
      backend: 'cloud',
      tag: 'test',
      latency: 'medium',
      supportedRatios: ['1:1'],
      pool: 'shared',
      concurrencyCapPerUser: 4,
      maxCountPerBatch: 4,
    },
    bind: () => provider,
    timeoutMs: () => 1_000,
  };
  return {
    db,
    logger: pino({ level: 'silent' }),
    runBatchPipeline: () => Promise.resolve(),
    config: {} as Config,
    userId: 'u1',
    request: { prompt: 'p', modelId: 'gpt-image-2.5-sunburst', ratio: '1:1', count: 1 },
    registryEntry,
    boundProvider: provider,
    disconnectSignal: new AbortController().signal,
    onTileSettled: () => undefined,
    onSyncFailure: () => undefined,
    ...overrides,
  };
}

test('startOrchestratorDetached releases slots and finalizes batch on sync throw', async () => {
  const prepared = preparedFixture();
  const released: number[] = [];

  await startOrchestratorDetached(
    prepared,
    ctx({
      runBatchPipeline: () => {
        throw new Error('sync boom');
      },
      onSyncFailure: () => { released.push(prepared.tiles.length); },
    }),
  );

  expect(released).toEqual([1]);
  const tile = db
    .query<{ status: string; error: string | null }, []>("SELECT status, error FROM tiles WHERE id='t1'")
    .get();
  expect(tile).toMatchObject({ status: 'failed', error: 'internal error' });
  const batch = db.query<{ status: string }, []>("SELECT status FROM batches WHERE id='b1'").get();
  expect(batch?.status).toBe('done');
});

test('startOrchestratorDetached releases slots on async rejection', async () => {
  const prepared = preparedFixture();
  const released: number[] = [];

  await startOrchestratorDetached(
    prepared,
    ctx({
      runBatchPipeline: () => Promise.reject(new Error('async boom')),
      onSyncFailure: () => { released.push(prepared.tiles.length); },
    }),
  );

  expect(released).toEqual([1]);
});

test('startOrchestratorDetached broadcasts failed tile frames and done before closing subscribers on pipeline rejection', async () => {
  const prepared = preparedFixture();
  const frames: string[] = [];
  bus.subscribe('b1', {
    enqueueTerminal: (frame) => { frames.push(new TextDecoder().decode(frame.bytes)); },
    enqueueOptional: () => undefined,
  });

  await startOrchestratorDetached(
    prepared,
    ctx({
      runBatchPipeline: () => Promise.reject(new Error('async boom')),
    }),
  );

  expect(frames.some((frame) => frame.includes('event: tile') && frame.includes('"status":"failed"'))).toBe(true);
  expect(frames.some((frame) => frame.includes('event: done'))).toBe(true);
});

test('startOrchestratorDetached broadcasts failed tile frames for real pipeline setup failures', async () => {
  const prepared = preparedFixture();
  const frames: string[] = [];
  const originalSetInterval = globalThis.setInterval;
  bus.subscribe('b1', {
    enqueueTerminal: (frame) => { frames.push(new TextDecoder().decode(frame.bytes)); },
    enqueueOptional: () => undefined,
  });
  globalThis.setInterval = (() => {
    throw new Error('synthetic setInterval failure');
  }) as typeof setInterval;
  try {
    await startOrchestratorDetached(
      prepared,
      ctx({
        closeBatchOnCleanup: false,
        runBatchPipeline,
      }),
    );
  } finally {
    globalThis.setInterval = originalSetInterval;
  }

  const failedTileIndex = frames.findIndex((frame) =>
    frame.includes('event: tile') && frame.includes('"status":"failed"')
  );
  const doneIndex = frames.findIndex((frame) => frame.includes('event: done'));
  expect(failedTileIndex).toBeGreaterThanOrEqual(0);
  expect(doneIndex).toBeGreaterThan(failedTileIndex);
});

test('startOrchestratorDetached releases the leftover reservation on the SUCCESS path (no pool-slot leak)', async () => {
  const prepared = preparedFixture();
  // A queued batch reserves entry.count (2) slots up front, but a per-tile
  // DELETE in the dequeue→BYOK-load window leaves only one prepared tile. The
  // pipeline succeeds and settles that single tile (one releaseOne). The
  // leftover reserved slot must be freed by onSyncFailure in finally — otherwise it
  // leaks until process restart.
  let reserved = 2;
  const { releaseOne, releaseRemaining } = createReservationReleaser(
    2,
    (count) => { reserved -= count; },
    () => undefined,
  );

  await startOrchestratorDetached(
    prepared,
    ctx({
      runBatchPipeline: (_prepared, c) => { c.onTileSettled(); return Promise.resolve(); },
      onTileSettled: releaseOne,
      onSyncFailure: releaseRemaining,
    }),
  );

  expect(reserved).toBe(0);
});

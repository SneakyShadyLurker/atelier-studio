import { beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config';
import { migrate } from '../db/migrate';
import { tempDir } from '../test/helpers';
import type { QueueEntry } from './queue';
import * as bus from './bus';
import type { DequeueContext } from './revalidate';
import { failBatchAtDequeue, revalidateAtDequeue } from './revalidate';

let db: Database;
let dataDir: string;

beforeEach(() => {
  dataDir = tempDir();
  db = new Database(':memory:');
  migrate(db, dataDir);
  bus.resetForTests();
});

function seed(batchId = 'b1'): void {
  db.run("INSERT OR IGNORE INTO users (id, created_at) VALUES ('u1', ?)", [Date.now()]);
  db.run(
    `INSERT INTO batches (id, user_id, prompt, model_id, model_label, ratio, created_at, status, pool)
     VALUES (?, 'u1', 'p', 'gpt-image-2.5-sunburst', 'GPT Image 2.5 Sunburst', '1:1', ?, 'running', 'shared')`,
    [batchId, Date.now()],
  );
  db.run(
    `INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status)
     VALUES ('t1', ?, 'u1', 0, 0, 'loading')`,
    [batchId],
  );
}

const entry: QueueEntry = {
  batchId: 'b1',
  userId: 'u1',
  modelId: 'gpt-image-2.5-sunburst',
  count: 1,
  queuedAt: Date.now(),
  epoch: 0,
};

function ctx(overrides: Partial<DequeueContext> = {}): DequeueContext {
  return {
    db,
    config: { DATA_DIR: dataDir, LOCAL_MODELS_USERS: new Set(['u1']) } as Config,
    logger: { error: () => undefined, warn: () => undefined, info: () => undefined },
    registry: {
      findModel: () => ({ model: { id: 'gpt-image-2.5-sunburst', pool: 'shared', maxCountPerBatch: 4 } }),
      healthSnapshot: () => new Map(),
    },
    ...overrides,
  };
}

test('revalidateAtDequeue returns ok when row exists running and model registered', () => {
  seed();
  const result = revalidateAtDequeue(ctx(), entry);
  expect(result.ok).toBe(true);
});

test('revalidateAtDequeue returns not ok when model is gone', () => {
  seed();
  const result = revalidateAtDequeue(
    ctx({
      registry: {
        findModel: () => null,
        healthSnapshot: () => new Map(),
      },
    }),
    entry,
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toBe('upstream rejected');
});

test('revalidateAtDequeue rejects a model whose host is offline', () => {
  seed();
  const result = revalidateAtDequeue(
    ctx({
      registry: {
        findModel: () => ({ model: { id: 'gpt-image-2.5-sunburst', pool: 'shared', maxCountPerBatch: 4 } }),
        healthSnapshot: () => new Map([
          ['gpt-image-2.5-sunburst', { ok: false, reason: 'unavailable' as const }],
        ]),
      },
    }),
    entry,
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toBe('upstream rejected');
});

test('revalidateAtDequeue lets a recovered batch through before the first health probe', () => {
  seed();
  const result = revalidateAtDequeue(
    ctx({
      registry: {
        findModel: () => ({ model: { id: 'gpt-image-2.5-sunburst', pool: 'shared', maxCountPerBatch: 4 } }),
        healthSnapshot: () => new Map([['gpt-image-2.5-sunburst', { ok: false }]]),
      },
    }),
    entry,
  );
  expect(result.ok).toBe(true);
});

test('revalidateAtDequeue fails queued refs whose upload artifact disappeared', () => {
  seed();
  const uploadId = 'upload-1';
  db.run(
    "INSERT INTO uploads (id, user_id, ext, mime, size_bytes, width, height, sha256, created_at) VALUES (?, 'u1', 'png', 'image/png', 3, 1, 1, 'sha', ?)",
    [uploadId, Date.now()],
  );
  db.run('INSERT INTO tile_ref_images (tile_id, upload_id, position) VALUES (?, ?, 0)', ['t1', uploadId]);

  const result = revalidateAtDequeue(ctx(), entry);

  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toBe('upstream rejected');
});

test('revalidateAtDequeue accepts queued refs when upload artifact exists', () => {
  seed();
  const uploadId = 'upload-1';
  db.run(
    "INSERT INTO uploads (id, user_id, ext, mime, size_bytes, width, height, sha256, created_at) VALUES (?, 'u1', 'png', 'image/png', 3, 1, 1, 'sha', ?)",
    [uploadId, Date.now()],
  );
  db.run('INSERT INTO tile_ref_images (tile_id, upload_id, position) VALUES (?, ?, 0)', ['t1', uploadId]);
  const dir = join(dataDir, 'uploads', 'u1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${uploadId}.png`), 'png');

  const result = revalidateAtDequeue(ctx(), entry);

  expect(result.ok).toBe(true);
});

test('failBatchAtDequeue flips tiles to failed, finalizes batch, and broadcasts terminal plus done', () => {
  seed();
  const frames: string[] = [];
  bus.subscribe('b1', {
    enqueueTerminal: (frame) => frames.push(new TextDecoder().decode(frame.bytes)),
    enqueueOptional: () => undefined,
  });

  failBatchAtDequeue(ctx(), entry, 'upstream rejected');

  const tile = db
    .query<{ status: string; error: string | null }, []>("SELECT status, error FROM tiles WHERE id='t1'")
    .get();
  expect(tile).toMatchObject({ status: 'failed', error: 'upstream rejected' });
  const batch = db.query<{ status: string }, []>("SELECT status FROM batches WHERE id='b1'").get();
  expect(batch?.status).toBe('done');
  expect(frames.some((frame) => frame.includes('event: tile'))).toBe(true);
  expect(frames.some((frame) => frame.includes('event: done'))).toBe(true);
});

test('failBatchAtDequeue does not broadcast terminal frames when no loading tiles were flipped', () => {
  seed();
  db.run("UPDATE tiles SET status='failed', error='internal error', completed_at=? WHERE id='t1'", [Date.now()]);
  db.run("UPDATE batches SET status='done' WHERE id='b1'");
  const frames: string[] = [];
  bus.subscribe('b1', {
    enqueueTerminal: (frame) => frames.push(new TextDecoder().decode(frame.bytes)),
    enqueueOptional: () => undefined,
  });

  failBatchAtDequeue(ctx(), entry, 'upstream rejected');

  expect(frames.some((frame) => frame.includes('event: tile'))).toBe(false);
  expect(frames.some((frame) => frame.includes('event: done'))).toBe(false);
});

test('revoked local access fails before health or artifact reads and retains terminal history', () => {
  seed();
  let healthRead = false;
  const configured = ctx({
    config: { DATA_DIR: dataDir, LOCAL_MODELS_USERS: new Set() } as Config,
    registry: {
      findModel: () => ({ model: { id: 'local', pool: 'local', maxCountPerBatch: 4 } }),
      healthSnapshot: () => { healthRead = true; return new Map(); },
    },
  });
  const result = revalidateAtDequeue(configured, entry);
  expect(result).toEqual({ ok: false, reason: 'upstream rejected' });
  expect(healthRead).toBe(false);
  if (!result.ok) failBatchAtDequeue(configured, entry, result.reason);
  expect(db.query("SELECT status FROM batches WHERE id='b1'").get()).toEqual({ status: 'done' });
  expect(db.query("SELECT status, error FROM tiles WHERE id='t1'").get())
    .toEqual({ status: 'failed', error: 'upstream rejected' });
});

test('shared mock remains allowed even with local backend and a revoked user', () => {
  seed();
  expect(revalidateAtDequeue(ctx({
    config: { DATA_DIR: dataDir, LOCAL_MODELS_USERS: new Set() } as Config,
    registry: {
      findModel: () => ({ model: { id: 'mock', backend: 'local', pool: 'shared', maxCountPerBatch: 4 } }),
      healthSnapshot: () => new Map(),
    },
  }), entry)).toEqual({ ok: true });
});

test('checks actual remaining tiles against the model cap independently of one reserved queue slot', () => {
  seed();
  for (let index = 1; index < 4; index += 1) {
    db.run("INSERT INTO tiles (id,batch_id,user_id,tile_index,seed,status) VALUES (?,'b1','u1',?,0,'loading')", [`t${index + 1}`, index]);
  }
  const configured = ctx({ registry: {
    findModel: () => ({ model: { id: 'krea', pool: 'local', maxCountPerBatch: 1 } }),
    healthSnapshot: () => new Map(),
  } });
  expect(entry.count).toBe(1);
  expect(revalidateAtDequeue(configured, entry)).toEqual({ ok: false, reason: 'upstream rejected' });
  // User cancellation hard-deletes tiles; 'canceled' is only a wire status.
  db.run("DELETE FROM tiles WHERE id != 't1'");
  expect(revalidateAtDequeue(configured, entry)).toEqual({ ok: true });
});

test('a recovered local batch within its current cap is admitted', () => {
  seed();
  expect(revalidateAtDequeue(ctx({ registry: {
    findModel: () => ({ model: { id: 'krea', pool: 'local', maxCountPerBatch: 4 } }),
    healthSnapshot: () => new Map(),
  } }), entry)).toEqual({ ok: true });
});

import { expect, test } from 'bun:test';
import { startupReconcile } from '../lifecycle/startup-reconcile';
import { acquireLocalTiles, acquireTiles, releaseLocalTiles, releaseTiles, resetConcurrencyForTests, tilesInFlight } from '../orchestrator/concurrency';
import * as queue from '../orchestrator/queue';
import { queueSlotsFor } from '../providers/registry';
import { kickQueues, queuedBatchStillRunnable } from '../orchestrator/dispatch';
import { DEQUEUE_RETRY_MS } from '../orchestrator/dequeue';
import { jsonRequest, testRuntime, testTextServices } from './helpers';

test('POST /api/generate returns 201 status=running when a slot is available', async () => {
  resetConcurrencyForTests();
  queue.resetQueueForTests();
  const { app } = testRuntime({ MOCK_PROVIDER_DELAY_MS: '200' });

  const res = await jsonRequest(app, '/api/generate', {
    prompt: 'p',
    modelId: 'mock-slow',
    ratio: '1:1',
    count: 1,
  }, 'test', 'application/json');

  expect(res.status).toBe(201);
  const body = await res.json() as { status?: string; pool?: string; batchId?: string };
  expect(body.status).toBe('running');
  expect(body.pool).toBe('shared');
  expect(typeof body.batchId).toBe('string');
});

test('a deferred kick failing on an old over-cap head preserves new accepted IDs and other reservations', async () => {
  resetConcurrencyForTests();
  queue.resetQueueForTests();
  const runtime = testRuntime({ MAX_CONCURRENT_TILES: '1', MAX_CONCURRENT_TILES_PER_USER: '1', LOG_LEVEL: 'error' });
  runtime.db.run("INSERT INTO users (id,created_at) VALUES ('old',1)");
  runtime.db.run(`INSERT INTO batches (id,user_id,prompt,ratio,model_id,model_label,created_at,status,pool)
    VALUES ('over-cap','old','old','1:1','mock-fast','Mock',1,'queued','shared')`);
  runtime.db.run(`INSERT INTO tiles (id,batch_id,user_id,tile_index,seed,status)
    VALUES ('over-cap-tile','over-cap','old',0,1,'loading')`);
  runtime.db.run(`CREATE TRIGGER fail_old_terminal BEFORE UPDATE OF status ON tiles
    WHEN OLD.batch_id='over-cap' BEGIN SELECT RAISE(FAIL,'injected terminal write failure'); END`);
  queue.enqueue('shared', { batchId: 'over-cap', userId: 'old', modelId: 'mock-fast', count: 2, queuedAt: 1 });
  expect(acquireTiles('other-active', 1, 1, 1).ok).toBe(true);
  const response = await jsonRequest(runtime.app, '/api/generate', {
    prompt: 'new accepted request', modelId: 'mock-fast', ratio: '1:1', count: 1,
  });
  expect(response.status).toBe(201);
  const payload = await response.json() as { batchId: string; tiles: { tileId: string }[]; status: string };
  expect(payload.status).toBe('queued');
  expect(payload.tiles).toHaveLength(1);
  expect(runtime.db.query('SELECT id FROM batches WHERE id=?').get(payload.batchId)).toEqual({ id: payload.batchId });
  await Bun.sleep(0);
  expect(runtime.logs.some((line) => line.includes('dequeue terminal settlement failed'))).toBe(true);
  expect(tilesInFlight()).toBe(1);
  expect(acquireTiles('extra', 1, 1, 1)).toEqual({ ok: false, reason: 'global' });
  releaseTiles('other-active', 1);
  kickQueues({ ...runtime, healthSnapshot: () => new Map() });
  const events = await runtime.fetch(`/api/batches/${payload.batchId}/events`, { headers: { 'Remote-User': 'test' } });
  expect(await events.text()).toContain('event: done');
  expect(runtime.db.query('SELECT status FROM tiles WHERE id=?').get('over-cap-tile')).toEqual({ status: 'loading' });
  runtime.db.run('DROP TRIGGER fail_old_terminal');
  const settlementDeadline = Date.now() + DEQUEUE_RETRY_MS * 8;
  while (Date.now() < settlementDeadline
    && runtime.db.query<{ status: string }, [string]>('SELECT status FROM batches WHERE id=?').get('over-cap')?.status === 'queued') {
    await Bun.sleep(10);
  }
  expect(runtime.db.query('SELECT status FROM tiles WHERE id=?').get('over-cap-tile')).toEqual({ status: 'failed' });
  expect(runtime.db.query('SELECT status FROM batches WHERE id=?').get('over-cap')).toEqual({ status: 'done' });
  expect(runtime.db.query("SELECT COUNT(*) AS n FROM batches WHERE user_id='old' AND status='queued'").get()).toEqual({ n: 0 });
  expect(tilesInFlight()).toBe(0);
});

test('POST /api/generate returns 201 status=queued when caps are full', async () => {
  resetConcurrencyForTests();
  queue.resetQueueForTests();
  const { app } = testRuntime({
    MOCK_PROVIDER_DELAY_MS: '300',
    MAX_CONCURRENT_TILES: '1',
    MAX_CONCURRENT_TILES_PER_USER: '1',
  });

  await jsonRequest(app, '/api/generate', {
    prompt: 'p1',
    modelId: 'mock-slow',
    ratio: '1:1',
    count: 1,
  }, 'test', 'application/json');
  const res = await jsonRequest(app, '/api/generate', {
    prompt: 'p2',
    modelId: 'mock-slow',
    ratio: '1:1',
    count: 1,
  }, 'test', 'application/json');

  expect(res.status).toBe(201);
  const body = await res.json() as { status?: string; queueLengthAhead?: number };
  expect(body.status).toBe('queued');
  expect(body.queueLengthAhead).toBe(0);
});

test('POST /api/generate returns JSON 201 queued regardless of Accept header', async () => {
  resetConcurrencyForTests();
  queue.resetQueueForTests();
  const { app } = testRuntime({
    MOCK_PROVIDER_DELAY_MS: '300',
    MAX_CONCURRENT_TILES: '1',
    MAX_CONCURRENT_TILES_PER_USER: '1',
  });

  await jsonRequest(app, '/api/generate', {
    prompt: 'p1',
    modelId: 'mock-slow',
    ratio: '1:1',
    count: 1,
  }, 'test', 'application/json');
  const res = await app.fetch(new Request('http://local/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Remote-User': 'test' },
    body: JSON.stringify({
      prompt: 'p2',
      modelId: 'mock-slow',
      ratio: '1:1',
      count: 1,
    }),
  }));

  expect(res.status).toBe(201);
  expect(res.headers.get('content-type')).toContain('application/json');
  expect(await res.json()).toMatchObject({ status: 'queued', queueLengthAhead: 0 });
});

test('POST /api/generate returns 400 COUNT_EXCEEDS_POOL when count exceeds pool capacity', async () => {
  resetConcurrencyForTests();
  queue.resetQueueForTests();
  // Non-batched shared-pool model: count=3 exceeds per-user cap of 2.
  // (Krea models are batched so they always acquire 1 slot.)
  const { app } = testRuntime({
    MAX_CONCURRENT_TILES: '2',
    MAX_CONCURRENT_TILES_PER_USER: '2',
  });

  const res = await jsonRequest(app, '/api/generate', {
    prompt: 'p',
    modelId: 'mock-slow',
    ratio: '1:1',
    count: 3,
  }, 'test', 'application/json');

  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ code: 'COUNT_EXCEEDS_POOL' });
});

test('POST /api/generate returns 429 QUEUE_FULL when per-user queue depth is exceeded', async () => {
  resetConcurrencyForTests();
  queue.resetQueueForTests();
  const { app } = testRuntime({
    MOCK_PROVIDER_DELAY_MS: '500',
    MAX_CONCURRENT_TILES: '1',
    MAX_CONCURRENT_TILES_PER_USER: '1',
    MAX_QUEUED_BATCHES_PER_USER: '2',
  });

  for (let index = 0; index < 3; index++) {
    const res = await jsonRequest(app, '/api/generate', {
      prompt: `p${index}`,
      modelId: 'mock-slow',
      ratio: '1:1',
      count: 1,
    }, 'test', 'application/json');
    expect(res.status).toBe(201);
  }

  const res = await jsonRequest(app, '/api/generate', {
    prompt: 'p4',
    modelId: 'mock-slow',
    ratio: '1:1',
    count: 1,
  }, 'test', 'application/json');
  expect(res.status).toBe(429);
  expect(await res.json()).toMatchObject({ code: 'QUEUE_FULL', retry_after_seconds: 5 });
});

test('status-flip transaction failure releases an acquired pool slot and does not enqueue', async () => {
  resetConcurrencyForTests();
  queue.resetQueueForTests();
  const { app, db } = testRuntime({
    MAX_CONCURRENT_TILES: '1',
    MAX_CONCURRENT_TILES_PER_USER: '1',
  });
  const originalPrepare = db.prepare.bind(db);
  let injected = false;
  db.prepare = ((sql: string) => {
    const statement = originalPrepare(sql);
    if (!injected && sql === "UPDATE batches SET status='running', started_at = ? WHERE id = ? AND status='queued'") {
      return new Proxy(statement, {
        get(target, prop, receiver): unknown {
          if (prop !== 'run') return Reflect.get(target, prop, receiver) as unknown;
          return (...args: unknown[]) => {
            if (!injected) {
              injected = true;
              throw new Error(`synthetic status update failure ${args.length}`);
            }
            return target.run(...(args as Parameters<typeof target.run>));
          };
        },
      });
    }
    return statement;
  }) as typeof db.prepare;

  const failed = await jsonRequest(app, '/api/generate', {
    prompt: 'p1',
    modelId: 'mock-fast',
    ratio: '1:1',
    count: 1,
  }, 'test', 'application/json');
  expect(failed.status).toBe(500);
  expect(queue.__queueTest.lengthOf('shared')).toBe(0);

  const followup = await jsonRequest(app, '/api/generate', {
    prompt: 'p2',
    modelId: 'mock-fast',
    ratio: '1:1',
    count: 1,
  }, 'test', 'application/json');
  expect(followup.status).toBe(201);
  expect(await followup.json()).toMatchObject({ status: 'running' });
});

test('queued batch starts after a running batch releases its pool slot', async () => {
  resetConcurrencyForTests();
  queue.resetQueueForTests();
  const { app, db } = testRuntime({
    MOCK_PROVIDER_DELAY_MS: '40',
    MAX_CONCURRENT_TILES: '1',
    MAX_CONCURRENT_TILES_PER_USER: '1',
  });

  const first = await jsonRequest(app, '/api/generate', {
    prompt: 'p1',
    modelId: 'mock-slow',
    ratio: '1:1',
    count: 1,
  }, 'test', 'application/json');
  const second = await jsonRequest(app, '/api/generate', {
    prompt: 'p2',
    modelId: 'mock-slow',
    ratio: '1:1',
    count: 1,
  }, 'test', 'application/json');
  const firstBody = await first.json() as { batchId: string; status: string };
  const secondBody = await second.json() as { batchId: string; status: string };
  expect(firstBody.status).toBe('running');
  expect(secondBody.status).toBe('queued');

  await waitFor(() => {
    const rows = db
      .query<{ id: string; status: string }, []>('SELECT id, status FROM batches ORDER BY created_at ASC')
      .all();
    return rows.length === 2 && rows.every((row) => row.status === 'done') ? rows : null;
  });

  expect(queue.__queueTest.lengthOf('shared')).toBe(0);
  expect(
    db.query<{ done: number }, []>("SELECT COUNT(*) AS done FROM tiles WHERE status = 'done'").get()?.done,
  ).toBe(2);
});

test('recovered queued batch is kicked after startup reconciliation', async () => {
  resetConcurrencyForTests();
  queue.resetQueueForTests();
  const { db, config, logger, keyStore } = testRuntime({
    MOCK_PROVIDER_DELAY_MS: '20',
    MAX_CONCURRENT_TILES: '1',
    MAX_CONCURRENT_TILES_PER_USER: '1',
  });
  const batchId = crypto.randomUUID();
  const tileId = crypto.randomUUID();
  db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run('test', 1);
  db.query(
    `INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, status, pool)
     VALUES (?, 'test', 'queued', '1:1', 'mock-slow', 'Mock Slow', 1, 'queued', 'shared')`,
  ).run(batchId);
  db.query("INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status) VALUES (?, ?, 'test', 0, 1, 'loading')")
    .run(tileId, batchId);

  startupReconcile(db, config.DATA_DIR, logger, {
    uploadTtlMs: config.UPLOAD_TTL_MS,
    orphanThreshold: config.RECONCILE_ORPHAN_THRESHOLD,
    force: config.RECONCILE_FORCE,
    dbIntegrityOk: true,
  });
  kickQueues({ db, config, logger, keyStore, healthSnapshot: () => new Map(), text: testTextServices(db, config) });

  await waitFor(() => db.query<{ status: string }, [string]>('SELECT status FROM batches WHERE id = ?').get(batchId)?.status === 'done' ? true : null);
  expect(queue.__queueTest.lengthOf('shared')).toBe(0);
  expect(db.query<{ status: string }, [string]>('SELECT status FROM tiles WHERE id = ?').get(tileId)?.status).toBe('done');
});

test('startup reconciliation finalizes queued batches with only terminal tiles and does not rebuild them', () => {
  resetConcurrencyForTests();
  queue.resetQueueForTests();
  const { db, config, logger } = testRuntime();
  const batchId = crypto.randomUUID();
  db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run('test', 1);
  db.query(
    `INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, status, pool)
     VALUES (?, 'test', 'queued', '1:1', 'mock-slow', 'Mock Slow', 1, 'queued', 'shared')`,
  ).run(batchId);
  db.query("INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, error, completed_at) VALUES (?, ?, 'test', 0, 1, 'failed', 'internal error', 2)")
    .run(crypto.randomUUID(), batchId);

  startupReconcile(db, config.DATA_DIR, logger, {
    uploadTtlMs: config.UPLOAD_TTL_MS,
    orphanThreshold: config.RECONCILE_ORPHAN_THRESHOLD,
    force: config.RECONCILE_FORCE,
    dbIntegrityOk: true,
  });

  expect(db.query<{ status: string }, [string]>('SELECT status FROM batches WHERE id = ?').get(batchId)?.status).toBe('done');
  expect(queue.__queueTest.lengthOf('shared')).toBe(0);
});

function seedQueuedKreaBatch(db: ReturnType<typeof testRuntime>['db'], tiles: number): { batchId: string; tileIds: string[] } {
  const batchId = crypto.randomUUID();
  const tileIds = Array.from({ length: tiles }, () => crypto.randomUUID());
  db.query('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)').run('carol', 1);
  db.query(
    `INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, status, pool)
     VALUES (?, 'carol', 'queued', '1:1', 'krea-2-gonzalomo', 'Krea 2 GonzaLomo', 1, 'queued', 'local')`,
  ).run(batchId);
  tileIds.forEach((tileId, index) => {
    db.query("INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status) VALUES (?, ?, 'carol', ?, 1, 'loading')")
      .run(tileId, batchId, index);
  });
  return { batchId, tileIds };
}

test('startup reconciliation restores a queued batched Krea request as one local slot', () => {
  resetConcurrencyForTests();
  queue.resetQueueForTests();
  const { db, config, logger } = testRuntime();
  const { batchId } = seedQueuedKreaBatch(db, 4);

  startupReconcile(db, config.DATA_DIR, logger, {
    uploadTtlMs: config.UPLOAD_TTL_MS,
    orphanThreshold: config.RECONCILE_ORPHAN_THRESHOLD,
    force: config.RECONCILE_FORCE,
    dbIntegrityOk: true,
    queueSlotsFor: (modelId, loadingTiles) => queueSlotsFor(config, modelId, loadingTiles),
  });

  expect(queue.__queueTest.peekHead('local')).toMatchObject({ batchId, count: 1 });
});

test('deleting one tile of a queued batched Krea request keeps its single local slot', async () => {
  resetConcurrencyForTests();
  queue.resetQueueForTests();
  const { app, db, config } = testRuntime();
  // Hold the only local slot so the post-cancel kick cannot dequeue the batch.
  expect(acquireLocalTiles(1, config.MAX_CONCURRENT_TILES_LOCAL).ok).toBe(true);
  const { batchId, tileIds } = seedQueuedKreaBatch(db, 4);
  queue.enqueue('local', { batchId, userId: 'carol', modelId: 'krea-2-gonzalomo', count: 1, queuedAt: Date.now() });

  const deleteRes = await app.fetch(new Request(`http://local/api/history/${batchId}/${tileIds[0] ?? ''}`, {
    method: 'DELETE',
    headers: { 'Remote-User': 'carol' },
  }));
  expect(deleteRes.status).toBe(204);
  expect(queue.__queueTest.peekHead('local')).toMatchObject({ batchId, count: 1 });
  releaseLocalTiles('carol', 1);
});

test('deleting one queued tile rewrites the queued reservation before dequeue', async () => {
  resetConcurrencyForTests();
  queue.resetQueueForTests();
  const { app, db } = testRuntime({
    MOCK_PROVIDER_DELAY_MS: '30',
    MAX_CONCURRENT_TILES: '2',
    MAX_CONCURRENT_TILES_PER_USER: '2',
  });

  const first = await jsonRequest(app, '/api/generate', {
    prompt: 'p1',
    modelId: 'mock-slow',
    ratio: '1:1',
    count: 2,
  }, 'test', 'application/json');
  const second = await jsonRequest(app, '/api/generate', {
    prompt: 'p2',
    modelId: 'mock-slow',
    ratio: '1:1',
    count: 2,
  }, 'test', 'application/json');
  const firstBody = await first.json() as { status: string };
  const secondBody = await second.json() as { batchId: string; status: string; tiles: { tileId: string }[] };
  expect(firstBody.status).toBe('running');
  expect(secondBody.status).toBe('queued');

  const deleteRes = await app.fetch(new Request(`http://local/api/history/${secondBody.batchId}/${secondBody.tiles[0]?.tileId ?? ''}`, {
    method: 'DELETE',
    headers: { 'Remote-User': 'test' },
  }));
  expect(deleteRes.status).toBe(204);
  expect(queue.__queueTest.peekHead('shared')?.count).toBe(1);

  await waitFor(() => {
    const row = db.query<{ status: string }, [string]>('SELECT status FROM batches WHERE id = ?').get(secondBody.batchId);
    return row?.status === 'done' ? row : null;
  });

  const third = await jsonRequest(app, '/api/generate', {
    prompt: 'p3',
    modelId: 'mock-slow',
    ratio: '1:1',
    count: 2,
  }, 'test', 'application/json');
  const thirdBody = await third.json() as { status: string };
  expect(thirdBody.status).toBe('running');
});

test('deleting queued head batch kicks the next runnable batch under strict FIFO', async () => {
  resetConcurrencyForTests();
  queue.resetQueueForTests();
  const { app, db } = testRuntime({
    MOCK_PROVIDER_DELAY_MS: '1000',
    MAX_CONCURRENT_TILES: '2',
    MAX_CONCURRENT_TILES_PER_USER: '1',
  });

  const running = await jsonRequest(app, '/api/generate', {
    prompt: 'alice running',
    modelId: 'mock-slow',
    ratio: '1:1',
    count: 1,
  }, 'alice', 'application/json');
  expect((await running.json() as { status: string }).status).toBe('running');

  db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run('bob', Date.now());
  const aliceQueuedBatchId = crypto.randomUUID();
  const aliceQueuedTileId = crypto.randomUUID();
  const bobQueuedBatchId = crypto.randomUUID();
  const bobQueuedTileId = crypto.randomUUID();
  db.query(
    `INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, status, pool)
     VALUES (?, 'alice', 'alice queued', '1:1', 'mock-slow', 'Mock Slow', ?, 'queued', 'shared')`,
  ).run(aliceQueuedBatchId, Date.now());
  db.query(
    `INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status)
     VALUES (?, ?, 'alice', 0, 1, 'loading')`,
  ).run(aliceQueuedTileId, aliceQueuedBatchId);
  db.query(
    `INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, status, pool)
     VALUES (?, 'bob', 'bob queued', '1:1', 'mock-slow', 'Mock Slow', ?, 'queued', 'shared')`,
  ).run(bobQueuedBatchId, Date.now() + 1);
  db.query(
    `INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status)
     VALUES (?, ?, 'bob', 0, 1, 'loading')`,
  ).run(bobQueuedTileId, bobQueuedBatchId);
  queue.enqueue('shared', {
    batchId: aliceQueuedBatchId,
    userId: 'alice',
    modelId: 'mock-slow',
    count: 1,
    queuedAt: Date.now(),
  });
  queue.enqueue('shared', {
    batchId: bobQueuedBatchId,
    userId: 'bob',
    modelId: 'mock-slow',
    count: 1,
    queuedAt: Date.now() + 1,
  });

  const deleteRes = await app.fetch(new Request(`http://local/api/history/${aliceQueuedBatchId}`, {
    method: 'DELETE',
    headers: { 'Remote-User': 'alice' },
  }));
  expect(deleteRes.status).toBe(204);

  await waitFor(() => {
    const row = db.query<{ status: string }, [string]>('SELECT status FROM batches WHERE id = ?').get(bobQueuedBatchId);
    return row?.status === 'running' || row?.status === 'done' ? row : null;
  }, 2_000);
  expect(queue.__queueTest.peekHead('shared')?.batchId).not.toBe(bobQueuedBatchId);
});

test('post-key-load queued start guard rejects deleted or archived running batches', () => {
  const { db } = testRuntime();
  const batchId = crypto.randomUUID();
  const tileId = crypto.randomUUID();
  db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run('alice', Date.now());
  db.query(
    `INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, status, pool)
     VALUES (?, 'alice', 'p', '1:1', 'gemini-3-pro-image-preview', 'Nano Banana Pro', ?, 'running', 'byok')`,
  ).run(batchId, Date.now());
  db.query("INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status) VALUES (?, ?, 'alice', 0, 1, 'loading')")
    .run(tileId, batchId);

  expect(queuedBatchStillRunnable(db, batchId, 'alice')).toBe(true);

  db.query('DELETE FROM tiles WHERE batch_id = ?').run(batchId);
  expect(queuedBatchStillRunnable(db, batchId, 'alice')).toBe(false);

  db.query("INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status) VALUES (?, ?, 'alice', 0, 1, 'loading')")
    .run(tileId, batchId);
  db.query('UPDATE batches SET archived_at = ? WHERE id = ?').run(Date.now(), batchId);
  expect(queuedBatchStillRunnable(db, batchId, 'alice')).toBe(false);
});

async function waitFor<T>(probe: () => T | null, timeoutMs = 1_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== null) return value;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await Bun.sleep(10);
  }
}

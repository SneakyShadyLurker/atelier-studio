import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { testConfig, tempDir } from '../test/helpers';
import { migrate } from '../db/migrate';
import * as bus from './bus';
import { beginShutdownDrain, resetShutdownDrainForTests, tryDequeueNext, type DequeueRuntimeContext } from './dequeue';
import * as queue from './queue';
import { acquireTiles, releaseTiles, resetConcurrencyForTests, tilesInFlight } from './concurrency';
import {
  configureUpstreamGate,
  noteBreakerState,
  resetUpstreamGateForTests,
} from './upstreamGate';

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db, '/tmp');
  queue.resetQueueForTests();
  bus.resetForTests();
  resetConcurrencyForTests();
});

function seedQueued(
  id: string,
  userId = 'u1',
  modelId = 'gpt-image-2.5-sunburst',
  pool: 'shared' | 'byok' | 'local' = 'shared',
  count = 1,
): void {
  db.run('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)', [userId, Date.now()]);
  db.run(
    `INSERT INTO batches (id, user_id, prompt, model_id, model_label, ratio, created_at, status, pool)
     VALUES (?, ?, 'p', ?, 'GPT Image 2.5 Sunburst', '1:1', ?, 'queued', ?)`,
    [id, userId, modelId, Date.now(), pool],
  );
  for (let i = 0; i < count; i += 1) {
    db.run(
      `INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status)
       VALUES (?, ?, ?, ?, 0, 'loading')`,
      [`t-${id}-${i}`, id, userId, i],
    );
  }
  queue.enqueue(pool, { batchId: id, userId, modelId, count, queuedAt: Date.now() });
}

function ctx(overrides: Partial<DequeueRuntimeContext> = {}): DequeueRuntimeContext {
  return {
    db,
    config: testConfig({ DATA_DIR: tempDir() }),
    logger: { error: () => undefined, warn: () => undefined, info: () => undefined },
    registry: {
      findModel: () => ({ model: { id: 'gpt-image-2.5-sunburst', pool: 'shared', maxCountPerBatch: 8 } }),
      healthSnapshot: () => new Map(),
    },
    acquireFor: () => ({ ok: true }),
    releaseFor: () => undefined,
    startOrchestratorDetached: () => Promise.resolve(),
    queueEpoch: queue.currentEpoch(),
    ...overrides,
  };
}

test('happy path dequeues head, flips DB row, broadcasts queue event, and calls start', () => {
  seedQueued('b1');
  const calls: string[] = [];
  const frames: string[] = [];
  bus.subscribe('b1', {
    enqueueTerminal: (frame) => frames.push(new TextDecoder().decode(frame.bytes)),
    enqueueOptional: () => undefined,
  });

  tryDequeueNext(
    'shared',
    ctx({
      startOrchestratorDetached: (entry) => {
        calls.push(entry.batchId);
        return Promise.resolve();
      },
    }),
  );

  expect(calls).toEqual(['b1']);
  const row = db.query<{ status: string }, []>("SELECT status FROM batches WHERE id='b1'").get();
  expect(row?.status).toBe('running');
  expect(queue.__queueTest.lengthOf('shared')).toBe(0);
  expect(frames.some((frame) => frame.includes('event: queue'))).toBe(true);
});

test('global cap miss stops without popping and without release', () => {
  seedQueued('b1');
  const released: number[] = [];
  tryDequeueNext(
    'shared',
    ctx({
      acquireFor: () => ({ ok: false, reason: 'global' }),
      releaseFor: (_pool, _userId, count) => released.push(count),
    }),
  );
  expect(queue.__queueTest.lengthOf('shared')).toBe(1);
  expect(released).toEqual([]);
});

test('recovered local batch over the current cap is failed and does not block later work', () => {
  seedQueued('too-big', 'alice', 'krea-2-gonzalomo', 'local', 2);
  seedQueued('next', 'bob', 'krea-2-gonzalomo', 'local', 1);
  const started: string[] = [];

  tryDequeueNext(
    'local',
    ctx({
      config: testConfig({ DATA_DIR: tempDir(), MAX_CONCURRENT_TILES_LOCAL: '1' }),
      startOrchestratorDetached: (entry) => {
        started.push(entry.batchId);
        return Promise.resolve();
      },
    }),
  );

  expect(started).toEqual(['next']);
  expect(queue.__queueTest.lengthOf('local')).toBe(0);
  expect(db.query<{ status: string; error: string | null }, []>("SELECT status, error FROM tiles WHERE id='t-too-big-0'").get()).toEqual({
    status: 'failed',
    error: 'internal error',
  });
  expect(db.query<{ status: string }, []>("SELECT status FROM batches WHERE id='too-big'").get()?.status).toBe('done');
  expect(db.query<{ status: string }, []>("SELECT status FROM batches WHERE id='next'").get()?.status).toBe('running');
});

test('local dequeue dispatches the affinity match before the FIFO head', () => {
  seedQueued('h3', 'alice', 'minimax-h3-i2v', 'local');
  seedQueued('gonzalomo', 'bob', 'krea-2-gonzalomo', 'local');
  queue.noteDispatched('local', 'krea-2-gonzalomo');
  const started: string[] = [];
  let acquired = false;
  const runtime = ctx({
    acquireFor: () => {
      if (acquired) return { ok: false, reason: 'global' };
      acquired = true;
      return { ok: true };
    },
    startOrchestratorDetached: (entry) => {
      started.push(entry.batchId);
      return Promise.resolve();
    },
  });

  tryDequeueNext('local', runtime);

  expect(started).toEqual(['gonzalomo']);
  expect(queue.__queueTest.peekHead('local')?.batchId).toBe('h3');
  acquired = false;
  tryDequeueNext('local', runtime);
  expect(started).toEqual(['gonzalomo', 'h3']);
});

test('local dequeue re-arms affinity after every dispatched entry', () => {
  seedQueued('a1', 'alice', 'krea-2-gonzalomo', 'local');
  seedQueued('b', 'bob', 'minimax-h3-i2v', 'local');
  seedQueued('a2', 'carol', 'krea-2-gonzalomo', 'local');
  const started: string[] = [];
  let acquired = false;
  const runtime = ctx({
    acquireFor: () => {
      if (acquired) return { ok: false, reason: 'global' };
      acquired = true;
      return { ok: true };
    },
    startOrchestratorDetached: (entry) => {
      started.push(entry.batchId);
      return Promise.resolve();
    },
  });

  for (let index = 0; index < 3; index += 1) {
    acquired = false;
    tryDequeueNext('local', runtime);
  }

  expect(started).toEqual(['a1', 'a2', 'b']);
});

test('local dequeue preserves same-user model-switch FIFO across capacity releases', () => {
  seedQueued('older', 'alice', 'minimax-h3-t2v', 'local');
  seedQueued('newer', 'alice', 'krea-2-gonzalomo', 'local');
  seedQueued('other', 'bob', 'krea-2-gonzalomo', 'local');
  queue.noteDispatched('local', 'krea-2-gonzalomo');
  const started: string[] = [];
  let occupied = false;
  const runtime = ctx({
    acquireFor: () => {
      if (occupied) return { ok: false, reason: 'global' };
      occupied = true;
      return { ok: true };
    },
    startOrchestratorDetached: (entry) => {
      started.push(entry.batchId);
      return Promise.resolve();
    },
  });

  queue.setPromptPreparation('older', queue.currentEpoch(), 'pending');
  tryDequeueNext('local', runtime);
  expect(started).toEqual(['other']);
  occupied = false;
  tryDequeueNext('local', runtime);
  expect(occupied).toBe(false);
  expect(db.query("SELECT status FROM batches WHERE id='newer'").get()).toEqual({ status: 'queued' });

  queue.setPromptPreparation('older', queue.currentEpoch(), 'ready');
  tryDequeueNext('local', runtime);
  expect(started).toEqual(['other', 'older']);
  occupied = false;
  tryDequeueNext('local', runtime);
  expect(started).toEqual(['other', 'older', 'newer']);
});

test('a passed-over local head is dispatched next once the affinity bound elapses', () => {
  // maxHeadWaitMs: 0 makes the bound trip on the first skip, so the test needs
  // no clock control: the dispatch of `a1` over `b` starts b's clock, and the
  // very next pick must be `b` even though another same-key entry is queued.
  queue.configureQueueScheduling({ affinityKeyOf: (modelId) => modelId, maxHeadWaitMs: 0 });
  try {
    queue.noteDispatched('local', 'krea-2-gonzalomo');
    seedQueued('b', 'bob', 'minimax-h3-i2v', 'local');
    seedQueued('a1', 'alice', 'krea-2-gonzalomo', 'local');
    seedQueued('a2', 'carol', 'krea-2-gonzalomo', 'local');
    const started: string[] = [];
    let acquired = false;
    const runtime = ctx({
      acquireFor: () => {
        if (acquired) return { ok: false, reason: 'global' };
        acquired = true;
        return { ok: true };
      },
      startOrchestratorDetached: (entry) => {
        started.push(entry.batchId);
        return Promise.resolve();
      },
    });

    for (let index = 0; index < 3; index += 1) {
      acquired = false;
      tryDequeueNext('local', runtime);
    }

    expect(started).toEqual(['a1', 'b', 'a2']);
  } finally {
    queue.configureQueueScheduling({ affinityKeyOf: (modelId) => modelId, maxHeadWaitMs: 600_000 });
  }
});

test('per-user cap miss keeps strict FIFO and does not skip to another user', () => {
  seedQueued('a1', 'alice');
  seedQueued('b1', 'bob');
  const acquired: string[] = [];
  const started: string[] = [];
  tryDequeueNext(
    'shared',
    ctx({
      acquireFor: (_pool, userId) => {
        if (userId === 'alice') return { ok: false, reason: 'per-user' };
        acquired.push(userId);
        return { ok: true };
      },
      startOrchestratorDetached: (entry) => {
        started.push(entry.batchId);
        return Promise.resolve();
      },
    }),
  );

  expect(acquired).toEqual([]);
  expect(started).toEqual([]);
  expect(queue.__queueTest.peekHead('shared')?.batchId).toBe('a1');
  expect(queue.__queueTest.lengthOf('shared')).toBe(2);
  expect(db.query<{ status: string }, []>("SELECT status FROM batches WHERE id='a1'").get()?.status).toBe('queued');
  expect(db.query<{ status: string }, []>("SELECT status FROM batches WHERE id='b1'").get()?.status).toBe('queued');
});

test("BYOK skips another user's blocked head when the later user has capacity", () => {
  seedQueued('a1', 'alice', 'gemini-3-pro-image-preview', 'byok');
  seedQueued('a2', 'alice', 'gemini-3-pro-image-preview', 'byok');
  seedQueued('b1', 'bob', 'gemini-3-pro-image-preview', 'byok');
  const acquired: string[] = [];
  const started: string[] = [];

  tryDequeueNext(
    'byok',
    ctx({
      acquireFor: (_pool, userId) => {
        acquired.push(userId);
        if (userId === 'alice') return { ok: false, reason: 'per-user' };
        return { ok: true };
      },
      startOrchestratorDetached: (entry) => {
        started.push(entry.batchId);
        return Promise.resolve();
      },
    }),
  );

  expect(acquired.slice(0, 2)).toEqual(['alice', 'bob']);
  expect(started).toEqual(['b1']);
  expect(queue.__queueTest.peekHead('byok')?.batchId).toBe('a1');
  expect(queue.__queueTest.lengthOf('byok')).toBe(2);
  expect(db.query<{ status: string }, []>("SELECT status FROM batches WHERE id='a1'").get()?.status).toBe('queued');
  expect(db.query<{ status: string }, []>("SELECT status FROM batches WHERE id='a2'").get()?.status).toBe('queued');
  expect(db.query<{ status: string }, []>("SELECT status FROM batches WHERE id='b1'").get()?.status).toBe('running');
});

test('stale in-memory entry with DB already canceled releases acquired slot and drops entry', () => {
  seedQueued('b1');
  db.query("UPDATE batches SET status='done' WHERE id='b1'").run();
  const released: number[] = [];
  tryDequeueNext(
    'shared',
    ctx({
      releaseFor: (_pool, _userId, count) => released.push(count),
    }),
  );
  expect(queue.__queueTest.lengthOf('shared')).toBe(0);
  expect(released).toEqual([1]);
});

test('stale dequeue contexts from before a queue reset cannot pop current entries', () => {
  const staleCtx = ctx();
  db = new Database(':memory:');
  migrate(db, '/tmp');
  queue.resetQueueForTests();
  seedQueued('current');

  tryDequeueNext('shared', staleCtx);

  expect(queue.__queueTest.peekHead('shared')?.batchId).toBe('current');
  expect(queue.__queueTest.lengthOf('shared')).toBe(1);
});

test('revalidate failure tombstones first batch, releases slot, and tries next head', () => {
  seedQueued('b1');
  seedQueued('b2');
  let calls = 0;
  tryDequeueNext(
    'shared',
    ctx({
      registry: {
        findModel: () => {
          calls += 1;
          return calls === 1 ? null : { model: { id: 'gpt-image-2.5-sunburst', pool: 'shared', maxCountPerBatch: 8 } };
        },
        healthSnapshot: () => new Map(),
      },
    }),
  );

  const t1 = db
    .query<{ status: string; error: string | null }, []>("SELECT status, error FROM tiles WHERE batch_id='b1'")
    .get();
  expect(t1).toMatchObject({ status: 'failed', error: 'upstream rejected' });
  const row2 = db.query<{ status: string }, []>("SELECT status FROM batches WHERE id='b2'").get();
  expect(row2?.status).toBe('running');
  expect(queue.__queueTest.lengthOf('shared')).toBe(0);
});

test('async start failure releases slot and kicks the next queued head', async () => {
  seedQueued('b1', 'alice');
  seedQueued('b2', 'bob');
  const released: string[] = [];
  const started: string[] = [];

  tryDequeueNext(
    'shared',
    ctx({
      releaseFor: (_pool, userId) => { released.push(userId); },
      startOrchestratorDetached: (entry) => {
        started.push(entry.batchId);
        return entry.batchId === 'b1'
          ? Promise.reject(new Error('start failed'))
          : Promise.resolve();
      },
    }),
  );

  await Bun.sleep(0);

  expect(released).toEqual(['alice']);
  expect(started).toEqual(['b1', 'b2']);
  expect(queue.__queueTest.lengthOf('shared')).toBe(0);
});

test('terminal-write failure after release cannot spend another active batch reservation', async () => {
  expect(acquireTiles('active', 1, 2, 2).ok).toBe(true);
  seedQueued('invalid', 'alice', 'removed-model');
  seedQueued('next', 'bob');
  seedQueued('waiting', 'carol');
  // Fail the terminal DB write, after revalidation has already released the
  // invalid entry. Real counters must still account for the active work.
  db.run(`CREATE TRIGGER fail_terminal BEFORE UPDATE OF status ON tiles
    WHEN OLD.batch_id = 'invalid' BEGIN SELECT RAISE(FAIL, 'terminal write failed'); END`);
  const started: string[] = [];
  const runtime = ctx({
    config: testConfig({ DATA_DIR: tempDir(), MAX_CONCURRENT_TILES: '2', MAX_CONCURRENT_TILES_PER_USER: '2' }),
    registry: {
      findModel: (id) => id === 'removed-model' ? null
        : { model: { id, pool: 'shared', maxCountPerBatch: 8 } },
      healthSnapshot: () => new Map(),
    },
    acquireFor: (_pool, user, count) => acquireTiles(user, count, 2, 2),
    releaseFor: (_pool, user, count) => { releaseTiles(user, count); },
    startOrchestratorDetached: (entry) => { started.push(entry.batchId); return Promise.resolve(); },
  });
  tryDequeueNext('shared', runtime);
  await Bun.sleep(0);
  expect(started).toEqual(['next']);
  expect(tilesInFlight()).toBe(2);
  expect(acquireTiles('extra', 1, 2, 2)).toEqual({ ok: false, reason: 'global' });
  expect(queue.__queueTest.peekHead('shared')?.batchId).toBe('waiting');
  // Completing just the unrelated active work admits exactly one waiter.
  releaseTiles('active', 1);
  tryDequeueNext('shared', runtime);
  expect(started).toEqual(['next', 'waiting']);
  expect(tilesInFlight()).toBe(2);
});

test('a starter rejecting after releasing its shared handle cannot release other active work', async () => {
  expect(acquireTiles('active', 1, 2, 2).ok).toBe(true);
  seedQueued('late-failure', 'alice');
  seedQueued('next', 'bob');
  seedQueued('waiting', 'carol');
  const started: string[] = [];
  tryDequeueNext('shared', ctx({
    config: testConfig({ DATA_DIR: tempDir(), MAX_CONCURRENT_TILES: '2', MAX_CONCURRENT_TILES_PER_USER: '2' }),
    acquireFor: (_pool, user, count) => acquireTiles(user, count, 2, 2),
    releaseFor: (_pool, user, count) => { releaseTiles(user, count); },
    startOrchestratorDetached: (entry, reservation) => {
      started.push(entry.batchId);
      if (entry.batchId === 'late-failure') {
        reservation.releaseRemaining();
        return Promise.reject(new Error('late pipeline cleanup failure'));
      }
      return Promise.resolve();
    },
  }));
  await Bun.sleep(0);
  expect(started).toEqual(['late-failure', 'next']);
  expect(tilesInFlight()).toBe(2);
  expect(acquireTiles('extra', 1, 2, 2)).toEqual({ ok: false, reason: 'global' });
  expect(queue.__queueTest.peekHead('shared')?.batchId).toBe('waiting');
});

test('missing BYOK key fails synchronously at dequeue and advances the next head', () => {
  seedQueued('b1', 'alice', 'gemini-3-pro-image-preview', 'byok');
  seedQueued('b2', 'bob', 'gemini-3-pro-image-preview', 'byok');
  db.run("INSERT INTO user_provider_keys (user_id, provider, ciphertext, nonce, key_version, fingerprint, created_at, updated_at) VALUES ('bob', 'google', ?, ?, 1, 'abc', ?, ?)", [
    new Uint8Array([1]),
    new Uint8Array([2]),
    Date.now(),
    Date.now(),
  ]);
  const released: string[] = [];
  const started: string[] = [];

  tryDequeueNext(
    'byok',
    ctx({
      registry: {
        findModel: () => ({ model: { id: 'gemini-3-pro-image-preview', pool: 'byok', maxCountPerBatch: 8, requiresKey: { provider: 'google' } } }),
        healthSnapshot: () => new Map(),
      },
      releaseFor: (_pool, userId) => { released.push(userId); },
      startOrchestratorDetached: (entry) => {
        started.push(entry.batchId);
        return Promise.resolve();
      },
    }),
  );

  expect(released).toEqual(['alice']);
  expect(started).toEqual(['b2']);
  expect(queue.__queueTest.lengthOf('byok')).toBe(0);
});

test('open breaker on shared pool blocks dequeue without claiming or starting', () => {
  seedQueued('b-gate');
  const started: string[] = [];
  configureUpstreamGate({
    kickPool: () => undefined,
    failQueued: () => undefined,
    halfOpenAfterMs: 60_000,
    maxPauseMs: 600_000,
    threshold: 5,
  });
  noteBreakerState('shared', 'open');

  tryDequeueNext(
    'shared',
    ctx({
      startOrchestratorDetached: (entry) => {
        started.push(entry.batchId);
        return Promise.resolve();
      },
    }),
  );

  expect(started).toEqual([]);
  expect(queue.__queueTest.lengthOf('shared')).toBe(1);
  const row = db.query<{ status: string }, []>("SELECT status FROM batches WHERE id='b-gate'").get();
  expect(row?.status).toBe('queued');
});

afterEach(() => {
  resetUpstreamGateForTests();
  resetShutdownDrainForTests();
});

test('shutdown drain gate leaves queued batches unclaimed when a slot release kicks the queue', () => {
  seedQueued('b-shutdown');
  const acquired: string[] = [];
  const started: string[] = [];
  beginShutdownDrain();

  tryDequeueNext(
    'shared',
    ctx({
      acquireFor: (_pool, _userId, count) => {
        acquired.push(`count:${count}`);
        return { ok: true };
      },
      startOrchestratorDetached: (entry) => {
        started.push(entry.batchId);
        return Promise.resolve();
      },
    }),
  );

  expect(acquired).toEqual([]);
  expect(started).toEqual([]);
  expect(queue.__queueTest.peekHead('shared')?.batchId).toBe('b-shutdown');
  expect(db.query<{ status: string }, []>("SELECT status FROM batches WHERE id='b-shutdown'").get()?.status).toBe('queued');
});

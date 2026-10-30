import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { parseSseText, testConfig, tempDir } from '../test/helpers';
import { migrate } from '../db/migrate';
import { hotStatements } from '../db/preparedStatements';
import { DB_CORRUPTION_EVENT } from '../db/integrity';
import * as bus from './bus';
import { beginShutdownDrain, DEQUEUE_RETRY_MS, kickDequeueNext, resetShutdownDrainForTests, tryDequeueNext, type DequeueRuntimeContext } from './dequeue';
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

test('a failed initial durable claim retains the queue and retries exactly once after contention clears', async () => {
  seedQueued('retry-claim', 'alice');
  const claim = spyOn(hotStatements(db).transitionQueuedToRunning, 'run')
    .mockImplementationOnce(() => { throw Object.assign(new Error('synthetic contention'), { code: 'SQLITE_BUSY' }); });
  const started: string[] = [];
  let acquisitions = 0;
  let releases = 0;
  const runtime = ctx({
    acquireFor: (_pool, user, count) => {
      acquisitions += 1;
      return acquireTiles(user, count, 4, 4);
    },
    releaseFor: (_pool, user, count) => { releases += count; releaseTiles(user, count); },
    startOrchestratorDetached: (entry, reservation) => {
      started.push(entry.batchId);
      reservation.releaseRemaining();
      return Promise.resolve();
    },
  });
  tryDequeueNext('shared', runtime);
  await Bun.sleep(0);
  expect(acquisitions).toBe(1);
  expect(releases).toBe(1);
  expect(queue.__queueTest.peekHead('shared')?.batchId).toBe('retry-claim');
  expect(db.query('SELECT status FROM batches WHERE id=?').get('retry-claim')).toEqual({ status: 'queued' });
  expect(tilesInFlight()).toBe(0);
  await Bun.sleep(DEQUEUE_RETRY_MS + 30);
  claim.mockRestore();
  expect(started).toEqual(['retry-claim']);
  expect(acquisitions).toBe(2);
  expect(releases).toBe(2);
  expect(queue.__queueTest.lengthOf('shared')).toBe(0);
  expect(tilesInFlight()).toBe(0);
});

for (const code of ['SQLITE_FULL', 'SQLITE_IOERR_WRITE', 'SQLITE_READONLY', 'SQLITE_INTERRUPT', 'SQLITE_CORRUPT']) {
  test(`${code} preserves queued jobs until database recovery`, async () => {
    seedQueued('storage-recovery', 'alice');
    seedQueued('storage-next', 'bob');
    const claim = spyOn(hotStatements(db).transitionQueuedToRunning, 'run')
      .mockImplementationOnce(() => { throw Object.assign(new Error('temporary host failure'), { code }); });
    const started: string[] = [];
    const runtime = ctx({
      acquireFor: (_pool, user, count) => acquireTiles(user, count, 4, 4),
      releaseFor: (_pool, user, count) => { releaseTiles(user, count); },
      startOrchestratorDetached: (entry, reservation) => {
        started.push(entry.batchId);
        reservation.releaseRemaining();
        return Promise.resolve();
      },
    });
    try {
      tryDequeueNext('shared', runtime);
      expect(started).toEqual([]);
      expect(db.query('SELECT status FROM batches ORDER BY id').all()).toEqual([{ status: 'queued' }, { status: 'queued' }]);
      expect(db.query('SELECT DISTINCT status FROM tiles').all()).toEqual([{ status: 'loading' }]);
      expect(tilesInFlight()).toBe(0);
      await Bun.sleep(DEQUEUE_RETRY_MS + 30);
      expect(started).toEqual(['storage-recovery', 'storage-next']);
      expect(tilesInFlight()).toBe(0);
    } finally { claim.mockRestore(); }
  });
}

test('an idle one-off unknown claim failure recovers automatically with bounded delay', async () => {
  seedQueued('unknown-claim');
  const claim = spyOn(hotStatements(db).transitionQueuedToRunning, 'run')
    .mockImplementationOnce(() => { throw new Error('database handle unavailable'); });
  const started: string[] = [];
  const runtime = ctx({ startOrchestratorDetached: (entry) => { started.push(entry.batchId); return Promise.resolve(); } });
  try {
    tryDequeueNext('shared', runtime);
    expect(started).toEqual([]);
    expect(db.query('SELECT status FROM batches WHERE id=?').get('unknown-claim')).toEqual({ status: 'queued' });
    await Bun.sleep(DEQUEUE_RETRY_MS + 30);
    expect(started).toEqual(['unknown-claim']);
  } finally { claim.mockRestore(); }
});

for (const pool of ['shared', 'local', 'byok'] as const) {
  test(`${pool}: a persistent uncoded claim failure preserves same-user FIFO while another user starts`, async () => {
    seedQueued('uncoded-first', 'alice', undefined, pool);
    seedQueued('uncoded-tail', 'alice', undefined, pool);
    seedQueued('healthy-bob', 'bob', undefined, pool);
    const statement = hotStatements(db).transitionQueuedToRunning;
    const run = statement.run.bind(statement);
    const claim = spyOn(statement, 'run').mockImplementation((...args) => {
      if (args[1] === 'uncoded-first') throw new Error('row-specific uncoded failure');
      return run(...args);
    });
    const started: string[] = [];
    const runtime = ctx({
      acquireFor: (_pool, user, count) => acquireTiles(user, count, 4, 4),
      releaseFor: (_pool, user, count) => { releaseTiles(user, count); },
      startOrchestratorDetached: (entry) => { started.push(entry.batchId); return Promise.resolve(); },
    });
    try {
      tryDequeueNext(pool, runtime);
      for (let i = 0; i < 5; i += 1) kickDequeueNext(pool, runtime);
      expect(claim).toHaveBeenCalledTimes(2);
      await Bun.sleep(DEQUEUE_RETRY_MS + 30);
      expect(started).toEqual(['healthy-bob']);
      expect(claim).toHaveBeenCalledTimes(3);
      expect(queue.entries(pool).map((entry) => entry.batchId)).toEqual(['uncoded-first', 'uncoded-tail']);
      expect(db.query("SELECT DISTINCT status FROM batches WHERE user_id='alice'").all()).toEqual([{ status: 'queued' }]);
      expect(tilesInFlight()).toBe(1);
      seedQueued('healthy-carol', 'carol', undefined, pool);
      kickDequeueNext(pool, runtime);
      expect(started).toEqual(['healthy-bob', 'healthy-carol']);
      for (let i = 0; i < 5; i += 1) kickDequeueNext(pool, runtime);
      await Bun.sleep(DEQUEUE_RETRY_MS + 30);
      expect(claim).toHaveBeenCalledTimes(4); // no early retry while its 500ms timer waits
      claim.mockRestore();
      await Bun.sleep(DEQUEUE_RETRY_MS + 30);
      expect(started).toEqual(['healthy-bob', 'healthy-carol', 'uncoded-first', 'uncoded-tail']);
      expect(tilesInFlight()).toBe(4);
      releaseTiles('bob', 1);
      releaseTiles('carol', 1);
      releaseTiles('alice', 2);
      expect(tilesInFlight()).toBe(0);
    } finally { claim.mockRestore(); }
  });
}

test('unexpected queue preparation bugs do not arm an automatic retry loop', async () => {
  let calls = 0;
  kickDequeueNext('local', ctx({ prepareQueued: () => { calls += 1; throw new Error('logic bug'); } }));
  await Bun.sleep(DEQUEUE_RETRY_MS + 30);
  expect(calls).toBe(1);
});

test('repeated operational errors back off while preserving queued ownership', async () => {
  seedQueued('backoff-claim');
  const claim = spyOn(hotStatements(db).transitionQueuedToRunning, 'run')
    .mockImplementation(() => { throw Object.assign(new Error('storage unavailable'), { code: 'SQLITE_FULL' }); });
  const started: string[] = [];
  const runtime = ctx({ startOrchestratorDetached: (entry) => { started.push(entry.batchId); return Promise.resolve(); } });
  try {
    tryDequeueNext('shared', runtime);
    await Bun.sleep(DEQUEUE_RETRY_MS + 30);
    expect(claim).toHaveBeenCalledTimes(2);
    await Bun.sleep(DEQUEUE_RETRY_MS + 30);
    expect(claim).toHaveBeenCalledTimes(2);
    expect(started).toEqual([]);
    expect(queue.__queueTest.peekHead('shared')?.batchId).toBe('backoff-claim');
    claim.mockRestore();
    await Bun.sleep(DEQUEUE_RETRY_MS * 2 + 30);
    expect(started).toEqual(['backoff-claim']);
  } finally { claim.mockRestore(); }
});

test('a pending claim retry cannot cross a queue epoch or shutdown', async () => {
  seedQueued('old-claim');
  const claim = spyOn(hotStatements(db).transitionQueuedToRunning, 'run')
    .mockImplementationOnce(() => { throw Object.assign(new Error('synthetic contention'), { code: 'SQLITE_LOCKED_SHAREDCACHE' }); });
  const started: string[] = [];
  const runtime = ctx({ startOrchestratorDetached: (entry) => { started.push(entry.batchId); return Promise.resolve(); } });
  tryDequeueNext('shared', runtime);
  queue.resetQueueForTests();
  claim.mockRestore();
  seedQueued('new-claim');
  await Bun.sleep(DEQUEUE_RETRY_MS + 30);
  expect(started).toEqual([]);
  expect(db.query('SELECT status FROM batches WHERE id=?').get('new-claim')).toEqual({ status: 'queued' });
  beginShutdownDrain();
  tryDequeueNext('shared', ctx());
  expect(started).toEqual([]);
});

for (const code of [undefined, 'SQLITE_CORRUPT'] as const) for (const matchingStamp of [true, false]) {
  test(`a claim committed before ${code ?? 'uncoded'} throw ${matchingStamp ? 'settles its own stamp' : 'leaves a different owner untouched'}`, async () => {
    seedQueued('ambiguous', 'alice');
    const statement = hotStatements(db).transitionQueuedToRunning;
    const run = statement.run.bind(statement);
    let attemptedAt = 0;
    const claim = spyOn(statement, 'run').mockImplementationOnce((...args) => {
      attemptedAt = args[0];
      run(...args);
      if (!matchingStamp) db.run('UPDATE batches SET started_at=? WHERE id=?', [attemptedAt + 1, 'ambiguous']);
      throw Object.assign(new Error('statement committed before its result was lost'), { code });
    });
    const started: string[] = [];
    const runtime = ctx({
      acquireFor: (_pool, user, count) => acquireTiles(user, count, 4, 4),
      releaseFor: (_pool, user, count) => { releaseTiles(user, count); },
      startOrchestratorDetached: (entry) => { started.push(entry.batchId); return Promise.resolve(); },
    });
    try {
      tryDequeueNext('shared', runtime);
      expect(db.query('SELECT status FROM batches WHERE id=?').get('ambiguous')).toEqual({ status: 'running' });
      expect(tilesInFlight()).toBe(0);
      await Bun.sleep(DEQUEUE_RETRY_MS + 30);
      expect(started).toEqual([]);
      expect(claim).toHaveBeenCalledTimes(1);
      expect(queue.__queueTest.lengthOf('shared')).toBe(0);
      expect(db.query('SELECT status, started_at FROM batches WHERE id=?').get('ambiguous'))
        .toEqual({ status: matchingStamp ? 'done' : 'running', started_at: matchingStamp ? attemptedAt : attemptedAt + 1 });
      expect(db.query('SELECT status FROM tiles WHERE batch_id=?').get('ambiguous'))
        .toEqual({ status: matchingStamp ? 'failed' : 'loading' });
    } finally { claim.mockRestore(); }
  });
}

for (const code of [undefined, 'SQLITE_CORRUPT'] as const) {
test(`failed claim inspection retains its timestamp and recovers after ${code ?? 'uncoded'} read failure`, async () => {
  seedQueued('inspect-retry');
  const claim = spyOn(hotStatements(db).transitionQueuedToRunning, 'run')
    .mockImplementationOnce(() => { throw new Error('one-off claim error'); });
  const started: string[] = [];
  const runtime = ctx({ startOrchestratorDetached: (entry) => { started.push(entry.batchId); return Promise.resolve(); } });
  try {
    tryDequeueNext('shared', runtime);
    const query = spyOn(db, 'query').mockImplementationOnce(() => { throw Object.assign(new Error('one-off inspection error'), { code }); });
    try {
      await Bun.sleep(DEQUEUE_RETRY_MS + 30);
      expect(started).toEqual([]);
      expect(queue.__queueTest.peekHead('shared')?.batchId).toBe('inspect-retry');
    } finally { query.mockRestore(); }
    await Bun.sleep(DEQUEUE_RETRY_MS * 2 + 30);
    expect(started).toEqual(['inspect-retry']);
  } finally { claim.mockRestore(); }
});
}

for (const code of ['SQLITE_BUSY', 'SQLITE_CORRUPT']) {
test(`a ${code} preparation failure without a claim stamp cannot settle another running owner`, async () => {
  seedQueued('prepared-by-another', 'alice', undefined, 'local');
  const timestamp = Date.now();
  const now = spyOn(Date, 'now').mockReturnValue(timestamp);
  let firstPreparation = true;
  const started: string[] = [];
  const runtime = ctx({
    prepareQueued: () => {
      if (!firstPreparation) return true;
      firstPreparation = false;
      db.run("UPDATE batches SET status='running',started_at=? WHERE id=?", [timestamp, 'prepared-by-another']);
      throw Object.assign(new Error('preparation failed'), { code });
    },
    startOrchestratorDetached: (entry) => { started.push(entry.batchId); return Promise.resolve(); },
  });
  try {
    kickDequeueNext('local', runtime);
    await Bun.sleep(DEQUEUE_RETRY_MS + 30);
    expect(started).toEqual([]);
    expect(queue.__queueTest.lengthOf('local')).toBe(0);
    expect(db.query('SELECT status,started_at FROM batches WHERE id=?').get('prepared-by-another'))
      .toEqual({ status: 'running', started_at: timestamp });
    expect(db.query('SELECT status FROM tiles WHERE batch_id=?').get('prepared-by-another')).toEqual({ status: 'loading' });
  } finally { now.mockRestore(); }
});
}

test('corrupt revalidation after a claim settles it before returning and defers later work', async () => {
  seedQueued('corrupt-claimed', 'alice');
  seedQueued('healthy-after-corruption', 'bob');
  const frames: string[] = [];
  const diagnostics: unknown[] = [];
  bus.subscribe('corrupt-claimed', {
    enqueueTerminal: (frame) => { frames.push(new TextDecoder().decode(frame.bytes)); }, enqueueOptional: () => undefined,
  });
  let first = true;
  let releases = 0;
  const started: string[] = [];
  const runtime = ctx({
    logger: { error: (payload) => { diagnostics.push(payload); }, warn: () => undefined, info: () => undefined },
    registry: {
      findModel: (id) => {
        if (first) { first = false; throw Object.assign(new Error('corrupt revalidation'), { code: 'SQLITE_CORRUPT' }); }
        return { model: { id, pool: 'shared', maxCountPerBatch: 8 } };
      }, healthSnapshot: () => new Map(),
    },
    acquireFor: (_pool, user, count) => acquireTiles(user, count, 4, 4),
    releaseFor: (_pool, user, count) => { releases += 1; releaseTiles(user, count); },
    startOrchestratorDetached: (entry, reservation) => { started.push(entry.batchId); reservation.releaseRemaining(); return Promise.resolve(); },
  });
  tryDequeueNext('shared', runtime);
  await Bun.sleep(0);
  expect(started).toEqual([]);
  expect(releases).toBe(1);
  expect(tilesInFlight()).toBe(0);
  expect(db.query('SELECT status FROM batches WHERE id=?').get('corrupt-claimed')).toEqual({ status: 'done' });
  expect(parseSseText(frames.join('')).map((frame) => frame.event)).toEqual(['tile', 'done']);
  expect(diagnostics).toContainEqual(expect.objectContaining({ event: DB_CORRUPTION_EVENT }));
  await Bun.sleep(DEQUEUE_RETRY_MS + 30);
  expect(started).toEqual(['healthy-after-corruption']);
  expect(releases).toBe(2);
  expect(tilesInFlight()).toBe(0);
});

for (const phase of ['tile write', 'finalize', 'retry inspection'] as const) {
  test(`corrupt ${phase} settlement retains ownership and retries with ordered failed/done frames`, async () => {
    seedQueued('corrupt-settlement', 'alice', 'removed-model');
    const query = spyOn(db, 'query');
    const run = spyOn(db, 'run');
    const frames: string[] = [];
    const diagnostics: unknown[] = [];
    let releases = 0;
    let starts = 0;
    bus.subscribe('corrupt-settlement', {
      enqueueTerminal: (frame) => { frames.push(new TextDecoder().decode(frame.bytes)); }, enqueueOptional: () => undefined,
    });
    const runtime = ctx({
      logger: { error: (payload) => { diagnostics.push(payload); }, warn: () => undefined, info: () => undefined },
      registry: { findModel: () => {
        const fail = () => { throw Object.assign(new Error('corrupt terminal write'), { code: 'SQLITE_CORRUPT' }); };
        if (phase === 'finalize') run.mockImplementationOnce(fail);
        else query.mockImplementationOnce(fail);
        return null;
      }, healthSnapshot: () => new Map() },
      acquireFor: (_pool, user, count) => acquireTiles(user, count, 4, 4),
      releaseFor: (_pool, user, count) => { releases += 1; releaseTiles(user, count); },
      startOrchestratorDetached: () => { starts += 1; return Promise.resolve(); },
    });
    try {
      tryDequeueNext('shared', runtime);
      expect(db.query('SELECT status FROM batches WHERE id=?').get('corrupt-settlement')).toEqual({ status: 'running' });
      expect(db.query('SELECT status FROM tiles WHERE batch_id=?').get('corrupt-settlement'))
        .toEqual({ status: phase === 'finalize' ? 'failed' : 'loading' });
      expect(parseSseText(frames.join('')).map((frame) => frame.event)).toEqual(phase === 'finalize' ? ['tile'] : []);
      expect(diagnostics).toContainEqual(expect.objectContaining({ event: DB_CORRUPTION_EVENT }));
      if (phase === 'retry inspection') {
        await Bun.sleep(0); // drain the release kick before faulting the due retry's inspection
        query.mockImplementationOnce(() => {
          throw Object.assign(new Error('corrupt retry inspection'), { code: 'SQLITE_CORRUPT' });
        });
      }
      await Bun.sleep(DEQUEUE_RETRY_MS + 30);
      if (phase === 'retry inspection') {
        expect(db.query('SELECT status FROM batches WHERE id=?').get('corrupt-settlement')).toEqual({ status: 'running' });
        await Bun.sleep(DEQUEUE_RETRY_MS * 2 + 30);
      }
      expect(db.query('SELECT status FROM batches WHERE id=?').get('corrupt-settlement')).toEqual({ status: 'done' });
      const events = parseSseText(frames.join(''));
      expect(events.map((frame) => frame.event)).toEqual(['tile', 'done']);
      expect(events[0]?.data).toMatchObject({ status: 'failed' });
      expect(starts).toBe(0);
      expect(releases).toBe(1);
      expect(tilesInFlight()).toBe(0);
    } finally { query.mockRestore(); run.mockRestore(); }
  });
}

test('own claim recovery resets its history and deletion cancels obsolete retries', async () => {
  seedQueued('recovered');
  const claim = spyOn(hotStatements(db).transitionQueuedToRunning, 'run')
    .mockImplementationOnce(() => { throw new Error('first failure'); });
  const timers = spyOn(globalThis, 'setTimeout');
  const started: string[] = [];
  const runtime = ctx({ startOrchestratorDetached: (entry) => { started.push(entry.batchId); return Promise.resolve(); } });
  try {
    tryDequeueNext('shared', runtime);
    await Bun.sleep(DEQUEUE_RETRY_MS + 30);
    expect(started).toEqual(['recovered']);
    seedQueued('deleted');
    claim.mockImplementationOnce(() => { throw new Error('new failure'); });
    tryDequeueNext('shared', runtime);
    expect(timers.mock.calls.map((args) => args[1])).toEqual([DEQUEUE_RETRY_MS, DEQUEUE_RETRY_MS]);
    db.run('DELETE FROM batches WHERE id=?', ['deleted']);
    kickDequeueNext('shared', runtime);
    await Bun.sleep(DEQUEUE_RETRY_MS + 30);
    expect(started).toEqual(['recovered']);
    expect(queue.__queueTest.lengthOf('shared')).toBe(0);
    expect(claim).toHaveBeenCalledTimes(3);
  } finally { timers.mockRestore(); claim.mockRestore(); }
});

test('a new busy claim retries in 250ms independently of a longer settlement lane', async () => {
  seedQueued('parked', 'alice', 'removed-model');
  db.run(`CREATE TRIGGER fail_parked BEFORE UPDATE OF status ON tiles
    WHEN OLD.batch_id='parked' BEGIN SELECT RAISE(FAIL,'parked constraint'); END`);
  const runtime = ctx({ registry: {
    findModel: (id) => id === 'removed-model' ? null : { model: { id, pool: 'shared', maxCountPerBatch: 8 } },
    healthSnapshot: () => new Map(),
  } });
  const timers = spyOn(globalThis, 'setTimeout');
  try {
    tryDequeueNext('shared', runtime);
    await Bun.sleep(DEQUEUE_RETRY_MS + 30);
    seedQueued('new-claim', 'bob');
    const claim = spyOn(hotStatements(db).transitionQueuedToRunning, 'run')
      .mockImplementationOnce(() => { throw Object.assign(new Error('busy claim'), { code: 'SQLITE_BUSY' }); });
    try {
      tryDequeueNext('shared', runtime);
      expect(timers.mock.calls.map((args) => args[1])).toEqual([DEQUEUE_RETRY_MS, DEQUEUE_RETRY_MS * 2, DEQUEUE_RETRY_MS]);
      await Bun.sleep(DEQUEUE_RETRY_MS + 30);
      expect(db.query('SELECT status FROM batches WHERE id=?').get('new-claim')).toEqual({ status: 'running' });
      expect(db.query('SELECT status FROM tiles WHERE batch_id=?').get('parked')).toEqual({ status: 'loading' });
      expect(claim).toHaveBeenCalledTimes(2);
    } finally { claim.mockRestore(); }
  } finally { timers.mockRestore(); }
});

test('blocking storage claims retry independently of deferred unknown-user history', async () => {
  seedQueued('unknown-alice', 'alice');
  const statement = hotStatements(db).transitionQueuedToRunning;
  const run = statement.run.bind(statement);
  let aliceCalls = 0;
  let bobCalls = 0;
  const claim = spyOn(statement, 'run').mockImplementation((...args) => {
    if (args[1] === 'unknown-alice') { aliceCalls += 1; throw new Error('persistent uncoded row failure'); }
    if (args[1] === 'busy-bob' && ++bobCalls <= 2) throw Object.assign(new Error('busy storage'), { code: 'SQLITE_BUSY' });
    return run(...args);
  });
  const timers = spyOn(globalThis, 'setTimeout');
  const started: string[] = [];
  const runtime = ctx({ startOrchestratorDetached: (entry, reservation) => {
    started.push(entry.batchId); reservation.releaseRemaining(); return Promise.resolve();
  } });
  try {
    tryDequeueNext('shared', runtime);
    await Bun.sleep(DEQUEUE_RETRY_MS + 30);
    expect(aliceCalls).toBe(2);
    seedQueued('busy-bob', 'bob');
    kickDequeueNext('shared', runtime);
    expect(bobCalls).toBe(1);
    expect(timers.mock.calls.map((args) => args[1])).toEqual([DEQUEUE_RETRY_MS, DEQUEUE_RETRY_MS * 2, DEQUEUE_RETRY_MS]);
    await Bun.sleep(DEQUEUE_RETRY_MS + 30);
    expect(bobCalls).toBe(2); // first BUSY retry is 250ms, not Alice's 500ms
    expect(timers.mock.calls.map((args) => args[1])).toEqual([DEQUEUE_RETRY_MS, DEQUEUE_RETRY_MS * 2, DEQUEUE_RETRY_MS, DEQUEUE_RETRY_MS * 2]);
    expect(started).toEqual([]);
    await Bun.sleep(DEQUEUE_RETRY_MS * 2 + 30);
    expect(bobCalls).toBe(3);
    expect(started).toEqual(['busy-bob']);
    expect(aliceCalls).toBe(3);
    expect(timers.mock.calls.at(-1)?.[1]).toBe(DEQUEUE_RETRY_MS * 4);
    expect(db.query('SELECT status FROM batches WHERE id=?').get('unknown-alice')).toEqual({ status: 'queued' });
  } finally { timers.mockRestore(); claim.mockRestore(); }
});

test('one failed parked row cannot starve a later settlement on the same due pass', async () => {
  seedQueued('parked-first', 'alice', 'removed-model');
  seedQueued('parked-second', 'bob', 'removed-model');
  for (const [trigger, batch] of [['fail_first', 'parked-first'], ['fail_second', 'parked-second']] as const) {
    db.run(`CREATE TRIGGER ${trigger} BEFORE UPDATE OF status ON tiles
      WHEN OLD.batch_id='${batch}' BEGIN SELECT RAISE(FAIL,'parked constraint'); END`);
  }
  const runtime = ctx({ registry: { findModel: () => null, healthSnapshot: () => new Map() } });
  tryDequeueNext('shared', runtime);
  db.run('DROP TRIGGER fail_second');
  await Bun.sleep(DEQUEUE_RETRY_MS + 30);
  expect(db.query('SELECT status FROM batches WHERE id=?').get('parked-second')).toEqual({ status: 'done' });
  expect(db.query('SELECT status FROM tiles WHERE batch_id=?').get('parked-second')).toEqual({ status: 'failed' });
  expect(db.query('SELECT status FROM tiles WHERE batch_id=?').get('parked-first')).toEqual({ status: 'loading' });
  db.run('DROP TRIGGER fail_first');
  await Bun.sleep(DEQUEUE_RETRY_MS * 2 + 30);
  expect(db.query('SELECT status FROM batches WHERE id=?').get('parked-first')).toEqual({ status: 'done' });
});

test('a permanent row-specific claim failure settles that row and starts later work exactly once', () => {
  seedQueued('bad-claim', 'alice');
  seedQueued('next-claim', 'bob');
  db.run(`CREATE TRIGGER refuse_bad_claim BEFORE UPDATE OF status ON batches
    WHEN OLD.id='bad-claim' AND NEW.status='running'
    BEGIN SELECT RAISE(FAIL, 'permanent row-specific claim failure'); END`);
  const started: string[] = [];
  let acquisitions = 0;
  let releases = 0;
  tryDequeueNext('shared', ctx({
    acquireFor: (_pool, user, count) => { acquisitions += count; return acquireTiles(user, count, 4, 4); },
    releaseFor: (_pool, user, count) => { releases += count; releaseTiles(user, count); },
    startOrchestratorDetached: (entry, reservation) => {
      started.push(entry.batchId);
      reservation.releaseRemaining();
      return Promise.resolve();
    },
  }));
  expect(started).toEqual(['next-claim']);
  expect(db.query('SELECT status FROM batches WHERE id=?').get('bad-claim')).toEqual({ status: 'done' });
  expect(db.query('SELECT status FROM tiles WHERE batch_id=?').get('bad-claim')).toEqual({ status: 'failed' });
  expect(acquisitions).toBe(2);
  expect(releases).toBe(2);
  expect(tilesInFlight()).toBe(0);
  expect(queue.__queueTest.lengthOf('shared')).toBe(0);
});

for (const boundary of ['shutdown', 'epoch reset'] as const) {
  test(`a starter rejecting after ${boundary} still settles its DB without removing new queue entries`, async () => {
    seedQueued('late-rejection', 'alice');
    const start = Promise.withResolvers<undefined>();
    let releases = 0;
    tryDequeueNext('shared', ctx({
      acquireFor: (_pool, user, count) => acquireTiles(user, count, 4, 4),
      releaseFor: (_pool, user, count) => { releases += count; releaseTiles(user, count); },
      startOrchestratorDetached: () => start.promise,
    }));
    expect(tilesInFlight()).toBe(1);
    if (boundary === 'shutdown') beginShutdownDrain();
    else queue.resetQueueForTests();
    // Deliberately reuse the id in the new memory projection. The old context
    // must settle its durable batch without removing this new queue entry.
    queue.enqueue('shared', { batchId: 'late-rejection', userId: 'new-owner', modelId: 'mock-fast', count: 1, queuedAt: 1 });
    start.reject(new Error('detached starter rejected late'));
    await Bun.sleep(0);
    expect(db.query('SELECT status FROM batches WHERE id=?').get('late-rejection')).toEqual({ status: 'done' });
    expect(db.query('SELECT status FROM tiles WHERE batch_id=?').get('late-rejection')).toEqual({ status: 'failed' });
    expect(queue.__queueTest.peekHead('shared')?.userId).toBe('new-owner');
    expect(releases).toBe(1);
    expect(tilesInFlight()).toBe(0);
  });
}

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

test('terminal constraints back off despite healthy claims and settle automatically after repair', async () => {
  expect(acquireTiles('active', 1, 2, 2).ok).toBe(true);
  seedQueued('invalid', 'alice', 'removed-model');
  seedQueued('next', 'bob');
  seedQueued('waiting', 'carol');
  // Fail the terminal DB write, after revalidation has already released the
  // invalid entry. Real counters must still account for the active work.
  db.run(`CREATE TRIGGER fail_terminal BEFORE UPDATE OF status ON tiles
    WHEN OLD.batch_id = 'invalid' BEGIN SELECT RAISE(FAIL, 'terminal write failed'); END`);
  const started: string[] = [];
  const errors: string[] = [];
  const runtime = ctx({
    config: testConfig({ DATA_DIR: tempDir(), MAX_CONCURRENT_TILES: '2', MAX_CONCURRENT_TILES_PER_USER: '2' }),
    registry: {
      findModel: (id) => id === 'removed-model' ? null
        : { model: { id, pool: 'shared', maxCountPerBatch: 8 } },
      healthSnapshot: () => new Map(),
    },
    logger: { error: (_error, message) => { errors.push(message ?? ''); }, warn: () => undefined, info: () => undefined },
    acquireFor: (_pool, user, count) => acquireTiles(user, count, 2, 2),
    releaseFor: (_pool, user, count) => { releaseTiles(user, count); },
    startOrchestratorDetached: (entry) => { started.push(entry.batchId); return Promise.resolve(); },
  });
  const timers = spyOn(globalThis, 'setTimeout');
  try {
    tryDequeueNext('shared', runtime);
    await Bun.sleep(0);
    expect(started).toEqual(['next']);
    expect(tilesInFlight()).toBe(2);
    expect(acquireTiles('extra', 1, 2, 2)).toEqual({ ok: false, reason: 'global' });
    expect(queue.__queueTest.peekHead('shared')?.batchId).toBe('waiting');
    await Bun.sleep(DEQUEUE_RETRY_MS + 30);
    expect(timers.mock.calls.map((args) => args[1])).toEqual([DEQUEUE_RETRY_MS, DEQUEUE_RETRY_MS * 2]);
    // Completing unrelated work claims a healthy waiter without resetting the
    // pending terminal settlement's exponential delay.
    releaseTiles('active', 1);
    tryDequeueNext('shared', runtime);
    expect(started).toEqual(['next', 'waiting']);
    await Bun.sleep(DEQUEUE_RETRY_MS * 2 + 30);
    expect(timers.mock.calls.map((args) => args[1])).toEqual([DEQUEUE_RETRY_MS, DEQUEUE_RETRY_MS * 2, DEQUEUE_RETRY_MS * 4]);
    expect(errors.filter((message) => message === 'dequeue terminal settlement failed')).toHaveLength(3);
    expect(db.query('SELECT status FROM tiles WHERE batch_id=?').get('invalid')).toEqual({ status: 'loading' });
    db.run('DROP TRIGGER fail_terminal');
    await Bun.sleep(DEQUEUE_RETRY_MS * 4 + 30);
    expect(db.query('SELECT status FROM tiles WHERE batch_id=?').get('invalid')).toEqual({ status: 'failed' });
    expect(db.query('SELECT status FROM batches WHERE id=?').get('invalid')).toEqual({ status: 'done' });
    expect(started).toEqual(['next', 'waiting']);
    expect(tilesInFlight()).toBe(2);
  } finally { timers.mockRestore(); }
});

test('an idle uncoded settlement failure recovers automatically', async () => {
  seedQueued('invalid', 'alice', 'removed-model');
  const query = spyOn(db, 'query');
  let lookups = 0;
  const runtime = ctx({ registry: {
    findModel: () => {
      lookups += 1;
      if (lookups === 1) query.mockImplementationOnce(() => { throw new Error('temporary uncoded failure'); });
      return null;
    },
    healthSnapshot: () => new Map(),
  } });
  try {
    tryDequeueNext('shared', runtime);
    expect(db.query('SELECT status FROM batches WHERE id=?').get('invalid')).toEqual({ status: 'running' });
    expect(queue.__queueTest.lengthOf('shared')).toBe(0);
    await Bun.sleep(DEQUEUE_RETRY_MS + 30);
    expect(db.query('SELECT status FROM batches WHERE id=?').get('invalid')).toEqual({ status: 'done' });
    expect(db.query('SELECT status FROM tiles WHERE batch_id=?').get('invalid')).toEqual({ status: 'failed' });
  } finally { query.mockRestore(); }
});

test('an operational terminal write failure retries after the database becomes writable', async () => {
  seedQueued('invalid', 'alice', 'removed-model');
  seedQueued('healthy', 'bob');
  const started: string[] = [];
  let firstValidation = true;
  const runtime = ctx({
    registry: {
      findModel: (id) => {
        if (id === 'removed-model') {
          if (firstValidation) {
            firstValidation = false;
            db.run('PRAGMA query_only = ON');
          }
          return null;
        }
        return { model: { id, pool: 'shared', maxCountPerBatch: 8 } };
      },
      healthSnapshot: () => new Map(),
    },
    startOrchestratorDetached: (entry) => { started.push(entry.batchId); return Promise.resolve(); },
  });
  tryDequeueNext('shared', runtime);
  expect(started).toEqual([]);
  expect(db.query('SELECT status FROM tiles WHERE batch_id=?').get('invalid')).toEqual({ status: 'loading' });
  db.run('PRAGMA query_only = OFF');
  await Bun.sleep(DEQUEUE_RETRY_MS + 30);
  expect(db.query('SELECT status FROM tiles WHERE batch_id=?').get('invalid')).toEqual({ status: 'failed' });
  expect(db.query('SELECT status FROM batches WHERE id=?').get('invalid')).toEqual({ status: 'done' });
  expect(started).toEqual(['healthy']);
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

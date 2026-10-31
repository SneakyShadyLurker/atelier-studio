import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { setTextModelProviderForTests } from '../providers/text/registry';
import { testRuntime } from '../test/helpers';
import { findModel } from '../providers/registry';
import { type TestTextFeatureProvider } from '../providers/text/featureHelpers';
import { configureQueuedPromptPreparation, prepareQueuedPrompts, stopQueuedPromptPreparation } from './queuedPromptPreparation';
import * as queue from './queue';
import { getBatchForUser, resetRegistryForTests, snapshotBatchControllers, snapshotBatchDonePromises } from './registry';
import { configureLlmAdmissionPools, enhancePool, resetLlmAdmissionForTests } from './llmAdmission';
import { acquireLocalTiles, localTilesInFlight, releaseLocalTiles, resetConcurrencyForTests } from './concurrency';
import { tryDequeueNext } from './dequeue';

const original = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
const candidate = 'a shorter adult portrait';
const gates: (() => void)[] = [];
const signals: AbortSignal[] = [];
let calls = 0;

function heldProvider(): TestTextFeatureProvider {
  return {
    async *enhance(_prompt, _images, signal) {
      calls += 1;
      signals.push(signal);
      await new Promise<void>((resolve) => { gates.push(resolve); });
      // Deliberately ignores cancellation: the preparer must reject late work.
      yield { type: 'delta', text: candidate };
      yield { type: 'done' };
    },
    draftList: () => Promise.resolve({ type: 'failed', status: null, detail: 'unused' }),
    draftTemplate: () => Promise.resolve({ type: 'failed', status: null, detail: 'unused' }),
    inferDimensions: () => Promise.resolve({ type: 'ok', ops: [] }),
    inferDimensionsSingleAttempt: () => Promise.resolve({ type: 'ok', ops: [] }),
    rescueDimension: () => Promise.resolve({ type: 'failed', kind: 'permanent', status: null, detail: 'unused' }),
  };
}

function setup(overrides: Record<string, unknown> = {}) {
  const configured = testRuntime({ seedLegacyText: true, LOCAL_MODELS_USERS: 'alice', LOG_LEVEL: 'info', ...overrides });
  let kicks = 0;
  configureQueuedPromptPreparation({ ...configured, kickLocalQueue: () => { kicks += 1; } });
  return { ...configured, kicks: () => kicks };
}

function seed(runtime: ReturnType<typeof setup>, id: string, prompt = original, modelId = 'krea-2-gonzalomo', userId = 'alice'): void {
  runtime.db.run('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, 1)', [userId]);
  runtime.db.run(`INSERT INTO batches (id,user_id,prompt,model_id,model_label,ratio,created_at,status,pool)
    VALUES (?,?,?,?,'Krea','1:1',1,'queued','local')`, [id, userId, prompt, modelId]);
  runtime.db.run(`INSERT INTO tiles (id,batch_id,user_id,tile_index,seed,status)
    VALUES (?,?,?,0,1,'loading')`, [`tile-${id}`, id, userId]);
  queue.enqueue('local', { batchId: id, userId, modelId, count: 1, queuedAt: 1 });
}

async function until(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 2000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error('preparation did not progress');
    await Bun.sleep(1);
  }
}

beforeEach(() => {
  queue.resetQueueForTests();
  resetRegistryForTests();
  resetLlmAdmissionForTests();
  resetConcurrencyForTests();
  calls = 0; gates.length = 0; signals.length = 0;
  setTextModelProviderForTests(heldProvider());
});

afterEach(async () => {
  const stopped = stopQueuedPromptPreparation();
  for (const release of gates) release();
  await stopped;
  setTextModelProviderForTests(null);
  resetLlmAdmissionForTests();
  resetRegistryForTests();
  queue.resetQueueForTests();
});

test('preparation caps work at two and blocks same-user ready tails while other users progress', async () => {
  const runtime = setup({ LOCAL_MODELS_USERS: 'alice,bob' });
  for (const id of ['one', 'two', 'three']) seed(runtime, id);
  seed(runtime, 'ready', 'a short portrait');
  seed(runtime, 'other', 'a short portrait', 'krea-2-gonzalomo', 'bob');
  expect(prepareQueuedPrompts(runtime.db)).toBe(true);
  await until(() => calls === 2);
  expect(localTilesInFlight()).toBe(0);
  expect(queue.entries('local').filter((entry) => entry.promptPreparation === 'pending')).toHaveLength(3);
  expect(queue.peekNext('local')?.batchId).toBe('other');
  expect(queue.positionOf('local', 'other')).toBe(0);
  expect(queue.positionOf('local', 'one')).toBe(1);
  expect(queue.positionOf('local', 'ready')).toBe(4);
  expect(snapshotBatchControllers()).toHaveLength(2);
  expect(snapshotBatchDonePromises()).toHaveLength(2);
  gates[0]?.();
  await until(() => calls === 3);
  expect(runtime.db.query('SELECT prompt FROM batches WHERE id = ?').get('one')).toEqual({ prompt: candidate });
  expect(queue.entries('local').find((entry) => entry.batchId === 'one')?.promptPreparation).toBe('ready');
  expect(queue.peekNext('local')?.batchId).toBe('one');
  expect(getBatchForUser('one', 'alice')).toBeUndefined();
  expect(localTilesInFlight()).toBe(0);
});

for (const owner of ['active', 'old-epoch', 'old-runtime'] as const) {
  test(`a preparation read failure dispatches video on the last release while preserving its ${owner} preparer owner`, async () => {
    const runtime = setup({ VIDEO_MODELS_ENABLED: 'true', LOCAL_MODELS_USERS: 'alice,bob' });
    seed(runtime, 'held');
    prepareQueuedPrompts(runtime.db);
    await until(() => calls === 1);
    const registered = getBatchForUser('held', 'alice');
    if (owner !== 'active') queue.rebuildFromDb(runtime.db);
    if (owner === 'old-runtime') configureQueuedPromptPreparation({ ...runtime, kickLocalQueue: () => undefined });
    seed(runtime, 'video', 'a short video scene', 'minimax-h3-t2v', 'bob');
    expect(acquireLocalTiles(1, 1).ok).toBe(true);
    const query = spyOn(runtime.db, 'query').mockImplementationOnce(() => { throw new Error('injected preparation read failure'); });
    const started: string[] = [];
    const releases: (() => void)[] = [];
    try {
      // This is the last running tile's only capacity wakeup. Admission must
      // progress synchronously despite the isolated preparatory read error.
      releaseLocalTiles('alice', 1);
      tryDequeueNext('local', {
        db: runtime.db, config: runtime.config, logger: runtime.logger,
        registry: { findModel, healthSnapshot: () => new Map() },
        acquireFor: (_pool, _user, count) => acquireLocalTiles(count, 1),
        releaseFor: (_pool, user, count) => { releaseLocalTiles(user, count); },
        startOrchestratorDetached: (entry, reservation) => {
          started.push(entry.batchId);
          releases.push(reservation.releaseRemaining);
          return Promise.resolve();
        },
        queueEpoch: queue.currentEpoch(), prepareQueued: () => prepareQueuedPrompts(runtime.db),
      });
      expect(runtime.logs.some((line) => line.includes('queued prompt preparation failed'))).toBe(true);
      expect(started).toEqual(['video']);
      expect(localTilesInFlight()).toBe(1);
      expect(acquireLocalTiles(1, 1)).toEqual({ ok: false, reason: 'global' });
      expect(queue.entries('local')).toMatchObject([{ batchId: 'held', promptPreparation: 'pending' }]);
      expect(getBatchForUser('held', 'alice')).toBe(registered);
      expect(calls).toBe(1);
      expect(runtime.db.query("SELECT status FROM batches WHERE id='video'").get()).toEqual({ status: 'running' });
    } finally {
      query.mockRestore();
      for (const release of releases) release();
    }
  });
}

test('a saturated existing enhance pool fails open once without a separate text admission pool', async () => {
  const runtime = setup({ MAX_CONCURRENT_LLM_ENHANCE_PER_USER: '1' });
  configureLlmAdmissionPools(runtime.config);
  const slot = enhancePool.acquire('alice');
  if (!slot.ok) throw new Error('expected enhance slot');
  try {
    seed(runtime, 'held');
    prepareQueuedPrompts(runtime.db);
    await until(() => queue.entries('local')[0]?.promptPreparation === 'ready');
    expect(calls).toBe(0);
    expect(runtime.db.query("SELECT prompt FROM batches WHERE id='held'").get()).toEqual({ prompt: original });
    slot.release();
    prepareQueuedPrompts(runtime.db);
    await Bun.sleep(0);
    expect(calls).toBe(0);
  } finally { slot.release(); }
});

test('a recovered removed Krea model fails normal dequeue without spending preparation capacity', async () => {
  const runtime = setup();
  seed(runtime, 'removed', original, 'krea-2-moody-mix');
  seed(runtime, 'valid-one');
  seed(runtime, 'valid-two');
  prepareQueuedPrompts(runtime.db);
  await until(() => calls === 2);
  expect(getBatchForUser('removed', 'alice')).toBeUndefined();
  expect(queue.peekNext('local')?.batchId).toBe('removed');
  expect(queue.positionOf('local', 'removed')).toBe(0);
  let starts = 0;
  tryDequeueNext('local', {
    db: runtime.db, config: runtime.config, logger: runtime.logger,
    registry: { findModel, healthSnapshot: () => new Map() },
    acquireFor: (_pool, _user, count) => acquireLocalTiles(count, 1),
    releaseFor: (_pool, user, count) => { releaseLocalTiles(user, count); },
    startOrchestratorDetached: () => { starts += 1; return Promise.resolve(); },
    queueEpoch: queue.currentEpoch(), prepareQueued: () => prepareQueuedPrompts(runtime.db),
  });
  expect(starts).toBe(0);
  expect(runtime.db.query("SELECT status FROM tiles WHERE batch_id='removed'").get()).toEqual({ status: 'failed' });
  expect(localTilesInFlight()).toBe(0);
  expect(calls).toBe(2);
  expect(queue.entries('local').map((entry) => entry.batchId)).toEqual(['valid-one', 'valid-two']);
});

for (const ending of ['last-tile', 'canceled', 'archived', 'deleted', 'epoch-reset', 'shutdown'] as const) {
  test(`${ending} discards a late preparer result and drains its registry entry`, async () => {
    const runtime = setup();
    seed(runtime, 'held');
    prepareQueuedPrompts(runtime.db);
    await until(() => calls === 1);
    const done = snapshotBatchDonePromises();
    let stopped: Promise<unknown[]> | undefined;
    if (ending === 'last-tile') {
      runtime.db.run("DELETE FROM tiles WHERE batch_id='held'");
      queue.updateCount('local', 'held', 0);
    } else if (ending === 'canceled') {
      runtime.db.run("UPDATE batches SET status='done' WHERE id='held'");
      getBatchForUser('held', 'alice')?.batchController.abort();
      queue.removeById('local', 'held');
    } else if (ending === 'archived') {
      runtime.db.run("UPDATE batches SET archived_at=1 WHERE id='held'");
    } else if (ending === 'deleted') {
      runtime.db.run("DELETE FROM batches WHERE id='held'");
    } else if (ending === 'epoch-reset') {
      queue.resetQueueForTests();
    } else {
      stopped = stopQueuedPromptPreparation();
      runtime.db.close();
      queue.removeById('local', 'held'); // Detached subscription cannot touch DB.
    }
    await Bun.sleep(0);
    if (ending === 'last-tile' || ending === 'canceled' || ending === 'epoch-reset' || ending === 'shutdown') {
      expect(signals[0]?.aborted).toBe(true);
    }
    gates[0]?.();
    await Promise.all(done);
    await stopped;
    await Bun.sleep(0);
    expect(getBatchForUser('held', 'alice')).toBeUndefined();
    if (ending !== 'shutdown') {
      const row = runtime.db.query<{ prompt: string }, []>("SELECT prompt FROM batches WHERE id='held'").get();
      if (ending === 'deleted') expect(row).toBeNull();
      else expect(row?.prompt).toBe(original);
    }
    expect(localTilesInFlight()).toBe(0);
    expect(queue.entries('local').some((entry) => entry.batchId === 'held')).toBe(false);
  });
}

test('a prompt changed while preparing wins the completion CAS and is not overwritten', async () => {
  const runtime = setup();
  seed(runtime, 'held');
  prepareQueuedPrompts(runtime.db);
  await until(() => calls === 1);
  runtime.db.run("UPDATE batches SET prompt='new operator prompt' WHERE id='held'");
  gates[0]?.();
  await until(() => queue.entries('local')[0]?.promptPreparation === 'ready');
  expect(runtime.db.query("SELECT prompt FROM batches WHERE id='held'").get()).toEqual({ prompt: 'new operator prompt' });
  expect(calls).toBe(1);
});

test('epoch rebuild aborts old preparation and prepares recovered queued work once under the new epoch', async () => {
  const runtime = setup();
  seed(runtime, 'held');
  prepareQueuedPrompts(runtime.db);
  await until(() => calls === 1);
  queue.rebuildFromDb(runtime.db);
  prepareQueuedPrompts(runtime.db);
  expect(signals[0]?.aborted).toBe(true);
  expect(queue.peekNext('local')).toBeUndefined();
  gates[0]?.();
  await until(() => calls === 2);
  expect(runtime.db.query("SELECT prompt FROM batches WHERE id='held'").get()).toEqual({ prompt: original });
  gates[1]?.();
  await until(() => queue.peekNext('local')?.batchId === 'held');
  expect(runtime.db.query("SELECT prompt FROM batches WHERE id='held'").get()).toEqual({ prompt: candidate });
});

test('a recovered now-short prompt waits for the old preparer controller to retire before admission', async () => {
  const runtime = setup();
  seed(runtime, 'held');
  prepareQueuedPrompts(runtime.db);
  await until(() => calls === 1);
  const old = getBatchForUser('held', 'alice');
  runtime.db.run("UPDATE batches SET prompt='new short prompt' WHERE id='held'");
  queue.rebuildFromDb(runtime.db);
  prepareQueuedPrompts(runtime.db);
  expect(queue.peekNext('local')).toBeUndefined();
  expect(old?.batchController.signal.aborted).toBe(true);
  gates[0]?.();
  await until(() => queue.peekNext('local')?.batchId === 'held');
  expect(getBatchForUser('held', 'alice')).toBeUndefined();
  expect(runtime.db.query("SELECT prompt FROM batches WHERE id='held'").get()).toEqual({ prompt: 'new short prompt' });
  expect(calls).toBe(1);
});

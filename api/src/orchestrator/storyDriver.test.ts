import { afterEach, describe, expect, test } from 'bun:test';
import { setTextModelProviderForTests } from '../providers/text/registry';
import type { Database } from 'bun:sqlite';
import { abortReason } from '../lifecycle/abort';
import sharp from 'sharp';
import type { EnhanceChunk, TestCliproxyTextProvider } from '../providers/cliproxyText';
import { generateHybridIdentity, identityToRecipient } from 'age-encryption';
import { DbUserKeyStore, StorageKeyring, configureStorageKeyring } from '../storage/crypto';
import { deleteArtifact, readArtifactBytes, writeAtomic } from '../storage/files';
import { storeUpload } from '../storage/uploadStore';
import { countInflightVideoForUser } from '../db/queueOps';
import type { BatchRow, TileRow } from '../db/types';
import { runBatchPipeline } from '../orchestrator';
import { startOrchestratorDetached } from './startDetached';
import { createReservationReleaser } from './concurrency';
import { findModel } from '../providers/registry';
import { buildQueuedRequestForBatch } from './dispatch';
import { pickLegacyTextModel, testRuntime } from '../test/helpers';
import * as queue from './queue';
import { draftPool, enhancePool, resetLlmAdmissionForTests } from './llmAdmission';
import {
  configureStoryDriver,
  kickStory,
  notifyStoryBatchTerminal,
  recoverStories,
  resetStoryDriverForTests,
  stopStoryDriver,
  waitForStoryDriverIdle,
} from './storyDriver';

const VIDEO_ON = {
  seedLegacyText: true,
  VIDEO_MODELS_ENABLED: 'true',
  LOCAL_MODELS_USERS: 'alice',
};
const PNG = new Uint8Array(await sharp({
  create: {
    width: 32,
    height: 32,
    channels: 3,
    background: { r: 20, g: 40, b: 60 },
  },
}).png().toBuffer());
const MP4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]);

function providerWith(
  enhance: TestCliproxyTextProvider['enhance'],
): TestCliproxyTextProvider {
  return {
    enhance,
    draftList: () => Promise.resolve({ type: 'failed', status: null, detail: 'unused' }),
    draftTemplate: () => Promise.resolve({ type: 'failed', status: null, detail: 'unused' }),
    inferDimensions: () => Promise.resolve({ type: 'ok', ops: [] }),
    inferDimensionsSingleAttempt: () => Promise.resolve({ type: 'ok', ops: [] }),
    rescueDimension: () => Promise.resolve({ type: 'failed', kind: 'permanent', status: null, detail: 'unused' }),
  };
}

function successfulProvider(text = 'enhanced motion'): TestCliproxyTextProvider {
  return providerWith(async function* () {
    await Promise.resolve();
    yield { type: 'delta', text: text.slice(0, 8) } satisfies EnhanceChunk;
    yield { type: 'delta', text: text.slice(8) } satisfies EnhanceChunk;
    yield { type: 'done' } satisfies EnhanceChunk;
  });
}

function seedStory(
  db: Database,
  beats: readonly string[],
  status: 'rendering' | 'canceled' = 'rendering',
): string {
  const storyId = crypto.randomUUID();
  db.query("INSERT OR IGNORE INTO users (id, created_at) VALUES ('alice', 1)").run();
  db.query(
    `INSERT INTO stories
      (id, user_id, status, outline, logline, continuity_bible, ratio,
       source_upload_id, extends_tile_id, source_prompt, error, eta_ms, created_at, updated_at)
     VALUES (?, 'alice', ?, 'outline', 'logline', 'bible', '16:9',
             NULL, NULL, NULL, NULL, 1000, 1, 1)`,
  ).run(storyId, status);
  const insert = db.query(
    `INSERT INTO story_segments
      (story_id, user_id, idx, beat, duration_frames, batch_id, attempts)
     VALUES (?, 'alice', ?, ?, 124, NULL, 0)`,
  );
  for (const [idx, beat] of beats.entries()) insert.run(storyId, idx, beat);
  return storyId;
}

function configure(
  runtime: ReturnType<typeof testRuntime>,
): void {
  configureStoryDriver({
    db: runtime.db,
    config: runtime.config,
    logger: runtime.logger,
    text: runtime.text,
    kickLocalQueue: () => undefined,
    extractLastFrame: () => Promise.resolve(PNG),
  });
}

function currentSegment(
  db: Database,
  storyId: string,
  idx: number,
): { batch_id: string | null; attempts: number } {
  const row = db.query<{ batch_id: string | null; attempts: number }, [string, number]>(
    'SELECT batch_id, attempts FROM story_segments WHERE story_id = ? AND idx = ?',
  ).get(storyId, idx);
  if (!row) throw new Error('story segment missing');
  return row;
}

async function markBatchDone(
  runtime: ReturnType<typeof testRuntime>,
  batchId: string,
): Promise<string> {
  const tile = runtime.db.query<{ id: string }, [string]>(
    'SELECT id FROM tiles WHERE batch_id = ?',
  ).get(batchId);
  if (!tile) throw new Error('tile missing');
  runtime.db.query("UPDATE batches SET status = 'done' WHERE id = ?").run(batchId);
  runtime.db.query(
    "UPDATE tiles SET status = 'done', ext = 'mp4', mime = 'video/mp4', completed_at = ? WHERE id = ?",
  ).run(Date.now(), tile.id);
  await writeAtomic(runtime.config.DATA_DIR, 'images', 'alice', tile.id, 'mp4', MP4);
  return tile.id;
}

function markBatchFailed(db: Database, batchId: string): void {
  db.query("UPDATE batches SET status = 'done' WHERE id = ?").run(batchId);
  db.query(
    "UPDATE tiles SET status = 'failed', error = 'internal error', completed_at = ? WHERE batch_id = ?",
  ).run(Date.now(), batchId);
}

function queuedPressure(db: Database, id = 'pressure', pool = 'shared'): void {
  db.query(`INSERT INTO batches (id,user_id,prompt,ratio,model_id,model_label,created_at,status,pool)
    VALUES (?,'alice','pressure','1:1','mock-fast','Mock',1,'queued',?)`).run(id, pool);
}

async function until(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error('story did not advance');
    await Bun.sleep(10);
  }
}

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reject(new Error('story lifecycle timed out')); }, 2_000);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

afterEach(async () => {
  await waitForStoryDriverIdle();
  resetStoryDriverForTests();
  setTextModelProviderForTests(null);
  queue.resetQueueForTests();
  resetLlmAdmissionForTests();
});

describe('story driver', () => {
  for (const pressure of ['per-user', 'total'] as const) {
    test(`${pressure} LLM saturation submits the raw beat without another provider call`, async () => {
      let calls = 0;
      setTextModelProviderForTests(providerWith(async function* () {
        await Promise.resolve(); calls += 1;
        yield { type: 'done' };
      }));
      const runtime = testRuntime({ ...VIDEO_ON,
        MAX_CONCURRENT_LLM_ENHANCE_PER_USER: '1', MAX_CONCURRENT_LLM_TOTAL: '1' });
      configure(runtime);
      const held = pressure === 'per-user' ? enhancePool.acquire('alice') : draftPool.acquire('bob');
      if (!held.ok) throw new Error('expected admission');
      try {
        const id = seedStory(runtime.db, ['raw beat']);
        kickStory(id);
        await waitForStoryDriverIdle();
        const segment = currentSegment(runtime.db, id, 0);
        expect(segment.attempts).toBe(1);
        expect(runtime.db.query('SELECT prompt FROM batches WHERE id = ?').get(segment.batch_id)).toEqual({ prompt: 'raw beat' });
        expect(calls).toBe(0);
      } finally {
        held.release();
      }
      const available = enhancePool.acquire('alice');
      expect(available.ok).toBe(true);
      if (available.ok) available.release();
    });
  }

  for (const outcome of ['success', 'failure'] as const) {
    test(`enhancement ${outcome} releases its LLM slot`, async () => {
      const runtime = testRuntime({ ...VIDEO_ON,
        MAX_CONCURRENT_LLM_ENHANCE_PER_USER: '1', MAX_CONCURRENT_LLM_TOTAL: '1' });
      configure(runtime);
      setTextModelProviderForTests(providerWith(async function* () {
        await Promise.resolve();
        expect(enhancePool.acquire('alice')).toEqual({ ok: false, reason: 'per-user' });
        expect(draftPool.acquire('bob')).toEqual({ ok: false, reason: 'global' });
        if (outcome === 'failure') throw new Error('provider failed');
        yield { type: 'delta', text: 'enhanced' };
        yield { type: 'done' };
      }));
      const id = seedStory(runtime.db, ['raw beat']);
      kickStory(id);
      await waitForStoryDriverIdle();
      const segment = currentSegment(runtime.db, id, 0);
      expect(segment.attempts).toBe(1);
      expect(runtime.db.query('SELECT prompt FROM batches WHERE id = ?').get(segment.batch_id)).toEqual({
        prompt: outcome === 'success' ? 'enhanced' : 'raw beat',
      });
      const available = enhancePool.acquire('alice');
      expect(available.ok).toBe(true);
      if (available.ok) available.release();
    });
  }

  for (const ending of ['cancel', 'already-canceled', 'shutdown'] as const) {
    test(`${ending} aborts stalled preparation, releases admission, and spends no attempt`, async () => {
      const runtime = testRuntime({ ...VIDEO_ON, LOCAL_MODELS_USERS: 'alice,bob',
        MAX_CONCURRENT_LLM_ENHANCE_PER_USER: '1', MAX_CONCURRENT_LLM_TOTAL: '1' });
      configure(runtime);
      let upstream: AbortSignal | undefined;
      let abortedStatus: unknown;
      let markStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      const id = seedStory(runtime.db, ['stalled']);
      const next = seedStory(runtime.db, ['next']);
      setTextModelProviderForTests(providerWith(async function* (prompt, _images, signal) {
        if (prompt === 'stalled') {
          upstream = signal;
          markStarted?.();
          await new Promise<void>((_resolve, reject) => {
            const abort = (): void => {
              abortedStatus = runtime.db.query('SELECT status FROM stories WHERE id = ?').get(id);
              reject(abortReason(signal));
            };
            if (signal.aborted) abort();
            else signal.addEventListener('abort', abort, { once: true });
          });
        }
        yield { type: 'delta', text: 'enhanced next' };
        yield { type: 'done' };
      }));
      kickStory(id);
      try {
        await within(started);
        // The real route must not abort another user's active preparation.
        const foreign = await runtime.fetch(`/api/stories/${id}/cancel`, {
          method: 'POST', headers: { 'Remote-User': 'bob' },
        });
        expect(foreign.status).toBe(404);
        expect(upstream?.aborted).toBe(false);
        kickStory(next);
        if (ending === 'shutdown') {
          await within(stopStoryDriver());
        } else {
          if (ending === 'already-canceled') runtime.db.query("UPDATE stories SET status = 'canceled' WHERE id = ?").run(id);
          const response = await runtime.fetch(`/api/stories/${id}/cancel`, {
            method: 'POST', headers: { 'Remote-User': 'alice' },
          });
          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({ inflightBatchId: null });
          await until(() => currentSegment(runtime.db, next, 0).batch_id !== null);
        }
        await within(waitForStoryDriverIdle());
        expect(upstream?.aborted).toBe(true);
        expect(abortedStatus).toEqual({ status: ending === 'shutdown' ? 'rendering' : 'canceled' });
        expect(currentSegment(runtime.db, id, 0)).toEqual({ batch_id: null, attempts: 0 });
        if (ending === 'shutdown') expect(currentSegment(runtime.db, next, 0).attempts).toBe(0);
        const available = enhancePool.acquire('alice');
        expect(available.ok).toBe(true);
        if (available.ok) available.release();
      } finally {
        // A failed assertion must not leave an abort-aware provider stalled.
        await within(stopStoryDriver());
      }
    });
  }

  test('route cancellation during continuation enhancement releases its handoff without a retry', async () => {
    const runtime = testRuntime(VIDEO_ON);
    configure(runtime);
    setTextModelProviderForTests(successfulProvider());
    const id = seedStory(runtime.db, ['first', 'continuation']);
    kickStory(id);
    await within(waitForStoryDriverIdle());
    const first = currentSegment(runtime.db, id, 0).batch_id;
    if (!first) throw new Error('first batch missing');
    await markBatchDone(runtime, first);
    let handoff: string | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let upstream: AbortSignal | undefined;
    setTextModelProviderForTests(providerWith(async function* (_prompt, _images, signal) {
      upstream = signal;
      handoff = runtime.db.query<{ id: string }, []>('SELECT id FROM uploads').get()?.id;
      markStarted?.();
      await new Promise<void>((_resolve, reject) => {
        const abort = (): void => { reject(abortReason(signal)); };
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
      yield { type: 'done' };
    }));
    notifyStoryBatchTerminal(first, true);
    try {
      await within(started);
      expect(handoff).toBeDefined();
      for (let retry = 0; retry < 2; retry += 1) {
        const response = await runtime.fetch(`/api/stories/${id}/cancel`, {
          method: 'POST', headers: { 'Remote-User': 'alice' },
        });
        expect(response.status).toBe(200);
      }
      await within(waitForStoryDriverIdle());
      expect(upstream?.aborted).toBe(true);
      expect(currentSegment(runtime.db, id, 1)).toEqual({ batch_id: null, attempts: 0 });
      if (!handoff) throw new Error('handoff missing');
      expect(runtime.db.query('SELECT id FROM uploads WHERE id = ?').get(handoff)).toBeNull();
      expect(await readArtifactBytes(runtime.config.DATA_DIR, 'uploads', 'alice', handoff, 'png', 'image/png')).toBeNull();
      expect(runtime.db.query('SELECT status FROM batches WHERE id = ?').get(first)).toEqual({ status: 'done' });
    } finally {
      await within(stopStoryDriver());
    }
  });

  test('its own rendering reservation at video cap one still submits the first segment', async () => {
    setTextModelProviderForTests(successfulProvider());
    const runtime = testRuntime({ ...VIDEO_ON, MAX_INFLIGHT_VIDEO_PER_USER: '1' });
    configure(runtime);
    const id = seedStory(runtime.db, ['beat']);
    expect(countInflightVideoForUser(runtime.db, 'alice', [])).toBe(1);
    kickStory(id);
    await waitForStoryDriverIdle();
    expect(currentSegment(runtime.db, id, 0).attempts).toBe(1);
    expect(countInflightVideoForUser(runtime.db, 'alice', ['minimax-h3-t2v'])).toBe(1);
  });

  test('queue pressure in another pool defers before enhancement and wakes once capacity clears', async () => {
    let enhancements = 0;
    setTextModelProviderForTests(providerWith(async function* () {
      await Promise.resolve();
      enhancements += 1;
      yield { type: 'delta', text: 'enhanced' };
      yield { type: 'done' };
    }));
    const runtime = testRuntime({ ...VIDEO_ON, MAX_QUEUED_BATCHES_PER_USER: '1' });
    configure(runtime);
    const id = seedStory(runtime.db, ['beat']);
    queuedPressure(runtime.db);
    kickStory(id); kickStory(id);
    await waitForStoryDriverIdle();
    expect(enhancements).toBe(0);
    expect(currentSegment(runtime.db, id, 0)).toEqual({ batch_id: null, attempts: 0 });
    expect(countInflightVideoForUser(runtime.db, 'alice', [])).toBe(1);
    runtime.db.query("UPDATE batches SET status='done' WHERE id='pressure'").run();
    await until(() => currentSegment(runtime.db, id, 0).batch_id !== null);
    await waitForStoryDriverIdle();
    expect(enhancements).toBe(1);
    expect(currentSegment(runtime.db, id, 0).attempts).toBe(1);
  });

  for (const pool of ['shared', 'byok', 'local'] as const) {
    test(`${pool} queue capacity changes wake deferred stories before the one-second fallback`, async () => {
      setTextModelProviderForTests(successfulProvider());
      const runtime = testRuntime({ ...VIDEO_ON, MAX_QUEUED_BATCHES_PER_USER: '1' });
      configure(runtime);
      const id = seedStory(runtime.db, ['beat']);
      queuedPressure(runtime.db, 'pressure', pool);
      runtime.db.run(`INSERT INTO tiles (id,batch_id,user_id,tile_index,seed,status)
        VALUES ('pressure-tile','pressure','alice',0,1,'loading')`);
      queue.enqueue(pool, { batchId: 'pressure', userId: 'alice', modelId: 'mock-fast', count: 1, queuedAt: 1 });
      kickStory(id);
      await waitForStoryDriverIdle();
      expect(currentSegment(runtime.db, id, 0).batch_id).toBeNull();
      runtime.db.run("UPDATE batches SET status='done' WHERE id='pressure'");
      const started = performance.now();
      queue.updateCount(pool, 'pressure', 0);
      await until(() => currentSegment(runtime.db, id, 0).batch_id !== null);
      expect(performance.now() - started).toBeLessThan(500);
      await waitForStoryDriverIdle();
    });
  }

  for (const ending of ['deferred', 'canceled', 'superseded', 'shutdown'] as const) {
    test(`late ${ending} releases only the generated handoff without spending an attempt`, async () => {
      setTextModelProviderForTests(successfulProvider());
      const runtime = testRuntime({ ...VIDEO_ON, MAX_QUEUED_BATCHES_PER_USER: '1' });
      configure(runtime);
      const id = seedStory(runtime.db, ['first', 'second']);
      kickStory(id);
      await waitForStoryDriverIdle();
      const first = currentSegment(runtime.db, id, 0).batch_id;
      if (first === null) throw new Error('first batch missing');
      await markBatchDone(runtime, first);
      const source = await storeUpload({ db: runtime.db, dataDir: runtime.config.DATA_DIR,
        logger: runtime.logger, userId: 'alice', bytes: PNG, signal: new AbortController().signal });
      runtime.db.query('UPDATE stories SET source_upload_id=? WHERE id=?').run(source.id, id);
      let handoff = '';
      setTextModelProviderForTests(providerWith(async function* () {
        await Promise.resolve();
        handoff = runtime.db.query<{ id: string }, [string]>(
          'SELECT id FROM uploads WHERE id != ?',
        ).get(source.id)?.id ?? '';
        if (ending === 'deferred') queuedPressure(runtime.db, 'late-pressure', 'byok');
        if (ending === 'canceled') runtime.db.query("UPDATE stories SET status='canceled' WHERE id=?").run(id);
        if (ending === 'superseded') runtime.db.query('UPDATE story_segments SET batch_id=? WHERE story_id=? AND idx=1').run(first, id);
        if (ending === 'shutdown') void stopStoryDriver();
        yield { type: 'delta', text: 'enhanced' };
        yield { type: 'done' };
      }));
      notifyStoryBatchTerminal(first, true);
      await waitForStoryDriverIdle();
      expect(handoff).not.toBe('');
      expect(runtime.db.query('SELECT id FROM uploads WHERE id=?').get(handoff)).toBeNull();
      expect(await readArtifactBytes(runtime.config.DATA_DIR, 'uploads', 'alice', handoff, 'png', 'image/png')).toBeNull();
      expect(runtime.db.query('SELECT id FROM uploads WHERE id=?').get(source.id)).not.toBeNull();
      expect(currentSegment(runtime.db, id, 1).attempts).toBe(0);
      if (ending !== 'superseded') expect(currentSegment(runtime.db, id, 1).batch_id).toBeNull();
      expect(runtime.db.query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM batches WHERE model_id LIKE ?').get('minimax%')?.n).toBe(1);
      if (ending === 'deferred') expect(runtime.db.query('SELECT status FROM stories WHERE id=?').get(id)).toEqual({ status: 'rendering' });
    });
  }

  for (const ending of ['cancel', 'reset', 'shutdown'] as const) {
    test(`${ending} prevents a deferred timer from submitting or accessing a closed DB`, async () => {
      let enhancements = 0;
      setTextModelProviderForTests(providerWith(async function* () {
        await Promise.resolve();
        enhancements += 1; yield { type: 'done' };
      }));
      const runtime = testRuntime({ ...VIDEO_ON, MAX_QUEUED_BATCHES_PER_USER: '1' });
      configure(runtime);
      const id = seedStory(runtime.db, ['beat']);
      queuedPressure(runtime.db);
      kickStory(id);
      await waitForStoryDriverIdle();
      runtime.db.query("UPDATE batches SET status='done' WHERE id='pressure'").run();
      if (ending === 'cancel') {
        runtime.db.query("UPDATE stories SET status='canceled' WHERE id=?").run(id);
      } else {
        if (ending === 'reset') resetStoryDriverForTests();
        else await stopStoryDriver();
        runtime.db.close();
        queue.enqueue('shared', { batchId: 'after-close', userId: 'alice', modelId: 'mock-fast', count: 1, queuedAt: 1 });
        queue.removeById('shared', 'after-close');
      }
      await Bun.sleep(150);
      await waitForStoryDriverIdle();
      expect(enhancements).toBe(0);
      if (ending === 'cancel') {
        expect(currentSegment(runtime.db, id, 0)).toEqual({ batch_id: null, attempts: 0 });
        expect(countInflightVideoForUser(runtime.db, 'alice', [])).toBe(0);
      }
    });
  }

  test('restart recovers a deferred zero-batch reservation after queue pressure drains', async () => {
    setTextModelProviderForTests(successfulProvider());
    const runtime = testRuntime({ ...VIDEO_ON, MAX_QUEUED_BATCHES_PER_USER: '1' });
    configure(runtime);
    const id = seedStory(runtime.db, ['beat']);
    queuedPressure(runtime.db);
    kickStory(id);
    await waitForStoryDriverIdle();
    resetStoryDriverForTests();
    expect(countInflightVideoForUser(runtime.db, 'alice', [])).toBe(1);
    configure(runtime); recoverStories();
    await waitForStoryDriverIdle();
    expect(currentSegment(runtime.db, id, 0).attempts).toBe(0);
    runtime.db.query("UPDATE batches SET status='done' WHERE id='pressure'").run();
    await until(() => currentSegment(runtime.db, id, 0).batch_id !== null);
    await waitForStoryDriverIdle();
    expect(countInflightVideoForUser(runtime.db, 'alice', ['minimax-h3-t2v'])).toBe(1);
  });

  test('accepted extension setup failure retains the failed batch and retries the story instead of canceling', async () => {
    setTextModelProviderForTests(successfulProvider());
    const runtime = testRuntime(VIDEO_ON);
    configure(runtime);
    const id = seedStory(runtime.db, ['first', 'second']);
    kickStory(id); await waitForStoryDriverIdle();
    const first = currentSegment(runtime.db, id, 0).batch_id;
    if (first === null) throw new Error('first batch missing');
    await markBatchDone(runtime, first);
    notifyStoryBatchTerminal(first, true); await waitForStoryDriverIdle();
    const second = currentSegment(runtime.db, id, 1).batch_id;
    if (second === null) throw new Error('second batch missing');
    const batch = runtime.db.query<BatchRow, [string]>('SELECT * FROM batches WHERE id=?').get(second);
    if (!batch) throw new Error('accepted batch missing');
    const tiles = runtime.db.query<TileRow, [string]>('SELECT * FROM tiles WHERE batch_id=?').all(second);
    if (batch.i2v_source_upload_id === null) throw new Error('handoff upload missing');
    deleteArtifact(runtime.config.DATA_DIR, 'uploads', 'alice', batch.i2v_source_upload_id, 'png');
    const entry = findModel(batch.model_id, runtime.config);
    if (!entry) throw new Error('model missing');
    let released = 0;
    const reservation = createReservationReleaser(1, (count) => { released += count; }, () => undefined);
    await startOrchestratorDetached({ batch, tiles }, {
      db: runtime.db, config: runtime.config, logger: runtime.logger, text: runtime.text, userId: 'alice',
      request: buildQueuedRequestForBatch(runtime.db, { batch, tiles }, entry.model), registryEntry: entry,
      boundProvider: { id: 'unused', backend: 'local', generate: () => { throw new Error('provider must not run'); } },
      disconnectSignal: new AbortController().signal,
      onSyncFailure: reservation.releaseRemaining, onTileSettled: reservation.releaseOne,
      runBatchPipeline,
    });
    await waitForStoryDriverIdle();
    expect(released).toBe(1);
    expect(runtime.db.query('SELECT status FROM stories WHERE id=?').get(id)).toEqual({ status: 'rendering' });
    expect(runtime.db.query('SELECT status,error FROM tiles WHERE batch_id=?').get(second))
      .toEqual({ status: 'failed', error: 'upstream rejected' });
    expect(currentSegment(runtime.db, id, 1).attempts).toBe(2);
    expect(currentSegment(runtime.db, id, 1).batch_id).not.toBe(second);
  });

  test('submits the first t2v segment through the queued local path', async () => {
    setTextModelProviderForTests(successfulProvider('enhanced t2v prompt'));
    const runtime = testRuntime(VIDEO_ON);
    configure(runtime);
    const storyId = seedStory(runtime.db, ['opening beat']);

    kickStory(storyId);
    await waitForStoryDriverIdle();

    const segment = currentSegment(runtime.db, storyId, 0);
    expect(segment.attempts).toBe(1);
    const batch = runtime.db.query<{
      status: string;
      model_id: string;
      prompt: string;
    }, [string]>('SELECT status, model_id, prompt FROM batches WHERE id = ?')
      .get(segment.batch_id ?? '');
    expect(batch).toEqual({
      status: 'queued',
      model_id: 'minimax-h3-t2v',
      prompt: 'enhanced t2v prompt',
    });
  });

  test('segment beats resolve through the story-segments task, and no model leaves the raw beat', async () => {
    const efforts: unknown[] = [];
    setTextModelProviderForTests(providerWith(async function* (_prompt, _images, _signal, _system, opts) {
      await Promise.resolve();
      efforts.push(opts?.reasoningEffort);
      yield { type: 'delta', text: 'enhanced t2v prompt' } satisfies EnhanceChunk;
      yield { type: 'done' } satisfies EnhanceChunk;
    }));
    const runtime = testRuntime(VIDEO_ON);
    configure(runtime);
    // A pick for another task does not apply; the story-segments pick (and its effort) does.
    pickLegacyTextModel(runtime.db, 'alice', 'motion', 'grok', 'xhigh');
    pickLegacyTextModel(runtime.db, 'alice', 'story-segments', 'mimo', 'high');
    const storyId = seedStory(runtime.db, ['opening beat']);
    kickStory(storyId);
    await waitForStoryDriverIdle();
    expect(efforts).toEqual(['high']);

    const bare = testRuntime({ ...VIDEO_ON, seedLegacyText: false });
    configure(bare);
    const bareStory = seedStory(bare.db, ['opening beat']);
    kickStory(bareStory);
    await waitForStoryDriverIdle();
    expect(efforts).toHaveLength(1);
    const segment = currentSegment(bare.db, bareStory, 0);
    expect(bare.db.query<{ prompt: string }, [string]>('SELECT prompt FROM batches WHERE id = ?')
      .get(segment.batch_id ?? '')?.prompt).toBe('opening beat');
  });

  test('waits for sealed storage without spending a segment attempt, then proceeds on unseal', async () => {
    setTextModelProviderForTests(successfulProvider('enhanced t2v prompt'));
    const runtime = testRuntime(VIDEO_ON);
    configure(runtime);
    const rootIdentity = await generateHybridIdentity();
    const keyring = new StorageKeyring({
      rootRecipient: await identityToRecipient(rootIdentity),
      store: new DbUserKeyStore(runtime.db),
    });
    configureStorageKeyring(keyring);
    try {
      const storyId = seedStory(runtime.db, ['opening beat']);
      kickStory(storyId);
      await Bun.sleep(50);
      expect(currentSegment(runtime.db, storyId, 0)).toEqual({ batch_id: null, attempts: 0 });

      await keyring.unseal(rootIdentity);
      await waitForStoryDriverIdle();
      expect(currentSegment(runtime.db, storyId, 0).attempts).toBe(1);
    } finally {
      configureStorageKeyring(null);
    }
  });

  test('advances a done first segment as a provenance-bound native extension', async () => {
    setTextModelProviderForTests(successfulProvider('enhanced motion'));
    const runtime = testRuntime(VIDEO_ON);
    configure(runtime);
    const storyId = seedStory(runtime.db, ['opening beat', 'second beat']);
    kickStory(storyId);
    await waitForStoryDriverIdle();
    const first = currentSegment(runtime.db, storyId, 0).batch_id;
    if (!first) throw new Error('first batch missing');
    const predecessorTileId = await markBatchDone(runtime, first);

    notifyStoryBatchTerminal(first, true);
    await waitForStoryDriverIdle();

    const second = currentSegment(runtime.db, storyId, 1).batch_id;
    if (!second) throw new Error('second batch missing');
    const batch = runtime.db.query<{
      sequence_index: number | null;
      sequence_id: string | null;
      i2v_source_upload_id: string | null;
      motion_prompt: string | null;
    }, [string]>(
      'SELECT sequence_index, sequence_id, i2v_source_upload_id, motion_prompt FROM batches WHERE id = ?',
    ).get(second);
    expect(batch?.sequence_index).toBe(1);
    expect(batch?.sequence_id).not.toBeNull();
    expect(batch?.motion_prompt).toBe('enhanced motion');
    const upload = runtime.db.query<{ source_tile_id: string | null }, [string]>(
      'SELECT source_tile_id FROM uploads WHERE id = ?',
    ).get(batch?.i2v_source_upload_id ?? '');
    expect(upload?.source_tile_id).toBe(predecessorTileId);
    expect(runtime.db.query<{ sequence_index: number | null }, [string]>(
      'SELECT sequence_index FROM batches WHERE id = ?',
    ).get(first)?.sequence_index).toBe(0);
  });

  test('falls back to the raw beat when enhancement emits partial text then an error chunk', async () => {
    setTextModelProviderForTests(providerWith(async function* () {
      await Promise.resolve();
      yield { type: 'delta', text: 'partial motion that must not be submitted' } satisfies EnhanceChunk;
      yield { type: 'failed', status: 503, detail: 'offline' } satisfies EnhanceChunk;
    }));
    const runtime = testRuntime(VIDEO_ON);
    configure(runtime);
    const storyId = seedStory(runtime.db, ['raw opening beat']);
    kickStory(storyId);
    await waitForStoryDriverIdle();
    const batchId = currentSegment(runtime.db, storyId, 0).batch_id;
    expect(runtime.db.query<{ prompt: string }, [string]>(
      'SELECT prompt FROM batches WHERE id = ?',
    ).get(batchId ?? '')?.prompt).toBe('raw opening beat');
  });

  test('retries one failed segment once and fails the story after the retry fails', async () => {
    setTextModelProviderForTests(successfulProvider());
    const runtime = testRuntime(VIDEO_ON);
    configure(runtime);
    const storyId = seedStory(runtime.db, ['opening beat']);
    kickStory(storyId);
    await waitForStoryDriverIdle();
    const first = currentSegment(runtime.db, storyId, 0).batch_id;
    if (!first) throw new Error('first batch missing');
    markBatchFailed(runtime.db, first);
    notifyStoryBatchTerminal(first, false);
    await waitForStoryDriverIdle();
    const retried = currentSegment(runtime.db, storyId, 0);
    expect(retried.attempts).toBe(2);
    expect(retried.batch_id).not.toBe(first);
    if (!retried.batch_id) throw new Error('retry batch missing');
    markBatchFailed(runtime.db, retried.batch_id);
    notifyStoryBatchTerminal(retried.batch_id, false);
    await waitForStoryDriverIdle();
    expect(runtime.db.query<{ status: string; error: string | null }, [string]>(
      'SELECT status, error FROM stories WHERE id = ?',
    ).get(storyId)).toEqual({ status: 'failed', error: 'segment 1 failed' });
  });

  test('does not advance a canceled story', async () => {
    setTextModelProviderForTests(successfulProvider());
    const runtime = testRuntime(VIDEO_ON);
    configure(runtime);
    const storyId = seedStory(runtime.db, ['opening beat'], 'canceled');
    kickStory(storyId);
    await waitForStoryDriverIdle();
    expect(currentSegment(runtime.db, storyId, 0).batch_id).toBeNull();
  });

  test('does not create a batch when cancellation lands during enhancement', async () => {
    const runtime = testRuntime(VIDEO_ON);
    configure(runtime);
    const storyId = seedStory(runtime.db, ['opening beat']);
    setTextModelProviderForTests(providerWith(async function* () {
      await Promise.resolve();
      yield { type: 'delta', text: 'enhanced prompt' } satisfies EnhanceChunk;
      runtime.db.query(
        "UPDATE stories SET status = 'canceled', updated_at = ? WHERE id = ?",
      ).run(Date.now(), storyId);
      yield { type: 'done' } satisfies EnhanceChunk;
    }));

    kickStory(storyId);
    await waitForStoryDriverIdle();

    expect(runtime.db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM batches').get()?.count)
      .toBe(0);
    expect(currentSegment(runtime.db, storyId, 0).batch_id).toBeNull();
    expect(runtime.db.query<{ status: string }, [string]>(
      'SELECT status FROM stories WHERE id = ?',
    ).get(storyId)?.status).toBe('canceled');
  });

  test('marks a story canceled when its submitted batch row is missing', async () => {
    setTextModelProviderForTests(successfulProvider());
    const runtime = testRuntime(VIDEO_ON);
    configure(runtime);
    const storyId = seedStory(runtime.db, ['opening beat']);
    kickStory(storyId);
    await waitForStoryDriverIdle();
    const batchId = currentSegment(runtime.db, storyId, 0).batch_id;
    if (!batchId) throw new Error('batch missing');
    runtime.db.query('DELETE FROM batches WHERE id = ?').run(batchId);
    notifyStoryBatchTerminal(batchId, false);
    await waitForStoryDriverIdle();
    expect(runtime.db.query<{ status: string }, [string]>(
      'SELECT status FROM stories WHERE id = ?',
    ).get(storyId)?.status).toBe('canceled');
    expect(countInflightVideoForUser(runtime.db, 'alice', [])).toBe(0);
  });

  test('completed-story bookkeeping releases its reservation even while unrelated queue pressure is full', async () => {
    setTextModelProviderForTests(successfulProvider());
    const runtime = testRuntime({ ...VIDEO_ON, MAX_QUEUED_BATCHES_PER_USER: '1' });
    configure(runtime);
    const id = seedStory(runtime.db, ['beat']);
    kickStory(id); await waitForStoryDriverIdle();
    const batchId = currentSegment(runtime.db, id, 0).batch_id;
    if (batchId === null) throw new Error('batch missing');
    await markBatchDone(runtime, batchId);
    queuedPressure(runtime.db);
    notifyStoryBatchTerminal(batchId, true); await waitForStoryDriverIdle();
    expect(runtime.db.query('SELECT status FROM stories WHERE id=?').get(id)).toEqual({ status: 'done' });
    expect(countInflightVideoForUser(runtime.db, 'alice', ['minimax-h3-t2v'])).toBe(0);
  });

  test('recovery re-kicks rendering stories', async () => {
    setTextModelProviderForTests(successfulProvider());
    const runtime = testRuntime(VIDEO_ON);
    configure(runtime);
    const storyId = seedStory(runtime.db, ['opening beat']);
    recoverStories();
    await waitForStoryDriverIdle();
    expect(currentSegment(runtime.db, storyId, 0).batch_id).not.toBeNull();
  });
});

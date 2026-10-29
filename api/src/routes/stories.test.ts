import { afterEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import type { ModelAvailability } from '@atelier/shared';
import { adoptStandaloneBatch, appendSegment } from '../db/sequences';
import { countInflightVideoForUser } from '../db/queueOps';
import { acquireForPool, releaseForPool } from '../orchestrator/concurrency';
import { capsForPool } from '../providers/registry';
import {
  configureLlmAdmissionPools,
  enhancePool,
  resetLlmAdmissionForTests,
} from '../orchestrator/llmAdmission';
import type { EnhanceChunk, TestCliproxyTextProvider } from '../providers/cliproxyText';
import { setCliproxyTextProviderForTests } from '../providers/cliproxyText';
import { writeTextBackendOverride } from '../routing/textBackendPreference';
import { writeAtomic } from '../storage/files';
import { grayCardPng } from '../test/image-fixtures';
import { parseSse, testRuntime } from '../test/helpers';
import * as queue from '../orchestrator/queue';
import {
  configureStoryDriver,
  resetStoryDriverForTests,
  waitForStoryDriverIdle,
} from '../orchestrator/storyDriver';

const VIDEO_ON = {
  VIDEO_MODELS_ENABLED: 'true',
  LOCAL_MODELS_USERS: 'alice',
};
const availability = new Map<string, ModelAvailability>([
  ['minimax-h3-i2v', { ok: true, checkedAt: 1 }],
  ['minimax-h3-t2v', { ok: true, checkedAt: 1 }],
]);

function fakeProvider(plan: unknown): TestCliproxyTextProvider {
  return {
    async *enhance(_prompt, _images, _signal, systemPrompt) {
      await Promise.resolve();
      const text = systemPrompt?.includes('story planner')
        ? JSON.stringify(plan)
        : 'writer output';
      yield { type: 'delta', text: text.slice(0, Math.ceil(text.length / 2)) } satisfies EnhanceChunk;
      yield { type: 'delta', text: text.slice(Math.ceil(text.length / 2)) } satisfies EnhanceChunk;
      yield { type: 'done' } satisfies EnhanceChunk;
    },
    draftList: () => Promise.resolve({ type: 'failed', status: null, detail: 'unused' }),
    draftTemplate: () => Promise.resolve({ type: 'failed', status: null, detail: 'unused' }),
    inferDimensions: () => Promise.resolve({ type: 'ok', ops: [] }),
    inferDimensionsSingleAttempt: () => Promise.resolve({ type: 'ok', ops: [] }),
    rescueDimension: () => Promise.resolve({ type: 'failed', kind: 'permanent', status: null, detail: 'unused' }),
  };
}

function validPlan(durations: readonly number[] = [124, 243]): unknown {
  return {
    logline: 'A clear arc.',
    continuityBible: 'Consistent subject and soundscape.',
    segments: durations.map((durationFrames, idx) => ({
      beat: `beat ${idx + 1}`,
      durationFrames,
    })),
  };
}

function postStory(
  runtime: ReturnType<typeof testRuntime>,
  body: Record<string, unknown>,
  userId = 'alice',
): Promise<Response> {
  return runtime.fetch('/api/stories', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Remote-User': userId },
    body: JSON.stringify(body),
  });
}

function cancelStory(
  runtime: ReturnType<typeof testRuntime>,
  storyId: string,
  userId = 'alice',
): Promise<Response> {
  return runtime.fetch(`/api/stories/${storyId}/cancel`, {
    method: 'POST',
    headers: { 'Remote-User': userId },
  });
}

function configureIdleDriver(runtime: ReturnType<typeof testRuntime>): void {
  configureStoryDriver({
    db: runtime.db,
    config: runtime.config,
    logger: runtime.logger,
    kickLocalQueue: () => undefined,
  });
}

function seedStoryWithQueuedBatch(
  db: Database,
  status: 'rendering' | 'failed' = 'rendering',
): {
  readonly storyId: string;
  readonly batchId: string;
} {
  const storyId = crypto.randomUUID();
  const batchId = crypto.randomUUID();
  const tileId = crypto.randomUUID();
  db.query("INSERT OR IGNORE INTO users (id, created_at) VALUES ('alice', 1)").run();
  db.query(
    `INSERT INTO batches
      (id, user_id, prompt, ratio, model_id, model_label, created_at, status, pool,
       duration_frames, context_frames)
     VALUES (?, 'alice', 'beat', '16:9', 'minimax-h3-t2v', 'H3', 1, 'queued', 'local', 124, 0)`,
  ).run(batchId);
  db.query(
    `INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status)
     VALUES (?, ?, 'alice', 0, 1, 'loading')`,
  ).run(tileId, batchId);
  db.query(
    `INSERT INTO stories
      (id, user_id, status, outline, logline, continuity_bible, ratio,
       source_upload_id, extends_tile_id, source_prompt, error, eta_ms, created_at, updated_at)
     VALUES (?, 'alice', ?, 'outline', 'logline', 'bible', '16:9',
             NULL, NULL, NULL, NULL, 1000, 1, 1)`,
  ).run(storyId, status);
  db.query(
    `INSERT INTO story_segments
      (story_id, user_id, idx, beat, duration_frames, batch_id, attempts)
     VALUES (?, 'alice', 0, 'beat', 124, ?, 1)`,
  ).run(storyId, batchId);
  return { storyId, batchId };
}

async function seedExtensionSequence(
  db: Database,
  dataDir: string,
  segmentCount: number,
): Promise<{ readonly tileId: string; readonly uploadId: string }> {
  db.query("INSERT OR IGNORE INTO users (id, created_at) VALUES ('alice', 1)").run();
  const batchIds: string[] = [];
  const tileIds: string[] = [];
  const insertBatch = db.query(
    `INSERT INTO batches
      (id, user_id, prompt, ratio, model_id, model_label, created_at, status, pool, duration_frames)
     VALUES (?, 'alice', ?, '16:9', 'minimax-h3-i2v', 'MiniMax H3', ?, 'done', 'local', 124)`,
  );
  const insertTile = db.query(
    `INSERT INTO tiles
      (id, batch_id, user_id, tile_index, seed, status, ext, mime, completed_at)
     VALUES (?, ?, 'alice', 0, 1, 'done', 'mp4', 'video/mp4', 1)`,
  );
  for (let idx = 0; idx < segmentCount; idx += 1) {
    const batchId = crypto.randomUUID();
    const tileId = crypto.randomUUID();
    batchIds.push(batchId);
    tileIds.push(tileId);
    insertBatch.run(batchId, `source ${idx + 1}`, idx + 1);
    insertTile.run(tileId, batchId);
  }
  const firstBatchId = batchIds[0];
  if (!firstBatchId) throw new Error('extension sequence needs at least one segment');
  const adopted = adoptStandaloneBatch(db, 'alice', firstBatchId);
  if (adopted.status !== 'ok') throw new Error('expected extension source adoption');
  let tailBatchId = firstBatchId;
  for (const batchId of batchIds.slice(1)) {
    const appended = appendSegment(
      db,
      { error: () => undefined },
      'alice',
      adopted.sequenceId,
      tailBatchId,
      batchId,
    );
    if (appended.status !== 'ok') throw new Error('expected extension source append');
    tailBatchId = batchId;
  }
  const tileId = tileIds.at(-1);
  if (!tileId) throw new Error('extension sequence tail missing');
  const uploadId = crypto.randomUUID();
  const bytes = await grayCardPng(64);
  db.query(
    `INSERT INTO uploads
      (id, user_id, ext, mime, size_bytes, width, height, sha256, created_at, source_tile_id)
     VALUES (?, 'alice', 'png', 'image/png', ?, 64, 64, ?, 1, ?)`,
  ).run(uploadId, bytes.byteLength, `sha-${uploadId}`, tileId);
  await writeAtomic(dataDir, 'uploads', 'alice', uploadId, 'png', bytes);
  return { tileId, uploadId };
}

afterEach(async () => {
  await waitForStoryDriverIdle();
  resetStoryDriverForTests();
  setCliproxyTextProviderForTests(null);
  resetLlmAdmissionForTests();
  queue.resetQueueForTests();
});

describe('story routes', () => {
  test('concurrent planners at cap one atomically reserve exactly one story', async () => {
    const runtime = testRuntime({ ...VIDEO_ON, availability, MAX_INFLIGHT_VIDEO_PER_USER: '1' });
    configureIdleDriver(runtime);
    let planned = 0;
    let resume = (): void => undefined;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const base = fakeProvider(validPlan());
    setCliproxyTextProviderForTests({ ...base, async *enhance(...args) {
      if (args[3]?.includes('story planner')) { planned += 1; await gate; }
      yield* base.enhance(...args);
    } });
    const first = parseSse(await postStory(runtime, { outline: 'first', ratio: '16:9' }));
    const second = parseSse(await postStory(runtime, { outline: 'second', ratio: '16:9' }));
    try {
      const deadline = performance.now() + 2_000;
      while (planned < 2) {
        if (performance.now() > deadline) throw new Error('both planners did not start');
        await Bun.sleep(5);
      }
    } finally { resume(); }
    const results = await Promise.all([first, second]);
    await waitForStoryDriverIdle();
    const winner = results.find((frames) => frames.some((frame) => frame.event === 'plan'));
    const loser = results.find((frames) => frames.at(-1)?.event === 'error');
    expect(winner).toBeDefined();
    expect(loser?.at(-1)).toEqual({ event: 'error', data: {
      message: 'video generation already in progress', code: 'VIDEO_BUSY',
    } });
    expect(loser?.some((frame) => frame.event === 'plan')).toBe(false);
    expect(runtime.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM stories').get()?.n).toBe(1);
    expect(runtime.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM story_segments').get()?.n).toBe(2);
    expect(countInflightVideoForUser(runtime.db, 'alice', ['minimax-h3-t2v', 'minimax-h3-i2v'])).toBe(1);
  });

  test('a manual video accepted during planning wins the final admission recheck without story rows or a kick', async () => {
    const runtime = testRuntime({ ...VIDEO_ON, availability, MAX_INFLIGHT_VIDEO_PER_USER: '1' });
    configureIdleDriver(runtime);
    let entered = (): void => undefined;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let resume = (): void => undefined;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const base = fakeProvider(validPlan());
    let writerCalls = 0;
    setCliproxyTextProviderForTests({ ...base, async *enhance(...args) {
      if (args[3]?.includes('story planner')) { entered(); await gate; }
      else writerCalls += 1;
      yield* base.enhance(...args);
    } });
    const framesPromise = parseSse(await postStory(runtime, { outline: 'arc', ratio: '16:9' }));
    await started;
    const caps = capsForPool(runtime.config, 'local');
    const slot = acquireForPool('local', 'alice', 1, caps);
    if (!slot.ok) throw new Error('local slot unavailable');
    try {
      const manual = await runtime.fetch('/api/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Remote-User': 'alice' },
        body: JSON.stringify({ modelId: 'minimax-h3-t2v', prompt: 'manual video', ratio: '16:9', count: 1, durationFrames: 124 }),
      });
      expect(manual.status).toBe(201);
      expect(await manual.json()).toMatchObject({ status: 'queued' });
      resume();
      const frames = await framesPromise;
      expect(frames.at(-1)).toEqual({ event: 'error', data: {
        message: 'video generation already in progress', code: 'VIDEO_BUSY',
      } });
      expect(frames.some((frame) => frame.event === 'plan')).toBe(false);
      expect(runtime.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM stories').get()?.n).toBe(0);
      expect(runtime.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM story_segments').get()?.n).toBe(0);
      expect(writerCalls).toBe(0);
    } finally {
      resume();
      releaseForPool('local', 'alice', 1);
      await framesPromise;
    }
  });

  test('both routes are leak-safe when video is disabled or local models are gated', async () => {
    const disabled = testRuntime({ LOCAL_MODELS_USERS: 'alice' });
    const missingStory = crypto.randomUUID();
    expect((await postStory(disabled, { outline: 'x', ratio: '16:9' })).status).toBe(404);
    expect((await cancelStory(disabled, missingStory)).status).toBe(404);

    const gated = testRuntime({ ...VIDEO_ON, availability });
    expect((await postStory(gated, { outline: 'x', ratio: '16:9' }, 'bob')).status).toBe(404);
    expect((await cancelStory(gated, missingStory, 'bob')).status).toBe(404);
  });

  test('plans a t2v story, inserts rows, and submits segment one queued', async () => {
    setCliproxyTextProviderForTests(fakeProvider(validPlan()));
    const runtime = testRuntime({ ...VIDEO_ON, availability });
    configureIdleDriver(runtime);
    const response = await postStory(runtime, { outline: 'A short arc', ratio: '16:9' });
    const frames = await parseSse(response);
    const plan = frames.find((frame) => frame.event === 'plan')?.data as {
      storyId?: string;
      segments?: unknown[];
    } | undefined;
    expect(typeof plan?.storyId).toBe('string');
    expect(plan?.segments).toHaveLength(2);
    await waitForStoryDriverIdle();
    const story = runtime.db.query<{ status: string }, [string]>(
      'SELECT status FROM stories WHERE id = ?',
    ).get(plan?.storyId ?? '');
    expect(story?.status).toBe('rendering');
    const segment = runtime.db.query<{ batch_id: string | null }, [string]>(
      'SELECT batch_id FROM story_segments WHERE story_id = ? AND idx = 0',
    ).get(plan?.storyId ?? '');
    const batch = runtime.db.query<{ status: string; model_id: string }, [string]>(
      'SELECT status, model_id FROM batches WHERE id = ?',
    ).get(segment?.batch_id ?? '');
    expect(batch).toEqual({ status: 'queued', model_id: 'minimax-h3-t2v' });
  });

  test('the planner call carries the storytelling pin effort', async () => {
    const plannerEfforts: unknown[] = [];
    const base = fakeProvider(validPlan());
    setCliproxyTextProviderForTests({
      ...base,
      enhance(prompt, images, signal, systemPrompt, opts) {
        if (systemPrompt?.includes('story planner')) plannerEfforts.push(opts?.reasoningEffort);
        return base.enhance(prompt, images, signal, systemPrompt, opts);
      },
    });
    const runtime = testRuntime({ ...VIDEO_ON, availability });
    configureIdleDriver(runtime);
    writeTextBackendOverride(runtime.db, 'alice', 'storytelling', 'grok', 'high');
    await parseSse(await postStory(runtime, { outline: 'A short arc', ratio: '16:9' }));
    await waitForStoryDriverIdle();
    expect(plannerEfforts).toEqual(['high']);
  });

  test('snaps planner durations onto the supported frame grid', async () => {
    setCliproxyTextProviderForTests(fakeProvider(validPlan([130, 350])));
    const runtime = testRuntime({ ...VIDEO_ON, availability });
    configureIdleDriver(runtime);
    const frames = await parseSse(await postStory(runtime, { outline: 'Arc', ratio: '16:9' }));
    const plan = frames.find((frame) => frame.event === 'plan')?.data as {
      segments?: { durationFrames: number }[];
    } | undefined;
    expect(plan?.segments?.map((segment) => segment.durationFrames)).toEqual([124, 362]);
  });

  test('returns an error frame and inserts nothing when too few beats remain', async () => {
    setCliproxyTextProviderForTests(fakeProvider(validPlan([124])));
    const runtime = testRuntime({ ...VIDEO_ON, availability });
    configureIdleDriver(runtime);
    const frames = await parseSse(await postStory(runtime, { outline: 'Arc', ratio: '16:9' }));
    expect(frames.at(-1)?.event).toBe('error');
    expect(runtime.db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM stories').get()?.count)
      .toBe(0);
  });

  test('rejects planning with MODEL_OFFLINE while MiniMax H3 is offline', async () => {
    const offline = new Map<string, ModelAvailability>([
      ['minimax-h3-i2v', { ok: false, checkedAt: 1, reason: 'unavailable' }],
    ]);
    const runtime = testRuntime({ ...VIDEO_ON, availability: offline });
    const response = await postStory(runtime, { outline: 'Arc', ratio: '16:9' });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'model offline', code: 'MODEL_OFFLINE' });
    expect(runtime.db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM stories').get()?.count)
      .toBe(0);
  });

  test('rejects planning while another video batch is in flight', async () => {
    const runtime = testRuntime({ ...VIDEO_ON, availability });
    seedStoryWithQueuedBatch(runtime.db);
    const response = await postStory(runtime, { outline: 'Arc', ratio: '16:9' });
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: 'video generation already in progress',
      code: 'VIDEO_BUSY',
    });
  });

  test('rejects planning when an extension sequence has fewer than two slots left', async () => {
    let providerCalls = 0;
    setCliproxyTextProviderForTests({
      ...fakeProvider(validPlan()),
      async *enhance() {
        await Promise.resolve();
        providerCalls += 1;
        yield { type: 'done' } satisfies EnhanceChunk;
      },
    });
    const runtime = testRuntime({ ...VIDEO_ON, availability, MAX_SEQUENCE_SEGMENTS: '4' });
    const source = await seedExtensionSequence(runtime.db, runtime.config.DATA_DIR, 3);

    const response = await postStory(runtime, {
      outline: 'Continue the arc.',
      sourceUploadId: source.uploadId,
      extendsTileId: source.tileId,
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'sequence-full' });
    expect(providerCalls).toBe(0);
  });

  test('fails planning cleanly when the source upload is released while the planner runs', async () => {
    const runtime = testRuntime({ ...VIDEO_ON, availability });
    const source = await seedExtensionSequence(runtime.db, runtime.config.DATA_DIR, 2);
    const planner = fakeProvider(validPlan());
    setCliproxyTextProviderForTests({
      ...planner,
      async *enhance(...args) {
        runtime.db.query('DELETE FROM uploads WHERE id = ?').run(source.uploadId);
        yield* planner.enhance(...args);
      },
    });

    const frames = await parseSse(await postStory(runtime, {
      outline: 'Continue the arc.',
      sourceUploadId: source.uploadId,
      extendsTileId: source.tileId,
    }));

    expect(frames.at(-1)).toEqual({ event: 'error', data: { message: 'upload not found' } });
    expect(runtime.db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM stories').get()?.count)
      .toBe(0);
  });

  test('clamps an extension plan to the exact remaining sequence capacity', async () => {
    setCliproxyTextProviderForTests(fakeProvider(validPlan([124, 243, 362, 124, 243, 362])));
    const runtime = testRuntime({ ...VIDEO_ON, availability, MAX_SEQUENCE_SEGMENTS: '5' });
    const source = await seedExtensionSequence(runtime.db, runtime.config.DATA_DIR, 2);

    const frames = await parseSse(await postStory(runtime, {
      outline: 'Continue through six possible beats.',
      sourceUploadId: source.uploadId,
      extendsTileId: source.tileId,
    }));
    const plan = frames.find((frame) => frame.event === 'plan')?.data as {
      storyId?: string;
      segments?: unknown[];
    } | undefined;

    expect(plan?.segments).toHaveLength(3);
    expect(runtime.db.query<{ count: number }, [string]>(
      'SELECT COUNT(*) AS count FROM story_segments WHERE story_id = ?',
    ).get(plan?.storyId ?? '')?.count).toBe(3);
  });

  test('returns QUEUE_FULL when the storytelling planner admission slot is saturated', async () => {
    let providerCalls = 0;
    setCliproxyTextProviderForTests({
      ...fakeProvider(validPlan()),
      async *enhance() {
        await Promise.resolve();
        providerCalls += 1;
        yield { type: 'done' } satisfies EnhanceChunk;
      },
    });
    const runtime = testRuntime({
      ...VIDEO_ON,
      availability,
      MAX_CONCURRENT_LLM_ENHANCE_PER_USER: '1',
    });
    configureLlmAdmissionPools(runtime.config);
    const slot = enhancePool.acquire('alice');
    if (!slot.ok) throw new Error('expected enhance admission slot');
    try {
      const response = await postStory(runtime, { outline: 'Arc', ratio: '16:9' });
      expect(response.status).toBe(429);
      expect(await response.json()).toEqual({
        error: 'queue full',
        code: 'QUEUE_FULL',
        reason: 'per-user',
        retry_after_seconds: 5,
      });
      expect(providerCalls).toBe(0);
    } finally {
      slot.release();
    }
  });

  test('cancels rendering stories idempotently and rejects terminal stories', async () => {
    const runtime = testRuntime({ ...VIDEO_ON, availability });
    const seeded = seedStoryWithQueuedBatch(runtime.db);
    const first = await cancelStory(runtime, seeded.storyId);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ inflightBatchId: seeded.batchId });
    const second = await cancelStory(runtime, seeded.storyId);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ inflightBatchId: seeded.batchId });

    const terminal = seedStoryWithQueuedBatch(runtime.db, 'failed');
    const conflict = await cancelStory(runtime, terminal.storyId);
    expect(conflict.status).toBe(409);
  });
});

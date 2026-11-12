// F33: a brief outage of the single ComfyUI host pauses the local queue instead
// of failing it. These run the real dispatch wiring (gate, dequeue, pipeline)
// with a fake provider and an injected host-availability view, standing in for
// the boot wiring between the health probe and the local host gate.
import { afterEach, expect, spyOn, test } from 'bun:test';
import type { ModelAvailability } from '@atelier/shared';
import { createBatch } from '../orchestrator/createBatch';
import { resetConcurrencyForTests } from '../orchestrator/concurrency';
import { configureUpstreamGateWiring, kickQueues, type DispatchDeps } from '../orchestrator/dispatch';
import {
  configureLocalHostGate, noteLocalHostAvailability, resetLocalHostGateForTests,
} from '../orchestrator/localHostGate';
import * as queue from '../orchestrator/queue';
import { resetRegistryForTests, snapshotBatchDonePromises } from '../orchestrator/registry';
import { isPaused, resetUpstreamGateForTests, setUpstreamGateTimersForTests } from '../orchestrator/upstreamGate';
import { findModel } from '../providers/registry';
import { testRuntime, testTextServices } from './helpers';

const MODEL = 'moss-base';
const HALF_OPEN_MS = 2_000;
const MAX_PAUSE_MS = 30_000;

const restores: (() => void)[] = [];

afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  resetUpstreamGateForTests();
  resetLocalHostGateForTests();
  queue.resetQueueForTests();
  resetRegistryForTests();
  resetConcurrencyForTests();
});

function refused(): Error {
  return Object.assign(new TypeError('Unable to connect. Is the computer able to access the url?'), { code: 'ECONNREFUSED' });
}

function setup(failureFor: (call: number) => unknown) {
  const runtime = testRuntime({
    LOCAL_MODELS_USERS: 'alice,bob,carol',
    MAX_CONCURRENT_TILES_LOCAL: '1',
    IMAGE_BREAKER_HALF_OPEN_MS: String(HALF_OPEN_MS),
    IMAGE_BREAKER_MAX_PAUSE_MS: String(MAX_PAUSE_MS),
  });
  const snapshot = new Map<string, ModelAvailability>();
  const deps: DispatchDeps = {
    db: runtime.db,
    config: runtime.config,
    logger: runtime.logger,
    keyStore: undefined,
    healthSnapshot: () => snapshot,
    text: testTextServices(runtime.db, runtime.config),
  };
  let now = 0;
  const pending: { at: number; fn: () => void }[] = [];
  setUpstreamGateTimersForTests({
    now: () => now,
    setTimer: (fn, ms) => { const timer = { at: now + ms, fn }; pending.push(timer); return timer; },
    clearTimer: (handle) => {
      const index = pending.indexOf(handle as { at: number; fn: () => void });
      if (index >= 0) pending.splice(index, 1);
    },
  });
  configureUpstreamGateWiring(deps);

  const entry = findModel(MODEL, runtime.config);
  if (!entry) throw new Error('expected registered local model');
  const prompts: string[] = [];
  const binding = spyOn(entry, 'bind').mockReturnValue({
    id: 'outage-test', backend: 'local',
    async *generate(request) {
      prompts.push(request.prompt);
      await Promise.resolve();
      yield { status: 'failed', error: failureFor(prompts.length), seed: request.seed, index: 0 };
    },
  });
  restores.push(() => { binding.mockRestore(); });

  const batchIds: string[] = [];
  for (const [index, user] of ['alice', 'bob', 'carol'].entries()) {
    const created = createBatch(runtime.db, user, { prompt: `p${index + 1}`, modelId: MODEL, ratio: '1:1', count: 1 }, entry);
    queue.enqueue('local', {
      batchId: created.batch.id, userId: user, modelId: MODEL, count: 1, queuedAt: created.batch.created_at,
    });
    batchIds.push(created.batch.id);
  }

  return {
    deps,
    snapshot,
    prompts,
    batchIds,
    advance(ms: number) {
      now += ms;
      for (const timer of [...pending]) {
        if (timer.at <= now) {
          pending.splice(pending.indexOf(timer), 1);
          timer.fn();
        }
      }
    },
    statuses: () => batchIds.map((id) => runtime.db.query<{ status: string }, [string]>(
      'SELECT status FROM batches WHERE id = ?',
    ).get(id)?.status),
    tileErrors: () => batchIds.map((id) => runtime.db.query<{ error: string | null }, [string]>(
      'SELECT error FROM tiles WHERE batch_id = ?',
    ).get(id)?.error ?? null),
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.allSettled(snapshotBatchDonePromises());
    await Bun.sleep(1);
  }
}

test('a host-level outage keeps three queued local batches waiting, then dispatches them in order', async () => {
  const t = setup(() => 'test terminal');
  let hostDown = true;
  t.snapshot.set(MODEL, { ok: false, checkedAt: 1, reason: 'unavailable' });
  configureLocalHostGate({ hostUnavailable: () => hostDown, probeNow: () => Promise.resolve(undefined) });
  noteLocalHostAvailability(false);

  kickQueues(t.deps);
  await settle();
  // Probe tokens keep arriving while paused; none may consume a batch.
  for (let i = 0; i < 5; i += 1) {
    t.advance(HALF_OPEN_MS);
    await settle();
  }

  expect(t.prompts).toEqual([]);
  expect(t.statuses()).toEqual(['queued', 'queued', 'queued']);
  expect(queue.entries('local').map((entry) => entry.batchId)).toEqual(t.batchIds);
  expect(isPaused('local')).toBe(true);

  hostDown = false;
  t.snapshot.set(MODEL, { ok: true, checkedAt: 2 });
  noteLocalHostAvailability(true);
  await settle();

  expect(isPaused('local')).toBe(false);
  expect(t.prompts).toEqual(['p1', 'p2', 'p3']);
  expect(queue.entries('local')).toHaveLength(0);
});

test('a transport failure before the lease pauses the pool and requests a probe; a healthy probe resumes it', async () => {
  const t = setup((call) => (call === 1 ? refused() : 'test terminal'));
  const probed: string[] = [];
  let finishProbe: () => void = () => undefined;
  configureLocalHostGate({
    hostUnavailable: () => false,
    probeNow: (modelId) => {
      probed.push(modelId);
      return new Promise<undefined>((resolve) => { finishProbe = () => { resolve(undefined); }; });
    },
  });

  kickQueues(t.deps);
  await settle();

  expect(t.prompts).toEqual(['p1']);
  expect(probed).toEqual([MODEL]);
  expect(isPaused('local')).toBe(true);
  expect(t.statuses()).toEqual(['done', 'queued', 'queued']);
  expect(t.tileErrors()[0]).not.toBeNull();
  expect(t.tileErrors().slice(1)).toEqual([null, null]);

  finishProbe();
  await settle();

  expect(isPaused('local')).toBe(false);
  expect(t.prompts).toEqual(['p1', 'p2', 'p3']);
});

test('a row-level offline model still fails its queued batches with upstream rejected and does not pause', async () => {
  const t = setup(() => 'test terminal');
  t.snapshot.set(MODEL, { ok: false, checkedAt: 1, reason: 'unavailable' });
  configureLocalHostGate({ hostUnavailable: () => false, probeNow: () => Promise.resolve(undefined) });

  kickQueues(t.deps);
  await settle();

  expect(t.prompts).toEqual([]);
  expect(t.tileErrors()).toEqual(['upstream rejected', 'upstream rejected', 'upstream rejected']);
  expect(isPaused('local')).toBe(false);
});

test('after the pause ceiling the queued local batches fail with service unavailable', async () => {
  const t = setup(() => 'test terminal');
  t.snapshot.set(MODEL, { ok: false, checkedAt: 1, reason: 'unavailable' });
  configureLocalHostGate({ hostUnavailable: () => true, probeNow: () => Promise.resolve(undefined) });
  noteLocalHostAvailability(false);

  kickQueues(t.deps);
  await settle();
  for (let elapsed = 0; elapsed < MAX_PAUSE_MS; elapsed += HALF_OPEN_MS) {
    t.advance(HALF_OPEN_MS);
    await settle();
  }

  expect(t.prompts).toEqual([]);
  expect(t.tileErrors()).toEqual(['service unavailable', 'service unavailable', 'service unavailable']);
  expect(queue.entries('local')).toHaveLength(0);
});

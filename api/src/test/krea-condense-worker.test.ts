import { afterEach, beforeEach, expect, test } from 'bun:test';
import { setTextModelProviderForTests } from '../providers/text/registry';
import { jsonRequest, restoreFetch, testRuntime } from './helpers';
import * as queue from '../orchestrator/queue';
import { resetLlmAdmissionForTests } from '../orchestrator/llmAdmission';
import { resetUpstreamGateForTests } from '../orchestrator/upstreamGate';
import {
  type EnhanceChunk,
  type TestTextFeatureProvider,
} from '../providers/text/featureHelpers';
import { KREA_PROMPT_CONDENSE_TRIGGER_WORDS } from '../prompts/promptBudget';
import { localTilesInFlight } from '../orchestrator/concurrency';
import { stopQueuedPromptPreparation } from '../orchestrator/queuedPromptPreparation';
import { snapshotBatchDonePromises } from '../orchestrator/registry';

// The condense pass runs in the batch worker, not in POST /api/generate. Its fail-open matrix is unit-tested in
// orchestrator/condenseBatchPrompt.test.ts; what THIS file pins is the
// architectural property that made the move worth doing — the 201 carrying the
// batch id no longer waits on a 57-120s LLM call — plus the wiring that the
// unit tests cannot see: the worker actually runs the pass and writes the
// result back onto the batch row.

const OVER_TRIGGER_WORDS = KREA_PROMPT_CONDENSE_TRIGGER_WORDS + 5;

function wordPrompt(count: number, prefix = 'word'): string {
  return Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`).join(' ');
}

function fakeCondenseProvider(
  enhance: TestTextFeatureProvider['enhance'],
): TestTextFeatureProvider {
  return {
    enhance,
    draftList: () => Promise.resolve({ type: 'failed', status: null, detail: 'not implemented' }),
    draftTemplate: () => Promise.resolve({ type: 'failed', status: null, detail: 'not implemented' }),
    inferDimensions: () => Promise.resolve({ type: 'ok', ops: [] }),
    inferDimensionsSingleAttempt: () => Promise.resolve({ type: 'ok', ops: [] }),
    rescueDimension: () => Promise.resolve({ type: 'failed', kind: 'permanent', status: null, detail: 'not implemented' }),
  };
}

function kreaRuntime() {
  return testRuntime({
    seedLegacyText: true,
    availability: new Map([
      ['krea-2-gonzalomo', { ok: true as const, checkedAt: 1_700_000_000_000 }],
    ]),
    LOCAL_MODELS_USERS: 'alice',
    LOG_LEVEL: 'info',
  });
}

async function waitForPrompt(
  runtime: ReturnType<typeof testRuntime>,
  batchId: string,
  expected: string,
): Promise<string | undefined> {
  const query = runtime.db.query<{ prompt: string }, [string]>(
    'SELECT prompt FROM batches WHERE id = ?',
  );
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const row = query.get(batchId);
    if (row?.prompt === expected) return row.prompt;
    await Bun.sleep(10);
  }
  return query.get(batchId)?.prompt;
}

beforeEach(() => {
  restoreFetch();
  queue.resetQueueForTests();
  resetLlmAdmissionForTests();
});

afterEach(async () => {
  await stopQueuedPromptPreparation();
  restoreFetch();
  setTextModelProviderForTests(null);
  resetLlmAdmissionForTests();
  resetUpstreamGateForTests();
});

test('the batch id comes back before condensation has even started', async () => {
  const original = `An adult woman ${wordPrompt(OVER_TRIGGER_WORDS)}`;
  const condensed = `An adult woman ${wordPrompt(120, 'short')}`;
  let condenseEntered!: () => void;
  const enteredCondense = new Promise<void>((resolve) => { condenseEntered = resolve; });
  let releaseCondense!: () => void;
  const condenseGate = new Promise<void>((resolve) => { releaseCondense = resolve; });

  setTextModelProviderForTests(fakeCondenseProvider(async function* () {
    condenseEntered();
    // Stands in for the 57-120s V4 Pro call. Nothing may depend on it
    // finishing before /api/generate answers.
    await condenseGate;
    yield { type: 'delta', text: condensed } satisfies EnhanceChunk;
    yield { type: 'done' } satisfies EnhanceChunk;
  }));
  const runtime = kreaRuntime();

  const res = await jsonRequest(runtime.app, '/api/generate', {
    prompt: original,
    modelId: 'krea-2-gonzalomo',
    ratio: '1:1',
    count: 1,
  }, 'alice');

  // The whole point: this resolved while the condense call is still parked on
  // its gate. Before the move this await could not complete until the LLM did.
  expect(res.status).toBe(201);
  const payload = await res.json() as { batchId: string; status: string };
  expect(typeof payload.batchId).toBe('string');
  expect(payload.status).toBe('queued');
  expect(localTilesInFlight()).toBe(0);

  await enteredCondense;
  // The row still carries the prompt as submitted — the batch is persisted
  // from the client's text, and the condensed form lands later.
  const beforeRow = runtime.db.query<{ prompt: string }, [string]>(
    'SELECT prompt FROM batches WHERE id = ?',
  ).get(payload.batchId);
  expect(beforeRow?.prompt).toBe(original);

  releaseCondense();
  expect(await waitForPrompt(runtime, payload.batchId, condensed)).toBe(condensed);
});

for (const failOpen of [false, true]) {
  test(`${failOpen ? 'fail-open' : 'still-long multisubject'} queued preparation is attempted exactly once`, async () => {
    const original = wordPrompt(400);
    const candidate = wordPrompt(300, 'short');
    let calls = 0;
    setTextModelProviderForTests(fakeCondenseProvider(async function* () {
      await Promise.resolve();
      calls += 1;
      if (!failOpen) yield { type: 'delta', text: candidate };
      yield { type: 'done' };
    }));
    const runtime = kreaRuntime();
    const response = await jsonRequest(runtime.app, '/api/generate', {
      prompt: original, modelId: 'krea-2-gonzalomo', ratio: '1:1', count: 1,
    }, 'alice');
    expect(response.status).toBe(201);
    const { batchId } = await response.json() as { batchId: string };
    const events = await runtime.fetch(`/api/batches/${batchId}/events`, { headers: { 'Remote-User': 'alice' } });
    expect(await events.text()).toContain('event: done');
    expect(calls).toBe(1);
    expect(runtime.db.query('SELECT prompt FROM batches WHERE id = ?').get(batchId))
      .toEqual({ prompt: failOpen ? original : candidate });
  });
}

for (const lastTile of [false, true]) {
  test(`deleting the ${lastTile ? 'last tile' : 'batch'} aborts queued condensation before it can persist or reserve the GPU`, async () => {
    let entered: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let finish: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    let signal: AbortSignal | undefined;
    setTextModelProviderForTests(fakeCondenseProvider(async function* (_prompt, _images, activeSignal) {
      signal = activeSignal;
      entered();
      await gate;
      yield { type: 'delta', text: 'a shorter adult portrait' };
      yield { type: 'done' };
    }));
    const runtime = kreaRuntime();
    const response = await jsonRequest(runtime.app, '/api/generate', {
      prompt: wordPrompt(350), modelId: 'krea-2-gonzalomo', ratio: '1:1', count: 1,
    }, 'alice');
    const payload = await response.json() as { batchId: string; tiles: { tileId: string }[] };
    await started;
    const done = snapshotBatchDonePromises();
    try {
      const suffix = lastTile ? `/${payload.tiles[0]?.tileId}` : '';
      const canceled = await runtime.fetch(`/api/history/${payload.batchId}${suffix}`, {
        method: 'DELETE', headers: { 'Remote-User': 'alice' },
      });
      expect(canceled.status).toBe(204);
      await Bun.sleep(0);
      expect(signal?.aborted).toBe(true);
    } finally { finish(); await Promise.all(done); }
    expect(runtime.db.query('SELECT id FROM batches WHERE id = ?').get(payload.batchId)).toBeNull();
    expect(queue.__queueTest.lengthOf('local')).toBe(0);
    expect(localTilesInFlight()).toBe(0);
  });
}

test('a prompt under the trigger is never rewritten by the worker', async () => {
  const original = wordPrompt(KREA_PROMPT_CONDENSE_TRIGGER_WORDS);
  let calls = 0;
  setTextModelProviderForTests(fakeCondenseProvider(async function* () {
    await Promise.resolve();
    calls += 1;
    yield { type: 'done' } satisfies EnhanceChunk;
  }));
  const runtime = kreaRuntime();

  const res = await jsonRequest(runtime.app, '/api/generate', {
    prompt: original,
    modelId: 'krea-2-gonzalomo',
    ratio: '1:1',
    count: 1,
  }, 'alice');
  expect(res.status).toBe(201);
  const payload = await res.json() as { batchId: string };

  await Bun.sleep(50);
  const row = runtime.db.query<{ prompt: string }, [string]>(
    'SELECT prompt FROM batches WHERE id = ?',
  ).get(payload.batchId);
  expect(row?.prompt).toBe(original);
  expect(calls).toBe(0);
});

import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import type { Database } from 'bun:sqlite';
import type { GenerateResponse } from '@atelier/shared';
import { restoreFetch, testRuntime } from '../test/helpers';
import * as queue from '../orchestrator/queue';
import * as dispatch from '../orchestrator/dispatch';
import * as concurrency from '../orchestrator/concurrency';
import * as queuedPromptPreparation from '../orchestrator/queuedPromptPreparation';
import {
  configureUpstreamGate,
  noteBreakerState,
  resetUpstreamGateForTests,
} from '../orchestrator/upstreamGate';
import { setGenerateSubmitRaceHookForTests } from './generate';

// Every post-commit side effect a creation runs; a replay must run none.
interface SideEffectSpies {
  readonly acquire: Mock<typeof concurrency.acquireForPool>;
  readonly enqueue: Mock<typeof queue.enqueue>;
  readonly start: Mock<typeof dispatch.startPrepared>;
  readonly kick: Mock<typeof dispatch.kickQueues>;
  readonly prepare: Mock<typeof queuedPromptPreparation.prepareQueuedPrompts>;
}

let spies: SideEffectSpies;

function namedSpies(): readonly (readonly [string, Mock<(...args: never[]) => unknown>])[] {
  return [
    ['acquire', spies.acquire],
    ['enqueue', spies.enqueue],
    ['start', spies.start],
    ['kick', spies.kick],
    ['prepare', spies.prepare],
  ];
}

function clearSpies(): void {
  for (const [, spy] of namedSpies()) spy.mockClear();
}

function expectNoSideEffects(): void {
  const called = namedSpies().filter(([, spy]) => spy.mock.calls.length > 0).map(([name]) => name);
  expect(called).toEqual([]);
}

beforeEach(() => {
  restoreFetch();
  queue.resetQueueForTests();
  // Pause the shared pool so a created batch stays queued and countable.
  configureUpstreamGate({
    kickPool: () => undefined,
    failQueued: () => undefined,
    halfOpenAfterMs: 60_000,
    maxPauseMs: 600_000,
    threshold: 5,
  });
  noteBreakerState('shared', 'open');
  spies = {
    acquire: spyOn(concurrency, 'acquireForPool'),
    enqueue: spyOn(queue, 'enqueue'),
    start: spyOn(dispatch, 'startPrepared'),
    kick: spyOn(dispatch, 'kickQueues').mockImplementation(() => undefined),
    prepare: spyOn(queuedPromptPreparation, 'prepareQueuedPrompts'),
  };
});

afterEach(() => {
  for (const [, spy] of namedSpies()) spy.mockRestore();
  setGenerateSubmitRaceHookForTests(null);
  restoreFetch();
  resetUpstreamGateForTests();
  queue.resetQueueForTests();
});

function generateRequest(overrides: Record<string, unknown> = {}, user = 'carol'): Request {
  return new Request('http://local/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Remote-User': user },
    body: JSON.stringify({
      modelId: 'gpt-image-2.5-sunburst',
      prompt: 'a test image',
      ratio: '1:1',
      count: 1,
      ...overrides,
    }),
  });
}

// Boot-time queue wiring may run preparation once; observe only the requests.
function runtime(): ReturnType<typeof testRuntime> {
  const created = testRuntime();
  clearSpies();
  return created;
}

function batchCount(db: Database): number {
  return db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM batches').get()?.n ?? 0;
}

function insertKeyedBatch(
  db: Database,
  opts: { id: string; user: string; key: string; modelId?: string; status?: 'queued' | 'running' | 'done' },
): void {
  db.query('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, 1)').run(opts.user);
  db.query(
    `INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, status, pool, idempotency_key)
     VALUES (?, ?, 'p', '1:1', ?, 'Label', 1, ?, 'shared', ?)`,
  ).run(opts.id, opts.user, opts.modelId ?? 'gpt-image-2.5-sunburst', opts.status ?? 'running', opts.key);
  db.query(
    `INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status) VALUES (?, ?, ?, 0, 7, ?)`,
  ).run(`${opts.id}-t0`, opts.id, opts.user, opts.status === 'done' ? 'done' : 'loading');
}

describe('POST /api/generate idempotency key', () => {
  test('the same key re-POSTed returns the existing batch with 200 and creates nothing', async () => {
    const { app, db } = runtime();

    const first = await app.fetch(generateRequest({ idempotencyKey: 'roll-1', seed: 1 }));
    expect(first.status).toBe(201);
    const created = await first.json() as GenerateResponse;
    expect(created.status).toBe('queued');
    expect(created).not.toHaveProperty('replayed');
    expect(queue.__queueTest.lengthOf('shared')).toBe(1);
    // The spies observe the creation, so their silence below is meaningful.
    expect(spies.enqueue).toHaveBeenCalledTimes(1);
    clearSpies();

    const second = await app.fetch(generateRequest({ idempotencyKey: 'roll-1', seed: 2, prompt: 'changed' }));
    expect(second.status).toBe(200);
    const replayed = await second.json() as GenerateResponse;
    expect(replayed).toEqual({ ...created, replayed: true });
    expect(batchCount(db)).toBe(1);
    expect(queue.__queueTest.lengthOf('shared')).toBe(1);
    expectNoSideEffects();
  });

  test('a key is scoped per user', async () => {
    const { app, db } = runtime();

    const alice = await app.fetch(generateRequest({ idempotencyKey: 'shared-key' }, 'alice'));
    const bob = await app.fetch(generateRequest({ idempotencyKey: 'shared-key' }, 'bob'));

    expect(alice.status).toBe(201);
    expect(bob.status).toBe(201);
    const aliceBody = await alice.json() as GenerateResponse;
    const bobBody = await bob.json() as GenerateResponse;
    expect(aliceBody.batchId).not.toBe(bobBody.batchId);
    expect(batchCount(db)).toBe(2);
  });

  test('a request without a key is never deduped', async () => {
    const { app, db } = runtime();

    const first = await app.fetch(generateRequest());
    const second = await app.fetch(generateRequest());

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(batchCount(db)).toBe(2);
  });

  test('an archived batch still replays', async () => {
    const { app, db } = runtime();
    const first = await app.fetch(generateRequest({ idempotencyKey: 'roll-archived' }));
    const created = await first.json() as GenerateResponse;
    db.query('UPDATE batches SET archived_at = 5 WHERE id = ?').run(created.batchId);
    clearSpies();

    const second = await app.fetch(generateRequest({ idempotencyKey: 'roll-archived' }));

    expect(second.status).toBe(200);
    expect((await second.json() as GenerateResponse).batchId).toBe(created.batchId);
    expect(batchCount(db)).toBe(1);
    expectNoSideEffects();
  });

  test('a hard-deleted batch frees its key', async () => {
    const { app, db } = runtime();
    const first = await app.fetch(generateRequest({ idempotencyKey: 'roll-deleted' }));
    const created = await first.json() as GenerateResponse;
    db.query('DELETE FROM tiles WHERE batch_id = ?').run(created.batchId);
    db.query('DELETE FROM batches WHERE id = ?').run(created.batchId);

    const second = await app.fetch(generateRequest({ idempotencyKey: 'roll-deleted' }));

    expect(second.status).toBe(201);
    expect((await second.json() as GenerateResponse).batchId).not.toBe(created.batchId);
  });

  test('a concurrent insert of the same key inside the transaction replays instead of failing', async () => {
    const { app, db } = runtime();
    setGenerateSubmitRaceHookForTests(({ db: hookDb, userId }) => {
      insertKeyedBatch(hookDb, { id: 'raced', user: userId, key: 'roll-raced' });
    });

    const res = await app.fetch(generateRequest({ idempotencyKey: 'roll-raced' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ batchId: 'raced', status: 'running', replayed: true });
    expect(batchCount(db)).toBe(1);
    expectNoSideEffects();
  });

  test('a replay of a done batch reports status done', async () => {
    const { app, db } = runtime();
    insertKeyedBatch(db, { id: 'finished', user: 'carol', key: 'roll-done', status: 'done' });

    const res = await app.fetch(generateRequest({ idempotencyKey: 'roll-done' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      batchId: 'finished',
      tiles: [{ tileId: 'finished-t0', tileIndex: 0, seed: 7 }],
      status: 'done',
      pool: 'shared',
      replayed: true,
    });
    expectNoSideEffects();
  });

  test('a replay ignores a retired model', async () => {
    const { app, db } = runtime();
    insertKeyedBatch(db, { id: 'old', user: 'carol', key: 'roll-retired', modelId: 'retired-model' });

    const res = await app.fetch(generateRequest({ idempotencyKey: 'roll-retired', modelId: 'retired-model' }));

    expect(res.status).toBe(200);
    expect((await res.json() as GenerateResponse).batchId).toBe('old');
    expectNoSideEffects();
  });
});

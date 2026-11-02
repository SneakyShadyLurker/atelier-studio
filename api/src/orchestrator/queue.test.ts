import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Pool } from '@atelier/shared';
import { migrate } from '../db/migrate';
import * as queue from './queue';

beforeEach(() => {
  queue.resetQueueForTests();
});

afterEach(() => {
  queue.configureQueueScheduling({ affinityKeyOf: (modelId) => modelId, maxHeadWaitMs: 600_000 });
});

function entry(batchId: string, userId = 'u1', _pool: Pool = 'shared'): queue.QueueEntryInput {
  return {
    batchId,
    userId,
    modelId: 'gpt-image-2.5-sunburst',
    count: 1,
    queuedAt: Date.now(),
  };
}

function seedQueued(db: Database, batchId: string, createdAt: number, pool: Pool = 'shared'): void {
  db.run("INSERT OR IGNORE INTO users (id, created_at) VALUES ('u1', ?)", [Date.now()]);
  db.run(
    `INSERT INTO batches (id, user_id, prompt, model_id, model_label, ratio, created_at, status, pool)
     VALUES (?, 'u1', 'p', 'gpt-image-2.5-sunburst', 'GPT Image 2.5 Sunburst', '1:1', ?, 'queued', ?)`,
    [batchId, createdAt, pool],
  );
  db.run(
    `INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status)
     VALUES (?, ?, 'u1', 0, 0, 'loading')`,
    [`t-${batchId}`, batchId],
  );
}

test('enqueue, peek, and pop use FIFO order per pool', () => {
  queue.enqueue('shared', entry('a'));
  queue.enqueue('shared', entry('b'));
  queue.enqueue('byok', entry('c', 'u1', 'byok'));

  expect(queue.__queueTest.peekHead('shared')?.batchId).toBe('a');
  expect(queue.__queueTest.peekHead('byok')?.batchId).toBe('c');
  expect(queue.__queueTest.popHead('shared')?.batchId).toBe('a');
  expect(queue.__queueTest.peekHead('shared')?.batchId).toBe('b');
  expect(queue.__queueTest.lengthOf('shared')).toBe(1);
});

test('positionOf returns 0 for head and -1 when not queued', () => {
  queue.enqueue('shared', entry('a'));
  queue.enqueue('shared', entry('b'));
  expect(queue.positionOf('shared', 'a')).toBe(0);
  expect(queue.positionOf('shared', 'b')).toBe(1);
  expect(queue.positionOf('shared', 'missing')).toBe(-1);
});

test('other users bypass preparation using the ready affinity projection', () => {
  queue.noteDispatched('local', 'krea-2-gonzalomo');
  queue.enqueue('local', { ...entry('preparing'), modelId: 'krea-2-gonzalomo' });
  queue.enqueue('local', { ...entry('video', 'u2'), modelId: 'minimax-h3-i2v' });
  queue.enqueue('local', { ...entry('ready', 'u3'), modelId: 'krea-2-gonzalomo' });
  queue.setPromptPreparation('preparing', queue.currentEpoch(), 'pending');
  expect(queue.peekNext('local')?.batchId).toBe('ready');
  expect(queue.positionOf('local', 'ready')).toBe(0);
  expect(queue.positionOf('local', 'video')).toBe(1);
  expect(queue.positionOf('local', 'preparing')).toBe(2);
  queue.setPromptPreparation('preparing', queue.currentEpoch(), 'ready');
  expect(queue.peekNext('local')?.batchId).toBe('preparing');
  expect(queue.positionOf('local', 'preparing')).toBe(0);
});

test('queue change subscriptions are deferred, coalesced and detachable', async () => {
  let calls = 0;
  const detach = queue.subscribeQueueChanges(() => { calls += 1; });
  queue.enqueue('byok', entry('a'));
  queue.updateCount('byok', 'a', 0);
  expect(calls).toBe(0);
  await Bun.sleep(0);
  expect(calls).toBe(1);
  detach();
  queue.enqueue('shared', entry('b'));
  queue.removeById('shared', 'b');
  await Bun.sleep(0);
  expect(calls).toBe(1);
});

test('model affinity never overtakes an earlier batch for the same user', () => {
  queue.noteDispatched('local', 'krea-2-gonzalomo');
  queue.enqueue('local', { ...entry('alice-video', 'alice'), modelId: 'minimax-h3-i2v' });
  queue.enqueue('local', { ...entry('alice-image', 'alice'), modelId: 'krea-2-gonzalomo' });
  queue.enqueue('local', { ...entry('bob-image', 'bob'), modelId: 'krea-2-gonzalomo' });
  queue.enqueue('local', { ...entry('alice-video-2', 'alice'), modelId: 'minimax-h3-t2v' });

  for (const [position, id] of ['bob-image', 'alice-video', 'alice-image', 'alice-video-2'].entries()) {
    expect(queue.positionOf('local', id)).toBe(position);
  }
  const dispatched: string[] = [];
  while (queue.peekNext('local')) {
    const next = queue.peekNext('local');
    if (!next) throw new Error('expected next batch');
    expect(queue.positionOf('local', next.batchId)).toBe(0);
    dispatched.push(next.batchId);
    queue.noteDispatchedFromQueue('local', next);
    queue.removeById('local', next.batchId);
  }
  expect(dispatched).toEqual(['bob-image', 'alice-video', 'alice-image', 'alice-video-2']);
});

test('pending heads block same-user ready tails and positions while other users progress', () => {
  queue.noteDispatched('local', 'krea-2-gonzalomo');
  queue.enqueue('local', { ...entry('pending', 'alice'), modelId: 'krea-2-test-beta' });
  queue.enqueue('local', { ...entry('later', 'alice'), modelId: 'krea-2-gonzalomo' });
  queue.enqueue('local', { ...entry('other', 'bob'), modelId: 'krea-2-gonzalomo' });
  queue.setPromptPreparation('pending', queue.currentEpoch(), 'pending');

  expect(queue.peekNext('local')?.batchId).toBe('other');
  expect(queue.positionOf('local', 'other')).toBe(0);
  expect(queue.positionOf('local', 'pending')).toBe(1);
  expect(queue.positionOf('local', 'later')).toBe(2);
  queue.removeById('local', 'other');
  expect(queue.peekNext('local')).toBeUndefined();
  expect(queue.positionOf('local', 'pending')).toBe(0);
  expect(queue.positionOf('local', 'later')).toBe(1);

  queue.setPromptPreparation('pending', queue.currentEpoch(), 'ready');
  expect(queue.peekNext('local')?.batchId).toBe('pending');
  queue.removeById('local', 'pending');
  expect(queue.peekNext('local')?.batchId).toBe('later');
});

test('canceling a pending head makes its same-user successor eligible', () => {
  queue.enqueue('local', entry('pending'));
  queue.enqueue('local', entry('next'));
  queue.setPromptPreparation('pending', queue.currentEpoch(), 'pending');
  expect(queue.peekNext('local')).toBeUndefined();
  queue.removeById('local', 'pending');
  expect(queue.peekNext('local')?.batchId).toBe('next');
  expect(queue.positionOf('local', 'next')).toBe(0);
});

test('local affinity picks another user\'s oldest matching model and projects dispatch positions', () => {
  const now = Date.now();
  queue.noteDispatched('local', 'krea-2-gonzalomo');
  queue.enqueue('local', { ...entry('h3'), modelId: 'minimax-h3-i2v', queuedAt: now });
  queue.enqueue('local', { ...entry('gonzalomo-1', 'u2'), modelId: 'krea-2-gonzalomo', queuedAt: now });
  queue.enqueue('local', { ...entry('gonzalomo-2', 'u2'), modelId: 'krea-2-gonzalomo', queuedAt: now });

  expect(queue.peekNext('local', now)?.batchId).toBe('gonzalomo-1');
  expect(queue.positionOf('local', 'gonzalomo-1', now)).toBe(0);
  expect(queue.positionOf('local', 'gonzalomo-2', now)).toBe(1);
  expect(queue.positionOf('local', 'h3', now)).toBe(2);
});

test('an entry passed over by affinity for the maximum wait is dispatched next', () => {
  const t0 = 1_000;
  queue.noteDispatched('local', 'krea-2-gonzalomo');
  queue.enqueue('local', { ...entry('h3'), modelId: 'minimax-h3-i2v' });
  queue.enqueue('local', { ...entry('gonzalomo-1', 'u2'), modelId: 'krea-2-gonzalomo' });
  queue.enqueue('local', { ...entry('gonzalomo-2', 'u2'), modelId: 'krea-2-gonzalomo' });

  const first = queue.peekNext('local', t0);
  if (!first) throw new Error('expected a pick');
  expect(first.batchId).toBe('gonzalomo-1');
  queue.noteDispatchedFromQueue('local', first, t0);
  queue.removeById('local', first.batchId);

  expect(queue.peekNext('local', t0 + 599_999)?.batchId).toBe('gonzalomo-2');
  expect(queue.peekNext('local', t0 + 600_000)?.batchId).toBe('h3');
  expect(queue.positionOf('local', 'gonzalomo-2', t0 + 600_000)).toBe(1);
});

test('queue age alone never trips the bound — only time passed over does', () => {
  queue.noteDispatched('local', 'krea-2-gonzalomo');
  queue.enqueue('local', { ...entry('h3'), modelId: 'minimax-h3-i2v', queuedAt: 0 });
  queue.enqueue('local', { ...entry('gonzalomo', 'u2'), modelId: 'krea-2-gonzalomo', queuedAt: 0 });

  expect(queue.peekNext('local', 10 * 600_000)?.batchId).toBe('gonzalomo');
});

test('a dispatch stamps every entry it jumped ahead of, not only the head', () => {
  const t0 = 0;
  queue.noteDispatched('local', 'krea-2-gonzalomo');
  queue.enqueue('local', { ...entry('h3-1'), modelId: 'minimax-h3-i2v' });
  queue.enqueue('local', { ...entry('h3-2'), modelId: 'minimax-h3-i2v' });
  queue.enqueue('local', { ...entry('gonzalomo', 'u2'), modelId: 'krea-2-gonzalomo' });

  const picked = queue.peekNext('local', t0);
  if (!picked) throw new Error('expected a pick');
  expect(picked.batchId).toBe('gonzalomo');
  queue.noteDispatchedFromQueue('local', picked, t0);
  queue.removeById('local', picked.batchId);
  // h3-1 is canceled; h3-2 becomes head with its own clock already running.
  queue.removeById('local', 'h3-1');
  queue.enqueue('local', { ...entry('gonzalomo-2', 'u2'), modelId: 'krea-2-gonzalomo' });

  expect(queue.peekNext('local', t0 + 1)?.batchId).toBe('gonzalomo-2');
  expect(queue.peekNext('local', t0 + 600_000)?.batchId).toBe('h3-2');
});

test('pending predecessors prevent ready tails from accruing affinity wait until eligible', () => {
  const t0 = 0;
  const maxWait = 600_000;
  queue.noteDispatched('local', 'krea-2-gonzalomo');
  queue.enqueue('local', { ...entry('alice-pending', 'alice'), modelId: 'minimax-h3-i2v' });
  queue.enqueue('local', { ...entry('alice-ready', 'alice'), modelId: 'minimax-h3-i2v' });
  queue.enqueue('local', { ...entry('bob-1', 'bob'), modelId: 'krea-2-gonzalomo' });
  queue.enqueue('local', { ...entry('bob-2', 'bob'), modelId: 'krea-2-gonzalomo' });
  queue.enqueue('local', { ...entry('bob-3', 'bob'), modelId: 'krea-2-gonzalomo' });
  queue.setPromptPreparation('alice-pending', queue.currentEpoch(), 'pending');
  queue.setPromptPreparation('alice-ready', queue.currentEpoch(), 'ready');

  const first = queue.peekNext('local', t0);
  if (!first) throw new Error('expected a pick');
  expect(first.batchId).toBe('bob-1');
  queue.noteDispatchedFromQueue('local', first, t0);
  queue.removeById('local', first.batchId);

  // Alice's ready tail was FIFO-blocked, so cancellation must not reveal an
  // expired starvation clock from Bob's earlier dispatch.
  const eligibleAt = t0 + maxWait + 1;
  queue.removeById('local', 'alice-pending');
  const second = queue.peekNext('local', eligibleAt);
  if (!second) throw new Error('expected a pick');
  expect(second.batchId).toBe('bob-2');
  expect(queue.positionOf('local', 'bob-2', eligibleAt)).toBe(0);
  queue.noteDispatchedFromQueue('local', second, eligibleAt);
  queue.removeById('local', second.batchId);

  // This real eligible pass-over starts the normal maximum-wait bound.
  expect(queue.peekNext('local', eligibleAt + maxWait - 1)?.batchId).toBe('bob-3');
  expect(queue.peekNext('local', eligibleAt + maxWait)?.batchId).toBe('alice-ready');
  expect(queue.positionOf('local', 'alice-ready', eligibleAt + maxWait)).toBe(0);
});

test('configureQueueScheduling drops the key derived under the previous mapping', () => {
  queue.noteDispatched('local', 'krea-2-gonzalomo');
  queue.configureQueueScheduling({ affinityKeyOf: (modelId) => modelId, maxHeadWaitMs: 600_000 });
  queue.enqueue('local', { ...entry('h3'), modelId: 'minimax-h3-i2v' });
  queue.enqueue('local', { ...entry('gonzalomo'), modelId: 'krea-2-gonzalomo' });

  expect(queue.peekNext('local')?.batchId).toBe('h3');
});

test('projected positions form a permutation with the matching group first', () => {
  const now = Date.now();
  const models = ['krea-2-gonzalomo', 'minimax-h3-i2v', 'krea-2-test-beta'];
  const total = 300;
  queue.noteDispatched('local', 'minimax-h3-i2v');
  for (let index = 0; index < total; index += 1) {
    const modelId = models[index % models.length];
    if (!modelId) throw new Error('unreachable');
    queue.enqueue('local', { ...entry(`b${String(index)}`, `u${String(index)}`), modelId, queuedAt: now });
  }

  const positions = new Set<number>();
  for (let index = 0; index < total; index += 1) {
    const position = queue.positionOf('local', `b${String(index)}`, now);
    positions.add(position);
    // Every H3 entry (index % 3 === 1) is dispatched before any other model.
    if (index % 3 === 1) expect(position).toBeLessThan(total / 3);
  }
  expect(positions.size).toBe(total);
  expect(Math.max(...positions)).toBe(total - 1);
  expect(queue.peekNext('local', now)?.batchId).toBe('b1');
});

test('local queue is FIFO without a prior dispatch', () => {
  queue.enqueue('local', { ...entry('first'), modelId: 'minimax-h3-i2v' });
  queue.enqueue('local', { ...entry('second'), modelId: 'krea-2-gonzalomo' });

  expect(queue.peekNext('local')?.batchId).toBe('first');
});

test('shared pool ignores local affinity', () => {
  queue.noteDispatched('local', 'krea-2-gonzalomo');
  queue.enqueue('shared', { ...entry('h3'), modelId: 'minimax-h3-i2v' });
  queue.enqueue('shared', { ...entry('gonzalomo'), modelId: 'krea-2-gonzalomo' });

  expect(queue.peekNext('shared')?.batchId).toBe('h3');
  expect(queue.positionOf('shared', 'h3')).toBe(0);
  expect(queue.positionOf('shared', 'gonzalomo')).toBe(1);
});

test('local affinity can group models by a shared residency key', () => {
  queue.configureQueueScheduling({
    affinityKeyOf: (modelId) => modelId.startsWith('minimax-h3-') ? 'minimax-h3' : modelId,
    maxHeadWaitMs: 600_000,
  });
  queue.noteDispatched('local', 'minimax-h3-i2v');
  queue.enqueue('local', { ...entry('gonzalomo'), modelId: 'krea-2-gonzalomo' });
  queue.enqueue('local', { ...entry('t2v', 'u2'), modelId: 'minimax-h3-t2v' });

  expect(queue.peekNext('local')?.batchId).toBe('t2v');
});

test('resetQueueForTests forgets the last dispatched local key', () => {
  queue.noteDispatched('local', 'krea-2-gonzalomo');
  queue.resetQueueForTests();
  queue.enqueue('local', { ...entry('h3'), modelId: 'minimax-h3-i2v' });
  queue.enqueue('local', { ...entry('gonzalomo'), modelId: 'krea-2-gonzalomo' });

  expect(queue.peekNext('local')?.batchId).toBe('h3');
});

test('removeById removes from any position', () => {
  queue.enqueue('shared', entry('a'));
  queue.enqueue('shared', entry('b'));
  queue.enqueue('shared', entry('c'));
  expect(queue.removeById('shared', 'b')).toBe(true);
  expect(queue.__queueTest.peekHead('shared')?.batchId).toBe('a');
  expect(queue.__queueTest.lengthOf('shared')).toBe(2);
  expect(queue.removeById('shared', 'missing')).toBe(false);
});

test('updateCount rewrites queued reservation and removes zero-count entries', () => {
  queue.enqueue('shared', { ...entry('a'), count: 2 });
  expect(queue.updateCount('shared', 'a', 1)).toBe(true);
  expect(queue.__queueTest.peekHead('shared')?.count).toBe(1);
  expect(queue.updateCount('shared', 'a', 0)).toBe(true);
  expect(queue.__queueTest.lengthOf('shared')).toBe(0);
});

test('rebuildFromDb loads queued rows ordered by created_at, id', () => {
  const db = new Database(':memory:');
  migrate(db, '/tmp');
  const now = Date.now();
  seedQueued(db, 'newer', now + 100);
  seedQueued(db, 'older', now);

  queue.rebuildFromDb(db);

  expect(queue.__queueTest.peekHead('shared')?.batchId).toBe('older');
  expect(queue.__queueTest.lengthOf('shared')).toBe(2);
});

test('rebuildFromDb does not resurrect an archived queued batch', () => {
  const db = new Database(':memory:');
  migrate(db, '/tmp');
  seedQueued(db, 'live', Date.now());
  seedQueued(db, 'archived', Date.now());
  db.run("UPDATE batches SET archived_at = ? WHERE id = 'archived'", [Date.now()]);

  queue.rebuildFromDb(db);

  expect(queue.__queueTest.lengthOf('shared')).toBe(1);
  expect(queue.__queueTest.peekHead('shared')?.batchId).toBe('live');
});

test('rebuildFromDb skips malformed rows and logs a warning', () => {
  const db = new Database(':memory:');
  migrate(db, '/tmp');
  const warns: unknown[] = [];
  db.run('PRAGMA ignore_check_constraints = ON');
  seedQueued(db, 'bad-pool', Date.now(), 'shared');
  db.run("UPDATE batches SET pool = 'bogus' WHERE id = 'bad-pool'");

  queue.rebuildFromDb(db, {
    warn: (payload) => { warns.push(payload); },
  });

  expect(queue.__queueTest.lengthOf('shared')).toBe(0);
  expect(warns).toContainEqual(expect.objectContaining({
    event: 'queue_rebuild_row_skipped',
    batchId: 'bad-pool',
  }));
});

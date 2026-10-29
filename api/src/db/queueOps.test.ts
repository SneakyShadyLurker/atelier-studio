import { beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Pool } from '@atelier/shared';
import { migrate } from './migrate';
import { countInflightVideoForUser, countQueuedForUser, transitionQueuedToRunning } from './queueOps';

function seedBatch(
  db: Database,
  id: string,
  userId: string,
  status: 'queued' | 'running' | 'done',
  pool: Pool = 'shared',
): void {
  db.run('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)', [userId, Date.now()]);
  db.run(
    `INSERT INTO batches (id, user_id, prompt, model_id, model_label, ratio, created_at, status, pool)
     VALUES (?, ?, 'p', 'gpt-image-2.5-sunburst', 'GPT Image 2.5 Sunburst', '1:1', ?, ?, ?)`,
    [id, userId, Date.now(), status, pool],
  );
}

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db, '/tmp');
});

test('transitionQueuedToRunning flips only queued batches and warns on illegal transitions', () => {
  seedBatch(db, 'b1', 'u1', 'queued');
  seedBatch(db, 'b2', 'u1', 'done');
  const warnings: unknown[] = [];

  const before = Date.now();
  const startedAt = transitionQueuedToRunning(db, 'b1', { warn: (payload) => { warnings.push(payload); } });
  expect(startedAt).toBeGreaterThanOrEqual(before);
  expect(transitionQueuedToRunning(db, 'b2', { warn: (payload) => { warnings.push(payload); } })).toBeNull();

  // The dispatch time is recorded on the row it returns for.
  expect(db.query<{ status: string; started_at: number | null }, []>("SELECT status, started_at FROM batches WHERE id='b1'").get())
    .toEqual({ status: 'running', started_at: startedAt });
  expect(db.query<{ status: string }, []>("SELECT status FROM batches WHERE id='b2'").get()?.status).toBe('done');
  expect(warnings).toContainEqual(expect.objectContaining({
    event: 'mark_running_skipped',
    batchId: 'b2',
  }));
});

test('countQueuedForUser counts only queued rows for that user', () => {
  seedBatch(db, 'b1', 'u1', 'queued');
  seedBatch(db, 'b2', 'u1', 'queued');
  seedBatch(db, 'b3', 'u1', 'running');
  seedBatch(db, 'b4', 'u2', 'queued');
  expect(countQueuedForUser(db, 'u1')).toBe(2);
});

test('transitionQueuedToRunning claims once and returns null when already claimed or missing (no logger, silent)', () => {
  seedBatch(db, 'b1', 'u1', 'queued');
  expect(transitionQueuedToRunning(db, 'b1')).toBeNumber();
  expect(transitionQueuedToRunning(db, 'b1')).toBeNull();
  expect(transitionQueuedToRunning(db, 'missing')).toBeNull();
  const row = db.query<{ status: string }, []>("SELECT status FROM batches WHERE id='b1'").get();
  expect(row?.status).toBe('running');
});

function seedStory(id: string, userId = 'u1', status = 'rendering'): void {
  db.run(`INSERT INTO stories (id,user_id,status,outline,logline,continuity_bible,ratio,eta_ms,created_at,updated_at)
    VALUES (?,?,?,'outline','logline','bible','16:9',1,1,1)`, [id, userId, status]);
}

function linkStory(storyId: string, userId: string, batchId: string, idx = 0): void {
  db.run(`INSERT INTO story_segments (story_id,user_id,idx,beat,duration_frames,batch_id,attempts)
    VALUES (?,?,?,'beat',124,?,1)`, [storyId, userId, idx, batchId]);
}

test('rendering stories reserve occupancy without batches, between segments, and with no current video IDs', () => {
  seedStory('reserved');
  seedStory('other', 'u2');
  seedStory('terminal', 'u1', 'done');
  expect(countInflightVideoForUser(db, 'u1', [])).toBe(1);
  seedBatch(db, 'done-segment', 'u1', 'done', 'local');
  db.run("UPDATE batches SET model_id='video' WHERE id='done-segment'");
  linkStory('reserved', 'u1', 'done-segment');
  expect(countInflightVideoForUser(db, 'u1', ['video'])).toBe(1);
});

test('a rendering story counts once with multiple linked active video batches; manual videos count separately', () => {
  seedStory('reserved');
  for (const [idx, id] of ['segment-a', 'segment-b', 'manual', 'other-user', 'image'].entries()) {
    seedBatch(db, id, id === 'other-user' ? 'u2' : 'u1', 'queued', 'local');
    if (id !== 'image') db.run("UPDATE batches SET model_id='video' WHERE id=?", [id]);
    if (idx < 2) linkStory('reserved', 'u1', id, idx);
  }
  expect(countInflightVideoForUser(db, 'u1', ['video'])).toBe(2);
  db.run("UPDATE stories SET status='canceled' WHERE id='reserved'");
  expect(countInflightVideoForUser(db, 'u1', ['video'])).toBe(3);
  db.run("UPDATE stories SET status='failed' WHERE id='reserved'");
  expect(countInflightVideoForUser(db, 'u1', ['video'])).toBe(3);
});

test('mismatched story and segment ownership cannot hide an owned active video batch', () => {
  seedStory('other-story', 'u2');
  seedBatch(db, 'owned-video', 'u1', 'running', 'local');
  db.run("UPDATE batches SET model_id='video' WHERE id='owned-video'");
  linkStory('other-story', 'u1', 'owned-video');
  expect(countInflightVideoForUser(db, 'u1', ['video'])).toBe(1);
  db.run("UPDATE story_segments SET user_id='u2'");
  expect(countInflightVideoForUser(db, 'u1', ['video'])).toBe(1);
});

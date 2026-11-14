import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPragmas } from './client';
import { migrate } from './migrate';
import { pruneStoriesWithoutBatches } from './stories';

type StoryStatus = 'rendering' | 'done' | 'failed' | 'canceled';

function setup(): Database {
  const db = new Database(':memory:');
  applyPragmas(db);
  migrate(db, mkdtempSync(join(tmpdir(), 'atelier-stories-')));
  db.run(`INSERT INTO users (id, created_at) VALUES ('alice', 1), ('bob', 1)`);
  return db;
}

function seedBatch(db: Database, userId: string): string {
  const batchId = crypto.randomUUID();
  db.query(
    `INSERT INTO batches
      (id, user_id, prompt, ratio, model_id, model_label, created_at, status, pool,
       duration_frames, context_frames)
     VALUES (?, ?, 'beat', '16:9', 'minimax-h3-t2v', 'H3', 1, 'done', 'local', 124, 0)`,
  ).run(batchId, userId);
  return batchId;
}

function seedStory(db: Database, userId: string, status: StoryStatus, batchIds: readonly (string | null)[]): string {
  const storyId = crypto.randomUUID();
  db.query(
    `INSERT INTO stories
      (id, user_id, status, outline, logline, continuity_bible, ratio, eta_ms, created_at, updated_at)
     VALUES (?, ?, ?, 'outline', 'logline', 'bible', '16:9', 1000, 1, 1)`,
  ).run(storyId, userId, status);
  batchIds.forEach((batchId, idx) => {
    db.query(
      `INSERT INTO story_segments (story_id, user_id, idx, beat, duration_frames, batch_id, attempts)
       VALUES (?, ?, ?, 'beat', 124, ?, 1)`,
    ).run(storyId, userId, idx, batchId);
  });
  return storyId;
}

function storyIds(db: Database): string[] {
  return db.query<{ id: string }, []>('SELECT id FROM stories ORDER BY id').all().map((row) => row.id);
}

function segmentCount(db: Database, storyId: string): number {
  return db.query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM story_segments WHERE story_id = ?')
    .get(storyId)?.n ?? 0;
}

describe('pruneStoriesWithoutBatches', () => {
  test('removes a finished story and its beats once every clip is gone', () => {
    const db = setup();
    const gone = seedBatch(db, 'alice');
    const story = seedStory(db, 'alice', 'done', [gone, null]);
    db.query('DELETE FROM batches WHERE id = ?').run(gone);

    expect(pruneStoriesWithoutBatches(db, 'alice')).toBe(1);
    expect(storyIds(db)).toEqual([]);
    expect(segmentCount(db, story)).toBe(0);
  });

  test('keeps a story while any of its clips still exists', () => {
    const db = setup();
    const gone = seedBatch(db, 'alice');
    const kept = seedBatch(db, 'alice');
    const story = seedStory(db, 'alice', 'canceled', [gone, kept]);
    db.query('DELETE FROM batches WHERE id = ?').run(gone);

    expect(pruneStoriesWithoutBatches(db, 'alice')).toBe(0);
    expect(storyIds(db)).toEqual([story]);
    expect(segmentCount(db, story)).toBe(2);
  });

  test('keeps a rendering story that has no clip yet', () => {
    const db = setup();
    const story = seedStory(db, 'alice', 'rendering', [null, null]);

    expect(pruneStoriesWithoutBatches(db)).toBe(0);
    expect(storyIds(db)).toEqual([story]);
  });

  test('removes a failed story that never rendered a clip', () => {
    const db = setup();
    seedStory(db, 'alice', 'failed', [null]);

    expect(pruneStoriesWithoutBatches(db)).toBe(1);
    expect(storyIds(db)).toEqual([]);
  });

  test('a user id limits the sweep to that user', () => {
    const db = setup();
    seedStory(db, 'alice', 'failed', [null]);
    const other = seedStory(db, 'bob', 'failed', [null]);

    expect(pruneStoriesWithoutBatches(db, 'alice')).toBe(1);
    expect(storyIds(db)).toEqual([other]);
    expect(pruneStoriesWithoutBatches(db)).toBe(1);
    expect(storyIds(db)).toEqual([]);
  });

  test("another user's batch with the same id does not keep a story", () => {
    const db = setup();
    const foreign = seedBatch(db, 'bob');
    seedStory(db, 'alice', 'done', [foreign]);

    expect(pruneStoriesWithoutBatches(db, 'alice')).toBe(1);
  });
});

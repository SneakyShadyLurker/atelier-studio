import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { renderedVideoFrames, VIDEO_CONTEXT_FRAMES } from '@atelier/shared';
import { testRuntime } from '../test/helpers';
import { estimateStoryEtaMs } from './videoEta';

function seedRate(db: Database, secondsPerFrame: number, createdAt: number): void {
  const batchId = crypto.randomUUID();
  const tileId = crypto.randomUUID();
  const frames = 124;
  db.query("INSERT OR IGNORE INTO users (id, created_at) VALUES ('alice', 1)").run();
  db.query(
    `INSERT INTO batches
      (id, user_id, prompt, ratio, model_id, model_label, created_at, status, pool,
       duration_frames, context_frames)
     VALUES (?, 'alice', 'video', '16:9', 'minimax-h3-t2v', 'H3', ?, 'done', 'local', ?, 0)`,
  ).run(batchId, createdAt, frames);
  db.query(
    `INSERT INTO tiles
      (id, batch_id, user_id, tile_index, seed, status, ext, mime, completed_at)
     VALUES (?, ?, 'alice', 0, 1, 'done', 'mp4', 'video/mp4', ?)`,
  ).run(tileId, batchId, createdAt + secondsPerFrame * frames * 1000);
}

describe('estimateStoryEtaMs', () => {
  test('uses the fallback rate when no completed video history exists', () => {
    const { db } = testRuntime();
    expect(estimateStoryEtaMs(db, [{ durationFrames: 124, isContinuation: false }]))
      .toBe(2 * 1000 * 124 + 45_000);
  });

  test('uses the median rate from recent single-tile video batches', () => {
    const { db } = testRuntime();
    seedRate(db, 1, 1_000);
    seedRate(db, 5, 2_000);
    seedRate(db, 3, 3_000);
    expect(estimateStoryEtaMs(db, [{ durationFrames: 124, isContinuation: false }]))
      .toBe(3 * 1000 * 124 + 45_000);
  });

  test('accounts for the rendered continuation head and grid overshoot', () => {
    const { db } = testRuntime();
    const rendered = renderedVideoFrames(124, VIDEO_CONTEXT_FRAMES);
    expect(estimateStoryEtaMs(db, [{ durationFrames: 124, isContinuation: true }]))
      .toBe(2 * 1000 * rendered + 45_000);
  });
});

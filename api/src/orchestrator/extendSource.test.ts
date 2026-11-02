import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VideoDurationFrames } from '@atelier/shared';
import { migrate } from '../db/migrate';
import type { ResolvedGenerateRequest } from '../orchestrator';
import { createBatch } from './createBatch';
import type { RegistryEntry } from '../providers/registry';
import { buildQueuedRequestForBatch } from './dispatch';
import { adoptStandaloneBatch, appendSegment } from '../db/sequences';
import { resolveExtendSource } from './extendSource';

function fakeRegistryEntry(): RegistryEntry {
  return {
    model: { id: 'minimax-h3-i2v', name: 'MiniMax H3 I2V', pool: 'local' },
  } as unknown as RegistryEntry;
}

function freshDb(): Database {
  const dataDir = mkdtempSync(join(tmpdir(), 'atelier-extend-src-'));
  const db = new Database(':memory:');
  migrate(db, dataDir);
  return db;
}

/** Seeds a finished video segment and the handoff upload cut from its last frame. */
function seedPredecessor(
  db: Database,
  opts: { durationFrames: VideoDurationFrames; contextFrames: number; uploadId: string },
): { tileId: string; batchId: string } {
  const req: ResolvedGenerateRequest = {
    prompt: 'walk',
    modelId: 'minimax-h3-i2v',
    ratio: '16:9',
    count: 1,
    durationFrames: opts.durationFrames,
  };
  const prepared = createBatch(db, 'u1', req, fakeRegistryEntry());
  const tileId = prepared.tiles[0]?.id ?? '';
  db.query("UPDATE batches SET status = 'done', context_frames = ? WHERE id = ?")
    .run(opts.contextFrames, prepared.batch.id);
  db.query("UPDATE tiles SET status = 'done', ext = 'mp4', mime = 'video/mp4' WHERE id = ?")
    .run(tileId);
  db.query(
    `INSERT INTO uploads (id, user_id, ext, mime, size_bytes, width, height, sha256, created_at, source_tile_id)
     VALUES (?, 'u1', 'png', 'image/png', 10, 8, 8, 'sha', 1, ?)`,
  ).run(opts.uploadId, tileId);
  return { tileId, batchId: prepared.batch.id };
}

describe('resolveExtendSource', () => {
  test('recovers the predecessor from the persisted upload, with no extendsTileId', () => {
    const db = freshDb();
    const { tileId } = seedPredecessor(db, { durationFrames: 124, contextFrames: 0, uploadId: 'up1' });

    const source = resolveExtendSource(db, 'u1', 'up1');
    expect(source?.tileId).toBe(tileId);
    // A first segment delivers exactly what was rendered.
    expect(source?.endFrame).toBe(124);
  });

  test('cuts back from the DELIVERED end of a guided predecessor, not its file end', () => {
    const db = freshDb();
    seedPredecessor(db, { durationFrames: 124, contextFrames: 22, uploadId: 'up1' });
    // Rendered 158 on disk, but frames 146..157 were dropped by the stitcher.
    expect(resolveExtendSource(db, 'u1', 'up1')?.endFrame).toBe(146);
  });

  test('a QUEUED extension keeps everything the continuation needs', () => {
    // Regression guard: `extendsTileId` lives only on the request built by
    // POST /api/generate. The local pool is serialized, so an Extend submitted
    // while another local render is in flight is rebuilt from its row instead —
    // and the continuation must survive that rebuild.
    const db = freshDb();
    const predecessor = seedPredecessor(db, { durationFrames: 124, contextFrames: 0, uploadId: 'up1' });

    const extension = createBatch(db, 'u1', {
      prompt: 'keep walking',
      modelId: 'minimax-h3-i2v',
      ratio: '16:9',
      count: 1,
      durationFrames: 124,
      i2vSourceUploadId: 'up1',
      extendsTileId: 'ignored-on-the-queued-path',
    }, fakeRegistryEntry());
    expect(resolveExtendSource(db, 'u1', 'up1', extension.batch.id)).toBeNull();
    const adopted = adoptStandaloneBatch(db, 'u1', predecessor.batchId);
    if (adopted.status !== 'ok') throw new Error('expected sequence adoption');
    expect(appendSegment(db, { error: () => undefined }, 'u1', adopted.sequenceId, predecessor.batchId, extension.batch.id).status).toBe('ok');

    const rebuilt = buildQueuedRequestForBatch(db, {
      batch: extension.batch,
      tiles: extension.tiles,
    });
    expect(rebuilt.extendsTileId).toBeUndefined();
    // ...yet the predecessor is still reachable, which is the whole point.
    expect(resolveExtendSource(db, 'u1', rebuilt.i2vSourceUploadId ?? null)).not.toBeNull();
    expect(resolveExtendSource(db, 'u1', rebuilt.i2vSourceUploadId ?? null, extension.batch.id)?.tileId).toBe(predecessor.tileId);
    expect(resolveExtendSource(db, 'u1', 'up1', predecessor.batchId)).toBeNull();
    expect(resolveExtendSource(db, 'someone-else', 'up1', extension.batch.id)).toBeNull();
  });

  test('returns null for a plain i2v job and for an unknown upload', () => {
    const db = freshDb();
    seedPredecessor(db, { durationFrames: 124, contextFrames: 0, uploadId: 'handoff' });
    // A user-supplied still has no source_tile_id, so it is not a continuation.
    db.query(
      `INSERT INTO uploads (id, user_id, ext, mime, size_bytes, width, height, sha256, created_at, source_tile_id)
       VALUES ('plain', 'u1', 'png', 'image/png', 10, 8, 8, 'sha', 1, NULL)`,
    ).run();
    expect(resolveExtendSource(db, 'u1', 'plain')).toBeNull();
    expect(resolveExtendSource(db, 'u1', 'missing')).toBeNull();
    expect(resolveExtendSource(db, 'u1', null)).toBeNull();
  });

  test('does not leak another user\'s segment', () => {
    const db = freshDb();
    seedPredecessor(db, { durationFrames: 124, contextFrames: 0, uploadId: 'up1' });
    expect(resolveExtendSource(db, 'someone-else', 'up1')).toBeNull();
  });
});

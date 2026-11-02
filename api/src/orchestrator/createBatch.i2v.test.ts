import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from '../db/migrate';
import type { ResolvedGenerateRequest } from '../orchestrator';
import { createBatch } from './createBatch';
import type { RegistryEntry } from '../providers/registry';
import { buildQueuedRequestForBatch } from './dispatch';

function fakeRegistryEntry(): RegistryEntry {
  return {
    model: { id: 'minimax-h3-i2v', name: 'MiniMax H3 I2V', pool: 'local' },
  } as unknown as RegistryEntry;
}

describe('createBatch — i2v source persistence', () => {
  test('persists the source upload id and motion prompt on the batch', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-i2v-batch-'));
    const db = new Database(':memory:');
    migrate(db, dataDir);

    const req: ResolvedGenerateRequest = {
      prompt: 'animate',
      modelId: 'minimax-h3-i2v',
      ratio: '16:9',
      count: 1,
      i2vSourceUploadId: 'up1',
      motionPrompt: 'slow push in',
    };
    const prepared = createBatch(db, 'u1', req, fakeRegistryEntry());

    const row = db
      .query<{ i2v_source_upload_id: string | null; motion_prompt: string | null }, [string]>(
        'SELECT i2v_source_upload_id, motion_prompt FROM batches WHERE id = ?',
      )
      .get(prepared.batch.id);
    expect(row).toMatchObject({ i2v_source_upload_id: 'up1', motion_prompt: 'slow push in' });
    expect(prepared.batch.i2v_source_upload_id).toBe('up1');
    expect(prepared.batch.motion_prompt).toBe('slow push in');

    db.close();
  });

  test('rebuilds queued generate requests with the source upload id and motion prompt', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-i2v-requeue-'));
    const db = new Database(':memory:');
    migrate(db, dataDir);

    const prepared = createBatch(
      db,
      'u1',
      {
        prompt: 'animate',
        modelId: 'minimax-h3-i2v',
        ratio: '16:9',
        count: 1,
        i2vSourceUploadId: 'up1',
        motionPrompt: 'slow push in',
      },
      fakeRegistryEntry(),
    );

    const request = buildQueuedRequestForBatch(db, prepared);

    expect(request).toMatchObject({
      prompt: 'animate',
      modelId: 'minimax-h3-i2v',
      ratio: '16:9',
      count: 1,
      i2vSourceUploadId: 'up1',
      motionPrompt: 'slow push in',
    });

    db.close();
  });

  test('falls back to the model default when a pre-0034 batch carries a NULL duration', () => {
    // Migration 0034 leaves duration_frames NULL on every pre-existing row, and
    // queue.rebuildFromDb re-enqueues queued batches verbatim at boot. Without
    // the fallback the rebuilt request omits durationFrames and buildWorkflow
    // throws 'videoFrames is required', killing a render the user already
    // queued. Reproduced end-to-end before the fix.
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-i2v-legacy-duration-'));
    const db = new Database(':memory:');
    migrate(db, dataDir);

    const prepared = createBatch(
      db,
      'u1',
      { prompt: 'animate', modelId: 'minimax-h3-i2v', ratio: '16:9', count: 1, motionPrompt: 'she turns' },
      fakeRegistryEntry(),
    );
    db.query('UPDATE batches SET duration_frames = NULL WHERE id = ?').run(prepared.batch.id);
    const legacy = { ...prepared, batch: { ...prepared.batch, duration_frames: null } };

    const videoModel = { id: 'minimax-h3-i2v', supportedDurations: [124, 243, 362], defaultDuration: 124 } as unknown as RegistryEntry['model'];
    expect(buildQueuedRequestForBatch(db, legacy, videoModel).durationFrames).toBe(124);

    // A persisted grid point always wins over the default.
    const explicit = { ...prepared, batch: { ...prepared.batch, duration_frames: 362 } };
    expect(buildQueuedRequestForBatch(db, explicit, videoModel).durationFrames).toBe(362);

    // Image models declare no durations, so nothing is invented for them.
    const imageModel = { id: 'gpt-image-2.5-sunburst' } as unknown as RegistryEntry['model'];
    expect(buildQueuedRequestForBatch(db, legacy, imageModel).durationFrames).toBeUndefined();

    db.close();
  });
});

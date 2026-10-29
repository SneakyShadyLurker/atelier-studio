import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { existsSync, unlinkSync } from 'node:fs';
import { adoptStandaloneBatch, appendSegment, markReady } from '../db/sequences';
import { resetStitchQueueForTests, waitForStitchQueueIdle } from '../orchestrator/stitchQueue';
import { setLastFrameRunnerForTests } from '../storage/lastFrame';
import { writeAtomic, writeAtomicPublishThenCommit } from '../storage/files';
import { resetDecryptedVideoCacheForTests } from '../storage/decryptedVideoCache';
import { storageKeyring } from '../storage/crypto';
import { jsonRequest, testRuntime } from '../test/helpers';
import { pngBytes } from '../test/image-fixtures';
import { setBeforeTailMutationForTests } from './sequences';

afterEach(async () => {
  await waitForStitchQueueIdle();
  resetStitchQueueForTests();
  setLastFrameRunnerForTests(null);
  setBeforeTailMutationForTests(null);
  resetDecryptedVideoCacheForTests();
});

interface SeededSequence {
  readonly id: string;
  readonly batches: readonly [string, string];
  readonly tiles: readonly [string, string];
}

function videoRuntime(overrides: Record<string, unknown> = {}) {
  return testRuntime({
    COMFYUI_BASE_URL: 'http://127.0.0.1:1',
    VIDEO_MODELS_ENABLED: 'true',
    LOCAL_MODELS_USERS: 'alice',
    availability: new Map([
      ['minimax-h3-i2v', { ok: true as const, checkedAt: Date.now() }],
    ]),
    ...overrides,
  });
}

async function seedSequence(
  db: Database,
  dataDir: string,
  userId = 'alice',
): Promise<SeededSequence> {
  const batches = [crypto.randomUUID(), crypto.randomUUID()] as const;
  const tiles = [crypto.randomUUID(), crypto.randomUUID()] as const;
  db.query('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, 1)').run(userId);
  const insertBatch = db.query(
    `INSERT INTO batches
      (id, user_id, prompt, ratio, model_id, model_label, created_at, status, pool, duration_frames)
     VALUES (?, ?, ?, '16:9', 'minimax-h3-i2v', 'MiniMax H3', ?, 'done', 'local', 124)`,
  );
  const insertTile = db.query(
    `INSERT INTO tiles
      (id, batch_id, user_id, tile_index, seed, status, ext, mime, completed_at)
     VALUES (?, ?, ?, 0, 1, 'done', 'mp4', 'video/mp4', 1)`,
  );
  for (let index = 0; index < 2; index++) {
    const batchId = batches[index];
    const tileId = tiles[index];
    if (!batchId || !tileId) throw new Error('missing seed id');
    insertBatch.run(batchId, userId, `part ${index}`, index + 1);
    insertTile.run(tileId, batchId, userId);
    await writeAtomic(dataDir, 'images', userId, tileId, 'mp4', new Uint8Array([0, 1, 2]));
  }
  const adopted = adoptStandaloneBatch(db, userId, batches[0]);
  if (adopted.status !== 'ok') throw new Error('expected adoption');
  const appended = appendSegment(db, { error: () => undefined }, userId, adopted.sequenceId, batches[0], batches[1]);
  if (appended.status !== 'ok') throw new Error('expected append');
  return { id: adopted.sequenceId, batches, tiles };
}

async function seedHandoffUpload(
  db: Database,
  dataDir: string,
  tileId: string,
  userId = 'alice',
): Promise<string> {
  const uploadId = crypto.randomUUID();
  const bytes = pngBytes();
  db.query(
    `INSERT INTO uploads
      (id, user_id, ext, mime, size_bytes, width, height, sha256, created_at, source_tile_id)
     VALUES (?, ?, 'png', 'image/png', ?, 64, 64, ?, 1, ?)`,
  ).run(uploadId, userId, bytes.byteLength, `sha-${uploadId}`, tileId);
  await writeAtomic(dataDir, 'uploads', userId, uploadId, 'png', bytes);
  return uploadId;
}

function extensionBody(tileId: string, uploadId: string): Record<string, unknown> {
  return {
    prompt: 'continue',
    modelId: 'minimax-h3-i2v',
    ratio: '16:9',
    count: 1,
    motionPrompt: 'continue',
    extendsTileId: tileId,
    i2vSourceUploadId: uploadId,
  };
}

describe('video sequence routes and submit validation', () => {
  test('warming the old master after append cannot poison the next publication', async () => {
    const runtime = videoRuntime();
    const seeded = await seedSequence(runtime.db, runtime.config.DATA_DIR);
    const oldBytes = new Uint8Array([9, 8, 7]);
    const newBytes = new Uint8Array([6, 5, 4]);
    await writeAtomicPublishThenCommit(runtime.config.DATA_DIR, 'images', 'alice', seeded.id, 'mp4', oldBytes,
      () => markReady(runtime.db, seeded.id, 2, 100));
    const tail = crypto.randomUUID();
    runtime.db.query(`INSERT INTO batches
      (id, user_id, prompt, ratio, model_id, model_label, created_at, status, pool, duration_frames)
      VALUES (?, 'alice', 'tail', '16:9', 'minimax-h3-i2v', 'MiniMax H3', 3, 'queued', 'local', 124)`).run(tail);
    expect(appendSegment(runtime.db, runtime.logger, 'alice', seeded.id, seeded.batches[1], tail).status).toBe('ok');
    const read = () => runtime.app.fetch(new Request(`http://local/api/sequences/${seeded.id}/master`, {
      headers: { 'Remote-User': 'alice' },
    }));
    const master = await read();
    expect(master.headers.get('Cache-Control')).toBe('private, no-store');
    expect(new Uint8Array(await master.arrayBuffer())).toEqual(oldBytes);
    await writeAtomicPublishThenCommit(runtime.config.DATA_DIR, 'images', 'alice', seeded.id, 'mp4', newBytes,
      () => markReady(runtime.db, seeded.id, 3, 100));
    expect(new Uint8Array(await (await read()).arrayBuffer())).toEqual(newBytes);
    expect(runtime.db.query('SELECT master_updated_at FROM video_sequences WHERE id = ?').get(seeded.id))
      .toEqual({ master_updated_at: 101 });
  });

  test('a master published during asynchronous cache materialization rejects the old read', async () => {
    const runtime = videoRuntime();
    const seeded = await seedSequence(runtime.db, runtime.config.DATA_DIR);
    await writeAtomicPublishThenCommit(runtime.config.DATA_DIR, 'images', 'alice', seeded.id, 'mp4', new Uint8Array([1, 2, 3]),
      () => markReady(runtime.db, seeded.id, 2, 100));
    const keyring = await storageKeyring();
    const originalRead = keyring.decryptFile.bind(keyring);
    let materializing: () => void = () => undefined;
    let release: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { materializing = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const readSpy = spyOn(keyring, 'decryptFile').mockImplementation(async (...args) => {
      const artifact = await originalRead(...args);
      materializing();
      await gate;
      return artifact;
    });
    try {
      const pendingRead = runtime.app.fetch(new Request(`http://local/api/sequences/${seeded.id}/master`, {
        headers: { 'Remote-User': 'alice' },
      }));
      await started;
      const newBytes = new Uint8Array([4, 5, 6]);
      await writeAtomicPublishThenCommit(runtime.config.DATA_DIR, 'images', 'alice', seeded.id, 'mp4', newBytes,
        () => markReady(runtime.db, seeded.id, 2, 100));
      release();
      expect((await pendingRead).status).toBe(503);
      const current = await runtime.app.fetch(new Request(`http://local/api/sequences/${seeded.id}/master`, {
        headers: { 'Remote-User': 'alice' },
      }));
      expect(new Uint8Array(await current.arrayBuffer())).toEqual(newBytes);
    } finally {
      release();
      readSpy.mockRestore();
    }
  });

  test('all sequence routes are leak-safe 404s when video models are disabled', async () => {
    const runtime = testRuntime();
    const id = crypto.randomUUID();
    for (const [method, path] of [
      ['POST', `/api/tiles/${id}/handoff-frame`],
      ['GET', `/api/sequences/${id}/master`],
      ['DELETE', `/api/sequences/${id}/tail`],
    ] as const) {
      const response = await runtime.app.fetch(new Request(`http://local${path}`, {
        method,
        headers: { 'Remote-User': 'alice' },
      }));
      expect(response.status).toBe(404);
    }
  });

  test('cross-user sequence reads/actions and handoff extraction return 404', async () => {
    const runtime = videoRuntime();
    const seeded = await seedSequence(runtime.db, runtime.config.DATA_DIR);
    for (const [method, path] of [
      ['POST', `/api/tiles/${seeded.tiles[1]}/handoff-frame`],
      ['GET', `/api/sequences/${seeded.id}/master`],
      ['DELETE', `/api/sequences/${seeded.id}/tail`],
    ] as const) {
      const response = await runtime.app.fetch(new Request(`http://local${path}`, {
        method,
        headers: { 'Remote-User': 'bob' },
      }));
      expect(response.status).toBe(404);
    }
  });

  test('handoff returns 404 when the owned done-video artifact is missing', async () => {
    const runtime = videoRuntime();
    const seeded = await seedSequence(runtime.db, runtime.config.DATA_DIR);
    unlinkSync(`${runtime.config.DATA_DIR}/images/alice/${seeded.tiles[1]}.mp4`);
    const response = await runtime.app.fetch(new Request(
      `http://local/api/tiles/${seeded.tiles[1]}/handoff-frame`,
      { method: 'POST', headers: { 'Remote-User': 'alice' } },
    ));
    expect(response.status).toBe(404);
  });

  test('submit rejects a non-tail source with 409 not-tail', async () => {
    const runtime = videoRuntime();
    const seeded = await seedSequence(runtime.db, runtime.config.DATA_DIR);
    const uploadId = await seedHandoffUpload(runtime.db, runtime.config.DATA_DIR, seeded.tiles[0]);
    const response = await jsonRequest(
      runtime.app,
      '/api/generate',
      extensionBody(seeded.tiles[0], uploadId),
      'alice',
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'not-tail' });
  });

  test('submit rejects a sequence at MAX_SEQUENCE_SEGMENTS', async () => {
    const runtime = videoRuntime({ MAX_SEQUENCE_SEGMENTS: '2' });
    const seeded = await seedSequence(runtime.db, runtime.config.DATA_DIR);
    const uploadId = await seedHandoffUpload(runtime.db, runtime.config.DATA_DIR, seeded.tiles[1]);
    const response = await jsonRequest(
      runtime.app,
      '/api/generate',
      extensionBody(seeded.tiles[1], uploadId),
      'alice',
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'sequence-full' });
  });

  test('submit rejects provenance mismatch with 400', async () => {
    const runtime = videoRuntime();
    const seeded = await seedSequence(runtime.db, runtime.config.DATA_DIR);
    const uploadId = await seedHandoffUpload(runtime.db, runtime.config.DATA_DIR, seeded.tiles[0]);
    const response = await jsonRequest(
      runtime.app,
      '/api/generate',
      extensionBody(seeded.tiles[1], uploadId),
      'alice',
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'provenance-mismatch' });
  });

  test('submit rejects a ratio that differs from the sequence', async () => {
    const runtime = videoRuntime();
    const seeded = await seedSequence(runtime.db, runtime.config.DATA_DIR);
    const uploadId = await seedHandoffUpload(runtime.db, runtime.config.DATA_DIR, seeded.tiles[1]);
    const response = await jsonRequest(
      runtime.app,
      '/api/generate',
      { ...extensionBody(seeded.tiles[1], uploadId), ratio: '1:1' },
      'alice',
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'validation failed',
      issues: [{ path: ['ratio'], message: 'ratio must match sequence' }],
    });
  });

  test('submit rejects extendsTileId for a model without I2V capability', async () => {
    const runtime = videoRuntime({
      availability: new Map([
        ['minimax-h3-t2v', { ok: true as const, checkedAt: Date.now() }],
      ]),
    });
    const seeded = await seedSequence(runtime.db, runtime.config.DATA_DIR);
    const response = await jsonRequest(runtime.app, '/api/generate', {
      prompt: 'continue',
      modelId: 'minimax-h3-t2v',
      ratio: '16:9',
      count: 1,
      extendsTileId: seeded.tiles[1],
    }, 'alice');
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'validation failed',
      issues: [{ path: ['extendsTileId'], message: 'model does not support video extension' }],
    });
  });

  test('tail discard returns 409 while a linked batch is queued or running', async () => {
    const runtime = videoRuntime();
    const seeded = await seedSequence(runtime.db, runtime.config.DATA_DIR);
    runtime.db.query("UPDATE batches SET status = 'running' WHERE id = ?").run(seeded.batches[1]);
    const response = await runtime.app.fetch(new Request(
      `http://local/api/sequences/${seeded.id}/tail`,
      { method: 'DELETE', headers: { 'Remote-User': 'alice' } },
    ));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'sequence-in-flight' });
  });

  test('tail discard sees a queued append that links immediately before its transaction', async () => {
    const runtime = videoRuntime();
    const seeded = await seedSequence(runtime.db, runtime.config.DATA_DIR);
    const queuedBatchId = crypto.randomUUID();
    const queuedTileId = crypto.randomUUID();
    runtime.db.query(
      `INSERT INTO batches
        (id, user_id, prompt, ratio, model_id, model_label, created_at, status, pool, duration_frames)
       VALUES (?, 'alice', 'queued tail', '16:9', 'minimax-h3-i2v', 'MiniMax H3', 3, 'queued', 'local', 124)`,
    ).run(queuedBatchId);
    runtime.db.query(
      `INSERT INTO tiles
        (id, batch_id, user_id, tile_index, seed, status)
       VALUES (?, ?, 'alice', 0, 1, 'loading')`,
    ).run(queuedTileId, queuedBatchId);
    setBeforeTailMutationForTests(() => {
      setBeforeTailMutationForTests(null);
      const appended = appendSegment(
        runtime.db,
        runtime.logger,
        'alice',
        seeded.id,
        seeded.batches[1],
        queuedBatchId,
      );
      if (appended.status !== 'ok') throw new Error('expected interleaved append');
    });

    const response = await runtime.app.fetch(new Request(
      `http://local/api/sequences/${seeded.id}/tail`,
      { method: 'DELETE', headers: { 'Remote-User': 'alice' } },
    ));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'sequence-in-flight' });
    expect(runtime.db.query<{ count: number }, [string]>(
      'SELECT COUNT(*) AS count FROM batches WHERE sequence_id = ?',
    ).get(seeded.id)?.count).toBe(3);
    expect(runtime.db.query<{ sequence_id: string | null; sequence_index: number | null }, [string]>(
      'SELECT sequence_id, sequence_index FROM batches WHERE id = ?',
    ).get(queuedBatchId)).toEqual({ sequence_id: seeded.id, sequence_index: 2 });
  });

  test('tail discard dissolves a sequence when only one segment would remain', async () => {
    const runtime = videoRuntime();
    const seeded = await seedSequence(runtime.db, runtime.config.DATA_DIR);
    const masterPath = `${runtime.config.DATA_DIR}/images/alice/${seeded.id}.mp4`;
    await writeAtomic(
      runtime.config.DATA_DIR,
      'images',
      'alice',
      seeded.id,
      'mp4',
      new Uint8Array([9, 8, 7]),
    );
    const response = await runtime.app.fetch(new Request(
      `http://local/api/sequences/${seeded.id}/tail`,
      { method: 'DELETE', headers: { 'Remote-User': 'alice' } },
    ));
    expect(response.status).toBe(204);
    expect(runtime.db.query('SELECT id FROM video_sequences WHERE id = ?').get(seeded.id)).toBeNull();
    expect(runtime.db.query<{ count: number }, [string, string]>(
      'SELECT COUNT(*) AS count FROM batches WHERE id IN (?, ?) AND sequence_id IS NOT NULL',
    ).get(...seeded.batches)?.count).toBe(0);
    expect(existsSync(masterPath)).toBe(false);
  });
});

import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { testRuntime } from './helpers';
import { pngBytes } from './image-fixtures';
import { startupReconcile } from '../lifecycle/startup-reconcile';

type Runtime = ReturnType<typeof testRuntime>;
type TileStatus = 'done' | 'failed';

const USER = 'alice';
const headers = { 'Remote-User': USER };

async function uploadRef(runtime: Runtime, userId = USER): Promise<string> {
  const form = new FormData();
  form.set('file', new File([pngBytes()], 'ref.png', { type: 'image/png' }));
  const res = await runtime.fetch('/api/uploads', { method: 'POST', headers: { 'Remote-User': userId }, body: form });
  expect(res.status).toBe(201);
  return (await res.json() as { id: string }).id;
}

function seedThread(
  runtime: Runtime,
  options: { refs?: readonly string[]; i2vSource?: string; status?: TileStatus; archivedAt?: number; userId?: string } = {},
): { batchId: string; tileId: string } {
  const now = Date.now();
  const userId = options.userId ?? USER;
  const batchId = crypto.randomUUID();
  const tileId = crypto.randomUUID();
  const status = options.status ?? 'done';
  runtime.db.query('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)').run(userId, now);
  runtime.db
    .query(`INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, status, archived_at, i2v_source_upload_id)
            VALUES (?, ?, 'p', '1:1', 'mock-fast', 'Mock Fast', ?, 'done', ?, ?)`)
    .run(batchId, userId, now, options.archivedAt ?? null, options.i2vSource ?? null);
  runtime.db
    .query(`INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, ext, mime, completed_at, archived_at, error)
            VALUES (?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?)`)
    .run(
      tileId,
      batchId,
      userId,
      status,
      status === 'done' ? 'png' : null,
      status === 'done' ? 'image/png' : null,
      now,
      options.archivedAt ?? null,
      status === 'failed' ? 'internal error' : null,
    );
  (options.refs ?? []).forEach((uploadId, position) => {
    runtime.db.query('INSERT INTO tile_ref_images (tile_id, upload_id, position) VALUES (?, ?, ?)').run(tileId, uploadId, position);
  });
  return { batchId, tileId };
}

function uploadExists(runtime: Runtime, uploadId: string, userId = USER): { row: boolean; file: boolean } {
  const row = runtime.db.query<{ one: number }, [string]>('SELECT 1 AS one FROM uploads WHERE id = ?').get(uploadId) !== null;
  return { row, file: existsSync(join(runtime.config.DATA_DIR, 'uploads', userId, `${uploadId}.png`)) };
}

const gone = { row: false, file: false };
const kept = { row: true, file: true };

describe('reference uploads live exactly as long as their threads', () => {
  test('hard-deleting a thread releases its reference and I2V source uploads', async () => {
    const runtime = testRuntime();
    const ref = await uploadRef(runtime);
    const source = await uploadRef(runtime);
    const { batchId } = seedThread(runtime, { refs: [ref], i2vSource: source, status: 'failed' });
    expect(uploadExists(runtime, ref)).toEqual(kept);

    const res = await runtime.fetch(`/api/history/${batchId}`, { method: 'DELETE', headers });

    expect(res.status).toBe(204);
    expect(uploadExists(runtime, ref)).toEqual(gone);
    expect(uploadExists(runtime, source)).toEqual(gone);
  });

  test('a soft-archived thread keeps its uploads until the archive copy is purged', async () => {
    const runtime = testRuntime();
    const ref = await uploadRef(runtime);
    const { batchId, tileId } = seedThread(runtime, { refs: [ref] });

    await runtime.fetch(`/api/history/${batchId}`, { method: 'DELETE', headers });
    expect(uploadExists(runtime, ref)).toEqual(kept);

    const res = await runtime.fetch(`/api/archive/${tileId}`, { method: 'DELETE', headers });
    expect(res.status).toBe(204);
    expect(uploadExists(runtime, ref)).toEqual(gone);
  });

  test('an upload another thread still uses survives', async () => {
    const runtime = testRuntime();
    const ref = await uploadRef(runtime);
    const { batchId } = seedThread(runtime, { refs: [ref], status: 'failed' });
    seedThread(runtime, { refs: [ref] });

    await runtime.fetch(`/api/history/${batchId}`, { method: 'DELETE', headers });

    expect(uploadExists(runtime, ref)).toEqual(kept);
  });

  test('keepUploads holds uploads the composer still has attached', async () => {
    const runtime = testRuntime();
    const held = await uploadRef(runtime);
    const released = await uploadRef(runtime);
    const { batchId } = seedThread(runtime, { refs: [held, released], status: 'failed' });

    const res = await runtime.fetch(`/api/history/${batchId}?keepUploads=${held}`, { method: 'DELETE', headers });

    expect(res.status).toBe(204);
    expect(uploadExists(runtime, held)).toEqual(kept);
    expect(uploadExists(runtime, released)).toEqual(gone);
  });

  test('keepUploads must be a UUID list', async () => {
    const runtime = testRuntime();
    const { batchId } = seedThread(runtime, { status: 'failed' });

    const res = await runtime.fetch(`/api/history/${batchId}?keepUploads=not-a-uuid`, { method: 'DELETE', headers });

    expect(res.status).toBe(400);
  });

  test('tile delete, bulk history delete and archive purge all release', async () => {
    const runtime = testRuntime();
    const tileRef = await uploadRef(runtime);
    const bulkRef = await uploadRef(runtime);
    const archiveRef = await uploadRef(runtime);
    const tileThread = seedThread(runtime, { refs: [tileRef], status: 'failed' });
    seedThread(runtime, { refs: [bulkRef], status: 'failed' });
    seedThread(runtime, { refs: [archiveRef], archivedAt: Date.now() });

    await runtime.fetch(`/api/history/${tileThread.batchId}/${tileThread.tileId}`, { method: 'DELETE', headers });
    expect(uploadExists(runtime, tileRef)).toEqual(gone);

    await runtime.fetch('/api/history', { method: 'DELETE', headers });
    expect(uploadExists(runtime, bulkRef)).toEqual(gone);
    expect(uploadExists(runtime, archiveRef)).toEqual(kept);

    await runtime.fetch('/api/archive', { method: 'DELETE', headers });
    expect(uploadExists(runtime, archiveRef)).toEqual(gone);
  });

  test("deletes never release another user's upload", async () => {
    const runtime = testRuntime();
    const bobRef = await uploadRef(runtime, 'bob');
    const { batchId } = seedThread(runtime, { refs: [bobRef], status: 'failed', userId: 'bob' });

    await runtime.fetch(`/api/history/${batchId}`, { method: 'DELETE', headers });
    await runtime.fetch('/api/history', { method: 'DELETE', headers });

    expect(uploadExists(runtime, bobRef, 'bob')).toEqual(kept);
  });

  test('a rendering story keeps its source upload after segment 1 is deleted', async () => {
    const runtime = testRuntime();
    const source = await uploadRef(runtime);
    const { batchId } = seedThread(runtime, { i2vSource: source, status: 'failed' });
    const now = Date.now();
    runtime.db
      .query(`INSERT INTO stories (id, user_id, status, outline, logline, continuity_bible, ratio, source_upload_id, eta_ms, created_at, updated_at)
              VALUES (?, ?, 'rendering', 'o', 'l', 'b', '16:9', ?, 0, ?, ?)`)
      .run(crypto.randomUUID(), USER, source, now, now);

    await runtime.fetch(`/api/history/${batchId}`, { method: 'DELETE', headers });

    expect(uploadExists(runtime, source)).toEqual(kept);
  });

  test('the boot archive purge releases expired threads’ uploads', async () => {
    const runtime = testRuntime();
    const ref = await uploadRef(runtime);
    seedThread(runtime, { refs: [ref], archivedAt: 1 });

    startupReconcile(runtime.db, runtime.config.DATA_DIR, runtime.logger, {
      uploadTtlMs: runtime.config.UPLOAD_TTL_MS,
      orphanThreshold: runtime.config.RECONCILE_ORPHAN_THRESHOLD,
      force: false,
      dbIntegrityOk: true,
    });

    expect(uploadExists(runtime, ref)).toEqual(gone);
  });
});

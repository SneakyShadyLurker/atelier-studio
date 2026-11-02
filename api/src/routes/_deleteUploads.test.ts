import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { MAX_DELETE_KEEP_UPLOADS } from '@atelier/shared';
import type { AppEnv } from '../server-env';
import { testRuntime } from '../test/helpers';
import { pngBytes } from '../test/image-fixtures';
import { artifactExists } from '../storage/files';
import { createLogger } from '../observability/logger';
import { preRegisterBatch, unregisterBatch } from '../orchestrator/registry';
import { parseDeleteKeepUploads } from './_deleteUploads';
import { parseQuery } from './_http';
import { ThreadDeleteQuerySchema } from './history.schema';

type Runtime = ReturnType<typeof testRuntime>;
interface Thread { batchId: string; tileId: string }
const headers = { 'Remote-User': 'test', 'Content-Type': 'application/json' };

const deleteRoutes = [
  { name: '/history', archived: false, path: (_thread: Thread) => '/api/history' },
  { name: '/history/:batchId', archived: false, path: (thread: Thread) => `/api/history/${thread.batchId}` },
  { name: '/history/:batchId/:tileId', archived: false, path: (thread: Thread) => `/api/history/${thread.batchId}/${thread.tileId}` },
  { name: '/archive', archived: true, path: (_thread: Thread) => '/api/archive' },
  { name: '/archive/:tileId', archived: true, path: (thread: Thread) => `/api/archive/${thread.tileId}` },
] as const;

async function uploadRef(runtime: Runtime, userId = 'test'): Promise<string> {
  const form = new FormData();
  form.set('file', new File([pngBytes()], 'ref.png', { type: 'image/png' }));
  const response = await runtime.fetch('/api/uploads', {
    method: 'POST', headers: { 'Remote-User': userId }, body: form,
  });
  expect(response.status).toBe(201);
  return (await response.json() as { id: string }).id;
}

function seedThread(runtime: Runtime, archived: boolean, refs: readonly string[], userId = 'test'): Thread {
  const batchId = crypto.randomUUID();
  const tileId = crypto.randomUUID();
  const now = Date.now();
  runtime.db.query('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)').run(userId, now);
  runtime.db.query(
    `INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, status, archived_at)
     VALUES (?, ?, 'p', '1:1', 'mock-fast', 'Mock Fast', ?, 'done', ?)`,
  ).run(batchId, userId, now, archived ? now : null);
  runtime.db.query(
    `INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, ext, mime, error, completed_at, archived_at)
     VALUES (?, ?, ?, 0, 42, ?, ?, ?, ?, ?, ?)`,
  ).run(tileId, batchId, userId, archived ? 'done' : 'failed', archived ? 'png' : null,
    archived ? 'image/png' : null, archived ? null : 'internal error', now, archived ? now : null);
  for (const [position, uploadId] of refs.entries()) {
    runtime.db.query('INSERT INTO tile_ref_images (tile_id, upload_id, position) VALUES (?, ?, ?)')
      .run(tileId, uploadId, position);
  }
  return { batchId, tileId };
}

async function expectUpload(runtime: Runtime, uploadId: string, present: boolean, userId = 'test'): Promise<void> {
  expect(runtime.db.query('SELECT id FROM uploads WHERE id = ? AND user_id = ?').get(uploadId, userId) !== null)
    .toBe(present);
  expect(await artifactExists(runtime.config.DATA_DIR, 'uploads', userId, uploadId, 'png')).toBe(present);
}

describe('DELETE history/archive upload holds', () => {
  for (const route of deleteRoutes) {
    for (const count of [65, 200]) {
      test(`${route.name} accepts ${count} distinct body holds and retains the actual upload at the end`, async () => {
        const runtime = testRuntime();
        const bodyHeld = await uploadRef(runtime);
        const queryHeld = await uploadRef(runtime);
        const released = await uploadRef(runtime);
        const otherRef = await uploadRef(runtime, 'other');
        const target = seedThread(runtime, route.archived, [bodyHeld, queryHeld, released]);
        const other = seedThread(runtime, route.archived, [otherRef], 'other');
        const keepUploads = [...Array.from({ length: count - 1 }, () => crypto.randomUUID()), bodyHeld];

        const response = await runtime.fetch(`${route.path(target)}?keepUploads=${queryHeld}`, {
          method: 'DELETE', headers, body: JSON.stringify({ keepUploads }),
        });

        expect(response.status).toBe(204);
        expect(runtime.db.query('SELECT id FROM tiles WHERE id = ?').get(target.tileId)).toBeNull();
        expect(runtime.db.query('SELECT id FROM batches WHERE id = ?').get(target.batchId)).toBeNull();
        await expectUpload(runtime, bodyHeld, true);
        await expectUpload(runtime, queryHeld, true);
        await expectUpload(runtime, released, false);
        expect(runtime.db.query('SELECT id FROM tiles WHERE id = ?').get(other.tileId)).not.toBeNull();
        await expectUpload(runtime, otherRef, true, 'other');
      });
    }

    const invalidBodies = [
      { name: 'invalid UUID', body: () => JSON.stringify({ keepUploads: ['not-a-uuid'] }), error: 'validation failed' },
      { name: 'oversized array', body: () => JSON.stringify({ keepUploads: Array(MAX_DELETE_KEEP_UPLOADS + 1).fill(crypto.randomUUID()) }), error: 'validation failed' },
      { name: 'non-array holds', body: () => JSON.stringify({ keepUploads: crypto.randomUUID() }), error: 'validation failed' },
      { name: 'missing holds', body: () => '{}', error: 'validation failed' },
      { name: 'unknown body field', body: () => JSON.stringify({ keepUploads: [], pinned: true }), error: 'validation failed' },
      { name: 'malformed JSON', body: () => '{', error: 'invalid JSON' },
    ];
    for (const invalid of invalidBodies) {
      test(`${route.name} rejects ${invalid.name} before deletion or cancellation`, async () => {
        const runtime = testRuntime();
        const ref = await uploadRef(runtime);
        const target = seedThread(runtime, route.archived, [ref]);
        const entry = preRegisterBatch(target.batchId, 'test', [target.tileId]);
        try {
          const response = await runtime.fetch(route.path(target), {
            method: 'DELETE', headers, body: invalid.body(),
          });
          expect(response.status).toBe(400);
          const payload = await response.json() as { error: string; issues?: unknown[] };
          expect(payload.error).toBe(invalid.error);
          if (invalid.error === 'validation failed') expect(payload.issues?.length).toBeGreaterThan(0);
          expect(runtime.db.query('SELECT id FROM tiles WHERE id = ?').get(target.tileId)).not.toBeNull();
          expect(runtime.db.query('SELECT id FROM batches WHERE id = ?').get(target.batchId)).not.toBeNull();
          expect(entry.batchController.signal.aborted).toBe(false);
          expect(entry.tileControllers.get(target.tileId)?.signal.aborted).toBe(false);
          await expectUpload(runtime, ref, true);
        } finally {
          unregisterBatch(target.batchId);
        }
      });
    }

    for (const queryHolds of [false, true]) {
      test(`${route.name} preserves legacy ${queryHolds ? '64-ID query' : 'no-hold'} deletes without a body`, async () => {
        const runtime = testRuntime();
        const ref = await uploadRef(runtime);
        const released = await uploadRef(runtime);
        const target = seedThread(runtime, route.archived, [ref, released]);
        const query = queryHolds
          ? `?keepUploads=${[...Array.from({ length: 63 }, () => crypto.randomUUID()), ref].join(',')}`
          : '';
        const response = await runtime.fetch(`${route.path(target)}${query}`, { method: 'DELETE', headers });
        expect(response.status).toBe(204);
        expect(runtime.db.query('SELECT id FROM tiles WHERE id = ?').get(target.tileId)).toBeNull();
        await expectUpload(runtime, ref, queryHolds);
        await expectUpload(runtime, released, false);
      });
    }

    test(`${route.name} cannot use body holds to delete another user's thread`, async () => {
      const runtime = testRuntime();
      const ref = await uploadRef(runtime, 'other');
      const target = seedThread(runtime, route.archived, [ref], 'other');
      const response = await runtime.fetch(route.path(target), {
        method: 'DELETE', headers,
        body: JSON.stringify({ keepUploads: Array.from({ length: 200 }, () => crypto.randomUUID()) }),
      });
      expect(response.status).toBe(204);
      expect(runtime.db.query('SELECT id FROM tiles WHERE id = ?').get(target.tileId)).not.toBeNull();
      await expectUpload(runtime, ref, true, 'other');
    });
  }
});

// Exercise union/boundary behavior through Hono without a database or mutation.
function holdParserApp() {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('logger', createLogger({ LOG_LEVEL: 'silent' }));
    await next();
  });
  app.delete('/', async (c) => {
    const query = parseQuery(c, ThreadDeleteQuerySchema);
    if (!query.ok) return query.response;
    const holds = await parseDeleteKeepUploads(c, query.value.keepUploads);
    if (!holds.ok) return holds.response;
    return c.json(holds.value);
  });
  return app;
}

describe('DELETE hold request boundaries', () => {
  test('deduplicates the complete query/body union in order', async () => {
    const [first, second, third] = Array.from({ length: 3 }, () => crypto.randomUUID());
    const response = await holdParserApp().request(`/?keepUploads=${first},${second},${first}`, {
      method: 'DELETE', body: JSON.stringify({ keepUploads: [second, third, third] }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([first, second, third]);
  });

  test('accepts exactly the maximum distinct holds with overlapping query ids', async () => {
    const keepUploads = Array.from({ length: MAX_DELETE_KEEP_UPLOADS }, () => crypto.randomUUID());
    const response = await holdParserApp().request(`/?keepUploads=${keepUploads[0]}`, {
      method: 'DELETE', body: JSON.stringify({ keepUploads }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(keepUploads);
  });

  test('rejects an oversized query/body union without truncating it', async () => {
    const response = await holdParserApp().request(`/?keepUploads=${crypto.randomUUID()}`, {
      method: 'DELETE',
      body: JSON.stringify({ keepUploads: Array.from({ length: MAX_DELETE_KEEP_UPLOADS }, () => crypto.randomUUID()) }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'validation failed', issues: [{ path: ['keepUploads'] }] });
  });

  test('keeps rejecting query lists above 64 even when the body is valid', async () => {
    const ids = Array.from({ length: 65 }, () => crypto.randomUUID());
    const response = await holdParserApp().request(`/?keepUploads=${ids.join(',')}`, {
      method: 'DELETE', body: JSON.stringify({ keepUploads: [] }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'validation failed' });
  });
});

describe('bulk history DELETE scope with body holds', () => {
  test('preserves collection and pinned filters while retaining a held upload', async () => {
    const runtime = testRuntime();
    const ref = await uploadRef(runtime);
    const target = seedThread(runtime, false, [ref]);
    const unpinned = seedThread(runtime, false, []);
    const otherCollection = seedThread(runtime, false, []);
    const collectionId = crypto.randomUUID();
    runtime.db.query('INSERT INTO collections (id, user_id, name, sort_order, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(collectionId, 'test', 'Other', 0, Date.now());
    runtime.db.query('UPDATE batches SET pinned = 1 WHERE id IN (?, ?)').run(target.batchId, otherCollection.batchId);
    runtime.db.query('UPDATE batches SET collection_id = ? WHERE id = ?').run(collectionId, otherCollection.batchId);
    const keepUploads = [...Array.from({ length: 199 }, () => crypto.randomUUID()), ref];

    const response = await runtime.fetch('/api/history?collectionId=null&pinned=true', {
      method: 'DELETE', headers, body: JSON.stringify({ keepUploads }),
    });

    expect(response.status).toBe(204);
    expect(runtime.db.query('SELECT id FROM tiles WHERE id = ?').get(target.tileId)).toBeNull();
    expect(runtime.db.query('SELECT id FROM tiles WHERE id = ?').get(unpinned.tileId)).not.toBeNull();
    expect(runtime.db.query('SELECT id FROM tiles WHERE id = ?').get(otherCollection.tileId)).not.toBeNull();
    await expectUpload(runtime, ref, true);
  });

  test('rejects GET-only query filters with a valid large body before deletion', async () => {
    const runtime = testRuntime();
    const target = seedThread(runtime, false, []);
    const response = await runtime.fetch('/api/history?q=search', {
      method: 'DELETE', headers,
      body: JSON.stringify({ keepUploads: Array.from({ length: 200 }, () => crypto.randomUUID()) }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'validation failed' });
    expect(runtime.db.query('SELECT id FROM tiles WHERE id = ?').get(target.tileId)).not.toBeNull();
  });
});

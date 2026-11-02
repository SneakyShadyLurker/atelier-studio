import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startupReconcile } from '../lifecycle/startup-reconcile';
import { testRuntime } from './helpers';

describe('startup reconciliation of broken done rows', () => {
  test('done row with missing artifact is tombstoned as internal error', () => {
    const { db, config, logger } = testRuntime();
    const now = Date.now();
    const batchId = crypto.randomUUID();
    const missing = crypto.randomUUID();
    const present = crypto.randomUUID();
    db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run('u', now);
    db.query('INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(batchId, 'u', 'p', '1:1', 'mock-fast', 'Mock Fast', now);
    db.query('INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, ext, mime, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(missing, batchId, 'u', 0, 1, 'done', 'png', 'image/png', now);
    db.query('INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, ext, mime, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(present, batchId, 'u', 1, 2, 'done', 'png', 'image/png', now);
    const dir = join(config.DATA_DIR, 'images', 'u');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${present}.png`), 'present');

    startupReconcile(db, config.DATA_DIR, logger, { uploadTtlMs: config.UPLOAD_TTL_MS, orphanThreshold: config.RECONCILE_ORPHAN_THRESHOLD, force: config.RECONCILE_FORCE, dbIntegrityOk: true });

    expect(db.query<{ status: string; error: string }, [string]>('SELECT status, error FROM tiles WHERE id = ?').get(missing))
      .toEqual({ status: 'failed', error: 'internal error' });
    expect(db.query<{ status: string; error: string | null }, [string]>('SELECT status, error FROM tiles WHERE id = ?').get(present))
      .toEqual({ status: 'done', error: null });
  });
});

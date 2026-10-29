import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startupReconcile } from '../lifecycle/startup-reconcile';
import { testRuntime } from './helpers';

function seedDoneTile(
  runtime: ReturnType<typeof testRuntime>,
  options: { userId: string; tileId: string; archivedAt?: number },
): void {
  const now = Date.now();
  const batchId = crypto.randomUUID();
  runtime.db.query('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)').run(options.userId, now);
  runtime.db
    .query('INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(batchId, options.userId, 'p', '1:1', 'mock-fast', 'Mock Fast', now, options.archivedAt ?? null);
  runtime.db
    .query(
      'INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, ext, mime, completed_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(options.tileId, batchId, options.userId, 0, 1, 'done', 'png', 'image/png', now, options.archivedAt ?? null);
  const imageDir = join(runtime.config.DATA_DIR, 'images', options.userId);
  mkdirSync(imageDir, { recursive: true });
  writeFileSync(join(imageDir, `${options.tileId}.png`), 'source');
}

describe('startup reconciliation of orphan thumbs', () => {
  test('removes thumb files without a matching live done tile', () => {
    const runtime = testRuntime();
    const orphanId = crypto.randomUUID();
    const thumbDir = join(runtime.config.DATA_DIR, 'thumbs', 'u');
    mkdirSync(thumbDir, { recursive: true });
    const orphanThumb = join(thumbDir, `${orphanId}.webp`);
    writeFileSync(orphanThumb, 'thumb');

    startupReconcile(runtime.db, runtime.config.DATA_DIR, runtime.logger, { uploadTtlMs: runtime.config.UPLOAD_TTL_MS, orphanThreshold: runtime.config.RECONCILE_ORPHAN_THRESHOLD, force: runtime.config.RECONCILE_FORCE, dbIntegrityOk: true });

    expect(existsSync(orphanThumb)).toBe(false);
  });

  test('preserves thumbs for archived done tiles', () => {
    const runtime = testRuntime();
    const tileId = crypto.randomUUID();
    seedDoneTile(runtime, { userId: 'u', tileId, archivedAt: Date.now() });
    const thumbDir = join(runtime.config.DATA_DIR, 'thumbs', 'u');
    mkdirSync(thumbDir, { recursive: true });
    const archivedThumb = join(thumbDir, `${tileId}.webp`);
    writeFileSync(archivedThumb, 'thumb');

    startupReconcile(runtime.db, runtime.config.DATA_DIR, runtime.logger, { uploadTtlMs: runtime.config.UPLOAD_TTL_MS, orphanThreshold: runtime.config.RECONCILE_ORPHAN_THRESHOLD, force: runtime.config.RECONCILE_FORCE, dbIntegrityOk: true });

    expect(existsSync(archivedThumb)).toBe(true);
  });
});

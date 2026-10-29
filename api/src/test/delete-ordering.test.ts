import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { generateEvents, testRuntime } from './helpers';

describe('history tile soft archive', () => {
  test('hard-deletes a failed tile instead of archiving it', async () => {
    const { app, db } = testRuntime();
    const userId = 'test';
    const batchId = crypto.randomUUID();
    const tileId = crypto.randomUUID();
    const now = Date.now();
    db.query('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)').run(userId, now);
    db.query(
      'INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(batchId, userId, 'p', '1:1', 'mock-fast', 'Mock Fast', now);
    db.query(
      "INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, error, completed_at) VALUES (?, ?, ?, ?, ?, 'failed', 'internal error', ?)",
    ).run(tileId, batchId, userId, 0, 1, now);

    const del = await app.fetch(
      new Request(`http://local/api/history/${batchId}/${tileId}`, { method: 'DELETE', headers: { 'Remote-User': userId } }),
    );
    expect(del.status).toBe(204);
    expect(db.query('SELECT id FROM tiles WHERE id = ?').get(tileId)).toBeNull();
    // Batch had only the failed tile — it gets dropped too instead of leaving a phantom archived row.
    expect(db.query('SELECT id FROM batches WHERE id = ?').get(batchId)).toBeNull();
  });

  test('archives a tile without unlinking its artifact and is idempotent', async () => {
    const { app, db, config } = testRuntime();
    const events = await generateEvents(app, { prompt: 'x', modelId: 'mock-fast', ratio: '1:1', count: 1 });
    const batchId = (events[0]?.data as { batchId: string }).batchId;
    const tileId = (events[0]?.data as { tiles: { tileId: string }[] }).tiles[0]?.tileId;
    expect(tileId).toBeTruthy();
    if (!tileId) throw new Error('missing tileId');
    const del = await app.fetch(new Request(`http://local/api/history/${batchId}/${tileId}`, { method: 'DELETE', headers: { 'Remote-User': 'test' } }));
    expect(del.status).toBe(204);
    const tile = db.query<{ archived_at: number | null }, [string]>('SELECT archived_at FROM tiles WHERE id = ?').get(tileId);
    const batch = db.query<{ archived_at: number | null }, [string]>('SELECT archived_at FROM batches WHERE id = ?').get(batchId);
    expect(typeof tile?.archived_at).toBe('number');
    expect(typeof batch?.archived_at).toBe('number');
    expect(existsSync(join(config.DATA_DIR, 'images', 'test', `${tileId}.png`))).toBe(true);
    const history = await app.fetch(new Request('http://local/api/history', { headers: { 'Remote-User': 'test' } }));
    expect(((await history.json()) as { items: unknown[] }).items).toHaveLength(0);
    const again = await app.fetch(new Request(`http://local/api/history/${batchId}/${tileId}`, { method: 'DELETE', headers: { 'Remote-User': 'test' } }));
    expect(again.status).toBe(204);
  });
});

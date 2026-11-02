import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { generateEvents, testRuntime } from './helpers';

describe('bulk history delete', () => {
  test('soft-archives user batches and artifacts idempotently', async () => {
    const { app, db, config } = testRuntime();
    const events = await generateEvents(app, { prompt: 'x', modelId: 'mock-fast', ratio: '1:1', count: 1 });
    const batchId = (events[0]?.data as { batchId: string }).batchId;
    const tileId = (events[0]?.data as { tiles: { tileId: string }[] }).tiles[0]?.tileId;
    expect(tileId).toBeTruthy();
    if (!tileId) throw new Error('missing tileId');
    const file = join(config.DATA_DIR, 'images', 'test', `${tileId}.png`);
    expect(existsSync(file)).toBe(true);
    const first = await app.fetch(new Request('http://local/api/history', { method: 'DELETE', headers: { 'Remote-User': 'test' } }));
    expect(first.status).toBe(204);
    const batch = db.query<{ archived_at: number | null }, [string]>('SELECT archived_at FROM batches WHERE id = ?').get(batchId);
    const tile = db.query<{ archived_at: number | null }, [string]>('SELECT archived_at FROM tiles WHERE id = ?').get(tileId);
    expect(typeof batch?.archived_at).toBe('number');
    expect(typeof tile?.archived_at).toBe('number');
    expect(existsSync(file)).toBe(true);
    const hidden = await app.fetch(new Request('http://local/api/history', { headers: { 'Remote-User': 'test' } }));
    expect(((await hidden.json()) as { items: unknown[] }).items).toHaveLength(0);
    const second = await app.fetch(new Request('http://local/api/history', { method: 'DELETE', headers: { 'Remote-User': 'test' } }));
    expect(second.status).toBe(204);
  });

  test('scoped DELETE archives only batches matching collectionId', async () => {
    const { app, db } = testRuntime();
    const created = await Promise.all([
      generateEvents(app, { prompt: 'a', modelId: 'mock-fast', ratio: '1:1', count: 1 }),
      generateEvents(app, { prompt: 'b', modelId: 'mock-fast', ratio: '1:1', count: 1 }),
    ]);
    const [batchKept, batchArchived] = created.map((events) => (events[0]?.data as { batchId: string }).batchId);
    if (!batchKept || !batchArchived) throw new Error('missing batchIds');

    const collection = await app.fetch(new Request('http://local/api/collections', {
      method: 'POST',
      headers: { 'Remote-User': 'test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'keep' }),
    }));
    const collectionId = (await collection.json() as { id: string }).id;
    await app.fetch(new Request(`http://local/api/history/${batchKept}`, {
      method: 'PATCH',
      headers: { 'Remote-User': 'test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ collectionId }),
    }));

    const res = await app.fetch(new Request('http://local/api/history?collectionId=null', { method: 'DELETE', headers: { 'Remote-User': 'test' } }));
    expect(res.status).toBe(204);
    const kept = db.query<{ archived_at: number | null }, [string]>('SELECT archived_at FROM batches WHERE id = ?').get(batchKept);
    const archived = db.query<{ archived_at: number | null }, [string]>('SELECT archived_at FROM batches WHERE id = ?').get(batchArchived);
    expect(kept?.archived_at).toBeNull();
    expect(typeof archived?.archived_at).toBe('number');
  });

  test('DELETE rejects q/cursor/limit so a search scope cannot silently widen', async () => {
    const { app } = testRuntime();
    const cases = ['q=foo', 'cursor=abc', 'limit=10'];
    for (const qs of cases) {
      const res = await app.fetch(new Request(`http://local/api/history?${qs}`, { method: 'DELETE', headers: { 'Remote-User': 'test' } }));
      expect(res.status).toBe(400);
    }
  });

  test('scoped DELETE archives only batches matching a specific collection', async () => {
    const { app, db } = testRuntime();
    const created = await Promise.all([
      generateEvents(app, { prompt: 'a', modelId: 'mock-fast', ratio: '1:1', count: 1 }),
      generateEvents(app, { prompt: 'b', modelId: 'mock-fast', ratio: '1:1', count: 1 }),
    ]);
    const [batchA, batchB] = created.map((events) => (events[0]?.data as { batchId: string }).batchId);
    if (!batchA || !batchB) throw new Error('missing batchIds');

    const colA = await app.fetch(new Request('http://local/api/collections', {
      method: 'POST',
      headers: { 'Remote-User': 'test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'A' }),
    }));
    const colB = await app.fetch(new Request('http://local/api/collections', {
      method: 'POST',
      headers: { 'Remote-User': 'test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'B' }),
    }));
    const colAId = (await colA.json() as { id: string }).id;
    const colBId = (await colB.json() as { id: string }).id;
    await app.fetch(new Request(`http://local/api/history/${batchA}`, {
      method: 'PATCH',
      headers: { 'Remote-User': 'test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ collectionId: colAId }),
    }));
    await app.fetch(new Request(`http://local/api/history/${batchB}`, {
      method: 'PATCH',
      headers: { 'Remote-User': 'test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ collectionId: colBId }),
    }));

    const res = await app.fetch(new Request(`http://local/api/history?collectionId=${colAId}`, { method: 'DELETE', headers: { 'Remote-User': 'test' } }));
    expect(res.status).toBe(204);
    const a = db.query<{ archived_at: number | null }, [string]>('SELECT archived_at FROM batches WHERE id = ?').get(batchA);
    const b = db.query<{ archived_at: number | null }, [string]>('SELECT archived_at FROM batches WHERE id = ?').get(batchB);
    expect(typeof a?.archived_at).toBe('number');
    expect(b?.archived_at).toBeNull();
  });
});

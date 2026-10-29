import { describe, expect, test } from 'bun:test';
import type { Batch, CollectionsResponse, Collection } from '@atelier/shared';
import { testRuntime } from './helpers';

type Db = ReturnType<typeof testRuntime>['db'];

interface SeedBatchOptions {
  userId?: string;
  batchId?: string;
  prompt?: string;
  createdAt?: number;
  collectionId?: string | null;
  pinned?: boolean;
  archivedAt?: number | null;
}

function jsonReq(path: string, body: unknown, method = 'POST', userId = 'alice'): Request {
  return new Request(`http://local${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'Remote-User': userId },
    body: JSON.stringify(body),
  });
}

function authedReq(path: string, method = 'GET', userId = 'alice'): Request {
  return new Request(`http://local${path}`, { method, headers: { 'Remote-User': userId } });
}

async function createCollection(app: ReturnType<typeof testRuntime>['app'], name: string, userId = 'alice'): Promise<Collection> {
  const res = await app.fetch(jsonReq('/api/collections', { name }, 'POST', userId));
  expect(res.status).toBe(201);
  return await res.json() as Collection;
}

function seedUser(db: Db, userId: string): void {
  db.query('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)').run(userId, Date.now());
}

function seedBatch(db: Db, options: SeedBatchOptions = {}): string {
  const userId = options.userId ?? 'alice';
  const batchId = options.batchId ?? crypto.randomUUID();
  const now = options.createdAt ?? Date.now();
  seedUser(db, userId);
  db.query(
    `INSERT INTO batches
       (id, user_id, prompt, ratio, model_id, model_label, created_at, archived_at, collection_id, pinned)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    batchId,
    userId,
    options.prompt ?? 'prompt',
    '1:1',
    'mock-fast',
    'Mock Fast',
    now,
    options.archivedAt ?? null,
    options.collectionId ?? null,
    options.pinned === true ? 1 : 0,
  );
  return batchId;
}

function batchIds(body: { items: Batch[] }): string[] {
  return body.items.map((batch) => batch.id);
}

describe('collections routes', () => {
  test('mounted route returns an empty collection list after Authelia', async () => {
    const { app } = testRuntime();
    const res = await app.fetch(authedReq('/api/collections'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      items: [],
      summary: { totalCount: 0, pinnedCount: 0, unsortedCount: 0, archivedTotalCount: 0, archivedPinnedCount: 0, archivedUnsortedCount: 0 },
    });
  });

  test('collections route requires Remote-User', async () => {
    const { app } = testRuntime();
    const res = await app.fetch(new Request('http://local/api/collections'));
    expect(res.status).toBe(401);
  });

  test('POST creates first-time users, assigns sort order, and rejects duplicate names', async () => {
    const { app, db } = testRuntime();
    const first = await createCollection(app, 'Logos');
    expect(first).toMatchObject({ name: 'Logos', count: 0 });
    await createCollection(app, 'Icons');
    await createCollection(app, 'Print');

    const rows = db
      .query<{ name: string; sort_order: number }, []>('SELECT name, sort_order FROM collections ORDER BY sort_order ASC')
      .all();
    expect(rows).toEqual([
      { name: 'Logos', sort_order: 0 },
      { name: 'Icons', sort_order: 1 },
      { name: 'Print', sort_order: 2 },
    ]);

    expect(db.query<{ id: string }, [string]>('SELECT id FROM users WHERE id = ?').get('alice')).toBeTruthy();
    const duplicate = await app.fetch(jsonReq('/api/collections', { name: 'Logos' }));
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ error: 'name already used' });
  });

  test.each([
    ['empty body', undefined],
    ['missing name', {}],
    ['blank name', { name: '   ' }],
    ['overlong name', { name: 'x'.repeat(65) }],
    ['unknown extra key', { name: 'ok', foo: true }],
  ])('POST rejects %s', async (_label, body) => {
    const { app } = testRuntime();
    const req = body === undefined
      ? new Request('http://local/api/collections', { method: 'POST', headers: { 'Remote-User': 'alice' } })
      : jsonReq('/api/collections', body);
    const res = await app.fetch(req);
    expect(res.status).toBe(400);
  });

  test('POST rejects the 51st collection', async () => {
    const { app } = testRuntime();
    for (let i = 0; i < 50; i++) {
      await createCollection(app, `c${i}`);
    }
    const res = await app.fetch(jsonReq('/api/collections', { name: 'one too many' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'collection limit reached' });
  });

  test.each([
    ['cross-user', 'bob'],
    ['unknown id', 'alice'],
  ])('PATCH collection rejects %s targets as 404', async (_label, userId) => {
    const { app } = testRuntime();
    const collection = await createCollection(app, 'Logos', 'alice');
    const id = userId === 'alice' ? crypto.randomUUID() : collection.id;
    const res = await app.fetch(jsonReq(`/api/collections/${id}`, { name: 'New' }, 'PATCH', userId));
    expect(res.status).toBe(404);
  });

  test.each([
    ['empty body', undefined],
    ['duplicate name', { name: 'Icons' }],
  ])('PATCH collection rejects %s', async (_label, body) => {
    const { app } = testRuntime();
    const collection = await createCollection(app, 'Logos');
    await createCollection(app, 'Icons');
    const req = body === undefined
      ? new Request(`http://local/api/collections/${collection.id}`, {
          method: 'PATCH',
          headers: { 'Remote-User': 'alice' },
        })
      : jsonReq(`/api/collections/${collection.id}`, body, 'PATCH');
    const res = await app.fetch(req);
    expect(res.status).toBe(body === undefined ? 400 : 409);
  });

  test('DELETE collection is idempotent and orphans assigned batches', async () => {
    const { app, db } = testRuntime();
    const collection = await createCollection(app, 'Logos');
    const batchId = seedBatch(db, { collectionId: collection.id });

    const deleted = await app.fetch(authedReq(`/api/collections/${collection.id}`, 'DELETE'));
    expect(deleted.status).toBe(204);
    const row = db.query<{ collection_id: string | null }, [string]>('SELECT collection_id FROM batches WHERE id = ?').get(batchId);
    expect(row).toEqual({ collection_id: null });

    const missing = await app.fetch(authedReq(`/api/collections/${crypto.randomUUID()}`, 'DELETE'));
    expect(missing.status).toBe(204);
    const crossUser = await app.fetch(authedReq(`/api/collections/${collection.id}`, 'DELETE', 'bob'));
    expect(crossUser.status).toBe(204);
  });

  test('GET collections includes live counts and library summary only', async () => {
    const { app, db } = testRuntime();
    const logos = await createCollection(app, 'Logos');
    const icons = await createCollection(app, 'Icons');
    seedBatch(db, { collectionId: logos.id, pinned: true });
    const archivedLogosBatch = seedBatch(db, { collectionId: logos.id, archivedAt: Date.now(), pinned: true });
    seedBatch(db, { collectionId: icons.id });
    seedBatch(db, { collectionId: null });
    // archived counts are tile-grain over the /api/archive predicate, so the
    // archived batch needs a visible (done+ext+mime+completed_at) tile or the
    // count reports 0 — matching what the Archive view would actually render.
    db.query(
      `INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, ext, mime, error, completed_at, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(crypto.randomUUID(), archivedLogosBatch, 'alice', 0, 1, 'done', 'png', 'image/png', null, Date.now(), Date.now());

    const res = await app.fetch(authedReq('/api/collections'));
    expect(res.status).toBe(200);
    const body = await res.json() as CollectionsResponse;
    expect(body.items.map((item) => ({ name: item.name, count: item.count, archivedCount: item.archivedCount }))).toEqual([
      { name: 'Logos', count: 1, archivedCount: 1 },
      { name: 'Icons', count: 1, archivedCount: 0 },
    ]);
    expect(body.summary).toEqual({
      totalCount: 3,
      pinnedCount: 1,
      unsortedCount: 1,
      archivedTotalCount: 1,
      archivedPinnedCount: 1,
      archivedUnsortedCount: 0,
    });
  });

  test('partial archive (tile-only) is reflected in rail counts but not batch counts', async () => {
    const { app, db } = testRuntime();
    const logos = await createCollection(app, 'Logos');
    // Live batch with one archived tile and one live tile — batches.archived_at
    // stays NULL but /api/archive surfaces the archived tile. The rail counts
    // must agree with the visible archive feed.
    const batchId = seedBatch(db, { collectionId: logos.id });
    db.query(
      `INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, ext, mime, error, completed_at, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(crypto.randomUUID(), batchId, 'alice', 0, 1, 'done', 'png', 'image/png', null, Date.now(), null);
    db.query(
      `INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, ext, mime, error, completed_at, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(crypto.randomUUID(), batchId, 'alice', 1, 2, 'done', 'png', 'image/png', null, Date.now(), Date.now());

    const res = await app.fetch(authedReq('/api/collections'));
    const body = await res.json() as CollectionsResponse;
    expect(body.items[0]?.count).toBe(1);
    expect(body.items[0]?.archivedCount).toBe(1);
    expect(body.summary.archivedTotalCount).toBe(1);
  });
});

describe('history collection and pin patch route', () => {
  test('PATCH history updates collection and pinned together, then can move to unsorted', async () => {
    const { app, db } = testRuntime();
    const collection = await createCollection(app, 'Logos');
    const batchId = seedBatch(db);

    const res = await app.fetch(jsonReq(`/api/history/${batchId}`, { collectionId: collection.id, pinned: true }, 'PATCH'));
    expect(res.status).toBe(200);
    const body = await res.json() as Batch;
    expect(body).toMatchObject({ id: batchId, collectionId: collection.id, pinned: true });

    const unsorted = await app.fetch(jsonReq(`/api/history/${batchId}`, { collectionId: null }, 'PATCH'));
    expect(unsorted.status).toBe(200);
    expect(db.query<{ collection_id: string | null }, [string]>('SELECT collection_id FROM batches WHERE id = ?').get(batchId))
      .toEqual({ collection_id: null });
  });

  test.each([
    ['neither collectionId nor pinned', {}],
    ['string pinned', { pinned: 'true' }],
    ['unknown extra key', { pinned: true, foo: 'bar' }],
  ])('PATCH history rejects %s', async (_label, body) => {
    const { app, db } = testRuntime();
    const batchId = seedBatch(db);
    const res = await app.fetch(jsonReq(`/api/history/${batchId}`, body, 'PATCH'));
    expect(res.status).toBe(400);
  });

  test('PATCH history hides cross-user batch and collection targets', async () => {
    const { app, db } = testRuntime();
    const aliceBatch = seedBatch(db, { userId: 'alice' });
    const bobBatch = seedBatch(db, { userId: 'bob' });
    const bobCollection = await createCollection(app, 'Bob collection', 'bob');

    const crossCollection = await app.fetch(jsonReq(`/api/history/${aliceBatch}`, { collectionId: bobCollection.id }, 'PATCH', 'alice'));
    expect(crossCollection.status).toBe(404);
    const crossBatch = await app.fetch(jsonReq(`/api/history/${bobBatch}`, { pinned: true }, 'PATCH', 'alice'));
    expect(crossBatch.status).toBe(404);
  });

  test('PATCH history rejects archived batches', async () => {
    const { app, db } = testRuntime();
    const batchId = seedBatch(db, { archivedAt: Date.now() });
    const res = await app.fetch(jsonReq(`/api/history/${batchId}`, { pinned: true }, 'PATCH'));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'batch is archived' });
  });
});

describe('history filters', () => {
  test('filters by collection, unsorted, pinned, and composed prompt search', async () => {
    const { app, db } = testRuntime();
    const logos = await createCollection(app, 'Logos');
    const icons = await createCollection(app, 'Icons');
    const match = seedBatch(db, { prompt: 'Viking logo % mark', collectionId: logos.id, pinned: true, createdAt: 300 });
    const otherCollection = seedBatch(db, { prompt: 'viking logo in other collection', collectionId: icons.id, pinned: true, createdAt: 200 });
    const unpinned = seedBatch(db, { prompt: 'viking logo unpinned', collectionId: logos.id, pinned: false, createdAt: 100 });
    const unsorted = seedBatch(db, { prompt: 'plain unsorted', collectionId: null, createdAt: 50 });

    const byCollection = await app.fetch(authedReq(`/api/history?collectionId=${logos.id}`));
    expect(batchIds(await byCollection.json() as { items: Batch[] })).toEqual([match, unpinned]);

    const byUnsorted = await app.fetch(authedReq('/api/history?collectionId=null'));
    expect(batchIds(await byUnsorted.json() as { items: Batch[] })).toEqual([unsorted]);

    const pinned = await app.fetch(authedReq('/api/history?pinned=true'));
    expect(batchIds(await pinned.json() as { items: Batch[] })).toEqual([match, otherCollection]);

    const composed = await app.fetch(authedReq(`/api/history?collectionId=${logos.id}&pinned=true&q=viking`));
    expect(batchIds(await composed.json() as { items: Batch[] })).toEqual([match]);
  });

  test.each([
    ['/api/history?collectionId=abc'],
    [`/api/history?q=${'x'.repeat(201)}`],
  ])('GET history rejects invalid query %s', async (path) => {
    const { app } = testRuntime();
    const res = await app.fetch(authedReq(path));
    expect(res.status).toBe(400);
  });

  test('empty q is ignored and mixed-case q matches case-insensitively', async () => {
    const { app, db } = testRuntime();
    const one = seedBatch(db, { prompt: 'VIKING crest', createdAt: 2 });
    const two = seedBatch(db, { prompt: 'other', createdAt: 1 });
    const empty = await app.fetch(authedReq('/api/history?q='));
    expect(batchIds(await empty.json() as { items: Batch[] })).toEqual([one, two]);
    const mixed = await app.fetch(authedReq('/api/history?q=viking'));
    expect(batchIds(await mixed.json() as { items: Batch[] })).toEqual([one]);
  });

  test('q escapes literal percent and underscore instead of wildcard matching', async () => {
    const { app, db } = testRuntime();
    const percent = seedBatch(db, { prompt: 'contains % literal', createdAt: 3 });
    const underscore = seedBatch(db, { prompt: 'contains _ literal', createdAt: 2 });
    seedBatch(db, { prompt: 'contains x literal', createdAt: 1 });

    const percentRes = await app.fetch(authedReq('/api/history?q=%25'));
    expect(batchIds(await percentRes.json() as { items: Batch[] })).toEqual([percent]);
    const underscoreRes = await app.fetch(authedReq('/api/history?q=_'));
    expect(batchIds(await underscoreRes.json() as { items: Batch[] })).toEqual([underscore]);
  });

  test('cursor pagination remains stable with filters and same-created_at ties', async () => {
    const { app, db } = testRuntime();
    const collection = await createCollection(app, 'Logos');
    const older = '00000000-0000-4000-8000-000000000001';
    const middle = '00000000-0000-4000-8000-000000000002';
    const newer = '00000000-0000-4000-8000-000000000003';
    seedBatch(db, { batchId: older, prompt: 'viking old', collectionId: collection.id, pinned: true, createdAt: 10 });
    seedBatch(db, { batchId: middle, prompt: 'viking middle', collectionId: collection.id, pinned: true, createdAt: 10 });
    seedBatch(db, { batchId: newer, prompt: 'viking new', collectionId: collection.id, pinned: true, createdAt: 10 });
    seedBatch(db, { prompt: 'viking filtered out', collectionId: null, pinned: true, createdAt: 20 });

    const page1 = await app.fetch(authedReq(`/api/history?collectionId=${collection.id}&pinned=true&q=viking&limit=2`));
    const body1 = await page1.json() as { items: Batch[]; nextCursor: string | null };
    expect(batchIds(body1)).toEqual([newer, middle]);
    expect(body1.nextCursor).toBeTruthy();
    const page2 = await app.fetch(authedReq(`/api/history?collectionId=${collection.id}&pinned=true&q=viking&limit=2&cursor=${body1.nextCursor}`));
    const body2 = await page2.json() as { items: Batch[]; nextCursor: string | null };
    expect(batchIds(body2)).toEqual([older]);
    expect(body2.nextCursor).toBeNull();
  });

  describe('PUT /collections/order', () => {
    test('rewrites sort_order to match the supplied permutation', async () => {
      const { app } = testRuntime();
      const a = await createCollection(app, 'Alpha');
      const b = await createCollection(app, 'Bravo');
      const c = await createCollection(app, 'Charlie');

      const res = await app.fetch(jsonReq('/api/collections/order', { orderedIds: [c.id, a.id, b.id] }, 'PUT'));
      expect(res.status).toBe(200);
      const body = await res.json() as CollectionsResponse;
      expect(body.items.map((row) => row.id)).toEqual([c.id, a.id, b.id]);

      const list = await app.fetch(authedReq('/api/collections'));
      const refetched = await list.json() as CollectionsResponse;
      expect(refetched.items.map((row) => row.name)).toEqual(['Charlie', 'Alpha', 'Bravo']);
    });

    test('rejects partial permutations and unknown ids', async () => {
      const { app } = testRuntime();
      const a = await createCollection(app, 'Alpha');
      const b = await createCollection(app, 'Bravo');
      await createCollection(app, 'Charlie');

      const partial = await app.fetch(jsonReq('/api/collections/order', { orderedIds: [a.id, b.id] }, 'PUT'));
      expect(partial.status).toBe(409);
      expect((await partial.json() as { error: string }).error).toContain('match current collections');

      const stranger = await app.fetch(
        jsonReq('/api/collections/order', { orderedIds: [a.id, b.id, '00000000-0000-4000-8000-000000000001'] }, 'PUT'),
      );
      expect(stranger.status).toBe(409);
    });

    test('rejects duplicate ids in the payload', async () => {
      const { app } = testRuntime();
      const a = await createCollection(app, 'Alpha');
      const b = await createCollection(app, 'Bravo');
      await createCollection(app, 'Charlie');

      const dup = await app.fetch(jsonReq('/api/collections/order', { orderedIds: [a.id, b.id, a.id] }, 'PUT'));
      expect(dup.status).toBe(400);
    });

    test('scopes reorder to the authed user', async () => {
      const { app } = testRuntime();
      const aliceFoo = await createCollection(app, 'Foo', 'alice');
      const bobBar = await createCollection(app, 'Bar', 'bob');

      const res = await app.fetch(jsonReq('/api/collections/order', { orderedIds: [aliceFoo.id, bobBar.id] }, 'PUT', 'alice'));
      expect(res.status).toBe(409);
    });

    test('requires Remote-User', async () => {
      const { app } = testRuntime();
      const res = await app.fetch(
        new Request('http://local/api/collections/order', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderedIds: ['00000000-0000-4000-8000-000000000001'] }),
        }),
      );
      expect(res.status).toBe(401);
    });

    test('rejects empty and oversized orderedIds payloads', async () => {
      const { app } = testRuntime();
      await createCollection(app, 'Alpha');

      const empty = await app.fetch(jsonReq('/api/collections/order', { orderedIds: [] }, 'PUT'));
      expect(empty.status).toBe(400);

      const oversized = Array.from({ length: 51 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
      const tooMany = await app.fetch(jsonReq('/api/collections/order', { orderedIds: oversized }, 'PUT'));
      expect(tooMany.status).toBe(400);
    });
  });
});

import { afterEach, describe, expect, test } from 'bun:test';
import { getBatchForUser, registerBatch, __registryTest, resetRegistryForTests } from '../orchestrator/registry';
const { registerTile } = __registryTest;
import * as bus from '../orchestrator/bus';
import * as queue from '../orchestrator/queue';
import { acquireTiles, byokTilesInFlight, tilesInFlight } from '../orchestrator/concurrency';
import { kickQueues } from '../orchestrator/dispatch';
import { openBatchEvents, parseSseText, submitGenerate, testRuntime, testTextServices } from './helpers';
import { pngBytes } from './image-fixtures';

const pngBase64 = Buffer.from(pngBytes()).toString('base64');

afterEach(() => {
  resetRegistryForTests();
  bus.resetForTests();
  queue.resetQueueForTests();
});

describe('DELETE cancel behavior', () => {
  test('per-tile DELETE aborts a loading tile and hard-deletes the empty batch', async () => {
    const { app, db } = testRuntime({ LOCAL_TIMEOUT_MS: '5000', MOCK_PROVIDER_DELAY_MS: '300' });
    const { batchId } = await submitGenerate(app, { prompt: 'slow', modelId: 'mock-slow', ratio: '1:1', count: 1 }, 'alice');
    const generation = openBatchEvents(app, batchId, 'alice');
    await Bun.sleep(40);
    const tile = db
      .query<{ batch_id: string; id: string }, [string]>('SELECT batch_id, id FROM tiles WHERE status = ?')
      .get('loading');
    if (!tile) throw new Error('expected a loading tile row by now');

    const del = await app.fetch(
      new Request(`http://local/api/history/${tile.batch_id}/${tile.id}`, {
        method: 'DELETE',
        headers: { 'Remote-User': 'alice' },
      }),
    );
    expect(del.status).toBe(204);
    const response = await generation;
    const events = parseSseText(await response.text());
    const terminal = events.find((e) => e.event === 'tile') as
      | { event: 'tile'; data: { status?: string } }
      | undefined;
    expect(terminal?.data.status).toBe('canceled');
    expect(db.query('SELECT id FROM tiles WHERE id = ?').get(tile.id)).toBeNull();
    expect(db.query('SELECT id FROM batches WHERE id = ?').get(tile.batch_id)).toBeNull();
  });

  test('per-batch DELETE hard-deletes completed tiles when canceling an in-flight batch', async () => {
    const { app, db } = testRuntime({
      LOCAL_TIMEOUT_MS: '5000',
      MOCK_PROVIDER_DELAY_MS: '1000',
      MOCK_PROVIDER_TILE_DELAYS: '25,1000',
      MAX_CONCURRENT_TILES: '2',
      MAX_CONCURRENT_TILES_PER_USER: '2',
    });
    const { batchId } = await submitGenerate(app, { prompt: 'mixed', modelId: 'mock-slow', ratio: '1:1', count: 2 }, 'alice');
    const generation = openBatchEvents(app, batchId, 'alice');
    await Bun.sleep(100);
    const batch = db.query<{ id: string }, []>('SELECT id FROM batches LIMIT 1').get();
    if (!batch) throw new Error('expected a batch row');
    const before = db
      .query<{ status: string; count: number }, []>('SELECT status, COUNT(*) AS count FROM tiles GROUP BY status ORDER BY status')
      .all();
    expect(before).toEqual([
      { status: 'done', count: 1 },
      { status: 'loading', count: 1 },
    ]);

    const del = await app.fetch(
      new Request(`http://local/api/history/${batch.id}`, {
        method: 'DELETE',
        headers: { 'Remote-User': 'alice' },
      }),
    );
    expect(del.status).toBe(204);
    const response = await generation;
    const events = parseSseText(await response.text());
    const canceledTiles = events.filter((e) => e.event === 'tile' && (e.data as { status?: string }).status === 'canceled');
    expect(canceledTiles).toHaveLength(1);

    expect(db.query('SELECT id FROM tiles WHERE batch_id = ?').all(batch.id)).toEqual([]);
    expect(db.query('SELECT id FROM batches WHERE id = ?').get(batch.id)).toBeNull();
  });

  test('per-batch DELETE removes a queued batch from memory and notifies subscribers', async () => {
    const { app, db } = testRuntime();
    const batchId = '88888888-8888-4888-8888-888888888888';
    const tileId = '99999999-9999-4999-8999-999999999999';
    db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run('alice', 1);
    db.query(
      `INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, status, pool)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 'shared')`,
    ).run(batchId, 'alice', 'queued', '1:1', 'mock-slow', 'Mock Slow', 1);
    db.query('INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status) VALUES (?, ?, ?, ?, ?, ?)')
      .run(tileId, batchId, 'alice', 0, 1, 'loading');
    queue.enqueue('shared', { batchId, userId: 'alice', modelId: 'mock-slow', count: 1, queuedAt: 1 });

    const events = await app.fetch(
      new Request(`http://local/api/batches/${batchId}/events`, {
        headers: { 'Remote-User': 'alice' },
      }),
    );
    const reader = events.body?.getReader();
    if (!reader) throw new Error('expected event stream');
    const first = await reader.read();
    const del = await app.fetch(
      new Request(`http://local/api/history/${batchId}`, {
        method: 'DELETE',
        headers: { 'Remote-User': 'alice' },
      }),
    );

    const decoder = new TextDecoder();
    const firstValue = first.value instanceof Uint8Array ? first.value : new Uint8Array();
    let text = decoder.decode(firstValue);
    for (;;) {
      const next = await reader.read();
      if (next.value instanceof Uint8Array) text += decoder.decode(next.value);
      if (next.done) break;
    }
    expect(del.status).toBe(204);
    expect(queue.positionOf('shared', batchId)).toBe(-1);
    expect(db.query('SELECT id FROM batches WHERE id = ?').get(batchId)).toBeNull();
    const frames = parseSseText(text);
    expect(frames.map((frame) => frame.event)).toEqual(['batch', 'tile', 'done']);
    expect(frames[1]?.data).toMatchObject({ tileId, tileIndex: 0, status: 'canceled' });
  });

  test('per-tile DELETE recomputes queued entry count from the database', async () => {
    const { app, db } = testRuntime({
      MAX_CONCURRENT_TILES: '2',
      MAX_CONCURRENT_TILES_PER_USER: '2',
    });
    expect(acquireTiles('alice', 1, 1, 1)).toEqual({ ok: true });
    const batchId = '12121212-1212-4121-8121-121212121212';
    const tileIds = [
      '23232323-2323-4323-8323-232323232323',
      '34343434-3434-4434-8434-343434343434',
      '45454545-4545-4454-8454-454545454545',
    ];
    db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run('alice', 1);
    db.query(
      `INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, status, pool)
       VALUES (?, 'alice', 'queued', '1:1', 'gpt-image-2.5-sunburst', 'GPT Image 2.5 Sunburst', 1, 'queued', 'shared')`,
    ).run(batchId);
    const insertTile = db.query(
      "INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status) VALUES (?, ?, 'alice', ?, ?, 'loading')",
    );
    for (const [index, tileId] of tileIds.entries()) {
      insertTile.run(tileId, batchId, index, index + 1);
    }
    queue.enqueue('shared', {
      batchId,
      userId: 'alice',
      modelId: 'gpt-image-2.5-sunburst',
      count: tileIds.length,
      queuedAt: 1,
    });

    for (const tileId of tileIds.slice(0, 1)) {
      const del = await app.fetch(new Request(`http://local/api/history/${batchId}/${tileId}`, {
        method: 'DELETE',
        headers: { 'Remote-User': 'alice' },
      }));
      expect(del.status).toBe(204);
    }

    expect(queue.__queueTest.peekHead('shared')).toMatchObject({ batchId, count: 2 });
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM tiles WHERE batch_id = '12121212-1212-4121-8121-121212121212' AND status = 'loading'")
        .get()?.count,
    ).toBe(2);
    expect(tilesInFlight()).toBe(1);
  });

  test('per-batch DELETE during queued BYOK key-load aborts before any upstream call', async () => {
    const runtime = testRuntime({ MAX_CONCURRENT_TILES_PER_USER_BYOK: '1' });
    const { app, db, config, logger, keyStore } = runtime;
    if (!keyStore) throw new Error('expected keyStore in test runtime');
    await runtime.seedKey('alice', 'google', 'AIzaTEST');
    const batchId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const tileId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    db.query(
      `INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, status, pool)
       VALUES (?, 'alice', 'queued byok', '1:1', 'gemini-3-pro-image-preview', 'Nano Banana Pro', 1, 'queued', 'byok')`,
    ).run(batchId);
    db.query(
      "INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status) VALUES (?, ?, 'alice', 0, 1, 'loading')",
    ).run(tileId, batchId);
    queue.enqueue('byok', {
      batchId,
      userId: 'alice',
      modelId: 'gemini-3-pro-image-preview',
      count: 1,
      queuedAt: 1,
    });

    const originalLoad = keyStore.load.bind(keyStore);
    const loadGate: { release?: () => void } = {};
    let loadStarted = false;
    keyStore.load = async (userId, provider) => {
      loadStarted = true;
      await new Promise<void>((resolve) => { loadGate.release = resolve; });
      return originalLoad(userId, provider);
    };
    let upstreamCalls = 0;
    globalThis.fetch = (() => {
      upstreamCalls += 1;
      return Promise.resolve(new Response('unexpected upstream call', { status: 599 }));
    }) as unknown as typeof fetch;

    kickQueues({ db, config, logger, keyStore, healthSnapshot: () => new Map(), text: testTextServices(db, config) });
    await waitFor(() => loadStarted ? true : null);
    const entry = await waitFor(() => getBatchForUser(batchId, 'alice') ?? null);

    const del = await app.fetch(new Request(`http://local/api/history/${batchId}`, {
      method: 'DELETE',
      headers: { 'Remote-User': 'alice' },
    }));
    expect(del.status).toBe(204);
    expect(entry.batchController.signal.aborted).toBe(true);

    if (!loadGate.release) throw new Error('expected key load gate');
    loadGate.release();
    await Bun.sleep(20);
    expect(upstreamCalls).toBe(0);
    expect(db.query('SELECT id FROM batches WHERE id = ?').get(batchId)).toBeNull();
  });

  test('per-tile DELETE during queued BYOK key-load skips upstream for only the deleted tile', async () => {
    const runtime = testRuntime({ MAX_CONCURRENT_TILES_PER_USER_BYOK: '2' });
    const { app, db, config, logger, keyStore } = runtime;
    if (!keyStore) throw new Error('expected keyStore in test runtime');
    await runtime.seedKey('alice', 'google', 'AIzaTEST');
    const batchId = 'abababab-abab-4aba-8aba-abababababab';
    const deletedTileId = 'cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd';
    const survivingTileId = 'efefefef-efef-4efe-8efe-efefefefefef';
    db.query(
      `INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, status, pool)
       VALUES (?, 'alice', 'queued byok tiles', '1:1', 'gemini-3-pro-image-preview', 'Nano Banana Pro', 1, 'queued', 'byok')`,
    ).run(batchId);
    const insertTile = db.query(
      "INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status) VALUES (?, ?, 'alice', ?, ?, 'loading')",
    );
    insertTile.run(deletedTileId, batchId, 0, 101);
    insertTile.run(survivingTileId, batchId, 1, 202);
    queue.enqueue('byok', {
      batchId,
      userId: 'alice',
      modelId: 'gemini-3-pro-image-preview',
      count: 2,
      queuedAt: 1,
    });

    const originalLoad = keyStore.load.bind(keyStore);
    const loadGate: { release?: () => void } = {};
    let loadStarted = false;
    keyStore.load = async (userId, provider) => {
      loadStarted = true;
      await new Promise<void>((resolve) => { loadGate.release = resolve; });
      return originalLoad(userId, provider);
    };
    let upstreamCalls = 0;
    globalThis.fetch = ((_input, _init) => {
      upstreamCalls += 1;
      return Promise.resolve(new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    inlineData: {
                      mimeType: 'image/png',
                      data: pngBase64,
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ));
    }) as typeof fetch;

    kickQueues({ db, config, logger, keyStore, healthSnapshot: () => new Map(), text: testTextServices(db, config) });
    await waitFor(() => loadStarted ? true : null);
    const entry = await waitFor(() => getBatchForUser(batchId, 'alice') ?? null);
    expect(byokTilesInFlight('alice')).toBe(2);

    const del = await app.fetch(new Request(`http://local/api/history/${batchId}/${deletedTileId}`, {
      method: 'DELETE',
      headers: { 'Remote-User': 'alice' },
    }));
    expect(del.status).toBe(204);
    expect(db.query('SELECT id FROM tiles WHERE id = ?').get(deletedTileId)).toBeNull();
    expect(entry.tileControllers.get(deletedTileId)?.signal.aborted).toBe(true);
    expect(byokTilesInFlight('alice')).toBe(2);

    if (!loadGate.release) throw new Error('expected key load gate');
    loadGate.release();
    await waitFor(() => {
      const row = db
        .query<{ status: string }, [string]>('SELECT status FROM tiles WHERE id = ?')
        .get(survivingTileId);
      return row?.status === 'done' ? true : null;
    });

    expect(upstreamCalls).toBe(1);
    expect(db.query('SELECT id FROM tiles WHERE id = ?').get(deletedTileId)).toBeNull();
    expect(
      db.query<{ status: string; ext: string | null; mime: string | null }, [string]>(
        'SELECT status, ext, mime FROM tiles WHERE id = ?',
      ).get(survivingTileId),
    ).toMatchObject({ status: 'done', ext: 'png', mime: 'image/png' });
    expect(byokTilesInFlight('alice')).toBe(0);
  });

  test('per-tile DELETE hard-deletes a done row when a tile cancel intent exists', async () => {
    const { app, db } = testRuntime();
    const batchId = '11111111-1111-4111-8111-111111111111';
    const tileId = '22222222-2222-4222-8222-222222222222';
    db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run('alice', 1);
    db.query('INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(batchId, 'alice', 'race', '1:1', 'mock-slow', 'Mock Slow', 1);
    db.query('INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, ext, mime, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(tileId, batchId, 'alice', 0, 1, 'done', 'png', 'image/png', 2);
    registerBatch(batchId, 'alice', new AbortController());
    registerTile(batchId, tileId, new AbortController());

    const del = await app.fetch(
      new Request(`http://local/api/history/${batchId}/${tileId}`, {
        method: 'DELETE',
        headers: { 'Remote-User': 'alice' },
      }),
    );

    expect(del.status).toBe(204);
    expect(db.query('SELECT id FROM tiles WHERE id = ?').get(tileId)).toBeNull();
    expect(db.query('SELECT id FROM batches WHERE id = ?').get(batchId)).toBeNull();
  });

  test('clear-all DELETE hard-deletes done rows in just-canceled in-flight batches only', async () => {
    const { app, db } = testRuntime();
    const inFlightBatchId = '33333333-3333-4333-8333-333333333333';
    const doneTileId = '44444444-4444-4444-8444-444444444444';
    const loadingTileId = '55555555-5555-4555-8555-555555555555';
    const settledBatchId = '66666666-6666-4666-8666-666666666666';
    const settledTileId = '77777777-7777-4777-8777-777777777777';
    db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run('alice', 1);
    db.query('INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(inFlightBatchId, 'alice', 'race', '1:1', 'mock-slow', 'Mock Slow', 1);
    db.query('INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(settledBatchId, 'alice', 'settled', '1:1', 'mock-slow', 'Mock Slow', 2);
    db.query('INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, ext, mime, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(doneTileId, inFlightBatchId, 'alice', 0, 1, 'done', 'png', 'image/png', 2);
    db.query('INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status) VALUES (?, ?, ?, ?, ?, ?)')
      .run(loadingTileId, inFlightBatchId, 'alice', 1, 2, 'loading');
    db.query('INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, ext, mime, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(settledTileId, settledBatchId, 'alice', 0, 1, 'done', 'png', 'image/png', 3);
    registerBatch(inFlightBatchId, 'alice', new AbortController());

    const del = await app.fetch(
      new Request('http://local/api/history', {
        method: 'DELETE',
        headers: { 'Remote-User': 'alice' },
      }),
    );

    expect(del.status).toBe(204);
    expect(db.query('SELECT id FROM tiles WHERE id IN (?, ?)').all(doneTileId, loadingTileId)).toEqual([]);
    const settled = db
      .query<{ archived_at: number | null }, [string]>('SELECT archived_at FROM tiles WHERE id = ?')
      .get(settledTileId);
    expect(typeof settled?.archived_at).toBe('number');
  });

  test('clear-all DELETE cancels multiple registered running batches beyond queued admission cap', async () => {
    const { app, db } = testRuntime({ MAX_QUEUED_BATCHES_PER_USER: '1' });
    const batches = [
      {
        batchId: '81818181-8181-4181-8181-818181818181',
        doneTileId: '82828282-8282-4282-8282-828282828282',
        loadingTileId: '83838383-8383-4383-8383-838383838383',
      },
      {
        batchId: '84848484-8484-4484-8484-848484848484',
        doneTileId: '85858585-8585-4585-8585-858585858585',
        loadingTileId: '86868686-8686-4686-8686-868686868686',
      },
    ];
    db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run('alice', 1);
    for (const [index, batch] of batches.entries()) {
      db.query('INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(batch.batchId, 'alice', `running-${index}`, '1:1', 'mock-slow', 'Mock Slow', index + 1);
      db.query('INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, ext, mime, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(batch.doneTileId, batch.batchId, 'alice', 0, index + 1, 'done', 'png', 'image/png', index + 10);
      db.query('INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status) VALUES (?, ?, ?, ?, ?, ?)')
        .run(batch.loadingTileId, batch.batchId, 'alice', 1, index + 20, 'loading');
    }
    const controllers = batches.map((batch) => {
      const controller = new AbortController();
      registerBatch(batch.batchId, 'alice', controller);
      return controller;
    });

    const del = await app.fetch(
      new Request('http://local/api/history', {
        method: 'DELETE',
        headers: { 'Remote-User': 'alice' },
      }),
    );

    expect(del.status).toBe(204);
    expect(controllers.every((controller) => controller.signal.aborted)).toBe(true);
    expect(db.query('SELECT id FROM tiles WHERE user_id = ?').all('alice')).toEqual([]);
    expect(db.query('SELECT id FROM batches WHERE user_id = ?').all('alice')).toEqual([]);
  });
});

async function waitFor<T>(probe: () => T | null, timeoutMs = 1_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== null) return value;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await Bun.sleep(10);
  }
}

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../db/migrate';
import type { KeyStore } from '../keystore';
import { createLogger } from '../observability/logger';
import { acquireForPool, byokTilesInFlight, localTilesInFlight, resetConcurrencyForTests, tilesInFlight } from '../orchestrator/concurrency';
import { createBatch } from '../orchestrator/createBatch';
import { beginShutdownDrain, resetShutdownDrainForTests } from '../orchestrator/dequeue';
import { stopQueuedPromptPreparation } from '../orchestrator/queuedPromptPreparation';
import * as queue from '../orchestrator/queue';
import { resetRegistryForTests, snapshotBatchDonePromises } from '../orchestrator/registry';
import { jsonRequest, testConfig, tempDir, testRuntime } from '../test/helpers';
import { kickQueues } from '../orchestrator/dispatch';
import { capsForPool, findModel } from '../providers/registry';

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db, tempDir());
  queue.resetQueueForTests();
  resetRegistryForTests();
  resetConcurrencyForTests();
});

afterEach(() => {
  db.close();
  queue.resetQueueForTests();
  resetRegistryForTests();
  resetConcurrencyForTests();
  resetShutdownDrainForTests();
});

for (const pool of ['shared', 'byok', 'local'] as const) {
  test(`${pool} direct admission queues behind the same user, preserves replay and permits another user`, async () => {
    const runtime = testRuntime({
      LOCAL_MODELS_USERS: 'alice,bob',
      MAX_CONCURRENT_TILES: '4',
      MAX_CONCURRENT_TILES_PER_USER: '4',
      MAX_CONCURRENT_TILES_PER_USER_BYOK: '4',
    });
    // Keep queue kicks from obscuring the route's admission decision. The
    // local predecessor represents a preparer still owning an older request.
    await stopQueuedPromptPreparation();
    beginShutdownDrain();
    const modelId = pool === 'shared' ? 'mock-fast'
      : pool === 'byok' ? 'gemini-3-pro-image-preview' : 'moss-image-sft';
    const olderModelId = pool === 'local' ? 'krea-2-gonzalomo' : modelId;
    const entry = findModel(modelId, runtime.config);
    const olderEntry = findModel(olderModelId, runtime.config);
    if (!entry || !olderEntry) throw new Error('expected registered models');
    let providerCalls = 0;
    const binding = spyOn(entry, 'bind').mockReturnValue({
      id: 'admission-test', backend: entry.model.backend,
      async *generate(request) {
        providerCalls += 1;
        await Promise.resolve();
        yield { status: 'failed', error: 'test terminal', seed: request.seed, index: 0 };
      },
    });
    try {
      if (pool === 'byok') {
        for (const user of ['alice', 'bob']) await runtime.seedKey(user, 'google', 'AIza' + 'x'.repeat(35));
      }
      const older = createBatch(runtime.db, 'alice', {
        prompt: 'older request', modelId: olderModelId, ratio: '1:1', count: pool === 'local' ? 1 : 4,
      }, olderEntry);
      queue.enqueue(pool, {
        batchId: older.batch.id, userId: 'alice', modelId: olderModelId,
        count: older.tiles.length, queuedAt: older.batch.created_at,
      });
      if (pool === 'local') queue.setPromptPreparation(older.batch.id, queue.currentEpoch(), 'pending');
      else expect(acquireForPool(pool, 'alice', 1, capsForPool(runtime.config, pool))).toEqual({ ok: true });

      const request = { prompt: 'new smaller request', modelId, ratio: '1:1', count: 1, idempotencyKey: 'new-request' };
      const response = await jsonRequest(runtime.app, '/api/generate', request, 'alice');
      expect(response.status).toBe(201);
      const payload = await response.json() as { batchId: string; status: string; queueLengthAhead: number };
      expect(payload).toMatchObject({ status: 'queued', queueLengthAhead: 1 });
      expect(queue.entries(pool).map((queued) => queued.batchId)).toEqual([older.batch.id, payload.batchId]);
      expect(providerCalls).toBe(0);
      expect(runtime.db.query('SELECT status FROM batches WHERE id=?').get(payload.batchId)).toEqual({ status: 'queued' });
      expect(pool === 'shared' ? tilesInFlight() : pool === 'byok' ? byokTilesInFlight('alice') : localTilesInFlight())
        .toBe(pool === 'local' ? 0 : 1);

      const replay = await jsonRequest(runtime.app, '/api/generate', request, 'alice');
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ batchId: payload.batchId, status: 'queued' });
      expect(queue.entries(pool)).toHaveLength(2);

      const other = await jsonRequest(runtime.app, '/api/generate', request, 'bob');
      expect(other.status).toBe(201);
      expect(await other.json()).toMatchObject({ status: 'running' });
      await Promise.allSettled(snapshotBatchDonePromises());
      expect(providerCalls).toBe(1);
      expect(queue.entries(pool)).toHaveLength(2);
    } finally {
      await Promise.allSettled(snapshotBatchDonePromises());
      binding.mockRestore();
    }
  });
}

function seedQueuedByokBatch(): void {
  db.run(`INSERT INTO users (id, created_at) VALUES ('alice', 1)`);
  db.run(
    `INSERT INTO user_provider_keys
       (user_id, provider, ciphertext, nonce, key_version, fingerprint, created_at, updated_at)
     VALUES ('alice', 'google', ?, ?, 1, 'fingerprint', 1, 1)`,
    [new Uint8Array([1]), new Uint8Array([2])],
  );
  db.run(
    `INSERT INTO batches (id, user_id, prompt, model_id, model_label, ratio, created_at, status, pool)
     VALUES ('11111111-1111-4111-8111-111111111111', 'alice', 'p', 'gemini-3-pro-image-preview', 'Nano Banana Pro', '1:1', 1, 'queued', 'byok')`,
  );
  db.run(
    `INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status)
     VALUES ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'alice', 0, 0, 'loading')`,
  );
  queue.enqueue('byok', {
    batchId: '11111111-1111-4111-8111-111111111111',
    userId: 'alice',
    modelId: 'gemini-3-pro-image-preview',
    count: 1,
    queuedAt: 1,
  });
}

describe('queued generation startup', () => {
  test('BYOK key-load window is visible to shutdown drain promises', async () => {
    seedQueuedByokBatch();
    let releaseLoad: (() => void) | undefined;
    const keyStore: KeyStore = {
      providersFor: () => Promise.resolve(new Set(['google'])),
      load: () => new Promise((resolve) => {
        releaseLoad = () => {
          resolve({ plaintext: 'AIza' + 'x'.repeat(35), fingerprint: 'fingerprint' });
        };
      }),
      put: () => Promise.reject(new Error('not used')),
      delete: () => Promise.reject(new Error('not used')),
      touch: () => Promise.resolve(),
    };

    const config = testConfig({ DATA_DIR: tempDir(), MAX_CONCURRENT_TILES_PER_USER_BYOK: '1' });
    kickQueues({
      db,
      config,
      logger: createLogger(config),
      keyStore,
      healthSnapshot: () => new Map(),
    });
    await Promise.resolve();

    const drain = snapshotBatchDonePromises();
    expect(drain).toHaveLength(1);
    const settledBeforeRelease = await Promise.race([
      Promise.allSettled(drain).then(() => true),
      new Promise<false>((resolve) => {
        setTimeout(() => { resolve(false); }, 25);
      }),
    ]);
    expect(settledBeforeRelease).toBe(false);

    releaseLoad?.();
    await Promise.allSettled(drain);
  });
});

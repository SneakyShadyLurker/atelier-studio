import { describe, expect, spyOn, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import type { Provider } from '../providers/types';
import type { RegistryEntry } from '../providers/registry';
import { runBatchPipeline } from '../orchestrator';
import { createBatch } from '../orchestrator/createBatch';
import { RefImagesNotFoundError, refImageByteTotal, refImageIdsForBatch } from '../orchestrator/refImages';
import type { GenerationContext, ResolvedGenerateRequest } from '../orchestrator';
import { cleanupPreparedBatch, resolveRefImagesAfterReservation } from '../orchestrator/refImages';
import { testRuntime } from './helpers';
import { pngBytes } from './image-fixtures';
import { writeAtomic } from '../storage/files';
import { storageKeyring } from '../storage/crypto';
import { createReservationReleaser } from '../orchestrator/concurrency';
import { startOrchestratorDetached } from '../orchestrator/startDetached';
import * as bus from '../orchestrator/bus';

const png = pngBytes();

function seedUpload(db: Database, userId: string, uploadId: string, sizeBytes: number): void {
  const now = Date.now();
  db.query('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)').run(userId, now);
  db.query(
    'INSERT INTO uploads (id, user_id, ext, mime, size_bytes, width, height, sha256, created_at) VALUES (?, ?, ?, ?, ?, 64, 64, ?, ?)',
  ).run(uploadId, userId, 'png', 'image/png', sizeBytes, `sha-${uploadId}`, now);
}

function countTiles(db: Database, batchId: string): number {
  return db.query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM tiles WHERE batch_id = ?').get(batchId)?.n ?? 0;
}

function countRefs(db: Database): number {
  return db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM tile_ref_images').get()?.n ?? 0;
}

const mockProvider: Provider = {
  id: 'mock-ref',
  backend: 'cloud',
  async *generate(req) {
    await Promise.resolve();
    yield { status: 'ready', bytes: png, ext: 'png', mime: 'image/png', seed: req.seed, index: 0 };
  },
};

function registryEntry(): RegistryEntry {
  return {
    model: {
      id: 'mock-ref',
      name: 'Mock Ref',
      backend: 'cloud',
      tag: 'test',
      latency: 'instant',
      supportedRatios: ['1:1'],
      supportsReferenceImages: true,
      pool: 'shared',
      concurrencyCapPerUser: 4,
      maxCountPerBatch: 4,
    },
    bind: () => mockProvider,
    timeoutMs: () => 10_000,
  };
}

function makeCtx(
  runtime: ReturnType<typeof testRuntime>,
  request: ResolvedGenerateRequest,
): GenerationContext {
  return {
    db: runtime.db,
    config: runtime.config,
    logger: runtime.logger,
    userId: 'alice',
    request,
    registryEntry: registryEntry(),
    boundProvider: mockProvider,
    disconnectSignal: new AbortController().signal,
    onTileSettled: () => undefined,
    onSyncFailure: () => undefined,
  };
}

describe('cleanupPreparedBatch', () => {
  test('removes batch, tiles, and tile_ref_images but leaves the uploads intact', () => {
    const { db } = testRuntime();
    const upload = crypto.randomUUID();
    seedUpload(db, 'alice', upload, 1);

    const prepared = createBatch(
      db,
      'alice',
      { prompt: 'x', modelId: 'mock-ref', ratio: '1:1', count: 2, refImageIds: [upload] },
      registryEntry(),
    );
    expect(countTiles(db, prepared.batch.id)).toBe(2);
    expect(countRefs(db)).toBe(2);

    cleanupPreparedBatch(db, 'alice', prepared.batch.id);

    expect(db.query('SELECT id FROM batches WHERE id = ?').get(prepared.batch.id)).toBeNull();
    expect(countTiles(db, prepared.batch.id)).toBe(0);
    expect(countRefs(db)).toBe(0);
    // uploads are ON DELETE RESTRICT — they must survive batch cleanup.
    expect(db.query('SELECT id FROM uploads WHERE id = ?').get(upload)).not.toBeNull();
  });

  test('is user-scoped — a different user cannot delete the batch', () => {
    const { db } = testRuntime();
    const upload = crypto.randomUUID();
    seedUpload(db, 'alice', upload, 1);
    const prepared = createBatch(
      db,
      'alice',
      { prompt: 'x', modelId: 'mock-ref', ratio: '1:1', count: 1, refImageIds: [upload] },
      registryEntry(),
    );

    cleanupPreparedBatch(db, 'bob', prepared.batch.id);

    expect(db.query('SELECT id FROM batches WHERE id = ?').get(prepared.batch.id)).not.toBeNull();
    expect(countTiles(db, prepared.batch.id)).toBe(1);
    expect(countRefs(db)).toBe(1);
  });
});

describe('resolveRefImagesAfterReservation', () => {
  test('retains the accepted batch and throws when a ref artifact is missing on disk', async () => {
    const runtime = testRuntime();
    const { db } = runtime;
    const upload = crypto.randomUUID();
    // Upload row exists (so createBatch succeeds) but the artifact file is
    // never written, so loadRefImages resolves to null after reservation.
    seedUpload(db, 'alice', upload, png.byteLength);
    const prepared = createBatch(
      db,
      'alice',
      { prompt: 'x', modelId: 'mock-ref', ratio: '1:1', count: 1, refImageIds: [upload] },
      registryEntry(),
    );
    const ctx = makeCtx(runtime, {
      prompt: 'x',
      modelId: 'mock-ref',
      ratio: '1:1',
      count: 1,
      refImageIds: [upload],
    });

    let caught: unknown;
    try {
      await resolveRefImagesAfterReservation(ctx, prepared);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RefImagesNotFoundError);

    expect(db.query('SELECT id FROM batches WHERE id = ?').get(prepared.batch.id)).not.toBeNull();
    expect(countTiles(db, prepared.batch.id)).toBe(1);
    expect(countRefs(db)).toBe(1);
  });

  for (const failure of ['missing', 'read-error'] as const) {
    test(`detached ${failure} settlement retains failed history and releases the reservation exactly once`, async () => {
      const runtime = testRuntime();
      const upload = crypto.randomUUID();
      seedUpload(runtime.db, 'alice', upload, png.byteLength);
      const request: ResolvedGenerateRequest = {
        prompt: 'x', modelId: 'mock-ref', ratio: '1:1', count: 1, refImageIds: [upload],
      };
      const prepared = createBatch(runtime.db, 'alice', request, registryEntry());
      let released = 0;
      const reservation = createReservationReleaser(1, (count) => { released += count; }, () => undefined);
      const frames: string[] = [];
      bus.subscribe(prepared.batch.id, {
        enqueueTerminal: (frame) => { frames.push(new TextDecoder().decode(frame.bytes)); },
        enqueueOptional: () => undefined,
      });
      if (failure === 'read-error') await writeAtomic(runtime.config.DATA_DIR, 'uploads', 'alice', upload, 'png', png);
      const keyring = await storageKeyring();
      const readError = failure === 'read-error'
        ? spyOn(keyring, 'decryptFileBytes').mockRejectedValueOnce(new Error('disk read/decrypt failed'))
        : undefined;
      try {
        await startOrchestratorDetached(prepared, {
          ...makeCtx(runtime, request), runBatchPipeline,
          onSyncFailure: reservation.releaseRemaining,
          onTileSettled: reservation.releaseOne,
        });
      } finally {
        readError?.mockRestore();
      }
      expect(released).toBe(1);
      expect(runtime.db.query('SELECT status FROM batches WHERE id=?').get(prepared.batch.id)).toEqual({ status: 'done' });
      expect(runtime.db.query('SELECT status,error FROM tiles WHERE batch_id=?').get(prepared.batch.id))
        .toEqual({ status: 'failed', error: failure === 'missing' ? 'upstream rejected' : 'internal error' });
      expect(countRefs(runtime.db)).toBe(1);
      expect(frames.some((frame) => frame.includes('event: tile'))).toBe(true);
      expect(frames.some((frame) => frame.includes('event: done'))).toBe(true);
    });
  }

  test('is a pass-through that leaves the batch intact when refImages are already resolved', async () => {
    const runtime = testRuntime();
    const { db } = runtime;
    const upload = crypto.randomUUID();
    seedUpload(db, 'alice', upload, png.byteLength);
    const prepared = createBatch(
      db,
      'alice',
      { prompt: 'x', modelId: 'mock-ref', ratio: '1:1', count: 1, refImageIds: [upload] },
      registryEntry(),
    );
    const ctx = makeCtx(runtime, {
      prompt: 'x',
      modelId: 'mock-ref',
      ratio: '1:1',
      count: 1,
      refImageIds: [upload],
      refImages: [{ bytes: png, mime: 'image/png' }],
    });

    const result = await resolveRefImagesAfterReservation(ctx, prepared);

    expect(result).toBe(ctx.request);
    expect(db.query('SELECT id FROM batches WHERE id = ?').get(prepared.batch.id)).not.toBeNull();
    expect(countTiles(db, prepared.batch.id)).toBe(1);
  });
});

describe('refImageByteTotal', () => {
  test('sums owned upload sizes and returns null on any missing or unowned id', () => {
    const { db } = testRuntime();
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    const bob = crypto.randomUUID();
    seedUpload(db, 'alice', a, 100);
    seedUpload(db, 'alice', b, 250);
    seedUpload(db, 'bob', bob, 999);

    expect(refImageByteTotal(db, 'alice', [a, b])).toBe(350);
    expect(refImageByteTotal(db, 'alice', [a, crypto.randomUUID()])).toBeNull();
    expect(refImageByteTotal(db, 'alice', [bob])).toBeNull();
    expect(refImageByteTotal(db, 'alice', [])).toBeNull();
  });
});

describe('refImageIdsForBatch', () => {
  test('returns the batch ref uploads in position order', () => {
    const { db } = testRuntime();
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    seedUpload(db, 'alice', first, 1);
    seedUpload(db, 'alice', second, 1);
    const prepared = createBatch(
      db,
      'alice',
      { prompt: 'x', modelId: 'mock-ref', ratio: '1:1', count: 2, refImageIds: [second, first] },
      registryEntry(),
    );

    expect(refImageIdsForBatch(db, prepared.batch.id)).toEqual([second, first]);
  });
});

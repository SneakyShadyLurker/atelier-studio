import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import type { Provider, ProviderGenerateOptions, ProviderRequest, ProviderResult } from './providers/types';
import type { RegistryEntry } from './providers/registry';
import { createGenerationStream } from './test/streamHarness';
import { parseSseText, testRuntime } from './test/helpers';
import { grayCardPng, pngBytes } from './test/image-fixtures';
import { readArtifactBytes, writeAtomic } from './storage/files';
import * as artifactFiles from './storage/files';
import { ensureThumbnail } from './storage/thumbnail';
import { setFfmpegRunnerForTests } from './storage/posterFrame';
import { runBatchPipeline } from './orchestrator';
import { createBatch } from './orchestrator/createBatch';
import { adoptStandaloneBatch, appendSegment, autoUnlinkBatch } from './db/sequences';
import { buildQueuedRequestForBatch } from './orchestrator/dispatch';
import { renderedVideoFrames } from '@atelier/shared';
import { resolveExtendSource } from './orchestrator/extendSource';
import { resetStitchQueueForTests, waitForStitchQueueIdle } from './orchestrator/stitchQueue';
import { setSequenceStitchRunnerForTests } from './storage/stitchSequence';
import { setVideoTailRunnerForTests } from './storage/videoTail';
import { storageKeyring } from './storage/crypto';
import { startOrchestratorDetached } from './orchestrator/startDetached';
import { createReservationReleaser } from './orchestrator/concurrency';
import * as tileTimeout from './lifecycle/timeout';
import { writeModelStepsOverride } from './routing/modelStepsPreference';

const sourceBytes = pngBytes();

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reject(new Error('poster lifecycle timed out')); }, 2_000);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function until(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error('poster extraction did not start');
    await Bun.sleep(0);
  }
}

const mp4Bytes = new Uint8Array([
  0x00, 0x00, 0x00, 0x18,
  0x66, 0x74, 0x79, 0x70,
  0x69, 0x73, 0x6f, 0x6d,
  0x00, 0x00, 0x00, 0x01,
  0x69, 0x73, 0x6f, 0x6d,
  0x6d, 0x70, 0x34, 0x31,
]);

function seedUploadRow(
  db: Database,
  userId: string,
  uploadId: string,
  ext: 'png',
  mime: 'image/png',
  sizeBytes: number,
): void {
  const now = Date.now();
  db.query('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)').run(userId, now);
  db.query(
    'INSERT INTO uploads (id, user_id, ext, mime, size_bytes, width, height, sha256, created_at) VALUES (?, ?, ?, ?, ?, 64, 64, ?, ?)',
  ).run(uploadId, userId, ext, mime, sizeBytes, `sha-${uploadId}`, now);
}

function i2vRegistryEntry(provider: Provider): RegistryEntry {
  return {
    model: {
      id: 'minimax-h3-i2v',
      name: 'MiniMax H3 I2V',
      backend: 'local',
      tag: 'comfyui',
      latency: 'slow',
      supportedRatios: ['16:9'],
      supportsI2V: true,
      outputsVideo: true,
      pool: 'local',
      concurrencyCapPerUser: 1,
      maxCountPerBatch: 1,
    },
    bind: () => provider,
    timeoutMs: ({ local }) => local,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function waitForThumb(
  dataDir: string,
  userId: string,
  tileId: string,
): Promise<Awaited<ReturnType<typeof readArtifactBytes>>> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const artifact = await readArtifactBytes(dataDir, 'thumbs', userId, tileId, 'webp', 'image/webp');
    if (artifact) return artifact;
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
  return null;
}

afterEach(async () => {
  await waitForStitchQueueIdle();
  resetStitchQueueForTests();
  setSequenceStitchRunnerForTests(null);
  setVideoTailRunnerForTests(null);
  setFfmpegRunnerForTests(null);
});

describe('orchestrator i2v', () => {
  for (const ending of ['read', 'delete'] as const) {
    test(`poster prewarm and first GET share publication through ${ending}`, async () => {
      const runtime = testRuntime();
      const { db, config, logger } = runtime;
      const uploadId = crypto.randomUUID();
      seedUploadRow(db, 'alice', uploadId, 'png', 'image/png', sourceBytes.byteLength);
      await writeAtomic(config.DATA_DIR, 'uploads', 'alice', uploadId, 'png', sourceBytes);
      const png = await grayCardPng(32);
      let releasePoster: (() => void) | undefined;
      const gate = new Promise<Uint8Array>((resolve) => { releasePoster = () => { resolve(png); }; });
      let extractions = 0;
      setFfmpegRunnerForTests(() => { extractions += 1; return gate; });
      const writeSpy = spyOn(artifactFiles, 'writeAtomic');
      const provider: Provider = {
        id: 'mock-i2v', backend: 'local',
        async *generate(req) {
          await Promise.resolve();
          yield { status: 'ready', bytes: mp4Bytes, ext: 'mp4', mime: 'video/mp4', seed: req.seed, index: 0 };
        },
      };
      let publication: Promise<Uint8Array> | undefined;
      try {
        const stream = createGenerationStream({
          db, config, logger, userId: 'alice',
          request: { prompt: 'animate', modelId: 'minimax-h3-i2v', ratio: '16:9', count: 1, i2vSourceUploadId: uploadId },
          registryEntry: i2vRegistryEntry(provider), boundProvider: provider,
          disconnectSignal: new AbortController().signal,
          onTileSettled: () => undefined, onSyncFailure: () => undefined,
        });
        const events = parseSseText(await within(new Response(stream).text()));
        expect(events.some((event) => event.event === 'tile' && isObject(event.data) && event.data.status === 'done')).toBe(true);
        const tile = db.query<{ id: string }, []>('SELECT id FROM tiles').get();
        if (!tile) throw new Error('tile missing');
        await until(() => extractions === 1);
        // Join the same public helper so teardown can await publication even
        // after deleting the row (the GET correctly returns 404 in that case).
        publication = ensureThumbnail({ db, dataDir: config.DATA_DIR, userId: 'alice', tileId: tile.id,
          ext: 'mp4', mime: 'video/mp4', logger, sourceBytes: mp4Bytes });
        const responsePromise = runtime.fetch(`/api/img/${tile.id}/thumb`, { headers: { 'Remote-User': 'alice' } });
        await Bun.sleep(0);
        if (ending === 'delete') db.query('DELETE FROM tiles WHERE id = ?').run(tile.id);
        releasePoster?.();
        const response = await within(responsePromise);
        await within(publication);
        expect(response.status).toBe(ending === 'read' ? 200 : 404);
        if (ending === 'read') {
          expect(response.headers.get('Content-Type')).toBe('image/webp');
          expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(Array.from(await publication));
        }
        const cached = await readArtifactBytes(config.DATA_DIR, 'thumbs', 'alice', tile.id, 'webp', 'image/webp');
        if (ending === 'read') expect(cached?.bytes).toEqual(await publication);
        else expect(cached).toBeNull();
        expect(extractions).toBe(1);
        expect(writeSpy.mock.calls.filter((args) => args[1] === 'thumbs')).toHaveLength(1);
      } finally {
        releasePoster?.();
        if (publication) await within(publication).catch(() => undefined);
        writeSpy.mockRestore();
      }
    });
  }

  for (const failure of ['missing', 'read-error'] as const) {
    test(`accepted extension ${failure} retains failed history, dissolves its sequence, and releases once`, async () => {
      const { db, config, logger } = testRuntime();
      const uploadId = crypto.randomUUID();
      seedUploadRow(db, 'alice', uploadId, 'png', 'image/png', sourceBytes.byteLength);
      const provider: Provider = {
        id: 'unused', backend: 'local',
        generate: () => { throw new Error('provider must not run'); },
      };
      const entry = i2vRegistryEntry(provider);
      const request = {
        prompt: 'extend', modelId: entry.model.id, ratio: '16:9' as const, count: 1,
        i2vSourceUploadId: uploadId, durationFrames: 124 as const,
      };
      const parent = createBatch(db, 'alice', request, entry);
      db.query("UPDATE batches SET status='done' WHERE id=?").run(parent.batch.id);
      db.query("UPDATE tiles SET status='done',ext='mp4',mime='video/mp4' WHERE batch_id=?").run(parent.batch.id);
      const adopted = adoptStandaloneBatch(db, 'alice', parent.batch.id);
      if (adopted.status !== 'ok') throw new Error('adoption failed');
      const accepted = createBatch(db, 'alice', request, entry);
      expect(appendSegment(db, logger, 'alice', adopted.sequenceId, parent.batch.id, accepted.batch.id).status).toBe('ok');
      if (failure === 'read-error') await writeAtomic(config.DATA_DIR, 'uploads', 'alice', uploadId, 'png', sourceBytes);
      const readError = failure === 'read-error'
        ? spyOn(await storageKeyring(), 'decryptFileBytes').mockRejectedValueOnce(new Error('read failed'))
        : undefined;
      let released = 0;
      const reservation = createReservationReleaser(1, (count) => { released += count; }, () => undefined);
      try {
        await startOrchestratorDetached(accepted, {
          db, config, logger, userId: 'alice', request, registryEntry: entry, boundProvider: provider,
          disconnectSignal: new AbortController().signal,
          onSyncFailure: reservation.releaseRemaining, onTileSettled: reservation.releaseOne,
          runBatchPipeline,
        });
      } finally { readError?.mockRestore(); }
      expect(released).toBe(1);
      expect(db.query('SELECT status,sequence_id FROM batches WHERE id=?').get(accepted.batch.id))
        .toEqual({ status: 'done', sequence_id: null });
      expect(db.query('SELECT status,error FROM tiles WHERE batch_id=?').get(accepted.batch.id))
        .toEqual({ status: 'failed', error: failure === 'missing' ? 'upstream rejected' : 'internal error' });
      expect(db.query('SELECT id FROM video_sequences WHERE id=?').get(adopted.sequenceId)).toBeNull();
      expect(db.query('SELECT sequence_id FROM batches WHERE id=?').get(parent.batch.id)).toEqual({ sequence_id: null });
    });
  }

  for (const mode of ['standalone-replay', 'linked-queued', 'unlinked-before-start', 'unlinked-during-tail'] as const) {
    test(`${mode} uses persisted membership for native context and preserves the source still`, async () => {
      const { db, config, logger } = testRuntime();
      const firstBatch = crypto.randomUUID();
      const firstTile = crypto.randomUUID();
      const sourceUpload = crypto.randomUUID();
      seedUploadRow(db, 'alice', sourceUpload, 'png', 'image/png', sourceBytes.byteLength);
      db.query(
        `INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, status, pool, duration_frames)
         VALUES (?, 'alice', 'first', '16:9', 'minimax-h3-i2v', 'MiniMax H3', 1, 'done', 'local', 124)`,
      ).run(firstBatch);
      db.query(
        `INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, ext, mime, completed_at)
         VALUES (?, ?, 'alice', 0, 1, 'done', 'mp4', 'video/mp4', 1)`,
      ).run(firstTile, firstBatch);
      db.query('UPDATE uploads SET source_tile_id = ? WHERE id = ?').run(firstTile, sourceUpload);
      await writeAtomic(config.DATA_DIR, 'images', 'alice', firstTile, 'mp4', mp4Bytes);
      await writeAtomic(config.DATA_DIR, 'uploads', 'alice', sourceUpload, 'png', sourceBytes);
      setFfmpegRunnerForTests(() => Promise.resolve(sourceBytes));
      setSequenceStitchRunnerForTests(() => Promise.resolve(mp4Bytes));
      const requests: ProviderRequest[] = [];
      const renderedFrames: number[] = [];
      const budgets: (number | undefined)[] = [];
      const provider: Provider = {
        id: 'mock-i2v', backend: 'local',
        async *generate(request, _signal, options): AsyncIterable<ProviderResult> {
          await Promise.resolve();
          requests.push(request);
          budgets.push(options?.executionTimeoutMs);
          renderedFrames.push(renderedVideoFrames(request.durationFrames ?? 124, request.i2vContext?.contextFrames ?? 0));
          yield { status: 'ready', bytes: mp4Bytes, ext: 'mp4', mime: 'video/mp4', seed: request.seed, index: 0,
            contextFrames: request.i2vContext?.contextFrames ?? 0 };
        },
      };
      const registryEntry = i2vRegistryEntry(provider);
      registryEntry.defaultSteps = 8;
      registryEntry.timeoutMs = ({ localVideo }) => localVideo;
      const durationFrames = mode === 'linked-queued' ? 362 as const : 124 as const;
      if (mode === 'linked-queued') writeModelStepsOverride(db, 'alice', 'minimax-h3-i2v', 100, 8);
      const submitted = {
        prompt: 'continue', modelId: 'minimax-h3-i2v', ratio: '16:9' as const, count: 1,
        i2vSourceUploadId: sourceUpload, durationFrames,
        ...(mode !== 'standalone-replay' ? { extendsTileId: firstTile } : {}),
      };
      const prepared = createBatch(db, 'alice', submitted, registryEntry);
      if (mode !== 'standalone-replay') {
        const adopted = adoptStandaloneBatch(db, 'alice', firstBatch);
        if (adopted.status !== 'ok') throw new Error('expected adoption');
        expect(appendSegment(db, logger, 'alice', adopted.sequenceId, firstBatch, prepared.batch.id).status).toBe('ok');
        if (mode === 'unlinked-before-start') expect(autoUnlinkBatch(db, 'alice', prepared.batch.id).status).toBe('dissolved');
      }
      // Story/queued prepared rows can be stale even though DB membership is
      // already committed. Queued/restarted requests also omit extendsTileId.
      expect(prepared.batch.sequence_id).toBeNull();
      const request = buildQueuedRequestForBatch(db, prepared, registryEntry.model);
      expect(request.extendsTileId).toBeUndefined();
      db.query("UPDATE batches SET status = 'running' WHERE id = ?").run(prepared.batch.id);
      let tailCalls = 0;
      setVideoTailRunnerForTests(() => {
        tailCalls += 1;
        if (mode === 'unlinked-during-tail') expect(autoUnlinkBatch(db, 'alice', prepared.batch.id).status).toBe('dissolved');
        return Promise.resolve(mp4Bytes);
      });
      await runBatchPipeline(prepared, {
        db, config, logger, userId: 'alice', request, registryEntry, boundProvider: provider,
        disconnectSignal: new AbortController().signal,
        onTileSettled: () => undefined, onSyncFailure: () => undefined,
      });
      const expectedContext = mode === 'linked-queued' ? 22 : 0;
      expect(requests).toHaveLength(1);
      expect(requests[0]?.i2vSource?.bytes).toEqual(sourceBytes);
      expect(requests[0]?.durationFrames).toBe(durationFrames);
      if (expectedContext) expect(requests[0]?.i2vContext?.contextFrames).toBe(expectedContext);
      else expect(requests[0]?.i2vContext).toBeUndefined();
      expect(renderedFrames).toEqual([renderedVideoFrames(durationFrames, expectedContext)]);
      expect(budgets).toEqual([Math.ceil(config.LOCAL_VIDEO_TIMEOUT_MS * (mode === 'linked-queued' ? 100 / 8 : 1)
        * renderedVideoFrames(durationFrames, expectedContext) / 124)]);
      expect(tailCalls).toBe(mode === 'linked-queued' || mode === 'unlinked-during-tail' ? 1 : 0);
      expect(db.query<{ context_frames: number }, [string]>('SELECT context_frames FROM batches WHERE id = ?').get(prepared.batch.id)?.context_frames)
        .toBe(expectedContext);
    });
  }

  for (const contextFrames of [22, 0]) {
    test(`non-batched video commits rendered context ${contextFrames} for extend and stitch consumers`, async () => {
      const { db, config, logger } = testRuntime();
      const firstBatch = crypto.randomUUID();
      const firstTile = crypto.randomUUID();
      seedUploadRow(db, 'alice', crypto.randomUUID(), 'png', 'image/png', sourceBytes.byteLength);
      db.query(
        `INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, status, pool, duration_frames)
         VALUES (?, 'alice', 'first', '16:9', 'minimax-h3-i2v', 'MiniMax H3', 1, 'done', 'local', 124)`,
      ).run(firstBatch);
      db.query(
        `INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, ext, mime, completed_at)
         VALUES (?, ?, 'alice', 0, 1, 'done', 'mp4', 'video/mp4', 1)`,
      ).run(firstTile, firstBatch);
      await writeAtomic(config.DATA_DIR, 'images', 'alice', firstTile, 'mp4', mp4Bytes);
      const sourceUpload = crypto.randomUUID();
      seedUploadRow(db, 'alice', sourceUpload, 'png', 'image/png', sourceBytes.byteLength);
      db.query('UPDATE uploads SET source_tile_id = ? WHERE id = ?').run(firstTile, sourceUpload);
      await writeAtomic(config.DATA_DIR, 'uploads', 'alice', sourceUpload, 'png', sourceBytes);
      setVideoTailRunnerForTests(() => Promise.resolve(mp4Bytes));
      setFfmpegRunnerForTests(() => Promise.resolve(sourceBytes));
      const stitched: string[][] = [];
      setSequenceStitchRunnerForTests((args) => {
        stitched.push([...args]);
        return Promise.resolve(mp4Bytes);
      });
      const requests: ProviderRequest[] = [];
      const provider: Provider = {
        id: 'mock-i2v', backend: 'local',
        async *generate(req): AsyncIterable<ProviderResult> {
          await Promise.resolve();
          requests.push(req);
          yield { status: 'ready', bytes: mp4Bytes, ext: 'mp4', mime: 'video/mp4', seed: req.seed, index: 0, contextFrames };
        },
      };
      const request = {
        prompt: 'continue', modelId: 'minimax-h3-i2v', ratio: '16:9' as const, count: 1,
        i2vSourceUploadId: sourceUpload, durationFrames: 124 as const,
      };
      const registryEntry = i2vRegistryEntry(provider);
      expect(registryEntry.model.batched).not.toBe(true);
      const prepared = createBatch(db, 'alice', request, registryEntry);
      const adopted = adoptStandaloneBatch(db, 'alice', firstBatch);
      if (adopted.status !== 'ok') throw new Error('expected adoption');
      expect(appendSegment(db, logger, 'alice', adopted.sequenceId, firstBatch, prepared.batch.id).status).toBe('ok');
      // Simulate a pre-existing intent so explicit fallback 0 must overwrite it.
      db.query('UPDATE batches SET context_frames = 22 WHERE id = ?').run(prepared.batch.id);
      await runBatchPipeline(prepared, {
        db, config, logger, userId: 'alice', request, registryEntry, boundProvider: provider,
        disconnectSignal: new AbortController().signal,
        onTileSettled: () => undefined, onSyncFailure: () => undefined,
      });
      await waitForStitchQueueIdle();
      expect(requests[0]?.i2vContext?.contextFrames).toBe(22);
      const tile = prepared.tiles[0];
      if (!tile) throw new Error('expected tile');
      expect(db.query<{ status: string }, [string]>('SELECT status FROM tiles WHERE id = ?').get(tile.id)?.status).toBe('done');
      expect(db.query<{ context_frames: number }, [string]>('SELECT context_frames FROM batches WHERE id = ?').get(prepared.batch.id)?.context_frames).toBe(contextFrames);
      const nextHandoff = crypto.randomUUID();
      seedUploadRow(db, 'alice', nextHandoff, 'png', 'image/png', sourceBytes.byteLength);
      db.query('UPDATE uploads SET source_tile_id = ? WHERE id = ?').run(tile.id, nextHandoff);
      expect(resolveExtendSource(db, 'alice', nextHandoff)?.endFrame).toBe(124 + contextFrames);
      expect(stitched).toHaveLength(1);
      expect(stitched[0]?.join(' ')).toContain(`trim=start_frame=${contextFrames || 1}:end_frame=${124 + contextFrames}`);
    });
  }

  for (const batched of [false, true]) {
    test(`${batched ? 'batched' : 'non-batched'} stored output survives a deadline expiring during pending cleanup`, async () => {
      const { db, config, logger } = testRuntime();
      setFfmpegRunnerForTests(() => Promise.resolve(sourceBytes));
      const deadline = new AbortController();
      const cleanupStarted = Promise.withResolvers<undefined>();
      const cleanup = Promise.withResolvers<undefined>();
      const timer = spyOn(tileTimeout, 'timeoutSignal').mockImplementation((_ms, parent) => ({
        signal: AbortSignal.any([parent, deadline.signal]), dispose: () => undefined,
      }));
      const provider: Provider = {
        id: 'mock-i2v', backend: 'local',
        async *generate(req): AsyncIterable<ProviderResult> {
          await Promise.resolve();
          yield { status: 'ready', bytes: mp4Bytes, ext: 'mp4', mime: 'video/mp4', seed: req.seed, index: 0,
            afterStored: () => { cleanupStarted.resolve(undefined); return cleanup.promise; } };
        },
      };
      const registryEntry = i2vRegistryEntry(provider);
      registryEntry.model.batched = batched;
      const request = { prompt: 'continue', modelId: 'minimax-h3-i2v', ratio: '16:9' as const, count: 1 };
      const prepared = createBatch(db, 'alice', request, registryEntry);
      try {
        const running = runBatchPipeline(prepared, {
          db, config, logger, userId: 'alice', request, registryEntry, boundProvider: provider,
          disconnectSignal: new AbortController().signal,
          onTileSettled: () => undefined, onSyncFailure: () => undefined,
        });
        await within(cleanupStarted.promise);
        deadline.abort(new tileTimeout.TileTimeout());
        cleanup.resolve(undefined);
        await within(running);
        const tile = prepared.tiles[0];
        if (!tile) throw new Error('expected tile');
        expect(db.query<{ status: string }, [string]>('SELECT status FROM tiles WHERE id = ?').get(tile.id)?.status).toBe('done');
        expect((await readArtifactBytes(config.DATA_DIR, 'images', 'alice', tile.id, 'mp4', 'video/mp4'))?.bytes).toEqual(mp4Bytes);
      } finally { cleanup.resolve(undefined); timer.mockRestore(); }
    });

    test(`a lost ${batched ? 'batched' : 'non-batched'} success race preserves batch context`, async () => {
      const { db, config, logger } = testRuntime();
      setFfmpegRunnerForTests(() => Promise.resolve(sourceBytes));
      const provider: Provider = {
        id: 'mock-i2v', backend: 'local',
        async *generate(req): AsyncIterable<ProviderResult> {
          await Promise.resolve();
          yield {
            status: 'ready', bytes: mp4Bytes, ext: 'mp4', mime: 'video/mp4', seed: req.seed, index: 0, contextFrames: 22,
            afterStored: async () => {
              db.query("UPDATE tiles SET status = 'failed', error = 'interrupted' WHERE status = 'loading'").run();
              await Promise.resolve();
            },
          };
        },
      };
      const registryEntry = i2vRegistryEntry(provider);
      registryEntry.model.batched = batched;
      const request = { prompt: 'continue', modelId: 'minimax-h3-i2v', ratio: '16:9' as const, count: 1, durationFrames: 124 as const };
      const prepared = createBatch(db, 'alice', request, registryEntry);
      db.query('UPDATE batches SET context_frames = 7 WHERE id = ?').run(prepared.batch.id);
      await runBatchPipeline(prepared, {
        db, config, logger, userId: 'alice', request, registryEntry, boundProvider: provider,
        disconnectSignal: new AbortController().signal,
        onTileSettled: () => undefined, onSyncFailure: () => undefined,
      });
      expect(db.query<{ context_frames: number }, [string]>('SELECT context_frames FROM batches WHERE id = ?').get(prepared.batch.id)?.context_frames).toBe(7);
      const tile = prepared.tiles[0];
      if (!tile) throw new Error('expected tile');
      expect(await readArtifactBytes(config.DATA_DIR, 'images', 'alice', tile.id, 'mp4', 'video/mp4')).toBeNull();
    });
  }

  for (const failure of ['sync', 'async'] as const) {
    test(`${failure} post-storage cleanup failure preserves the completed artifact`, async () => {
      const { db, config, logger } = testRuntime();
      setFfmpegRunnerForTests(() => Promise.resolve(sourceBytes));
      const provider: Provider = {
        id: 'mock-i2v', backend: 'local',
        async *generate(req): AsyncIterable<ProviderResult> {
          await Promise.resolve();
          yield { status: 'ready', bytes: mp4Bytes, ext: 'mp4', mime: 'video/mp4', seed: req.seed, index: 0,
            afterStored: () => {
              if (failure === 'sync') throw new Error('synthetic cleanup failure');
              return Promise.reject(new Error('synthetic cleanup failure'));
            } };
        },
      };
      const registryEntry = i2vRegistryEntry(provider);
      const request = { prompt: 'continue', modelId: 'minimax-h3-i2v', ratio: '16:9' as const, count: 1 };
      const prepared = createBatch(db, 'alice', request, registryEntry);
      await runBatchPipeline(prepared, {
        db, config, logger, userId: 'alice', request, registryEntry, boundProvider: provider,
        disconnectSignal: new AbortController().signal,
        onTileSettled: () => undefined, onSyncFailure: () => undefined,
      });
      expect(db.query('SELECT status FROM tiles WHERE batch_id = ?').get(prepared.batch.id)).toEqual({ status: 'done' });
    });
  }

  test('text-to-video emits native progress and receives its scaled execution budget without a source still', async () => {
    const { db, config, logger } = testRuntime();
    setFfmpegRunnerForTests(() => Promise.resolve(sourceBytes));
    let budget: number | undefined;
    const provider: Provider = {
      id: 'mock-t2v', backend: 'local',
      async *generate(req, _signal, options): AsyncIterable<ProviderResult> {
        expect(req.i2vSource).toBeUndefined();
        budget = options?.executionTimeoutMs;
        options?.onProgress?.({ progress: 0.5, phase: 'sampling' });
        await Promise.resolve();
        yield { status: 'ready', bytes: mp4Bytes, ext: 'mp4', mime: 'video/mp4', seed: req.seed, index: 0 };
      },
    };
    const registryEntry = i2vRegistryEntry(provider);
    registryEntry.model = { ...registryEntry.model, id: 'minimax-h3-t2v', supportsI2V: false };
    registryEntry.defaultSteps = 8;
    registryEntry.timeoutMs = ({ localVideo }) => localVideo;
    writeModelStepsOverride(db, 'alice', 'minimax-h3-t2v', 100, 8);
    const stream = createGenerationStream({
      db, config, logger, userId: 'alice',
      request: { prompt: 'a landscape', modelId: 'minimax-h3-t2v', ratio: '16:9', count: 1, durationFrames: 362 },
      registryEntry, boundProvider: provider, disconnectSignal: new AbortController().signal,
      onTileSettled: () => undefined, onSyncFailure: () => undefined,
    });
    const events = parseSseText(await new Response(stream).text());
    expect(events.some((event) => event.event === 'tile' && isObject(event.data) && event.data.status === 'progress'
      && event.data.progress === 0.5)).toBe(true);
    expect(budget).toBe(Math.ceil(config.LOCAL_VIDEO_TIMEOUT_MS * 100 / 8 * 362 / 124));
  });

  test('threads persisted source bytes, prewarms poster, and emits progress before mp4 done', async () => {
    const { db, config, logger } = testRuntime();
    const uploadId = crypto.randomUUID();
    seedUploadRow(db, 'alice', uploadId, 'png', 'image/png', sourceBytes.byteLength);
    await writeAtomic(config.DATA_DIR, 'uploads', 'alice', uploadId, 'png', sourceBytes);
    const posterFrame = await grayCardPng(32);
    setFfmpegRunnerForTests(() => Promise.resolve(posterFrame));

    const seenRequests: ProviderRequest[] = [];
    const provider: Provider = {
      id: 'mock-i2v',
      backend: 'local',
      async *generate(
        req: ProviderRequest,
        _signal: AbortSignal,
        options?: ProviderGenerateOptions,
      ): AsyncIterable<ProviderResult> {
        seenRequests.push(req);
        options?.onProgress?.({ progress: 0.25, phase: 'sampling' });
        options?.onProgress?.({ progress: 0.75, phase: 'decoding' });
        await Promise.resolve();
        yield {
          status: 'ready',
          bytes: mp4Bytes,
          ext: 'mp4',
          mime: 'video/mp4',
          seed: req.seed,
          index: 0,
        };
      },
    };

    const stream = createGenerationStream({
      db,
      config,
      logger,
      userId: 'alice',
      request: {
        prompt: 'animate the still',
        modelId: 'minimax-h3-i2v',
        ratio: '16:9',
        count: 1,
        i2vSourceUploadId: uploadId,
        motionPrompt: 'slow push in',
      },
      registryEntry: i2vRegistryEntry(provider),
      boundProvider: provider,
      disconnectSignal: new AbortController().signal,
      onTileSettled: () => undefined,
      onSyncFailure: () => undefined,
    });

    const events = parseSseText(await new Response(stream).text());
    const tileRows = db
      .query<{ id: string; ext: string | null; mime: string | null }, []>(
        'SELECT id, ext, mime FROM tiles ORDER BY tile_index ASC',
      )
      .all();
    const tile = tileRows[0];
    if (tile === undefined) throw new Error('expected tile row');
    const seenRequest = seenRequests[0];
    if (seenRequest === undefined) throw new Error('expected provider request');

    expect(seenRequest.i2vSource?.bytes).toEqual(sourceBytes);
    expect(seenRequest.i2vSource?.ext).toBe('png');
    expect(seenRequest.motionPrompt).toBe('slow push in');
    const written = await readArtifactBytes(config.DATA_DIR, 'images', 'alice', tile.id, 'mp4', 'video/mp4');
    expect(written?.bytes).toEqual(mp4Bytes);
    const thumb = await waitForThumb(config.DATA_DIR, 'alice', tile.id);
    expect(thumb?.mime).toBe('image/webp');

    const progressEvents = events.filter((event) =>
      event.event === 'tile' && isObject(event.data) && event.data.status === 'progress'
    );
    expect(progressEvents.length).toBeGreaterThanOrEqual(1);
    expect(progressEvents[0]?.data).toMatchObject({
      tileId: tile.id,
      tileIndex: 0,
      status: 'progress',
      progress: 0.25,
      phase: 'sampling',
    });
    const doneIndex = events.findIndex((event) =>
      event.event === 'tile' && isObject(event.data) && event.data.status === 'done'
    );
    const firstProgressIndex = events.findIndex((event) =>
      event.event === 'tile' && isObject(event.data) && event.data.status === 'progress'
    );
    expect(firstProgressIndex).toBeGreaterThanOrEqual(0);
    expect(doneIndex).toBeGreaterThan(firstProgressIndex);
    expect(events[doneIndex]?.data).toMatchObject({ status: 'done', ext: 'mp4', mime: 'video/mp4' });
    expect(tile.ext).toBe('mp4');
    expect(tile.mime).toBe('video/mp4');
  });

  test('poster extraction failure does not fail the mp4 tile', async () => {
    const { db, config, logger } = testRuntime();
    const uploadId = crypto.randomUUID();
    seedUploadRow(db, 'alice', uploadId, 'png', 'image/png', sourceBytes.byteLength);
    await writeAtomic(config.DATA_DIR, 'uploads', 'alice', uploadId, 'png', sourceBytes);
    setFfmpegRunnerForTests(() => Promise.reject(new Error('poster failed')));

    const provider: Provider = {
      id: 'mock-i2v',
      backend: 'local',
      async *generate(req: ProviderRequest): AsyncIterable<ProviderResult> {
        await Promise.resolve();
        yield {
          status: 'ready',
          bytes: mp4Bytes,
          ext: 'mp4',
          mime: 'video/mp4',
          seed: req.seed,
          index: 0,
        };
      },
    };

    const stream = createGenerationStream({
      db,
      config,
      logger,
      userId: 'alice',
      request: {
        prompt: 'animate the still',
        modelId: 'minimax-h3-i2v',
        ratio: '16:9',
        count: 1,
        i2vSourceUploadId: uploadId,
      },
      registryEntry: i2vRegistryEntry(provider),
      boundProvider: provider,
      disconnectSignal: new AbortController().signal,
      onTileSettled: () => undefined,
      onSyncFailure: () => undefined,
    });

    const events = parseSseText(await new Response(stream).text());
    const done = events.find((event) =>
      event.event === 'tile' && isObject(event.data) && event.data.status === 'done'
    );

    expect(done?.data).toMatchObject({ status: 'done', ext: 'mp4', mime: 'video/mp4' });
    expect(db.query<{ status: string; ext: string | null; mime: string | null }, []>('SELECT status, ext, mime FROM tiles').get())
      .toMatchObject({ status: 'done', ext: 'mp4', mime: 'video/mp4' });
  });

  test('emits done without waiting for poster prewarm to finish', async () => {
    const { db, config, logger } = testRuntime();
    const uploadId = crypto.randomUUID();
    seedUploadRow(db, 'alice', uploadId, 'png', 'image/png', sourceBytes.byteLength);
    await writeAtomic(config.DATA_DIR, 'uploads', 'alice', uploadId, 'png', sourceBytes);
    let releasePoster: ((bytes: Uint8Array) => void) | undefined;
    setFfmpegRunnerForTests(() => new Promise<Uint8Array>((resolve) => { releasePoster = resolve; }));

    const provider: Provider = {
      id: 'mock-i2v',
      backend: 'local',
      async *generate(req: ProviderRequest): AsyncIterable<ProviderResult> {
        await Promise.resolve();
        yield {
          status: 'ready',
          bytes: mp4Bytes,
          ext: 'mp4',
          mime: 'video/mp4',
          seed: req.seed,
          index: 0,
        };
      },
    };

    const stream = createGenerationStream({
      db,
      config,
      logger,
      userId: 'alice',
      request: {
        prompt: 'animate the still',
        modelId: 'minimax-h3-i2v',
        ratio: '16:9',
        count: 1,
        i2vSourceUploadId: uploadId,
      },
      registryEntry: i2vRegistryEntry(provider),
      boundProvider: provider,
      disconnectSignal: new AbortController().signal,
      onTileSettled: () => undefined,
      onSyncFailure: () => undefined,
    });

    const textPromise = new Response(stream).text();
    try {
      const result = await Promise.race([
        textPromise.then((text) => ({ kind: 'text' as const, text })),
        new Promise<{ kind: 'timeout' }>((resolve) => { setTimeout(() => { resolve({ kind: 'timeout' }); }, 75); }),
      ]);
      expect(result.kind).toBe('text');
      if (result.kind === 'text') {
        const events = parseSseText(result.text);
        expect(events.some((event) =>
          event.event === 'tile' && isObject(event.data) && event.data.status === 'done'
        )).toBe(true);
      }
    } finally {
      await within(textPromise).catch(() => '');
      await until(() => releasePoster !== undefined);
      const tile = db.query<{ id: string }, []>('SELECT id FROM tiles').get();
      const publication = tile
        ? ensureThumbnail({ db, dataDir: config.DATA_DIR, userId: 'alice', tileId: tile.id,
          ext: 'mp4', mime: 'video/mp4', logger, sourceBytes: mp4Bytes })
        : undefined;
      releasePoster?.(await grayCardPng(32));
      if (publication) await within(publication);
    }

    const tile = db
      .query<{ id: string; status: string; ext: string | null; mime: string | null }, []>('SELECT id, status, ext, mime FROM tiles')
      .get();
    expect(tile).toMatchObject({ status: 'done', ext: 'mp4', mime: 'video/mp4' });
    if (!tile) throw new Error('expected tile row');
    const written = await readArtifactBytes(config.DATA_DIR, 'images', 'alice', tile.id, 'mp4', 'video/mp4');
    expect(written?.bytes).toEqual(mp4Bytes);
  });
});

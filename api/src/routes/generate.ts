import { Hono, type Context } from 'hono';
import type { ApiErrorCode } from '@atelier/shared';
import { RETRY_AFTER_FIELD } from '@atelier/shared';
import type { ResolvedGenerateRequest } from '../orchestrator';
import { createBatch } from '../orchestrator/createBatch';
import { RefImagesNotFoundError, refImageByteTotal } from '../orchestrator/refImages';
import { reportIfCorruption } from '../db/integrity';
import { isUniqueConstraintError } from '../db/constraints';
import { findBatchByIdempotencyKey } from '../db/idempotency';
import type { BatchRow } from '../db/types';
import { adoptStandaloneBatch, appendSegment } from '../db/sequences';
import { countInflightVideoForUser, countQueuedForUser, transitionQueuedToRunning } from '../db/queueOps';
import * as queue from '../orchestrator/queue';
import * as bus from '../orchestrator/bus';
import { scheduleDequeueNext } from '../orchestrator/dequeue';
import {
  buildDequeueContext,
  kickQueues,
  startPrepared,
  type DispatchDeps,
} from '../orchestrator/dispatch';
import { failBatchTerminally } from '../orchestrator/failBatchTerminally';
import {
  acquireForPool,
  createReservationReleaser,
  releaseForPool,
} from '../orchestrator/concurrency';
import { needsQueuedPromptPreparation, prepareQueuedPrompts } from '../orchestrator/queuedPromptPreparation';
import {
  capsForPool,
  findModel,
  isLocalModelGated,
  registryForConfig,
  type RegistryEntry,
} from '../providers/registry';
import type { AppEnv } from '../server-env';
import { GenerateRequestSchema } from './generate.schema';
import { buildReplayResponse } from './generate.replay';
import { extensionErrorResponse, invalidFieldResponse, parseBody } from './_http';
import { uploadArtifactExists } from '../storage/uploadStore';
import { preRegisterBatch } from '../orchestrator/registry';
import { isPaused } from '../orchestrator/upstreamGate';
import { isStorageSealed } from '../storage/crypto';
import { validateExtension, type ExtensionCheck } from '../orchestrator/extendValidation';

class ExtensionSubmitError extends Error {
  constructor(readonly kind: Exclude<ExtensionCheck['status'], 'ok'>) {
    super(kind);
    this.name = 'ExtensionSubmitError';
  }
}

type GenerateSubmitRaceHook = (ctx: Readonly<{
  db: AppEnv['Variables']['db'];
  userId: string;
  request: ResolvedGenerateRequest;
}>) => void;

let generateSubmitRaceHookForTests: GenerateSubmitRaceHook | null = null;

export function setGenerateSubmitRaceHookForTests(hook: GenerateSubmitRaceHook | null): void {
  generateSubmitRaceHookForTests = hook;
}

function depsFromContext(c: Context<AppEnv>): DispatchDeps {
  return {
    db: c.var.db,
    config: c.var.config,
    logger: c.var.logger,
    keyStore: c.var.keyStore,
    healthSnapshot: c.var.healthSnapshot,
  };
}

// Async, non-blocking pre-flight check of reference-image artifacts.
//
// This MUST run OUTSIDE the /generate write transaction. The earlier
// synchronous `existsSync` variant ran inside `db.transaction(...)` while
// the WAL writer lock was held — up to 10 blocking `stat(2)` calls per
// generate request, serializing every other writer on disk latency. The
// async stat fan-out below keeps the event loop free and the writer lock
// short. Returns `true` if every (schema-deduplicated) upload row exists AND
// its artifact file is on disk; `false` if any row or file is missing.
async function refArtifactsExist(
  db: AppEnv['Variables']['db'],
  dataDir: string,
  userId: string,
  refImageIds: readonly string[],
): Promise<boolean> {
  const results = await Promise.all(
    refImageIds.map((id) => uploadArtifactExists(db, dataDir, userId, id)),
  );
  return results.every((ok) => ok);
}

function uploadRowExists(
  db: AppEnv['Variables']['db'],
  userId: string,
  uploadId: string,
): boolean {
  return db
    .query<{ one: number }, [string, string]>(
      'SELECT 1 AS one FROM uploads WHERE user_id = ? AND id = ?',
    )
    .get(userId, uploadId) !== null;
}


export const generateRoutes = new Hono<AppEnv>().post('/generate', async (c) => {
  const parsed = await parseBody(c, GenerateRequestSchema);
  if (!parsed.ok) return parsed.response;

  const userId = c.var.userId;
  // Idempotent replay: a known key names one of this user's batches, which
  // answers 200 in the creation shape and runs no admission, reservation,
  // enqueue or dispatch. This precedes model and availability validation on
  // purpose, so a batch created on a since-retired or offline model still
  // replays. Not handled: a same-key request that fails a pre-transaction gate
  // because a concurrent same-key request committed first. The client never
  // sends two concurrent requests with one key (one unanswered POST per drain,
  // one key per press), so that race has no caller.
  const idempotencyKey = parsed.value.idempotencyKey;
  const replay = (batch: BatchRow) => {
    c.var.logger.info({ batchId: batch.id, event: 'generate_replayed' }, 'generate replayed an existing batch');
    return c.json(buildReplayResponse(c.var.db, batch), 200);
  };
  if (idempotencyKey !== undefined) {
    const existing = findBatchByIdempotencyKey(c.var.db, userId, idempotencyKey);
    if (existing) return replay(existing);
  }
  const entry = findModel(parsed.value.modelId, c.var.config);
  if (!entry || isLocalModelGated(c.var.config, userId, entry)) {
    return invalidFieldResponse(c, 'modelId', 'unknown modelId');
  }
  if (!entry.model.supportedRatios.includes(parsed.value.ratio)) {
    return invalidFieldResponse(c, 'ratio', 'unsupported ratio for modelId');
  }
  if (
    parsed.value.durationFrames !== undefined
    && entry.model.supportedDurations?.includes(parsed.value.durationFrames) !== true
  ) {
    return invalidFieldResponse(c, 'durationFrames', 'unsupported durationFrames for modelId');
  }

  // Race-guard against a stale models list. The /api/models response carries
  // the snapshot at fetch time; if the upstream host went offline between the
  // user opening the picker and submitting, we'd otherwise queue a request
  // that's guaranteed to fail at the provider call. Returning 503 here lets
  // the client invalidate the models query and flip the chip to disabled.
  const availability = c.var.healthSnapshot().get(entry.model.id);
  if (availability && !availability.ok) {
    // `availability.reason` is now a closed-vocabulary token (see
    // `@atelier/shared::ModelAvailabilityReason` and
    // `lifecycle/health-probe.ts::sanitizeProbeReason`) — the raw `err.message`
    // that used to carry LAN host:port is sanitized at the probe boundary. We
    // still don't repeat the category on the 503 wire surface; the operational
    // 'MODEL_OFFLINE' code is the only public payload. Keeps the spirit of
    // architecture_invariants §3 — "NO file paths, NO appended hints" — even
    // though the upstream leak is already plugged at the source.
    c.var.logger.warn(
      { modelId: entry.model.id, reason: availability.reason },
      'model offline at submission',
    );
    return c.json(
      { error: 'model offline', code: 'MODEL_OFFLINE' satisfies ApiErrorCode },
      503,
    );
  }

  const supportsI2V = entry.model.supportsI2V === true;
  const isVideoModel = entry.model.outputsVideo === true;
  // T2V and I2V share one per-user in-flight budget: both hold the single
  // local GPU slot for minutes, so the cap counts every video model.
  const videoModelIds = isVideoModel
    ? registryForConfig(c.var.config)
        .filter((candidate) => candidate.model.outputsVideo === true)
        .map((candidate) => candidate.model.id)
    : [];
  if (parsed.value.extendsTileId !== undefined && !supportsI2V) {
    return invalidFieldResponse(c, 'extendsTileId', 'model does not support video extension');
  }
  if (supportsI2V) {
    const i2vSourceUploadId = parsed.value.i2vSourceUploadId;
    if (!i2vSourceUploadId) {
      return invalidFieldResponse(c, 'i2vSourceUploadId', 'i2vSourceUploadId is required for this model');
    }
    if (!(await uploadArtifactExists(c.var.db, c.var.config.DATA_DIR, userId, i2vSourceUploadId))) {
      return c.json({ error: 'upload not found' }, 404);
    }
    if (parsed.value.extendsTileId !== undefined) {
      const extension = validateExtension(
        c.var.db,
        userId,
        parsed.value.extendsTileId,
        i2vSourceUploadId,
        parsed.value.ratio,
        c.var.config.MAX_SEQUENCE_SEGMENTS,
      );
      if (extension.status !== 'ok') return extensionErrorResponse(c, extension.status);
    }
  }
  if (isVideoModel) {
    if (parsed.value.count !== 1) {
      return invalidFieldResponse(c, 'count', 'video models require count 1');
    }
    if (countInflightVideoForUser(c.var.db, userId, videoModelIds) >= c.var.config.MAX_INFLIGHT_VIDEO_PER_USER) {
      return c.json({
        error: 'video generation already in progress',
        code: 'VIDEO_BUSY' satisfies ApiErrorCode,
      }, 429);
    }
  }

  const registryEntry: RegistryEntry = entry;
  const gate = entry.model.requiresKey;
  let keyPlaintext: string | undefined;
  let touchRequiredKey: (() => Promise<void>) | undefined;
  if (gate) {
    const keyStore = c.var.keyStore;
    if (!keyStore) {
      return c.json({ error: 'byok-not-configured' as const }, 503);
    }
    let loaded: Awaited<ReturnType<typeof keyStore.load>>;
    try {
      loaded = await keyStore.load(userId, gate.provider);
    } catch (err) {
      // Master-key rotation without re-encrypt is unrecoverable.
      // Surface every decrypt failure at error-level with a structured event
      // so an operator can spot the symptom in stdout — a burst of these from
      // multiple users in seconds = master key changed under live ciphertext.
      c.var.logger.error(
        { err, event: 'byok_decrypt_failure', provider: gate.provider, userId },
        'BYOK key decrypt failed; treating as missing',
      );
      return c.json({ error: 'BYOK key required', code: 'NEEDS_GOOGLE_KEY' satisfies ApiErrorCode }, 400);
    }
    if (!loaded) {
      return c.json({ error: 'BYOK key required', code: 'NEEDS_GOOGLE_KEY' satisfies ApiErrorCode }, 400);
    }
    keyPlaintext = loaded.plaintext;
    touchRequiredKey = () => keyStore.touch(userId, gate.provider);
  }
  const boundProvider = registryEntry.bind(
    keyPlaintext === undefined ? {} : { keyPlaintext },
  );

  const refImageIds = parsed.value.refImageIds;
  if (refImageIds && refImageIds.length > 0) {
    if (registryEntry.model.supportsReferenceImages !== true) {
      return invalidFieldResponse(c, 'refImageIds', 'model does not support reference images');
    }
    const modelCap = registryEntry.model.maxRefImages ?? 0;
    if (refImageIds.length > modelCap) {
      return invalidFieldResponse(c, 'refImageIds', `model accepts at most ${modelCap} reference images`);
    }
    const totalBytes = refImageByteTotal(c.var.db, userId, refImageIds);
    if (totalBytes === null) return c.json({ error: 'upload not found' }, 404);
    if (totalBytes > c.var.config.MAX_REF_BYTES_PER_BATCH) {
      return c.json({ error: 'reference images exceed per-batch byte budget' }, 400);
    }
  }

  const pool = registryEntry.model.pool;
  const caps = capsForPool(c.var.config, pool);
  const tileCount = parsed.value.count;
  // Batched Krea models run all N images in a single GPU job,
  // so only 1 pool slot is acquired regardless of image count. Non-batched
  // models reserve one slot per tile.
  const isBatchedModel = registryEntry.model.batched === true;
  const acquireCount = isBatchedModel ? 1 : tileCount;
  const poolMaxAcquirable = Math.min(
    caps.globalCap ?? Number.POSITIVE_INFINITY,
    caps.perUserCap,
  );
  if (acquireCount > poolMaxAcquirable) {
    return c.json({ error: 'count exceeds pool capacity', code: 'COUNT_EXCEEDS_POOL' satisfies ApiErrorCode }, 400);
  }
  // A batched model renders every tile in one job, so the pool check above
  // never sees the image count; enforce the published per-job cap
  // (COMFYUI_BATCH_MAX for local rows) here so a stale client cannot exceed it.
  if (isBatchedModel && tileCount > registryEntry.model.maxCountPerBatch) {
    return c.json({ error: 'count exceeds model batch capacity', code: 'COUNT_EXCEEDS_POOL' satisfies ApiErrorCode }, 400);
  }

  // Video models always carry a concrete clip length downstream — the workflow
  // declares {{videoFrames}} and buildWorkflow refuses to guess. Non-video
  // models never get one, so image batches keep a null duration_frames.
  const effectiveDurationFrames = entry.model.supportedDurations === undefined
    ? undefined
    : parsed.value.durationFrames ?? entry.model.defaultDuration;

  // The batch is created with the prompt AS SUBMITTED. Krea condensation is an
  // LLM call that used to run right here, ahead of the 201 — see
  // orchestrator/condenseBatchPrompt for why it now runs in the worker instead.
  try {
    const request: ResolvedGenerateRequest = {
      prompt: parsed.value.prompt,
      modelId: parsed.value.modelId,
      ratio: parsed.value.ratio,
      count: parsed.value.count,
      ...(parsed.value.seed === undefined ? {} : { seed: parsed.value.seed }),
      ...(refImageIds ? { refImageIds } : {}),
      ...(supportsI2V && parsed.value.i2vSourceUploadId ? { i2vSourceUploadId: parsed.value.i2vSourceUploadId } : {}),
      ...(supportsI2V && parsed.value.motionPrompt !== undefined ? { motionPrompt: parsed.value.motionPrompt } : {}),
      ...(parsed.value.extendsTileId !== undefined ? { extendsTileId: parsed.value.extendsTileId } : {}),
      // Resolve the effective clip length HERE rather than at the workflow
      // boundary: the value is persisted on the batch row and re-read on
      // re-dispatch, so a default applied later would not survive a requeue.
      ...(effectiveDurationFrames !== undefined ? { durationFrames: effectiveDurationFrames } : {}),
      ...(parsed.value.provenance ? { provenance: parsed.value.provenance } : {}),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    };
    // FS pre-flight runs OUTSIDE the write transaction. The earlier
    // synchronous existsSync inside `db.transaction(...)` held the SQLite
    // writer lock across every ref-image `stat(2)` syscall, serializing
    // every other writer on disk latency. The async fan-out below keeps
    // the writer lock to the minimum DB writes below. Also collapses the
    // earlier double-released-on-failure race: `acquireForPool` now only
    // runs after this check passes, so there is no "acquire-then-bail"
    // path that could mismatch JS-counter mutation vs a rolled-back txn.
    if (refImageIds && !(await refArtifactsExist(c.var.db, c.var.config.DATA_DIR, userId, refImageIds))) {
      return c.json({ error: 'upload not found' }, 404);
    }

    type CreateOutcome =
      | { kind: 'queue-full' }
      | { kind: 'video-busy' }
      | { kind: 'i2v-source-missing' }
      | { kind: 'replay'; batch: BatchRow }
      | { kind: 'ok'; prepared: ReturnType<typeof createBatch> };

    const created = c.var.db.transaction((): CreateOutcome => {
      generateSubmitRaceHookForTests?.({ db: c.var.db, userId, request });
      // Look the key up again under the write lock: a same-key request may
      // have committed since the pre-validation lookup.
      if (idempotencyKey !== undefined) {
        const existing = findBatchByIdempotencyKey(c.var.db, userId, idempotencyKey);
        if (existing) return { kind: 'replay', batch: existing };
      }
      if (countQueuedForUser(c.var.db, userId) >= c.var.config.MAX_QUEUED_BATCHES_PER_USER) {
        return { kind: 'queue-full' };
      }
      if (isVideoModel) {
        if (countInflightVideoForUser(c.var.db, userId, videoModelIds) >= c.var.config.MAX_INFLIGHT_VIDEO_PER_USER) {
          return { kind: 'video-busy' };
        }
      }
      if (supportsI2V) {
        if (!request.i2vSourceUploadId || !uploadRowExists(c.var.db, userId, request.i2vSourceUploadId)) {
          return { kind: 'i2v-source-missing' };
        }
      }
      let extension: Extract<ExtensionCheck, { status: 'ok' }> | undefined;
      if (request.extendsTileId !== undefined && request.i2vSourceUploadId !== undefined) {
        const checked = validateExtension(
          c.var.db,
          userId,
          request.extendsTileId,
          request.i2vSourceUploadId,
          request.ratio,
          c.var.config.MAX_SEQUENCE_SEGMENTS,
        );
        if (checked.status !== 'ok') throw new ExtensionSubmitError(checked.status);
        extension = checked;
      }
      const prepared = createBatch(c.var.db, userId, request, registryEntry);
      if (extension) {
        let sequenceId = extension.source.sequence_id;
        if (sequenceId === null) {
          const adopted = adoptStandaloneBatch(c.var.db, userId, extension.source.batch_id);
          if (adopted.status === 'conflict') throw new ExtensionSubmitError('not-tail');
          sequenceId = adopted.sequenceId;
        }
        const appended = appendSegment(
          c.var.db,
          c.var.logger,
          userId,
          sequenceId,
          extension.source.batch_id,
          prepared.batch.id,
        );
        if (appended.status !== 'ok') throw new ExtensionSubmitError('not-tail');
        prepared.batch.sequence_id = appended.sequenceId;
        prepared.batch.sequence_index = appended.sequenceIndex;
      }
      return { kind: 'ok', prepared };
    }).immediate();

    if (created.kind === 'replay') return replay(created.batch);
    if (created.kind === 'queue-full') {
      return c.json({ error: 'queue full', code: 'QUEUE_FULL' satisfies ApiErrorCode, [RETRY_AFTER_FIELD]: 5 }, 429);
    }
    if (created.kind === 'video-busy') {
      return c.json({
        error: 'video generation already in progress',
        code: 'VIDEO_BUSY' satisfies ApiErrorCode,
      }, 429);
    }
    if (created.kind === 'i2v-source-missing') {
      return c.json({ error: 'upload not found' }, 404);
    }

    const prepared = created.prepared;
    // Sealed artifact storage queues instead of starting: the batch may need
    // to read stored refs/sources, and dequeue resumes it on unseal.
    const needsPreparation = pool === 'local' && needsQueuedPromptPreparation(request.modelId, request.prompt);
    // Every pool keeps this user's accepted queue order even if a newer,
    // smaller request could acquire capacity before its queued predecessor.
    const hasQueuedPredecessor = queue.entries(pool).some((entry) => entry.userId === userId);
    const acquired = hasQueuedPredecessor || needsPreparation || isPaused(pool) || isStorageSealed()
      ? ({ ok: false, reason: 'global' } as const)
      : acquireForPool(pool, userId, acquireCount, capsForPool(c.var.config, pool));
    let queued = false;
    if (acquired.ok) {
      try {
        c.var.db.transaction(() => {
          prepared.batch.started_at = transitionQueuedToRunning(c.var.db, prepared.batch.id, c.var.logger);
        })();
      } catch (error) {
        releaseForPool(pool, userId, acquireCount);
        try {
          failBatchTerminally(c.var.db, c.var.config, c.var.logger, prepared.batch.id, 'internal error', {
            close: () => { bus.closeBatch(prepared.batch.id); },
          });
        } catch (cleanupError) {
          c.var.logger.error(
            { err: cleanupError, batchId: prepared.batch.id },
            'generate mark-running cleanup failed',
          );
        }
        throw error;
      }
      prepared.batch.status = 'running';
      queue.noteDispatched(pool, parsed.value.modelId);
    } else {
      queue.enqueue(pool, {
        batchId: prepared.batch.id,
        userId,
        modelId: parsed.value.modelId,
        count: acquireCount,
        queuedAt: prepared.batch.created_at,
      });
      queued = true;
    }

    const queueEpoch = queue.currentEpoch();
    const reservation = createReservationReleaser(
      queued ? 0 : acquireCount,
      (count) => { releaseForPool(pool, userId, count); },
      () => { scheduleDequeueNext(pool, buildDequeueContext(depsFromContext(c), queueEpoch)); },
    );

    if (!queued) {
      preRegisterBatch(prepared.batch.id, userId, prepared.tiles.map((tile) => tile.id));
      void startPrepared(depsFromContext(c), prepared, {
        userId,
        request,
        registryEntry,
        boundProvider,
        reservation,
        touchRequiredKey,
      });
    }
    if (queued) {
      prepareQueuedPrompts(c.var.db);
      const deps = depsFromContext(c);
      queueMicrotask(() => { kickQueues(deps); });
    }

    return c.json({
      batchId: prepared.batch.id,
      tiles: prepared.tiles.map((tile) => ({
        tileId: tile.id,
        tileIndex: tile.tile_index,
        seed: tile.seed,
      })),
      status: queued ? ('queued' as const) : ('running' as const),
      pool,
      ...(queued ? { queueLengthAhead: queue.positionOf(pool, prepared.batch.id) } : {}),
      ...(refImageIds ? { refImageIds } : {}),
    }, 201);
  } catch (error) {
    if (error instanceof ExtensionSubmitError) return extensionErrorResponse(c, error.kind);
    if (error instanceof RefImagesNotFoundError) return c.json({ error: 'upload not found' }, 404);
    // Final guard behind the in-transaction lookup: the per-user partial
    // UNIQUE index refused a duplicate key. Match the index column too, since
    // idx_batches_sequence_index is also UNIQUE on batches.
    if (
      idempotencyKey !== undefined
      && isUniqueConstraintError(error, 'batches')
      && error instanceof Error
      && error.message.includes('idempotency_key')
    ) {
      const existing = findBatchByIdempotencyKey(c.var.db, userId, idempotencyKey);
      if (existing) return replay(existing);
    }
    // This catch consumes the batch-insert transaction's errors, so they never
    // reach the global onError corruption tagging; a damaged FTS index would
    // otherwise surface here as a bare 'failed to start generation'.
    if (!reportIfCorruption(error, c.var.logger, { phase: 'generate' })) {
      c.var.logger.error({ err: error }, 'failed to start generation');
    }
    return c.json({ error: 'internal error' }, 500);
  }
});

// Server-wide dispatch runtime: queue kicks, upstream-gate wiring, and the
// start of an accepted batch (immediate from POST /generate, or dequeued).
// Routes and boot import it; it never imports a route.
import type { Database } from 'bun:sqlite';
import type { TextServices } from '../routing/textServices';
import { isVideoDurationFrames } from '@atelier/shared';
import type { Config } from '../config';
import { BATCH_COLUMNS, TILE_COLUMNS } from '../db/columns';
import type { BatchRow, TileRow } from '../db/types';
import type { KeyStore } from '../keystore';
import type { AppLogger } from '../observability/logger';
import { runBatchPipeline, type PreparedBatch, type ResolvedGenerateRequest } from '../orchestrator';
import { capsForPool, findModel, type RegistryEntry } from '../providers/registry';
import type { Provider } from '../providers/types';
import type { HealthSnapshot } from '../server-env';
import { UserCanceledError } from './cancellation';
import { acquireForPool, releaseForPool, type ReservationReleaser } from './concurrency';
import { kickDequeueNext, type DequeueRuntimeContext } from './dequeue';
import * as queue from './queue';
import type { QueueEntry } from './queue';
import { prepareQueuedPrompts } from './queuedPromptPreparation';
import { refImageIdsForBatch } from './refImages';
import { preRegisterBatch, setBatchDonePromise, unregisterBatch } from './registry';
import { failBatchAtDequeue } from './revalidate';
import { startOrchestratorDetached } from './startDetached';
import { configureUpstreamGate } from './upstreamGate';

export interface DispatchDeps {
  db: Database;
  config: Config;
  logger: AppLogger;
  keyStore: KeyStore | undefined;
  healthSnapshot: HealthSnapshot;
  /** Text-model routing for the pipeline's fallback prompt condensation. */
  text: TextServices;
}

export function kickQueues(deps: DispatchDeps): void {
  const queueEpoch = queue.currentEpoch();
  kickDequeueNext('shared', buildDequeueContext(deps, queueEpoch));
  kickDequeueNext('byok', buildDequeueContext(deps, queueEpoch));
  kickDequeueNext('local', buildDequeueContext(deps, queueEpoch));
}

export function configureUpstreamGateWiring(deps: DispatchDeps): void {
  configureUpstreamGate({
    threshold: deps.config.IMAGE_BREAKER_THRESHOLD,
    halfOpenAfterMs: deps.config.IMAGE_BREAKER_HALF_OPEN_MS,
    maxPauseMs: deps.config.IMAGE_BREAKER_MAX_PAUSE_MS,
    kickPool: (pool) => {
      kickDequeueNext(pool, buildDequeueContext(deps, queue.currentEpoch()));
    },
    failQueued: (pool, reason) => {
      for (const entry of [...queue.entries(pool)]) {
        queue.removeById(pool, entry.batchId);
        failBatchAtDequeue(
          {
            db: deps.db,
            config: deps.config,
            logger: deps.logger,
            registry: { findModel, healthSnapshot: deps.healthSnapshot },
          },
          entry,
          reason,
        );
      }
    },
  });
}

export function buildDequeueContext(deps: DispatchDeps, queueEpoch: number): DequeueRuntimeContext {
  return {
    db: deps.db,
    config: deps.config,
    logger: deps.logger,
    registry: {
      findModel,
      healthSnapshot: deps.healthSnapshot,
    },
    acquireFor: (pool, queuedUserId, count) => acquireForPool(pool, queuedUserId, count, capsForPool(deps.config, pool)),
    releaseFor: (pool, queuedUserId, count) => { releaseForPool(pool, queuedUserId, count); },
    prepareQueued: () => prepareQueuedPrompts(deps.db),
    startOrchestratorDetached: (entry, reservation) => {
      const started = startQueuedEntry(deps, entry, reservation);
      setBatchDonePromise(entry.batchId, started);
      return started;
    },
    queueEpoch,
  };
}

export interface StartPreparedOptions {
  readonly userId: string;
  readonly request: ResolvedGenerateRequest;
  readonly registryEntry: RegistryEntry;
  readonly boundProvider: Provider;
  readonly reservation: ReservationReleaser;
  readonly touchRequiredKey: (() => Promise<void>) | undefined;
  /** The queue preparer already attempted prompt condensation. */
  readonly promptPrepared?: boolean;
}

// The one detached start shared by the immediate (/generate) and dequeued
// paths: the pipeline runs on the batch's own lifetime and releases its
// reservation per tile, with the remainder released on setup failure or
// settle.
export function startPrepared(
  deps: Pick<DispatchDeps, 'db' | 'config' | 'logger' | 'text'>,
  prepared: PreparedBatch,
  opts: StartPreparedOptions,
): Promise<void> {
  return startOrchestratorDetached(prepared, {
    db: deps.db,
    config: deps.config,
    logger: deps.logger,
    text: deps.text,
    userId: opts.userId,
    request: opts.request,
    registryEntry: opts.registryEntry,
    boundProvider: opts.boundProvider,
    promptPrepared: opts.promptPrepared === true,
    // Never-aborting placeholder. In the decoupled model the client watches
    // via GET /batches/:id/events, not the submitting request — /generate
    // returns 201 synchronously, so its request signal aborts on response
    // completion and would fire the disconnect handler on every generation.
    // Never wire batch teardown to a request signal.
    disconnectSignal: new AbortController().signal,
    onTileSettled: opts.reservation.releaseOne,
    onSyncFailure: opts.reservation.releaseRemaining,
    closeBatchOnCleanup: false,
    ...(opts.touchRequiredKey ? { onBatchSucceeded: opts.touchRequiredKey } : {}),
    runBatchPipeline,
  });
}

async function startQueuedEntry(deps: DispatchDeps, entry: QueueEntry, reservation: ReservationReleaser): Promise<void> {
  let handedOffToPipeline = false;
  try {
    const prepared = loadPreparedBatch(deps.db, entry.batchId, entry.userId);
    if (!prepared) throw new Error(`queued batch ${entry.batchId} disappeared before start`);
    const registered = preRegisterBatch(entry.batchId, entry.userId, prepared.tiles.map((tile) => tile.id));
    const registryEntry = findModel(prepared.batch.model_id, deps.config);
    if (!registryEntry) throw new Error(`queued batch ${entry.batchId} model disappeared before start`);

    const request = buildQueuedRequestForBatch(deps.db, prepared, registryEntry.model);

    let keyPlaintext: string | undefined;
    let touchRequiredKey: (() => Promise<void>) | undefined;
    const gate = registryEntry.model.requiresKey;
    if (gate) {
      const keyStore = deps.keyStore;
      if (!keyStore) throw new Error('queued BYOK batch cannot start without key store');
      const loaded = await keyStore.load(entry.userId, gate.provider);
      if (registered.batchController.signal.aborted) throw new UserCanceledError();
      if (!loaded) throw new Error('queued BYOK batch cannot start without user key');
      keyPlaintext = loaded.plaintext;
      touchRequiredKey = () => keyStore.touch(entry.userId, gate.provider);
      if (!queuedBatchStillRunnable(deps.db, entry.batchId, entry.userId)) {
        throw new Error(`queued batch ${entry.batchId} canceled before BYOK start`);
      }
    }

    const boundProvider = registryEntry.bind(
      keyPlaintext === undefined ? {} : { keyPlaintext },
    );
    // Queue admission reserves the original tile count before BYOK key load.
    // A per-tile DELETE in that await window can shrink the live DB rows, but
    // keeping the short-lived over-reservation avoids mutating pool counters
    // from the delete route and is acceptable at current sub-10-tile caps.
    handedOffToPipeline = true;
    await startPrepared(deps, prepared, {
      userId: entry.userId,
      request,
      registryEntry,
      boundProvider,
      reservation,
      touchRequiredKey,
      promptPrepared: entry.promptPreparation === 'ready',
    });
  } finally {
    if (!handedOffToPipeline) unregisterBatch(entry.batchId);
  }
}

function loadPreparedBatch(
  db: Database,
  batchId: string,
  userId: string,
): PreparedBatch | null {
  const batch = db
    .query<BatchRow, [string, string]>(`SELECT ${BATCH_COLUMNS} FROM batches WHERE id = ? AND user_id = ?`)
    .get(batchId, userId);
  if (!batch) return null;
  const tiles = db
    .query<TileRow, [string, string]>(
      `SELECT ${TILE_COLUMNS}
         FROM tiles
        WHERE batch_id = ? AND user_id = ?
        ORDER BY tile_index ASC`,
    )
    .all(batchId, userId);
  return { batch, tiles };
}

export function buildQueuedRequestForBatch(
  db: Database,
  prepared: PreparedBatch,
  model?: RegistryEntry['model'],
): ResolvedGenerateRequest {
  const refImageIds = refImageIdsForBatch(db, prepared.batch.id);
  // Batches queued BEFORE migration 0034 carry a NULL duration, and boot
  // re-enqueues them verbatim (queue.rebuildFromDb). Without this fallback the
  // rebuilt request omits durationFrames, buildWorkflow throws, and a render
  // the user already queued dies on deploy. The model default IS the length
  // those rows were rendered at, so the fallback is faithful, not a guess.
  const durationFrames = isVideoDurationFrames(prepared.batch.duration_frames)
    ? prepared.batch.duration_frames
    : model?.defaultDuration;
  return {
    prompt: prepared.batch.prompt,
    modelId: prepared.batch.model_id,
    ratio: prepared.batch.ratio,
    count: prepared.tiles.length,
    ...(refImageIds.length > 0 ? { refImageIds } : {}),
    ...(prepared.batch.i2v_source_upload_id
      ? { i2vSourceUploadId: prepared.batch.i2v_source_upload_id }
      : {}),
    ...(prepared.batch.motion_prompt
      ? { motionPrompt: prepared.batch.motion_prompt }
      : {}),
    ...(durationFrames !== undefined ? { durationFrames } : {}),
  };
}

export function queuedBatchStillRunnable(
  db: Database,
  batchId: string,
  userId: string,
): boolean {
  const row = db
    .query<{ status: string; archived_at: number | null; loading_count: number }, [string, string]>(
      `SELECT b.status, b.archived_at,
              (SELECT COUNT(*) FROM tiles t
                WHERE t.batch_id = b.id
                  AND t.user_id = b.user_id
                  AND t.status = 'loading'
                  AND t.archived_at IS NULL) AS loading_count
         FROM batches b
        WHERE b.id = ?
          AND b.user_id = ?`,
    )
    .get(batchId, userId);
  return row !== null
    && row.status === 'running'
    && row.archived_at === null
    && row.loading_count > 0;
}

import type { Database } from 'bun:sqlite';
import type { TextServices } from './routing/textServices';
import type {
  DoneEvent,
  GptModerationNotice,
  GptModerationReason,
  GenerateRequest,
  MediaExt,
  MediaMime,
  TileMime,
  TileErrorCategory,
  TileEvent,
} from '@atelier/shared';
import {
  DEFAULT_VIDEO_DURATION_FRAMES,
  VIDEO_CONTEXT_FRAMES,
  isVideoMime,
  renderedVideoFrames,
} from '@atelier/shared';
import type { Config } from './config';
import type { BatchRow, TileRow, UploadRow } from './db/types';
import { tileModeration } from './db/moderation';
import { SQL_LOADING_GUARD } from './db/tombstone';
import {
  KEEPALIVE_MS,
  encodeSseComment,
  encodeSseFrame,
  terminalFrame,
  type TerminalFrame,
  type TerminalTileEvent,
} from './lifecycle/sse';
import { TileTimeout, timeoutSignal } from './lifecycle/timeout';
import { bindBatchLogger, bindTileLogger, type AppLogger } from './observability/logger';
import { isUserCanceled } from './orchestrator/cancellation';
import {
  getOrCreateTileController,
  registerBatch,
  setBatchDonePromise,
  unregisterBatch,
  unregisterTile,
} from './orchestrator/registry';
import { sanitizedModerationNotice, sanitizeProviderError } from './orchestrator/sanitize';
import type { RegistryEntry } from './providers/registry';
import {
  isAllowedArtifact,
  toMediaMime,
  type Provider,
  type ProviderGenerateOptions,
  type ProviderProgress,
  type ProviderRequest,
  type ProviderResult,
} from './providers/types';
import { deleteArtifact, readArtifactBytes, writeAtomic } from './storage/files';
import { extractVideoTail } from './storage/videoTail';
import { withDecryptedArtifactFiles } from './storage/decryptedTemp';
import { resolveExtendSource } from './orchestrator/extendSource';
import { ensureThumbnail } from './storage/thumbnail';
import * as bus from './orchestrator/bus';
import { failBatchTerminally } from './orchestrator/failBatchTerminally';
import { finalizeBatch } from './orchestrator/finalize';
import { settleSequenceAfterBatchTerminal } from './orchestrator/sequenceLifecycle';
import { RefImagesNotFoundError, resolveRefImagesAfterReservation } from './orchestrator/refImages';
import { condenseBatchPrompt, persistCondensedPrompt } from './orchestrator/condenseBatchPrompt';
import { doneTileEvent } from './orchestrator/tileEvents';
import { readModelStepsOverride } from './routing/modelStepsPreference';

export interface ResolvedRefImage {
  bytes: Uint8Array;
  mime: TileMime;
}

export type ResolvedGenerateRequest = GenerateRequest & {
  refImages?: readonly ResolvedRefImage[];
  i2vSource?: NonNullable<ProviderRequest['i2vSource']>;
  i2vContext?: NonNullable<ProviderRequest['i2vContext']>;
  /** The user's base-sampler step override, resolved once per batch at dispatch. */
  steps?: number;
};

export interface GenerationContext {
  db: Database;
  config: Config;
  logger: AppLogger;
  /** Text-model routing for the fallback prompt condensation. */
  text: TextServices;
  userId: string;
  request: ResolvedGenerateRequest;
  registryEntry: RegistryEntry;
  /**
   * The `Provider` resolved from `registryEntry.bind(deps)` at request time.
   * Non-BYOK entries return a constant instance; BYOK entries construct the
   * adapter with the decrypted user key. The route owns the bind so the
   * orchestrator stays unaware of any per-request adapter dependencies.
   */
  boundProvider: Provider;
  disconnectSignal: AbortSignal;
  /**
   * Called once per tile after `runTile` settles (success, failure, or
   * abort). The route uses this to release one global concurrency slot per
   * tile so users can submit follow-up batches as soon as individual tiles
   * finish, instead of waiting for the rest of the batch.
   */
  onTileSettled: () => void;
  /**
   * Called on EVERY pre-`runTile` setup failure so the route can release the
   * slots it reserved up-front: both the pre-start ref-image resolution catch
   * and the synchronous-throw branch inside `start()`. Once any `runTile` is
   * scheduled, per-tile release goes through `onTileSettled` instead. The
   * route's implementation is idempotent (`outstanding`-guarded), so the
   * route's own outer catch calling it again is a harmless no-op.
   */
  onSyncFailure: () => void;
  /**
   * Called once after every tile in the batch reached the terminal `done`
   * state and the batch `done` SSE event has been queued.
   */
  onBatchSucceeded?: (() => Promise<void>) | undefined;
  closeBatchOnCleanup?: boolean | undefined;
  /** The queue preparer already attempted condensation, including fail-open. */
  promptPrepared?: boolean;
}

export interface PreparedBatch {
  batch: BatchRow;
  tiles: TileRow[];
}

type EmitTerminal = (frame: TerminalFrame) => void;
type EmitOptional = (makeFrame: () => Uint8Array) => void;

export async function runBatchPipeline(prepared: PreparedBatch, ctx: GenerationContext): Promise<void> {
  // Register the batch controller BEFORE the async ref-image load. Otherwise
  // there is a window where the loading rows are visible to a concurrent
  // DELETE /history but registry.getBatchForUser returns nothing, and a SIGTERM
  // shutdown's snapshotBatchControllers() can't see this not-yet-registered
  // batch. Caller must unregister on ANY setup failure so the registry
  // doesn't grow with phantom entries.
  const logger = bindBatchLogger(ctx.logger, prepared.batch.id);
  const batchController = new AbortController();
  // Register the SIGTERM-drain settle promise NOW, at registry time — not
  // later inside start(). registerBatch is what snapshotBatchControllers()
  // keys off; if the done-promise were only set inside start() (after the
  // `await resolveRefImagesAfterReservation` ref-load), a batch caught by
  // SIGTERM in that window would be aborted but invisible to
  // snapshotBatchDonePromises(), and db.close() could race its still-pending
  // writes — the exact failure the drain exists to prevent. settleBatchDone
  // is resolved on EVERY terminal path: the pre-start catch below, and the
  // start() success/sync-throw paths.
  let settleBatchDone: () => void = () => undefined;
  const batchSettled = new Promise<void>((resolve) => { settleBatchDone = resolve; });
  const registered = registerBatch(prepared.batch.id, ctx.userId, batchController);
  const activeBatchController = registered.batchController;
  setBatchDonePromise(prepared.batch.id, batchSettled);
  // Pre-start abort teardown: the documented onSyncFailure contract, then
  // unregister + (conditional) bus close + settle the SIGTERM drain. Reached
  // when the batch controller is already aborted at registry time or after
  // the ref-image await — same sequence, one definition.
  const abortBeforeStart = (): void => {
    try {
      ctx.onSyncFailure();
    } finally {
      unregisterBatch(prepared.batch.id);
      if (ctx.closeBatchOnCleanup !== false) bus.closeBatch(prepared.batch.id);
      settleBatchDone();
    }
  };
  if (activeBatchController.signal.aborted) {
    abortBeforeStart();
    return;
  }
  let request: ResolvedGenerateRequest;
  try {
    request = await resolveRefImagesAfterReservation(ctx, prepared);
    request = await resolveI2vSourceAfterReservation(ctx, prepared, request);
    request = await resolveI2vContextAfterReservation(ctx, prepared, request);
    request = resolveModelSteps(ctx, request);
    // Production queued requests were already prepared before GPU admission.
    // Keep the fail-open fallback for direct/legacy pipeline callers only.
    const condensed = ctx.promptPrepared ? request.prompt : await condenseBatchPrompt(request.prompt, request.modelId, {
      config: ctx.config,
      text: ctx.text,
      logger,
      userId: ctx.userId,
      signal: activeBatchController.signal,
    });
    if (condensed !== request.prompt) {
      persistCondensedPrompt(ctx.db, prepared.batch.id, condensed);
      // Keep the in-memory row in step with the write: later frames and
      // finalize reads take the batch from `prepared`, not a re-SELECT.
      prepared.batch.prompt = condensed;
      request = { ...request, prompt: condensed };
    }
    // signal can be aborted during the await (DELETE while resolving refs or condensing); TS narrowing forgets this across the await.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (activeBatchController.signal.aborted) {
      abortBeforeStart();
      return;
    }
  } catch (error) {
    // Setup failed before the worker started. Keep accepted rows so detached
    // recovery can finalize failure history and settle sequence/story state.
    unregisterBatch(prepared.batch.id);
    settleBatchDone();
    // Release the up-front reservation here too — this pre-start window is a
    // setup failure the documented onSyncFailure contract covers. Idempotent
    // vs the route's outer-catch releaseRemaining(); without it, slot release
    // depended entirely on that redundant path (a refactor trusting the
    // contract would have leaked the whole reservation until restart).
    ctx.onSyncFailure();
    throw error;
  }
  const disconnect = () => {
    // v3 spec: client disconnect detaches the subscriber, not the batch.
    // Workers keep running, settle as usual via onTileSettled, and the
    // existing enqueue/enqueueIfReady helpers no-op against the closed
    // controller. SIGTERM and user-cancel paths still abort the batch
    // controller through the registry — those are unchanged.
    logger.info({ batchId: prepared.batch.id }, 'client stream detached; batch continues');
  };
  if (ctx.disconnectSignal.aborted) {
    disconnect();
  } else {
    ctx.disconnectSignal.addEventListener('abort', disconnect, { once: true });
  }

  // ByteLengthQueuingStrategy caps the controller's internal buffer at
  // ~1 MB. Slow consumers signal backpressure via desiredSize ≤ 0;
  // enqueueIfReady drops optional frames (keepalives + partial previews)
  // when the queue is saturated. Terminal frames still flow through.
  let keepalive: ReturnType<typeof setInterval> | null = null;
  const stopKeepalive = (): void => {
    // Idempotent: clearing a setInterval handle is safe on a stopped timer,
    // but we also null the slot so a stray re-entry (e.g., catch arm before
    // finally) cannot double-clear or read a stale handle.
    if (keepalive !== null) {
      clearInterval(keepalive);
      keepalive = null;
    }
  };
  const cleanup = () => {
    stopKeepalive();
    ctx.disconnectSignal.removeEventListener('abort', disconnect);
    unregisterBatch(prepared.batch.id);
    if (ctx.closeBatchOnCleanup !== false) bus.closeBatch(prepared.batch.id);
  };
  try {
    keepalive = setInterval(() => { bus.broadcastOptional(prepared.batch.id, () => encodeSseComment()); }, KEEPALIVE_MS);

        // allSettled, not all: if one tile rejects (transient SQLITE_BUSY
        // in emitFailed, etc.), we still wait for the siblings to settle
        // before running cleanup. With `Promise.all`, the first rejection
        // skipped to `.finally` immediately; siblings kept running with no
        // stream and no slot accounting — leaking the cap and writing
        // artifacts to disk for tiles whose batch row was already
        // tombstoned. The per-tile `.finally(onTileSettled)` releases one
        // concurrency slot per tile, regardless of outcome.
        // Defer each runTile onto a microtask. runTile has a synchronous
        // prologue (registerTile / AbortSignal.any / timeoutSignal) that can
        // throw; calling it directly inside .map() would throw out of this
        // synchronous block with some sibling runTile promises already live —
        // then onSyncFailure() (full-reservation release) AND their
        // .finally(onTileSettled) would both fire. Promise.resolve().then()
        // turns any prologue throw into a rejected promise that
        // Promise.allSettled absorbs, so EVERY tile gets exactly one
        // .finally(onTileSettled). onSyncFailure() below is therefore
        // structurally reachable ONLY when zero runTile promises were
        // scheduled (a throw strictly before this statement) — the documented
        // invariant is now true by construction, not just by comment.
    const isBatched = ctx.registryEntry.model.batched === true;
    const results = await Promise.allSettled(
      isBatched
        // Batched: one ComfyUI generate() produces all N images in a single
        // GPU pass. A single onTileSettled() releases the one slot acquired
        // for the whole batch (non-batched acquires one slot per tile).
        ? [
            Promise.resolve()
              .then(() =>
                runBatch(
                  { ...ctx, request },
                  prepared.tiles,
                  activeBatchController.signal,
                  (frame) => { bus.broadcastTerminal(prepared.batch.id, frame); },
                  (makeFrame) => { bus.broadcastOptional(prepared.batch.id, makeFrame); },
                  logger,
                ),
              )
              .finally(() => { ctx.onTileSettled(); }),
          ]
        : prepared.tiles.map((tile) =>
            Promise.resolve()
              .then(() =>
                runTile(
                  { ...ctx, request },
                  tile,
                  activeBatchController.signal,
                  (frame) => { bus.broadcastTerminal(prepared.batch.id, frame); },
                  (makeFrame) => { bus.broadcastOptional(prepared.batch.id, makeFrame); },
                  logger,
                ),
              )
              .finally(() => { ctx.onTileSettled(); }),
          ),
    );
    // Per-tile rejection logging. Promise.allSettled collapses every
    // individual rejection into a single result entry; without an explicit
    // walk the only error surfaced downstream is the first one `find()`
    // picks. Observability-only — failLoadingTiles + finalizeBatch below
    // still own the on-the-wire failure path unchanged.
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result?.status !== 'rejected') continue;
      const tile = prepared.tiles[i];
      logger.error(
        { err: result.reason, tileId: tile?.id, batchId: prepared.batch.id },
        'orchestrator tile pipeline rejected',
      );
    }
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (rejected) {
      logger.error({ err: rejected.reason }, 'orchestrator pipeline failure');
      try {
        failBatchTerminally(ctx.db, ctx.config, ctx.logger, prepared.batch.id, 'internal error', {
          emitTerminal: (frame) => { bus.broadcastTerminal(prepared.batch.id, frame); },
        });
      } catch {
        /* best-effort; startup reconciliation is the floor */
      }
      return;
    }
    finalizeBatch(ctx.db, prepared.batch.id);
    const succeeded = batchTilesDone(ctx.db, prepared.batch.id, prepared.tiles.length);
    settleSequenceAfterBatchTerminal(
      ctx.db,
      ctx.config,
      ctx.logger,
      prepared.batch.id,
      succeeded,
    );
    // signal.aborted state can flip during the awaited work above; the narrowing-aware lint rule misreads this branch.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!activeBatchController.signal.aborted || isUserCanceled(activeBatchController.signal.reason)) {
      const done: DoneEvent = { batchId: prepared.batch.id };
      bus.broadcastTerminal(prepared.batch.id, terminalFrame('done', done));
      if (ctx.onBatchSucceeded && succeeded) {
        try {
          await ctx.onBatchSucceeded();
        } catch {
          /* best-effort side effect */
        }
      }
    }
  } catch (error) {
    // Stop keepalive synchronously inside the catch so the interval cannot
    // outlive a throw on the slow recovery path below. cleanup() in finally
    // re-runs this idempotently; stopKeepalive() is safe to call twice.
    stopKeepalive();
    logger.error({ err: error }, 'orchestrator start failure');
    try {
      // failBatchTerminally now broadcasts `done` here too — the previous
      // open-coded arm finalized but never emitted `done`, truncating the
      // client stream on this slow-recovery path.
      failBatchTerminally(ctx.db, ctx.config, ctx.logger, prepared.batch.id, 'internal error', {
        emitTerminal: (frame) => { bus.broadcastTerminal(prepared.batch.id, frame); },
      });
    } catch {
      /* best-effort */
    }
    ctx.onSyncFailure();
    throw error;
  } finally {
    cleanup();
    settleBatchDone();
  }
}

function batchTilesDone(db: Database, batchId: string, expectedCount: number): boolean {
  const row = db
    .query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM tiles WHERE batch_id = ? AND status = 'done'",
    )
    .get(batchId);
  return row?.count === expectedCount;
}

type UploadSourceRow = Pick<UploadRow, 'id' | 'ext' | 'mime'>;

function shouldLoadI2vSource(entry: RegistryEntry): boolean {
  // `supportsI2V` is the canonical "needs a source still" flag — registry.ts
  // derives it from the workflow's {{sourceImage}} placeholder at one site.
  // T2V models are video (`outputsVideo`) without it and never load a source.
  return entry.model.pool === 'local' && entry.model.supportsI2V === true;
}

/**
 * Reads the user's per-model step override once, at dispatch start, so every
 * dispatch path (immediate, queued, Storytelling) gets it and a batch never
 * mixes values. Models without a step concept carry none.
 */
function resolveModelSteps(ctx: GenerationContext, request: ResolvedGenerateRequest): ResolvedGenerateRequest {
  if (ctx.registryEntry.defaultSteps === undefined) return request;
  const steps = readModelStepsOverride(ctx.db, ctx.userId, request.modelId);
  return steps === undefined ? request : { ...request, steps };
}

function resolveTimeoutMs(ctx: GenerationContext): number {
  const unscaled = ctx.registryEntry.timeoutMs({
    cloud: ctx.config.CLOUD_TIMEOUT_MS,
    local: ctx.config.LOCAL_TIMEOUT_MS,
    localVideo: ctx.config.LOCAL_VIDEO_TIMEOUT_MS,
  });
  // The local budgets are sized for each row's default step count, and
  // sampling cost is ~linear in steps. Scale up for an override above the
  // default; a lower count keeps the default (fast-failure) budget.
  const defaultSteps = ctx.registryEntry.defaultSteps;
  const steps = ctx.request.steps;
  const base = defaultSteps !== undefined && steps !== undefined && steps > defaultSteps
    ? Math.ceil((unscaled * steps) / defaultSteps)
    : unscaled;
  // LOCAL_VIDEO_TIMEOUT_MS budgets the BASELINE 124-frame clip. H3 denoises one
  // joint AV latent over a fixed step count, so cost is ~linear in frames — a
  // 362-frame clip inheriting the 124-frame ceiling would abort mid-render and
  // look like an upstream failure. Scale rather than raise the flat ceiling, so
  // short clips keep their tight (fast-failure) bound.
  const frames = ctx.request.durationFrames;
  if (frames === undefined || ctx.registryEntry.model.outputsVideo !== true) return base;
  // A continuation renders its context head on top of the requested length, so
  // budget against the frames actually denoised rather than the ones delivered.
  const rendered = renderedVideoFrames(frames, ctx.request.i2vContext?.contextFrames ?? 0);
  return Math.ceil((base * rendered) / DEFAULT_VIDEO_DURATION_FRAMES);
}

async function resolveI2vSourceAfterReservation(
  ctx: GenerationContext,
  prepared: PreparedBatch,
  request: ResolvedGenerateRequest,
): Promise<ResolvedGenerateRequest> {
  if (!shouldLoadI2vSource(ctx.registryEntry) || request.i2vSource) return request;
  const uploadId = prepared.batch.i2v_source_upload_id;
  if (uploadId === null) return request;
  const row = ctx.db
    .query<UploadSourceRow, [string, string]>(
      'SELECT id, ext, mime FROM uploads WHERE id = ? AND user_id = ?',
    )
    .get(uploadId, ctx.userId);
  if (!row) {
    throw new RefImagesNotFoundError();
  }
  const artifact = await readArtifactBytes(ctx.config.DATA_DIR, 'uploads', ctx.userId, row.id, row.ext, row.mime);
  if (!artifact) {
    throw new RefImagesNotFoundError();
  }
  return { ...request, i2vSource: { bytes: artifact.bytes, ext: artifact.ext } };
}

/** ffmpeg tail cut is a few frames of a local file — a generous bound, not a budget. */
const VIDEO_CONTEXT_TAIL_TIMEOUT_MS = 30_000;
const VIDEO_CONTEXT_TAIL_MAX_BYTES = 16 * 1024 * 1024;

async function resolveI2vContextAfterReservation(
  ctx: GenerationContext,
  prepared: PreparedBatch,
  request: ResolvedGenerateRequest,
): Promise<ResolvedGenerateRequest> {
  if (!shouldLoadI2vSource(ctx.registryEntry)) return request;
  // Membership is persisted before immediate/story/queued dispatch. Handoff
  // provenance alone also survives standalone Retry/Re-roll, whose raw video
  // has no sequence master to trim the native continuation head and overshoot.
  // Never use transient request.extendsTileId or the possibly stale prepared
  // membership: rebuilt queued/restarted requests omit that field.
  const uploadId = prepared.batch.i2v_source_upload_id;
  const source = resolveExtendSource(ctx.db, ctx.userId, uploadId, prepared.batch.id);
  if (!source) return request;
  try {
    const bytes = await withDecryptedArtifactFiles(
      ctx.config.DATA_DIR,
      [{ root: 'images', userId: ctx.userId, artifactId: source.tileId, ext: source.ext }],
      {},
      ([path]) => {
        if (path === undefined) throw new Error('decrypted video context source missing');
        return extractVideoTail(path, {
          sourceEndFrame: source.endFrame,
          contextFrames: VIDEO_CONTEXT_FRAMES,
          timeoutMs: VIDEO_CONTEXT_TAIL_TIMEOUT_MS,
          maxOutputBytes: VIDEO_CONTEXT_TAIL_MAX_BYTES,
        });
      },
    );
    if (bytes === null) throw new Error('video context source artifact missing');
    const currentSource = resolveExtendSource(ctx.db, ctx.userId, uploadId, prepared.batch.id);
    if (currentSource?.tileId !== source.tileId || currentSource.endFrame !== source.endFrame) return request;
    return { ...request, i2vContext: { bytes, contextFrames: VIDEO_CONTEXT_FRAMES } };
  } catch (error) {
    ctx.logger.warn(
      { err: error, i2vSourceUploadId: uploadId },
      'video context tail unavailable; falling back to the still-frame handoff',
    );
    return request;
  }
}

function providerRequestForTile(
  ctx: GenerationContext,
  batchId: string,
  tileIndex: number,
  seed: number,
  count?: number,
): ProviderRequest {
  return {
    prompt: ctx.request.prompt,
    modelId: ctx.request.modelId,
    ratio: ctx.request.ratio,
    tileIndex,
    seed,
    ...(count !== undefined ? { count } : {}),
    ...(ctx.request.refImages ? { refImages: ctx.request.refImages } : {}),
    ...(ctx.request.i2vSource ? { i2vSource: ctx.request.i2vSource } : {}),
    // A predecessor deletion can dissolve the sequence during async setup.
    ...(ctx.request.i2vContext && resolveExtendSource(ctx.db, ctx.userId, ctx.request.i2vSourceUploadId ?? null, batchId)
      ? { i2vContext: ctx.request.i2vContext } : {}),
    ...(ctx.request.motionPrompt !== undefined ? { motionPrompt: ctx.request.motionPrompt } : {}),
    ...(ctx.request.durationFrames !== undefined ? { durationFrames: ctx.request.durationFrames } : {}),
    ...(ctx.request.steps !== undefined ? { steps: ctx.request.steps } : {}),
  };
}

function providerOptionsForTile(
  ctx: GenerationContext,
  tile: TileRow,
  parentSignal: AbortSignal,
  tileSignal: AbortSignal,
  emitOptional: EmitOptional,
  executionTimeoutMs: number,
): ProviderGenerateOptions | undefined {
  if (ctx.registryEntry.model.pool !== 'local') return undefined;
  const options: ProviderGenerateOptions = { executionTimeoutMs };
  if (ctx.registryEntry.model.outputsVideo === true) {
    options.onProgress = (progress) => {
      if (parentSignal.aborted || tileSignal.aborted) return;
      emitProgress(emitOptional, tile, progress);
    };
  }
  return options;
}

function emitProgress(
  emitOptional: EmitOptional,
  tile: TileRow,
  progress: ProviderProgress,
): void {
  if (!Number.isFinite(progress.progress)) return;
  const clamped = Math.min(1, Math.max(0, progress.progress));
  const event: TileEvent = {
    tileId: tile.id,
    tileIndex: tile.tile_index,
    status: 'progress',
    progress: clamped,
    ...(progress.phase !== undefined ? { phase: progress.phase } : {}),
  };
  emitOptional(() => encodeSseFrame('tile', event));
}

async function prewarmVideoPoster(
  ctx: GenerationContext,
  tile: TileRow,
  bytes: Uint8Array,
  mime: string,
  logger: AppLogger,
): Promise<void> {
  if (!isVideoMime(mime)) return;
  try {
    await ensureThumbnail({
      db: ctx.db, dataDir: ctx.config.DATA_DIR, userId: tile.user_id,
      tileId: tile.id, ext: 'mp4', mime, sourceBytes: bytes, logger,
    });
  } catch (error) {
    logger.warn({ err: error }, 'video poster prewarm failed');
  }
}

// The rendered head belongs to the accepted artifact. A lost terminal race
// must preserve both the tile and its batch's previously recorded context.
function commitReadyTile(
  db: Database,
  tile: TileRow,
  ext: MediaExt,
  mime: MediaMime,
  completedAt: number,
  contextFrames: number | undefined,
): boolean {
  return db.transaction(() => {
    const update = db.query(
      "UPDATE tiles SET status = 'done', ext = ?, mime = ?, completed_at = ? WHERE id = ? AND user_id = ? AND status = 'loading'",
    ).run(ext, mime, completedAt, tile.id, tile.user_id);
    if (update.changes !== 1) return false;
    // Explicit 0 is the provider's still-frame fallback, not a missing value.
    if (contextFrames !== undefined) {
      db.query('UPDATE batches SET context_frames = ? WHERE id = ? AND user_id = ?')
        .run(contextFrames, tile.batch_id, tile.user_id);
    }
    return true;
  }).immediate();
}

// The cancel-or-fail ladder every abort branch shares: a user cancel (on the
// batch or this tile) emits `canceled`, anything else fails with `category`.
function cancelOrFail(
  db: Database,
  emitTerminal: EmitTerminal,
  tile: TileRow,
  parentSignal: AbortSignal,
  tileController: AbortController | undefined,
  category: TileErrorCategory,
): void {
  if (tileController !== undefined && isUserCancelOnComposite(parentSignal, tileController)) {
    emitCanceled(emitTerminal, tile);
  } else {
    emitFailed(db, emitTerminal, tile, category);
  }
}

interface TileCommitScope {
  readonly ctx: GenerationContext;
  readonly tile: TileRow;
  readonly tileController: AbortController | undefined;
  readonly tileSignal: AbortSignal;
  readonly parentSignal: AbortSignal;
  readonly emitTerminal: EmitTerminal;
  readonly logger: AppLogger;
}

// Single owner of the terminal-result commit for one tile, shared by runTile
// and runBatch: abort check -> provider failure -> artifact guard -> durable
// write -> post-write abort reap -> guarded `done` UPDATE (orphan reap on a
// lost race) -> `done` frame -> poster prewarm. A throw (e.g. the disk write)
// propagates to the caller's catch, which owns the failure mapping.
async function commitTerminalResult(scope: TileCommitScope, result: TerminalProviderResult): Promise<void> {
  const { ctx, tile, tileController, tileSignal, parentSignal, emitTerminal, logger } = scope;
  const abortCategory = abortedCategory(tileSignal, parentSignal);
  if (abortCategory) {
    cancelOrFail(ctx.db, emitTerminal, tile, parentSignal, tileController, abortCategory);
    return;
  }

  if (result.status === 'failed') {
    emitFailed(
      ctx.db,
      emitTerminal,
      tile,
      sanitizeProviderError(result.error ?? 'empty provider result', logger),
      sanitizedModerationNotice(result.error),
    );
    return;
  }

  if (!isAllowedArtifact(result.ext, result.mime)) {
    logger.error({ ext: result.ext, mime: result.mime }, 'unsupported provider artifact format');
    emitFailed(ctx.db, emitTerminal, tile, 'unsupported format');
    return;
  }

  const ext = result.ext;
  const mime = toMediaMime(ext);
  await writeAtomic(ctx.config.DATA_DIR, 'images', tile.user_id, tile.id, ext, result.bytes);
  try {
    // The provider owns and drains cleanup delivery. Its network latency must
    // not consume the deadline of an artifact already durably stored.
    void result.afterStored?.().catch((error: unknown) => {
      logger.warn({ err: error }, 'provider post-storage cleanup failed');
    });
  } catch (error) {
    logger.warn({ err: error }, 'provider post-storage cleanup failed');
  }
  // writeAtomic is signal-unaware (Bun.write + reopen + fsync + rename
  // + parent fsync — all run regardless once started). Re-check abort
  // state after the bytes hit disk: if disconnect/timeout fired during
  // the write, skip the UPDATE roundtrip and reap the artifact. The
  // success-path guarded UPDATE below would have caught this anyway
  // (status='loading' no longer matches), but emitFailed routes the
  // post-write abort through the canonical category mapping.
  const postWriteAbort = abortedCategory(tileSignal, parentSignal);
  if (postWriteAbort) {
    try {
      deleteArtifact(ctx.config.DATA_DIR, 'images', tile.user_id, tile.id, ext);
    } catch (error) {
      // ENOENT is already swallowed by deleteArtifact; anything else
      // (EACCES/EBUSY/EROFS/disk full) is rare. Don't escape into the
      // caller's catch — we want emitFailed to land the canonical abort
      // category, not a sanitized fs error. Reconciliation reaps any
      // straggling artifact at next boot.
      logger.error({ err: error }, 'post-write deleteArtifact failed');
    }
    cancelOrFail(ctx.db, emitTerminal, tile, parentSignal, tileController, postWriteAbort);
    return;
  }
  const completedAt = Date.now();
  // Guarded UPDATE: status='loading' is the only legal predecessor of 'done'.
  // Without this, a delete-during-generate race (DELETE /history removes the
  // row entirely) or a SIGTERM/cancel race (which fails the row first) gets
  // overwritten by a stale success — the tile lies about being done while
  // history shows it failed/deleted, and /api/img/:tileId 404s.
  //
  // The guarded UPDATE preserves the v3 invariant that workers continue
  // running independent of the client stream: a tile whose bytes hit disk
  // is allowed to commit 'done' even if the stream has already closed.
  // The only races that can leave the row in a non-'loading' state are
  // a concurrent DELETE /history (removes the row) or a SIGTERM/cancel
  // (marks it 'failed:interrupted'/'canceled'); in both cases the guard
  // correctly suppresses the stale success write.
  if (!commitReadyTile(ctx.db, tile, ext, mime, completedAt, result.contextFrames)) {
    // Row was already failed (SIGTERM/timeout) or deleted (history DELETE).
    // Reap the artifact we just wrote so it doesn't sit as an orphan until
    // next-boot reconciliation.
    deleteArtifact(ctx.config.DATA_DIR, 'images', tile.user_id, tile.id, ext);
    logger.warn({ tileId: tile.id }, 'success update lost race; orphan artifact unlinked');
    return;
  }
  logger.info('tile done');
  emitTerminal(terminalFrame('tile', doneTileEvent(tile, ext, mime, completedAt)));
  void prewarmVideoPoster(ctx, tile, result.bytes, mime, logger);
}

async function runTile(
  ctx: GenerationContext,
  tile: TileRow,
  parentSignal: AbortSignal,
  emitTerminal: EmitTerminal,
  emitOptional: EmitOptional,
  batchLogger: AppLogger,
): Promise<void> {
  const logger = bindTileLogger(batchLogger, tile.id);
  const timeoutMs = resolveTimeoutMs(ctx);
  const tileController = getOrCreateTileController(tile.batch_id, ctx.userId, tile.id);
  if (tileController.signal.aborted) {
    try {
      if (isUserCanceled(tileController.signal.reason)) {
        emitCanceled(emitTerminal, tile);
      } else {
        emitFailed(ctx.db, emitTerminal, tile, 'interrupted');
      }
      return;
    } finally {
      unregisterTile(tile.batch_id, tile.id);
    }
  }
  // Compose batch (parent), per-tile cancel, and per-tile timeout into a
  // single effective signal. AbortSignal.any propagates whichever
  // constituent fires first along with that source's .reason.
  const composedParent = AbortSignal.any([parentSignal, tileController.signal]);
  const tileSignal = timeoutSignal(timeoutMs, composedParent);
  try {
    const result = await drainProviderToTerminal(
      ctx.boundProvider.generate(
        providerRequestForTile(ctx, tile.batch_id, tile.tile_index, tile.seed),
        tileSignal.signal,
        providerOptionsForTile(ctx, tile, parentSignal, tileSignal.signal, emitOptional, timeoutMs),
      ),
      // Forwarder: every `partial` the provider yields becomes a `tile`
      // event with status='partial'. Persist nothing — partials are
      // transient previews; only the terminal `done`/`failed` state is
      // recorded in SQLite. The forwarder is a no-op once parent or tile
      // signal aborts so we don't push frames into a closed stream.
      (partial) => {
        if (parentSignal.aborted || tileSignal.signal.aborted) return;
        const event: TileEvent = {
          tileId: tile.id,
          tileIndex: tile.tile_index,
          status: 'partial',
          preview: partial.preview,
          index: partial.index,
        };
        // Drop on backpressure — partials are optional progress signals;
        // a stalled consumer can't keep up with 1 MB base64 frames. Pass a
        // factory: the megabyte JSON.stringify+encode runs only after the bus
        // confirms a subscriber and the sink confirms buffer space, so an
        // absent or saturated consumer never pays for it.
        emitOptional(() => encodeSseFrame('tile', event));
      },
    );

    if (result) {
      await commitTerminalResult(
        { ctx, tile, tileController, tileSignal: tileSignal.signal, parentSignal, emitTerminal, logger },
        result,
      );
      return;
    }
    // The provider ended without a terminal result.
    const abortCategory = abortedCategory(tileSignal.signal, parentSignal);
    if (abortCategory) {
      cancelOrFail(ctx.db, emitTerminal, tile, parentSignal, tileController, abortCategory);
      return;
    }
    emitFailed(ctx.db, emitTerminal, tile, sanitizeProviderError('empty provider result', logger));
  } catch (error) {
    if (isUserCancelOnComposite(parentSignal, tileController)) {
      emitCanceled(emitTerminal, tile);
      return;
    }
    // abortedCategory() is the single source of the abort priority
    // (parent-abort dominates -> tile timeout -> tile abort); only when it
    // returns null is this a genuine provider error. Calling it here instead
    // of re-encoding the ladder closes the drift the previous inline copy had
    // already developed (it omitted the tileSignal.aborted branch), which let
    // a slow provider's catch report a provider error where a SIGTERM-induced
    // parent abort was the real cause.
    const category = abortedCategory(tileSignal.signal, parentSignal)
      ?? sanitizeProviderError(error, logger);
    emitFailed(ctx.db, emitTerminal, tile, category);
  } finally {
    // Defensive: abort the per-tile controller so any provider iterator
    // still observing `tileController.signal` (via AbortSignal.any in the
    // composite) unwinds promptly on the outer-error path, and so a leaked
    // adapter listener doesn't hold a reference past unregisterTile.
    // Idempotent — no-op on an already-aborted controller; safe on every
    // outcome path (success, abort, timeout, provider error).
    tileController.abort();
    tileSignal.dispose();
    unregisterTile(tile.batch_id, tile.id);
  }
}

/**
 * Run a single ComfyUI batch job covering all `tiles` at once.
 *
 * ComfyUI generates N images in one GPU pass via `generate({ count: N })`.
 * Each yielded terminal result carries an `index` that maps 1-to-1 to
 * `tiles[index]`. Only one concurrency slot is acquired by the caller
 * (vs one per tile in the non-batched path); a single `onTileSettled()`
 * call in the `.finally` of the caller's wrapping promise releases it.
 *
 * Cancellation is coarse: any individual tile controller aborting or the
 * parent signal aborting cancels the entire GPU job, since ComfyUI batch
 * generation cannot be interrupted for a subset of images.
 */
async function runBatch(
  ctx: GenerationContext,
  tiles: TileRow[],
  parentSignal: AbortSignal,
  emitTerminal: EmitTerminal,
  emitOptional: EmitOptional,
  batchLogger: AppLogger,
): Promise<void> {
  const logger = batchLogger;

  if (tiles.length === 0) {
    logger.error({ modelId: ctx.request.modelId }, 'runBatch called with empty tiles array; skipping provider request');
    return;
  }

  const timeoutMs = resolveTimeoutMs(ctx);

  // Register one controller per tile (supports individual tile cancel, which
  // cancels the whole job since ComfyUI batch is atomic).
  const tileControllers = tiles.map((tile) =>
    getOrCreateTileController(tile.batch_id, ctx.userId, tile.id),
  );

  // Composing all tile signals + parent means any single tile cancel or parent
  // abort will abort the entire generate() call.
  const composedParent = AbortSignal.any([
    parentSignal,
    ...tileControllers.map((c) => c.signal),
  ]);
  const tileSignal = timeoutSignal(timeoutMs, composedParent);

  // Track which tile indices received a terminal result so we can fail any
  // that the iterator skipped (shouldn't happen, but belt-and-braces). Declared
  // outside the try so the catch below can read it for its cancel branch. Note
  // it is added to before the artifact write, so membership means "handled by
  // the loop", not "a terminal frame was emitted".
  const settled = new Set<number>();

  try {
    // If any controller was already aborted before we start (e.g. user canceled
    // a tile right as the batch was admitted), emit terminal events and return.
    if (composedParent.aborted) {
      for (const [i, tile] of tiles.entries()) {
        cancelOrFail(ctx.db, emitTerminal, tile, parentSignal, tileControllers[i], 'interrupted');
      }
      return;
    }

    const firstTile = tiles[0];
    if (firstTile === undefined) {
      logger.error({ modelId: ctx.request.modelId }, 'runBatch lost first tile after empty guard');
      return;
    }

    // One generate() call for all N tiles; use tiles[0].seed as the batch seed.
    const genIterable = ctx.boundProvider.generate(
      providerRequestForTile(ctx, firstTile.batch_id, 0, firstTile.seed, tiles.length),
      tileSignal.signal,
      providerOptionsForTile(ctx, firstTile, parentSignal, tileSignal.signal, emitOptional, timeoutMs),
    );

    for await (const result of genIterable) {
      if (result.status === 'partial') {
        // A partial's `index` is its within-tile preview ordinal, not its
        // terminal batch position. Route with the explicit batchIndex so the
        // second/third sampler preview cannot leak onto the second/third tile.
        const tile = tiles[result.batchIndex];
        if (tile && !parentSignal.aborted && !tileSignal.signal.aborted) {
          const event: TileEvent = {
            tileId: tile.id,
            tileIndex: tile.tile_index,
            status: 'partial',
            preview: result.preview,
            index: result.index,
          };
          emitOptional(() => encodeSseFrame('tile', event));
        }
        continue;
      }

      // Terminal result: map index → tile.
      const tileIdx = result.index;
      const tile = tiles[tileIdx];
      if (!tile) {
        logger.error({ tileIdx, tilesCount: tiles.length }, 'batch result index out of range');
        continue;
      }
      if (settled.has(tileIdx)) {
        logger.warn({ tileIdx }, 'duplicate terminal result for batch tile');
        continue;
      }
      // Before the commit: the catch below relies on `settled` covering a
      // tile whose disk write threw.
      settled.add(tileIdx);
      await commitTerminalResult(
        {
          ctx,
          tile,
          tileController: tileControllers[tileIdx],
          tileSignal: tileSignal.signal,
          parentSignal,
          emitTerminal,
          logger: logger.child({ tileIdx }),
        },
        result,
      );
    }

    // After the iterator ends, fail any tiles that never received a terminal.
    const finalAbortCategory = abortedCategory(tileSignal.signal, parentSignal);
    for (const [i, tile] of tiles.entries()) {
      if (settled.has(i)) continue;
      if (finalAbortCategory) {
        cancelOrFail(ctx.db, emitTerminal, tile, parentSignal, tileControllers[i], finalAbortCategory);
      } else {
        emitFailed(ctx.db, emitTerminal, tile, sanitizeProviderError('empty provider result', logger));
      }
    }
  } catch (error) {
    const abortCategory = abortedCategory(tileSignal.signal, parentSignal);
    for (const [i, tile] of tiles.entries()) {
      const controller = tileControllers[i];
      if (controller !== undefined) {
        if (isUserCancelOnComposite(parentSignal, controller)) {
          // emitCanceled touches no DB, so unlike emitFailed it cannot tell a
          // tile that already emitted `done` from a live one and would trail a
          // contradicting `canceled`. Skip the settled ones here — and ONLY
          // here: `settled` is added before writeAtomic, so a tile whose disk
          // write threw is in the set with no terminal emitted yet and must
          // still reach emitFailed below, whose guarded UPDATE + authoritative
          // row re-read is what makes suppression safe on that branch.
          if (settled.has(i)) continue;
          // Preserve the explicit wire-level cancellation even though the
          // history DELETE normally removes the row before the provider unwinds.
          emitCanceled(emitTerminal, tile);
          continue;
        }
      }
      emitFailed(ctx.db, emitTerminal, tile, abortCategory ?? sanitizeProviderError(error, logger));
    }
  } finally {
    for (const controller of tileControllers) {
      controller.abort();
    }
    tileSignal.dispose();
    for (const tile of tiles) {
      unregisterTile(tile.batch_id, tile.id);
    }
  }
}

function abortedCategory(tileSignal: AbortSignal, parentSignal: AbortSignal): TileErrorCategory | null {
  if (parentSignal.aborted) {
    // Parent-signal abort sources under v3: SIGTERM (ServerShuttingDownError)
    // and user cancel via DELETE /history (UserCanceledError, caught upstream
    // by isUserCancelOnComposite — never reaches this branch). Both map to
    // 'interrupted' here: SIGTERM matches the category startup-reconcile uses
    // for loading rows orphaned by a previous run.
    return 'interrupted';
  }
  if (tileSignal.reason instanceof TileTimeout) return 'timed out';
  if (tileSignal.aborted) return 'interrupted';
  return null;
}

function isUserCancelOnComposite(parentSignal: AbortSignal, tileController: AbortController): boolean {
  return isUserCanceled(parentSignal.reason) || isUserCanceled(tileController.signal.reason);
}

type TerminalProviderResult = Extract<ProviderResult, { status: 'ready' } | { status: 'failed' }>;

async function drainProviderToTerminal(
  iterable: AsyncIterable<ProviderResult>,
  onPartial: (partial: Extract<ProviderResult, { status: 'partial' }>) => void,
): Promise<TerminalProviderResult | null> {
  // Consume the provider iterator. Forward every `partial` to the caller as
  // it arrives; return on the first terminal result. The provider contract
  // (Provider.generate JSDoc) requires the iterator to end after a terminal,
  // so any further yields are ignored — we don't enforce that with a wasted
  // `await reader.return()` since AsyncIterable cleanup is automatic on
  // the first early return.
  for await (const item of iterable) {
    if (item.status === 'partial') {
      onPartial(item);
      continue;
    }
    return item;
  }
  return null;
}

function emitFailed(
  db: Database,
  emitTerminal: EmitTerminal,
  tile: TileRow,
  error: TileErrorCategory,
  moderation?: GptModerationNotice,
): void {
  const completedAt = Date.now();
  const persisted = db.transaction((): { error: TileErrorCategory; completedAt: number; moderation: GptModerationNotice | undefined } | null => {
    // Archived-loading tiles that fail would otherwise become invisible
    // tombstones: archive view filters `status='done'` (so failed rows hide)
    // and history filters `archived_at IS NULL` (so archived rows hide). The
    // 30-day TTL purge eventually reaps them, but a row in a state no view
    // can show is a slow leak. Hard-delete them here instead — the user has
    // already asked for the batch to go away, a failure is the same intent.
    // Also drop the archived parent batch when this was its last remaining
    // tile, otherwise we'd leak the same tombstone class one layer up.
    const archived = db
      .query<{ archived_at: number | null; batch_id: string }, [string]>(
        'SELECT archived_at, batch_id FROM tiles WHERE id = ?',
      )
      .get(tile.id);
    if (archived?.archived_at != null) {
      // DELETE predicate is `archived_at IS NOT NULL` — NOT `status='loading'`.
      // The disconnect/cleanup path (failLoadingTiles + per-tile timeout) may
      // have already flipped this row to status='failed' before emitFailed
      // lands; gating on status would leave the tombstone behind. The user
      // already archived the batch, the row is in a state no view can show —
      // delete it regardless of which writer terminal'd it first.
      db.query('DELETE FROM tiles WHERE id = ? AND archived_at IS NOT NULL').run(tile.id);
      const remaining = db
        .query<{ count: number }, [string]>('SELECT COUNT(*) AS count FROM tiles WHERE batch_id = ?')
        .get(archived.batch_id)?.count ?? 0;
      if (remaining === 0) {
        db.query('DELETE FROM batches WHERE id = ? AND archived_at IS NOT NULL').run(archived.batch_id);
      }
      return null;
    }
    db.query(`UPDATE tiles SET status = ?, error = ?, completed_at = ?, moderation_reason = ?, moderation_categories = ? WHERE id = ? AND ${SQL_LOADING_GUARD}`)
      .run('failed', error, completedAt, moderation?.reason ?? null, moderation?.categories ? JSON.stringify(moderation.categories) : null, tile.id);
    // A zero-change update has two materially different causes. A concurrent
    // failLoadingTiles writer still needs its persisted terminal replayed on
    // this stream; a tile already committed `done` must never be contradicted
    // by a later provider throw. Read the authoritative row and emit only its
    // actual failed state. A deleted row remains suppressed (no ghost event).
    const row = db
      .query<{ status: string; error: TileErrorCategory | null; completed_at: number | null; moderation_reason: GptModerationReason | null; moderation_categories: string | null }, [string]>(
        'SELECT status, error, completed_at, moderation_reason, moderation_categories FROM tiles WHERE id = ?',
      )
      .get(tile.id);
    if (row?.status !== 'failed') return null;
    return {
      error: row.error ?? error,
      completedAt: row.completed_at ?? completedAt,
      moderation: tileModeration(row),
    };
  })();
  if (persisted === null) return;
  const event: TerminalTileEvent = {
    tileId: tile.id,
    tileIndex: tile.tile_index,
    status: 'failed',
    error: persisted.error,
    ...(persisted.moderation ? { moderation: persisted.moderation } : {}),
    completedAt: persisted.completedAt,
  };
  emitTerminal(terminalFrame('tile', event));
}

function emitCanceled(
  emitTerminal: EmitTerminal,
  tile: TileRow,
): void {
  // The DELETE route hard-deletes the DB row BEFORE the worker
  // observes the abort, so this helper does not touch the DB — it
  // only emits the wire-level terminal so the originating client's
  // useGenerate consumer can remove the tile from cache and so any
  // tab subscribed via BroadcastChannel can converge silently.
  const event: TerminalTileEvent = {
    tileId: tile.id,
    tileIndex: tile.tile_index,
    status: 'canceled',
    completedAt: Date.now(),
  };
  emitTerminal(terminalFrame('tile', event));
}

export const __orchestratorTest = {
  emitFailed,
};

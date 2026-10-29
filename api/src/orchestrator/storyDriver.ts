import type { Database } from 'bun:sqlite';
import type { Ratio, VideoDurationFrames } from '@atelier/shared';
import { videoDurationSeconds } from '@atelier/shared';
import type { Config } from '../config';
import { adoptStandaloneBatch, appendSegment } from '../db/sequences';
import { reportIfCorruption } from '../db/integrity';
import { countQueuedForUser } from '../db/queueOps';
import type { AppLogger } from '../observability/logger';
import { motionEnhanceSystemPrompt } from '../prompts/motionEnhanceSystemPrompt';
import { motionExtendEnhanceSystemPrompt } from '../prompts/motionExtendEnhanceSystemPrompt';
import { storyT2vSystemPrompt } from '../prompts/storyT2vSystemPrompt';
import { MOTION_ENHANCE_DEFAULTS } from '../providers/cliproxyText.config';
import type { EnhanceImageInput } from '../providers/cliproxyText';
import { findModel, isLocalModelGated } from '../providers/registry';
import { aiFillTextProviderForConfig } from '../providers/textRouting';
import { downscaleForVision } from '../storage/downscaleForVision';
import { storageKeyring } from '../storage/crypto';
import { withDecryptedArtifactFiles } from '../storage/decryptedTemp';
import { extractLastFramePng } from '../storage/lastFrame';
import { releaseUploads, storeUpload } from '../storage/uploadStore';
import { createBatch } from './createBatch';
import { validateExtension } from './extendValidation';
import * as queue from './queue';
import { enhancePool } from './llmAdmission';

export interface StoryDriverRuntime {
  readonly db: Database;
  readonly config: Config;
  readonly logger: AppLogger;
  readonly kickLocalQueue: () => void;
  readonly extractLastFrame?: (
    inputPath: string,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<Uint8Array>;
}

interface StoryRow {
  readonly id: string;
  readonly user_id: string;
  readonly status: 'rendering' | 'done' | 'failed' | 'canceled';
  readonly continuity_bible: string;
  readonly ratio: Ratio;
  readonly source_upload_id: string | null;
  readonly extends_tile_id: string | null;
  readonly source_prompt: string | null;
}

interface StorySegmentRow {
  readonly story_id: string;
  readonly idx: number;
  readonly beat: string;
  readonly duration_frames: VideoDurationFrames;
  readonly batch_id: string | null;
  readonly attempts: number;
}

interface BatchStateRow {
  readonly id: string;
  readonly status: string;
  readonly prompt: string;
  readonly motion_prompt: string | null;
}

interface PredecessorRow extends BatchStateRow {
  readonly tile_id: string;
}

interface PendingStory {
  running: boolean;
  rerun: boolean;
}

type SegmentMode = 't2v' | 'i2v-first' | 'extension';

let runtime: StoryDriverRuntime | null = null;
let stopping = false;
let workerRunning = false;
const pending = new Map<string, PendingStory>();
const fifo: string[] = [];
const idleWaiters = new Set<() => void>();
const deferred = new Set<string>();
let retryTimer: ReturnType<typeof setTimeout> | undefined;
const STORY_QUEUE_RETRY_MS = 1_000;
let unsubscribeQueueChanges: (() => void) | undefined;
const active = new Map<string, {
  readonly configured: StoryDriverRuntime;
  readonly userId: string;
  readonly controller: AbortController;
}>();

// Called only after the route's scoped cancellation transaction commits.
export function abortStoryPreparation(db: Database, storyId: string, userId: string): void {
  const work = active.get(storyId);
  if (work?.configured.db === db && work.userId === userId) {
    work.controller.abort(new Error('story canceled'));
  }
}

function wakeDeferredStories(): void {
  if (!runtime || stopping) return;
  const ids = [...deferred];
  deferred.clear();
  for (const id of ids) kickStory(id);
}

function clearDeferredRetries(): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = undefined;
  deferred.clear();
}

function deferStory(storyId: string): void {
  if (!runtime || stopping) return;
  deferred.add(storyId);
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    if (!runtime || stopping) return;
    wakeDeferredStories();
  }, STORY_QUEUE_RETRY_MS);
  retryTimer.unref();
}

function isCurrentRuntime(configured: StoryDriverRuntime): boolean {
  return runtime === configured && !stopping;
}

export function configureStoryDriver(next: StoryDriverRuntime): void {
  for (const work of active.values()) work.controller.abort(new Error('story runtime replaced'));
  unsubscribeQueueChanges?.();
  clearDeferredRetries();
  stopping = false;
  runtime = next;
  unsubscribeQueueChanges = queue.subscribeQueueChanges(wakeDeferredStories);
}

export function stopStoryDriver(): Promise<void> {
  unsubscribeQueueChanges?.();
  unsubscribeQueueChanges = undefined;
  stopping = true;
  for (const work of active.values()) work.controller.abort(new Error('story driver stopped'));
  clearDeferredRetries();
  fifo.length = 0;
  pending.clear();
  return waitForStoryDriverIdle();
}

export function resetStoryDriverForTests(): void {
  unsubscribeQueueChanges?.();
  unsubscribeQueueChanges = undefined;
  if (workerRunning) throw new Error('cannot reset story driver while running');
  stopping = true;
  clearDeferredRetries();
  runtime = null;
  fifo.length = 0;
  pending.clear();
  resolveIdleWaiters();
}

export function waitForStoryDriverIdle(): Promise<void> {
  if (!workerRunning && fifo.length === 0 && pending.size === 0) return Promise.resolve();
  return new Promise((resolve) => { idleWaiters.add(resolve); });
}

export function notifyStoryBatchTerminal(batchId: string, _succeeded: boolean): void {
  const configured = runtime;
  if (!configured || stopping) return;
  const row = configured.db.query<{ story_id: string }, [string]>(
    `SELECT ss.story_id
       FROM story_segments ss
       JOIN stories s ON s.id = ss.story_id AND s.user_id = ss.user_id
      WHERE ss.batch_id = ? AND s.status = 'rendering'`,
  ).get(batchId);
  if (row) kickStory(row.story_id);
}

export function kickStory(storyId: string): void {
  if (!runtime || stopping) return;
  deferred.delete(storyId);
  const existing = pending.get(storyId);
  if (existing) {
    if (existing.running) existing.rerun = true;
    return;
  }
  pending.set(storyId, { running: false, rerun: false });
  fifo.push(storyId);
  void pump();
}

export function recoverStories(): void {
  const configured = runtime;
  if (!configured || stopping) return;
  const rows = configured.db.query<{ id: string }, []>(
    "SELECT id FROM stories WHERE status = 'rendering' ORDER BY created_at ASC, id ASC",
  ).all();
  for (const row of rows) kickStory(row.id);
}

async function pump(): Promise<void> {
  if (workerRunning) return;
  workerRunning = true;
  try {
    for (;;) {
      const storyId = fifo.shift();
      if (!storyId) break;
      const state = pending.get(storyId);
      const configured = runtime;
      if (!state || !configured || stopping) continue;
      state.running = true;
      await runAdvance(configured, storyId);
      state.running = false;
      if (state.rerun && isCurrentRuntime(configured)) {
        state.rerun = false;
        fifo.push(storyId);
      } else {
        pending.delete(storyId);
      }
    }
  } finally {
    workerRunning = false;
    if (fifo.length > 0) void pump();
    else if (pending.size === 0) resolveIdleWaiters();
  }
}

async function runAdvance(configured: StoryDriverRuntime, storyId: string): Promise<void> {
  const work = { configured, userId: '', controller: new AbortController() };
  try {
    const userId = configured.db.query<{ user_id: string }, [string]>(
      'SELECT user_id FROM stories WHERE id = ?',
    ).get(storyId)?.user_id;
    if (userId === undefined) return;
    work.userId = userId;
    active.set(storyId, work);
    const result = await advanceStory(configured, storyId, work.controller.signal);
    if (result === 'deferred' && isCurrentRuntime(configured)) deferStory(storyId);
  } catch (error) {
    if (!isCurrentRuntime(configured) || work.controller.signal.aborted) return;
    if (!reportIfCorruption(error, configured.logger, { phase: 'story_advance', storyId })) {
      configured.logger.error(
        { err: error, event: 'story_advance_failed', storyId },
        'story advance failed',
      );
    }
    try {
      markStoryFailed(configured.db, storyId, 'story failed');
    } catch (dbError) {
      reportIfCorruption(dbError, configured.logger, {
        phase: 'story_advance_mark_failed',
        storyId,
      });
    }
  } finally {
    if (active.get(storyId) === work) active.delete(storyId);
  }
}

async function advanceStory(configured: StoryDriverRuntime, storyId: string, lifetime: AbortSignal): Promise<'deferred' | undefined> {
  // An extension segment reads the predecessor clip, which needs the storage
  // root. Wait for the host agent's unseal BEFORE loading story state and
  // before any per-segment timeout starts, so a long sealed period (e.g. a
  // reboot nobody logged into yet) never burns a segment attempt.
  await (await storageKeyring()).awaitUnsealed(lifetime);
  lifetime.throwIfAborted();
  if (!isCurrentRuntime(configured)) return;
  const story = configured.db.query<StoryRow, [string]>(
    `SELECT id, user_id, status, continuity_bible, ratio, source_upload_id,
            extends_tile_id, source_prompt
       FROM stories WHERE id = ?`,
  ).get(storyId);
  if (story?.status !== 'rendering') return;
  const segments = configured.db.query<StorySegmentRow, [string]>(
    `SELECT story_id, idx, beat, duration_frames, batch_id, attempts
       FROM story_segments WHERE story_id = ? ORDER BY idx ASC`,
  ).all(storyId);
  const submitted = segments.filter((segment) => segment.batch_id !== null);
  const next = segments.find((segment) => segment.batch_id === null);
  let segment = next;

  if (submitted.length > 0) {
    const last = submitted.at(-1);
    if (!last?.batch_id) return;
    const batch = configured.db.query<BatchStateRow, [string, string]>(
      'SELECT id, status, prompt, motion_prompt FROM batches WHERE id = ? AND user_id = ?',
    ).get(last.batch_id, story.user_id);
    if (!batch) {
      markStoryCanceled(configured.db, story.id);
      return;
    }
    if (batch.status === 'queued' || batch.status === 'running') return;
    const tileDone = configured.db.query<{ one: number }, [string, string]>(
      `SELECT 1 AS one FROM tiles
        WHERE batch_id = ? AND user_id = ? AND status = 'done'
          AND ext = 'mp4' AND mime = 'video/mp4'`,
    ).get(batch.id, story.user_id) !== null;
    if (batch.status !== 'done' || !tileDone) {
      if (last.attempts < 2) segment = last;
      else {
        markStoryFailed(configured.db, story.id, `segment ${last.idx + 1} failed`);
        return;
      }
    } else if (!next) {
      configured.db.query(
        "UPDATE stories SET status = 'done', error = NULL, updated_at = ? WHERE id = ? AND status = 'rendering'",
      ).run(Date.now(), story.id);
      return;
    }
  }

  if (!segment) return;
  // Finish terminal/missing-batch bookkeeping before pressure can defer work.
  if (countQueuedForUser(configured.db, story.user_id) >= configured.config.MAX_QUEUED_BATCHES_PER_USER) {
    return 'deferred';
  }
  const mode = segmentMode(story, segment);
  let predecessor: PredecessorRow | null = null;
  if (mode === 'extension') {
    predecessor = segment.idx === 0
      ? loadPredecessorByTile(configured.db, story.user_id, story.extends_tile_id)
      : loadPredecessorForPreviousSegment(configured.db, story.user_id, segments, segment.idx);
    if (predecessor === null) {
      // The source tile was hard-deleted out from under the story; nothing
      // will ever notify again, so failing here beats a forever-'rendering' row.
      markStoryFailed(configured.db, story.id, 'source missing');
      return;
    }
    if (predecessor.status !== 'done') return;
  }

  const clipSeconds = videoDurationSeconds(segment.duration_frames);
  const signal = AbortSignal.any([lifetime, AbortSignal.timeout(configured.config.CLOUD_TIMEOUT_MS)]);
  let prompt = segment.beat;
  let motionPrompt: string | undefined;
  let uploadId: string | undefined;
  let submittedBatch = false;

  try {
    if (mode === 'extension' && predecessor) {
      try {
        const extractLastFrame = configured.extractLastFrame ?? extractLastFramePng;
        const png = await withDecryptedArtifactFiles(
          configured.config.DATA_DIR,
          [{ root: 'images', userId: story.user_id, artifactId: predecessor.tile_id, ext: 'mp4' }],
          { signal },
          ([path]) => {
            if (path === undefined) throw new Error('decrypted predecessor missing');
            return extractLastFrame(path, { signal });
          },
        );
        if (png === null) throw new Error('predecessor artifact missing');
        if (!isCurrentRuntime(configured)) return;
        const upload = await storeUpload({
          db: configured.db,
          dataDir: configured.config.DATA_DIR,
          logger: configured.logger,
          userId: story.user_id,
          bytes: png,
          signal,
          sourceTileId: predecessor.tile_id,
        });
        uploadId = upload.id;
        const images = [await downscaleForVision(png, signal)];
        motionPrompt = await enhanceSegment(
          configured,
          story,
          segment,
          images,
          motionExtendEnhanceSystemPrompt({
            previousMotionPrompt: predecessor.motion_prompt ?? predecessor.prompt,
            sourcePrompt: story.continuity_bible,
            clipSeconds,
          }),
          signal,
          lifetime,
        );
      } catch (error) {
        if (isCurrentRuntime(configured) && !lifetime.aborted) recordSubmissionFailure(configured, story, segment, error);
        return;
      }
    } else if (mode === 'i2v-first') {
      motionPrompt = await enhanceSegment(
        configured,
        story,
        segment,
        [],
        motionEnhanceSystemPrompt({
          sourcePrompt: [story.continuity_bible, story.source_prompt].filter(Boolean).join('\n\n'),
          clipSeconds,
        }),
        signal,
        lifetime,
      );
    } else {
      prompt = await enhanceSegment(
        configured,
        story,
        segment,
        [],
        storyT2vSystemPrompt({ bible: story.continuity_bible, clipSeconds }),
        signal,
        lifetime,
      );
    }

    lifetime.throwIfAborted();
    if (!isCurrentRuntime(configured)) return;
    const liveStory = configured.db.query<{ status: StoryRow['status'] }, [string]>(
      'SELECT status FROM stories WHERE id = ?',
    ).get(story.id);
    if (liveStory?.status !== 'rendering') return;

    const modelId = mode === 't2v' ? 'minimax-h3-t2v' : 'minimax-h3-i2v';
    const registryEntry = findModel(modelId, configured.config);
    if (!registryEntry || isLocalModelGated(configured.config, story.user_id, registryEntry)) {
      markStoryFailed(configured.db, story.id, 'model unavailable');
      return;
    }
    const predecessorTileId = predecessor?.tile_id;
    const request = {
      prompt,
      modelId,
      ratio: story.ratio,
      count: 1,
      durationFrames: segment.duration_frames,
      ...(motionPrompt !== undefined ? { motionPrompt } : {}),
      ...(mode === 'i2v-first' && story.source_upload_id !== null
        ? { i2vSourceUploadId: story.source_upload_id }
        : {}),
      ...(mode === 'extension' && uploadId !== undefined && predecessorTileId !== undefined
        ? { i2vSourceUploadId: uploadId, extendsTileId: predecessorTileId }
        : {}),
    };

    const created = configured.db.transaction(():
      | { readonly kind: 'failed' }
      | { readonly kind: 'superseded' }
      | { readonly kind: 'deferred' }
      | { readonly kind: 'created'; readonly batchId: string; readonly createdAt: number } => {
      const currentStory = configured.db.query<{ status: StoryRow['status'] }, [string]>(
        'SELECT status FROM stories WHERE id = ?',
      ).get(story.id);
      const currentSegment = configured.db.query<{ batch_id: string | null }, [string, number]>(
        'SELECT batch_id FROM story_segments WHERE story_id = ? AND idx = ?',
      ).get(story.id, segment.idx);
      if (
        !isCurrentRuntime(configured)
        || currentStory?.status !== 'rendering'
        || currentSegment?.batch_id !== segment.batch_id
      ) {
        return { kind: 'superseded' };
      }
      if (countQueuedForUser(configured.db, story.user_id) >= configured.config.MAX_QUEUED_BATCHES_PER_USER) {
        return { kind: 'deferred' };
      }
      let extension: ReturnType<typeof validateExtension> | undefined;
      if (mode === 'extension' && uploadId !== undefined && predecessorTileId !== undefined) {
        extension = validateExtension(
          configured.db,
          story.user_id,
          predecessorTileId,
          uploadId,
          story.ratio,
          configured.config.MAX_SEQUENCE_SEGMENTS,
        );
        if (extension.status !== 'ok') {
          markStoryFailed(configured.db, story.id, extension.status);
          return { kind: 'failed' };
        }
      }
      const prepared = createBatch(configured.db, story.user_id, request, registryEntry);
      if (extension?.status === 'ok') {
        let sequenceId = extension.source.sequence_id;
        if (sequenceId === null) {
          const adopted = adoptStandaloneBatch(configured.db, story.user_id, extension.source.batch_id);
          if (adopted.status === 'conflict') {
            deletePreparedBatch(configured.db, story.user_id, prepared.batch.id);
            markStoryFailed(configured.db, story.id, 'not-tail');
            return { kind: 'failed' };
          }
          sequenceId = adopted.sequenceId;
        }
        const appended = appendSegment(
          configured.db,
          configured.logger,
          story.user_id,
          sequenceId,
          extension.source.batch_id,
          prepared.batch.id,
        );
        if (appended.status !== 'ok') {
          deletePreparedBatch(configured.db, story.user_id, prepared.batch.id);
          markStoryFailed(configured.db, story.id, 'not-tail');
          return { kind: 'failed' };
        }
      }
      const now = Date.now();
      configured.db.query(
        `UPDATE story_segments
            SET batch_id = ?, attempts = attempts + 1
          WHERE story_id = ? AND idx = ?`,
      ).run(prepared.batch.id, story.id, segment.idx);
      configured.db.query('UPDATE stories SET updated_at = ? WHERE id = ?')
        .run(now, story.id);
      return { kind: 'created', batchId: prepared.batch.id, createdAt: prepared.batch.created_at };
    }).immediate();
    if (created.kind === 'deferred') return 'deferred';
    if (created.kind !== 'created') return;
    submittedBatch = true;
    queue.enqueue('local', {
      batchId: created.batchId,
      userId: story.user_id,
      modelId,
      count: 1,
      queuedAt: created.createdAt,
    });
    configured.kickLocalQueue();
  } finally {
    // Only the newly extracted handoff is ours to release. The story's source
    // upload and accepted batches keep their existing retention contracts.
    if (uploadId !== undefined && !submittedBatch) {
      releaseUploads({
        db: configured.db, dataDir: configured.config.DATA_DIR,
        logger: configured.logger, userId: story.user_id, uploadIds: [uploadId],
      });
    }
  }
  return undefined;
}

function segmentMode(story: StoryRow, segment: StorySegmentRow): SegmentMode {
  if (segment.idx === 0 && story.source_upload_id === null && story.extends_tile_id === null) {
    return 't2v';
  }
  if (segment.idx === 0 && story.source_upload_id !== null && story.extends_tile_id === null) {
    return 'i2v-first';
  }
  return 'extension';
}

async function enhanceSegment(
  configured: StoryDriverRuntime,
  story: StoryRow,
  segment: StorySegmentRow,
  images: readonly EnhanceImageInput[],
  systemPrompt: string,
  signal: AbortSignal,
  lifetime: AbortSignal,
): Promise<string> {
  let release: (() => void) | undefined;
  try {
    lifetime.throwIfAborted();
    const slot = enhancePool.acquire(story.user_id);
    if (!slot.ok) return segment.beat;
    release = () => { slot.release(); };
    const provider = aiFillTextProviderForConfig(configured.config, 'kimi');
    let text = '';
    let done = false;
    for await (const chunk of provider.enhance(
      segment.beat,
      images,
      signal,
      systemPrompt,
      { defaults: MOTION_ENHANCE_DEFAULTS },
    )) {
      lifetime.throwIfAborted();
      if (chunk.type === 'delta') text += chunk.text;
      else if (chunk.type === 'reasoning') continue;
      else if (chunk.type === 'done') done = true;
      else throw new Error('motion enhancement failed');
    }
    const trimmed = text.trim();
    if (!done || trimmed.length === 0) throw new Error('motion enhancement returned no text');
    return trimmed;
  } catch (error) {
    lifetime.throwIfAborted();
    configured.logger.warn(
      { err: error, event: 'story_motion_enhance_failed', storyId: story.id, segmentIndex: segment.idx },
      'story motion enhancement failed; using raw beat',
    );
    return segment.beat;
  } finally {
    release?.();
  }
}

function loadPredecessorByTile(
  db: Database,
  userId: string,
  tileId: string | null,
): PredecessorRow | null {
  if (!tileId) return null;
  return db.query<PredecessorRow, [string, string]>(
    `SELECT b.id, b.status, b.prompt, b.motion_prompt, t.id AS tile_id
       FROM tiles t
       JOIN batches b ON b.id = t.batch_id AND b.user_id = t.user_id
      WHERE t.id = ? AND t.user_id = ? AND t.status = 'done'
        AND t.ext = 'mp4' AND t.mime = 'video/mp4'`,
  ).get(tileId, userId);
}

function loadPredecessorForPreviousSegment(
  db: Database,
  userId: string,
  segments: readonly StorySegmentRow[],
  segmentIndex: number,
): PredecessorRow | null {
  const previous = segments.find((segment) => segment.idx === segmentIndex - 1);
  if (!previous?.batch_id) return null;
  return db.query<PredecessorRow, [string, string]>(
    `SELECT b.id, b.status, b.prompt, b.motion_prompt, t.id AS tile_id
       FROM batches b
       JOIN tiles t ON t.batch_id = b.id AND t.user_id = b.user_id
      WHERE b.id = ? AND b.user_id = ? AND b.status = 'done'
        AND t.status = 'done' AND t.ext = 'mp4' AND t.mime = 'video/mp4'`,
  ).get(previous.batch_id, userId);
}

function recordSubmissionFailure(
  configured: StoryDriverRuntime,
  story: StoryRow,
  segment: StorySegmentRow,
  error: unknown,
): void {
  configured.logger.warn(
    { err: error, event: 'story_segment_submission_failed', storyId: story.id, segmentIndex: segment.idx },
    'story segment submission failed',
  );
  const attempts = configured.db.transaction(() => {
    configured.db.query(
      'UPDATE story_segments SET attempts = attempts + 1 WHERE story_id = ? AND idx = ?',
    ).run(story.id, segment.idx);
    const next = configured.db.query<{ attempts: number }, [string, number]>(
      'SELECT attempts FROM story_segments WHERE story_id = ? AND idx = ?',
    ).get(story.id, segment.idx)?.attempts ?? 2;
    if (next >= 2) markStoryFailed(configured.db, story.id, `segment ${segment.idx + 1} failed`);
    else configured.db.query('UPDATE stories SET updated_at = ? WHERE id = ?').run(Date.now(), story.id);
    return next;
  }).immediate();
  if (attempts < 2) kickStory(story.id);
}

// Foreign keys are OFF on this connection (bun:sqlite default), so removing a
// just-created batch must delete its child tiles explicitly or they orphan.
function deletePreparedBatch(db: Database, userId: string, batchId: string): void {
  db.query('DELETE FROM tiles WHERE batch_id = ? AND user_id = ?').run(batchId, userId);
  db.query('DELETE FROM batches WHERE id = ? AND user_id = ?').run(batchId, userId);
}

function markStoryFailed(db: Database, storyId: string, error: string): void {
  db.query(
    "UPDATE stories SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status = 'rendering'",
  ).run(error, Date.now(), storyId);
}

function markStoryCanceled(db: Database, storyId: string): void {
  db.query(
    "UPDATE stories SET status = 'canceled', error = NULL, updated_at = ? WHERE id = ? AND status = 'rendering'",
  ).run(Date.now(), storyId);
}

function resolveIdleWaiters(): void {
  for (const resolve of idleWaiters) resolve();
  idleWaiters.clear();
}

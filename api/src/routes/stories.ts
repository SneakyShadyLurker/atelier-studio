import { Hono, type Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type {
  ApiErrorCode,
  Ratio,
  StoryPlanSseEvent,
  StorySegmentPlan,
} from '@atelier/shared';
import {
  STORY_MAX_SEGMENTS,
  STORY_MIN_SEGMENTS,
} from '@atelier/shared';
import type { AppEnv } from '../server-env';
import { reportIfCorruption } from '../db/integrity';
import { countInflightVideoForUser } from '../db/queueOps';
import { withLlmSlot } from '../lifecycle/withLlmSlot';
import { enhancePool } from '../orchestrator/llmAdmission';
import { loadRefImages } from '../orchestrator/refImages';
import { validateExtension } from '../orchestrator/extendValidation';
import { abortStoryPreparation, kickStory } from '../orchestrator/storyDriver';
import { estimateStoryEtaMs } from '../orchestrator/videoEta';
import { parseJsonLenient } from '../prompts/lenientJson';
import {
  snapPlannedDuration,
  StoryPlanParseSchema,
  STORY_PLAN_RESPONSE_FORMAT,
  storyPlannerSystemPrompt,
  storyPlannerUserContent,
  type StorySourceMode,
} from '../prompts/storyPlannerSystemPrompt';
import { legacyLatencyProfile, STORY_PLANNER_DEFAULTS, textStreamDrainMs } from '../providers/cliproxyText.config';
import type { EnhanceImageInput } from '../providers/cliproxyText';
import {
  findModel,
  isLocalModelGated,
  localModelsAllowed,
  registryForConfig,
  type RegistryEntry,
} from '../providers/registry';
import { aiFillTextProviderForConfig } from '../providers/textRouting';
import { resolveTextBackend, resolveTextBackendEffort } from '../routing/textBackendPreference';
import { downscaleForVision } from '../storage/downscaleForVision';
import { uploadArtifactExists } from '../storage/uploadStore';
import { extensionErrorResponse, invalidFieldResponse, parseBody, parseParams } from './_http';
import { videoSequencesGate } from './sequences.gate';
import { StoryCreateBodySchema, StoryIdParamSchema } from './stories.schema';

const SAFE_ERROR_MESSAGE = "Couldn't plan the story. Please try again.";

interface ResolvedStorySource {
  readonly mode: StorySourceMode;
  readonly ratio: Ratio;
  readonly sourceUploadId: string | null;
  readonly extendsTileId: string | null;
  readonly sourcePrompt: string | null;
}

interface ExtendSourceRow {
  readonly ratio: Ratio;
  readonly prompt: string;
  readonly motion_prompt: string | null;
}


function requireModel(
  c: Context<AppEnv>,
  modelId: string,
): RegistryEntry | Response {
  const entry = findModel(modelId, c.var.config);
  if (!entry || isLocalModelGated(c.var.config, c.var.userId, entry)) {
    return c.json({ error: 'not found' }, 404);
  }
  return entry;
}

function isResponse(value: RegistryEntry | Response): value is Response {
  return value instanceof Response;
}

const localModelsGate = createMiddleware<AppEnv>(async (c, next) => {
  if (!localModelsAllowed(c.var.config, c.var.userId)) {
    return c.json({ error: 'not found' }, 404);
  }
  await next();
  return;
});

// Path-scoped: a sub-app `*` would gate every /api path mounted after it.
export const storiesRoutes = new Hono<AppEnv>()
  .use('/stories', videoSequencesGate, localModelsGate)
  .use('/stories/*', videoSequencesGate, localModelsGate)
  .post('/stories', async (c) => {
    const parsed = await parseBody(c, StoryCreateBodySchema);
    if (!parsed.ok) return parsed.response;
    const i2vEntry = requireModel(c, 'minimax-h3-i2v');
    if (isResponse(i2vEntry)) return i2vEntry;

    let source: ResolvedStorySource;
    let effectiveMax = STORY_MAX_SEGMENTS;
    if (parsed.value.extendsTileId !== undefined) {
      if (parsed.value.sourceUploadId === undefined) {
        return invalidFieldResponse(c, 'sourceUploadId', 'sourceUploadId is required when extending a video');
      }
      const row = c.var.db.query<ExtendSourceRow, [string, string]>(
        `SELECT b.ratio, b.prompt, b.motion_prompt
           FROM tiles t
           JOIN batches b ON b.id = t.batch_id AND b.user_id = t.user_id
          WHERE t.id = ? AND t.user_id = ? AND t.status = 'done'
            AND t.ext = 'mp4' AND t.mime = 'video/mp4' AND b.status = 'done'`,
      ).get(parsed.value.extendsTileId, c.var.userId);
      if (!row) return c.json({ error: 'not found' }, 404);
      const extension = validateExtension(
        c.var.db,
        c.var.userId,
        parsed.value.extendsTileId,
        parsed.value.sourceUploadId,
        row.ratio,
        c.var.config.MAX_SEQUENCE_SEGMENTS,
      );
      if (extension.status !== 'ok') return extensionErrorResponse(c, extension.status);
      const sequenceSegmentCount = extension.source.sequence_id === null
        ? 1
        : c.var.db.query<{ count: number }, [string, string]>(
          'SELECT COUNT(*) AS count FROM batches WHERE sequence_id = ? AND user_id = ?',
        ).get(extension.source.sequence_id, c.var.userId)?.count ?? 0;
      const remaining = c.var.config.MAX_SEQUENCE_SEGMENTS - sequenceSegmentCount;
      if (remaining < STORY_MIN_SEGMENTS) {
        return c.json({ error: 'sequence-full' }, 409);
      }
      effectiveMax = Math.min(STORY_MAX_SEGMENTS, remaining);
      source = {
        mode: 'extend',
        ratio: row.ratio,
        sourceUploadId: parsed.value.sourceUploadId,
        extendsTileId: parsed.value.extendsTileId,
        sourcePrompt: row.motion_prompt ?? row.prompt,
      };
    } else if (parsed.value.sourceUploadId !== undefined) {
      if (!(await uploadArtifactExists(c.var.db, c.var.config.DATA_DIR, c.var.userId, parsed.value.sourceUploadId))) {
        return c.json({ error: 'upload not found' }, 404);
      }
      if (parsed.value.ratio === undefined) {
        return invalidFieldResponse(c, 'ratio', 'ratio is required');
      }
      if (!i2vEntry.model.supportedRatios.includes(parsed.value.ratio)) {
        return invalidFieldResponse(c, 'ratio', 'unsupported ratio for modelId');
      }
      source = {
        mode: 'i2v',
        ratio: parsed.value.ratio,
        sourceUploadId: parsed.value.sourceUploadId,
        extendsTileId: null,
        sourcePrompt: parsed.value.sourcePrompt ?? null,
      };
    } else {
      if (parsed.value.ratio === undefined) {
        return invalidFieldResponse(c, 'ratio', 'ratio is required');
      }
      const t2vEntry = requireModel(c, 'minimax-h3-t2v');
      if (isResponse(t2vEntry)) return t2vEntry;
      if (!t2vEntry.model.supportedRatios.includes(parsed.value.ratio)) {
        return invalidFieldResponse(c, 'ratio', 'unsupported ratio for modelId');
      }
      source = {
        mode: 't2v',
        ratio: parsed.value.ratio,
        sourceUploadId: null,
        extendsTileId: null,
        sourcePrompt: null,
      };
    }

    if (c.var.healthSnapshot().get(i2vEntry.model.id)?.ok !== true) {
      return c.json(
        { error: 'model offline', code: 'MODEL_OFFLINE' satisfies ApiErrorCode },
        503,
      );
    }
    const videoModelIds = registryForConfig(c.var.config)
      .filter((entry) => entry.model.outputsVideo === true)
      .map((entry) => entry.model.id);
    if (
      countInflightVideoForUser(c.var.db, c.var.userId, videoModelIds)
      >= c.var.config.MAX_INFLIGHT_VIDEO_PER_USER
    ) {
      return c.json(
        { error: 'video generation already in progress', code: 'VIDEO_BUSY' satisfies ApiErrorCode },
        429,
      );
    }

    // Resolved before the slot so the deadline can follow the planner backend.
    const backend = resolveTextBackend(
      c.var.db,
      c.var.userId,
      'storytelling',
      'kimi',
      { visionRequired: source.mode !== 't2v', targetPool: 'local' },
    );
    const reasoningEffort = resolveTextBackendEffort(c.var.db, c.var.userId, 'storytelling', backend);

    return withLlmSlot(c, enhancePool, c.var.userId, 5, () => ({
      timeoutMs: textStreamDrainMs(legacyLatencyProfile(backend), c.var.config.CLOUD_TIMEOUT_MS),
      disconnect: c.req.raw.signal,
      run: async ({ send, signal, clientDisconnected }) => {
        const emit = (frame: StoryPlanSseEvent): void => { send(frame.event, frame.data); };
        emit({ event: 'status', data: { phase: 'planning' } });
        try {
          const provider = aiFillTextProviderForConfig(c.var.config, backend);
          let images: EnhanceImageInput[] = [];
          if (source.sourceUploadId !== null) {
            const loaded = await loadRefImages(
              c.var.db,
              c.var.config.DATA_DIR,
              c.var.userId,
              [source.sourceUploadId],
            );
            const image = loaded?.[0];
            if (!image) {
              emit({ event: 'error', data: { message: SAFE_ERROR_MESSAGE } });
              return;
            }
            images = [await downscaleForVision(image.bytes, signal)];
          }
          let text = '';
          let done = false;
          for await (const chunk of provider.enhance(
            storyPlannerUserContent(parsed.value.outline, source.sourcePrompt ?? undefined),
            images,
            signal,
            storyPlannerSystemPrompt(source.mode, effectiveMax),
            {
              defaults: STORY_PLANNER_DEFAULTS,
              responseFormat: STORY_PLAN_RESPONSE_FORMAT,
              ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
            },
          )) {
            if (chunk.type === 'delta') text += chunk.text;
            else if (chunk.type === 'reasoning') continue;
            else if (chunk.type === 'done') done = true;
            else {
              c.var.logger.warn(
                { event: 'story_plan_upstream_error', status: chunk.status, detail: chunk.detail, userId: c.var.userId },
                'story planning failed',
              );
              emit({ event: 'error', data: { message: SAFE_ERROR_MESSAGE } });
              return;
            }
          }
          if (!done || signal.aborted) {
            if (!clientDisconnected()) emit({ event: 'error', data: { message: SAFE_ERROR_MESSAGE } });
            return;
          }
          const decoded = StoryPlanParseSchema.safeParse(parseJsonLenient(text));
          if (!decoded.success) {
            c.var.logger.warn(
              { event: 'story_plan_invalid', issues: decoded.error.issues, userId: c.var.userId },
              'story plan was invalid',
            );
            emit({ event: 'error', data: { message: SAFE_ERROR_MESSAGE } });
            return;
          }
          const segments: StorySegmentPlan[] = decoded.data.segments
            .flatMap((segment) => {
              const beat = segment.beat.trim();
              return beat.length === 0
                ? []
                : [{ beat, durationFrames: snapPlannedDuration(segment.durationFrames) }];
            })
            .slice(0, effectiveMax);
          if (segments.length < STORY_MIN_SEGMENTS) {
            emit({ event: 'error', data: { message: SAFE_ERROR_MESSAGE } });
            return;
          }
          const etaMs = estimateStoryEtaMs(
            c.var.db,
            segments.map((segment, idx) => ({
              durationFrames: segment.durationFrames,
              isContinuation: idx > 0 || source.mode === 'extend',
            })),
          );
          const storyId = crypto.randomUUID();
          const now = Date.now();
          const logline = decoded.data.logline.trim();
          const continuityBible = decoded.data.continuityBible.trim();
          const persisted = c.var.db.transaction(() => {
            if (countInflightVideoForUser(c.var.db, c.var.userId, videoModelIds)
              >= c.var.config.MAX_INFLIGHT_VIDEO_PER_USER) return 'video-busy';
            // The source was checked before planning, but a thread delete can
            // release it while the planner runs; only the story row holds it.
            if (source.sourceUploadId !== null && c.var.db.query<{ one: number }, [string, string]>(
              'SELECT 1 AS one FROM uploads WHERE id = ? AND user_id = ?',
            ).get(source.sourceUploadId, c.var.userId) === null) return 'source-missing';
            c.var.db.query(
              `INSERT INTO stories
                (id, user_id, status, outline, logline, continuity_bible, ratio,
                 source_upload_id, extends_tile_id, source_prompt, error, eta_ms,
                 created_at, updated_at)
               VALUES (?, ?, 'rendering', ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
            ).run(
              storyId,
              c.var.userId,
              parsed.value.outline,
              logline,
              continuityBible,
              source.ratio,
              source.sourceUploadId,
              source.extendsTileId,
              source.sourcePrompt,
              etaMs,
              now,
              now,
            );
            const insert = c.var.db.query(
              `INSERT INTO story_segments
                (story_id, user_id, idx, beat, duration_frames, batch_id, attempts)
               VALUES (?, ?, ?, ?, ?, NULL, 0)`,
            );
            for (const [idx, segment] of segments.entries()) {
              insert.run(storyId, c.var.userId, idx, segment.beat, segment.durationFrames);
            }
            return 'persisted';
          }).immediate();
          if (persisted === 'video-busy') {
            emit({ event: 'error', data: { message: 'video generation already in progress', code: 'VIDEO_BUSY' } });
            return;
          }
          if (persisted === 'source-missing') {
            emit({ event: 'error', data: { message: 'upload not found' } });
            return;
          }
          kickStory(storyId);
          emit({ event: 'plan', data: { storyId, logline, segments, etaMs } });
        } catch (error) {
          if (!clientDisconnected()) {
            if (!reportIfCorruption(error, c.var.logger, {
              phase: 'story_plan',
              userId: c.var.userId,
            })) {
              c.var.logger.error(
                { err: error, event: 'story_plan_failed', userId: c.var.userId },
                'story planning failed',
              );
            }
            emit({ event: 'error', data: { message: SAFE_ERROR_MESSAGE } });
          }
        }
      },
    }));
  })
  .post('/stories/:id/cancel', (c) => {
    const params = parseParams(c, StoryIdParamSchema);
    if (!params.ok) return params.response;
    const result = c.var.db.transaction(():
      | { readonly status: 'not-found' }
      | { readonly status: 'canceled'; readonly inflightBatchId: string | null }
      | { readonly status: 'terminal' }
      | { readonly status: 'ok'; readonly inflightBatchId: string | null } => {
      const story = c.var.db.query<{ status: string }, [string, string]>(
        'SELECT status FROM stories WHERE id = ? AND user_id = ?',
      ).get(params.value.id, c.var.userId);
      if (!story) return { status: 'not-found' };
      if (story.status !== 'rendering' && story.status !== 'canceled') {
        return { status: 'terminal' };
      }
      const inflightBatchId = c.var.db.query<{ batch_id: string }, [string, string]>(
        `SELECT ss.batch_id
           FROM story_segments ss
           JOIN batches b ON b.id = ss.batch_id AND b.user_id = ss.user_id
          WHERE ss.story_id = ? AND ss.user_id = ?
            AND b.status IN ('queued', 'running')
          ORDER BY ss.idx DESC LIMIT 1`,
      ).get(params.value.id, c.var.userId)?.batch_id ?? null;
      if (story.status === 'canceled') return { status: 'canceled', inflightBatchId };
      c.var.db.query(
        "UPDATE stories SET status = 'canceled', error = NULL, updated_at = ? WHERE id = ? AND user_id = ?",
      ).run(Date.now(), params.value.id, c.var.userId);
      return { status: 'ok', inflightBatchId };
    }).immediate();
    if (result.status === 'not-found') return c.json({ error: 'not found' }, 404);
    if (result.status === 'terminal') return c.json({ error: 'story is not rendering' }, 409);
    abortStoryPreparation(c.var.db, params.value.id, c.var.userId);
    return c.json({ inflightBatchId: result.inflightBatchId });
  });

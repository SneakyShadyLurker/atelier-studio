import { Hono } from 'hono';
import type { ApiErrorCode, TextTask } from '@atelier/shared';
import type { AppEnv } from '../server-env';
import { withLlmSlot } from '../lifecycle/withLlmSlot';
import { enhancePool } from '../orchestrator/llmAdmission';
import type { EnhanceCallOptions, EnhanceImageInput } from '../providers/text/featureHelpers';
import { textModelFailureBody, textProviderForResolved } from '../providers/textRouting';
import { AI_FILL_DEFAULTS, MOTION_ENHANCE_DEFAULTS, textStreamDrainMs } from '../providers/text/textBudgets';
import { videoDurationSeconds } from '@atelier/shared';
import { motionEnhanceSystemPrompt } from '../prompts/motionEnhanceSystemPrompt';
import { motionExtendEnhanceSystemPrompt } from '../prompts/motionExtendEnhanceSystemPrompt';
import { failedToSseError } from '../lifecycle/llm-error';
import { EnhancePromptRequestSchema } from './enhance.schema';
import { parseBody } from './_http';
import { loadRefImages, refImageByteTotal } from '../orchestrator/refImages';
import { downscaleForVision } from '../storage/downscaleForVision';
import { findModel, localModelsAllowed } from '../providers/registry';
import { KREA_ENHANCE_SYSTEM_PROMPT, MOSS_ENHANCE_SYSTEM_PROMPT } from '../prompts/enhanceSystemPrompt';
import { isSunburstModel, SUNBURST_ENHANCE_SYSTEM_PROMPT } from '../prompts/gptSystemPrompt';
import { classifyImageModelTarget, isLocalOpenWeightsTarget } from '../prompts/gptImagePhrasing';
import { StorageSealedError } from '../storage/crypto';

const SAFE_ERROR_MESSAGE = 'Couldn’t enhance the prompt. Please try again.';

export const enhanceRoutes = new Hono<AppEnv>().post('/enhance-prompt', async (c) => {
  const parsed = await parseBody(c, EnhancePromptRequestSchema);
  if (!parsed.ok) return parsed.response;

  const logger = c.var.logger;
  const userId = c.var.userId;
  const prompt = parsed.value.prompt;
  const refImageIds = parsed.value.refImageIds;
  const extendContext = parsed.value.extendContext;
  // Motion and local formats keep their existing prompts. Only the exact
  // registered Sunburst model receives its dedicated enhancement contract.
  const modelId = parsed.value.modelId;
  const entry = modelId !== undefined ? findModel(modelId, c.var.config) : null;
  const localModelsEnabledForUser = localModelsAllowed(c.var.config, userId);
  const promptFormat = entry && (entry.model.pool !== 'local' || localModelsEnabledForUser)
    ? entry.model.promptFormat
    : undefined;
  const wantsMotion = promptFormat === 'h3-motion';

  let systemPrompt: string | undefined;
  let enhanceOpts: EnhanceCallOptions;
  let handoffUploadIdForVision: string | undefined;
  let task: TextTask;
  let visionRequired: boolean;

  if (wantsMotion) {
    // MiniMax H3 motion-prompt enhancement runs on the `motion` task's model.
    // The kill switch returns an explicit 409 the client treats as "submit
    // the raw motion prompt".
    if (!c.var.config.I2V_MOTION_ENHANCE) {
      return c.json(
        { error: 'motion enhancement unavailable', code: 'MOTION_ENHANCE_UNAVAILABLE' satisfies ApiErrorCode },
        409,
      );
    }
    task = 'motion';
    const motionPromptOpts = {
      ...(parsed.value.sourcePrompt !== undefined ? { sourcePrompt: parsed.value.sourcePrompt } : {}),
      ...(parsed.value.durationFrames !== undefined
        ? { clipSeconds: videoDurationSeconds(parsed.value.durationFrames) }
        : {}),
    };
    const motionSystemPrompt = extendContext === undefined
      ? motionEnhanceSystemPrompt(motionPromptOpts)
      : motionExtendEnhanceSystemPrompt({
          ...motionPromptOpts,
          previousMotionPrompt: extendContext.previousMotionPrompt,
        });
    systemPrompt = motionSystemPrompt;
    enhanceOpts = { defaults: MOTION_ENHANCE_DEFAULTS };
    handoffUploadIdForVision = extendContext?.handoffUploadId;
    // The handoff frame is sent to the writer, so it needs a vision model.
    visionRequired = handoffUploadIdForVision !== undefined;
  } else {
    const rawTarget = modelId === undefined ? null : classifyImageModelTarget(modelId);
    const target = isLocalOpenWeightsTarget(rawTarget) && !localModelsEnabledForUser ? null : rawTarget;
    task = 'enhance';
    visionRequired = refImageIds !== undefined && refImageIds.length > 0;
    // Krea and MOSS keep their own enhance prompts; Sunburst gets its
    // dedicated contract; other image targets use the provider's
    // model-neutral default.
    systemPrompt = isLocalOpenWeightsTarget(target)
      ? target === 'moss' ? MOSS_ENHANCE_SYSTEM_PROMPT : KREA_ENHANCE_SYSTEM_PROMPT
      : isSunburstModel(entry?.model.id) ? SUNBURST_ENHANCE_SYSTEM_PROMPT : undefined;
    enhanceOpts = { defaults: AI_FILL_DEFAULTS };
  }
  // The image model selects its prompt writer, if one is set.
  const resolved = c.var.text.resolve({
    userId,
    task,
    ...(entry ? { imageModelId: entry.model.id } : {}),
    visionRequired,
  });
  if (!resolved.ok) return c.json(textModelFailureBody(resolved.reason), 409);
  const provider = textProviderForResolved(c.var.config, c.var.text, resolved.model);
  if (resolved.effort !== undefined) enhanceOpts = { ...enhanceOpts, reasoningEffort: resolved.effort };
  if (refImageIds && refImageIds.length > 0) {
    const totalBytes = refImageByteTotal(c.var.db, userId, refImageIds);
    if (totalBytes === null) {
      return c.json(
        { error: 'reference image not found', issues: [{ path: ['refImageIds'], message: 'not found' }] },
        400,
      );
    }
    if (totalBytes > c.var.config.MAX_REF_BYTES_PER_BATCH) {
      return c.json(
        { error: 'reference images too large', issues: [{ path: ['refImageIds'], message: 'too large' }] },
        400,
      );
    }
  }
  // Server-owned hard ceiling on one enhance stream (the cloud upstream timeout,
  // longer for GLM). Admission control + slot lifecycle live in withLlmSlot.
  const timeoutMs = textStreamDrainMs(resolved.model.latencyProfile, c.var.config.CLOUD_TIMEOUT_MS);

  return withLlmSlot(c, enhancePool, userId, 5, () => ({
    timeoutMs,
    disconnect: c.req.raw.signal,
    run: async ({ send, signal, timedOut, clientDisconnected }) => {
      let settled = false;
      const fail = (event: string): void => {
        logger.error({ event, timeoutMs, userId }, 'prompt enhance did not complete');
        send('error', { message: SAFE_ERROR_MESSAGE });
      };
      try {
        let images: EnhanceImageInput[] = [];
        if (refImageIds && refImageIds.length > 0) {
          const loaded = await loadRefImages(c.var.db, c.var.config.DATA_DIR, userId, refImageIds);
          if (!loaded) {
            logger.warn({ event: 'enhance_ref_missing', userId }, 'enhance ref artifact missing');
            send('error', { message: SAFE_ERROR_MESSAGE });
            return;
          }
          try {
            images = await Promise.all(loaded.map((ref) => downscaleForVision(ref.bytes, signal)));
          } catch (err) {
            // A client disconnect mid-downscale aborts `signal`; stay silent
            // (the outer finally still releases the slot). Real decode failures
            // surface as a safe error.
            if (!clientDisconnected()) {
              logger.error({ err, event: 'enhance_downscale_failed', userId }, 'enhance ref downscale failed');
              send('error', { message: SAFE_ERROR_MESSAGE });
            }
            return;
          }
        }
        if (handoffUploadIdForVision !== undefined) {
          try {
            const loaded = await loadRefImages(
              c.var.db,
              c.var.config.DATA_DIR,
              userId,
              [handoffUploadIdForVision],
            );
            const handoff = loaded?.[0];
            if (handoff === undefined) {
              logger.warn(
                { event: 'motion_extend_handoff_missing', userId },
                'motion extend handoff image unavailable; continuing without vision',
              );
            } else {
              images = [...images, await downscaleForVision(handoff.bytes, signal)];
            }
          } catch (err) {
            if (signal.aborted) return;
            // Sealed storage is transient and must fail the request (outer
            // catch → safe SSE error), not silently drop the vision input.
            if (err instanceof StorageSealedError) throw err;
            logger.warn(
              { err, event: 'motion_extend_handoff_unreadable', userId },
              'motion extend handoff image unreadable; continuing without vision',
            );
          }
        }
        try {
          for await (const chunk of provider.enhance(prompt, images, signal, systemPrompt, enhanceOpts)) {
            if (signal.aborted) break;
            if (chunk.type === 'delta') {
              send('delta', { text: chunk.text });
            } else if (chunk.type === 'reasoning') {
              // The enhance stream carries text only; the client renders deltas
              // as they land, so there is no waiting state to narrate.
              continue;
            } else if (chunk.type === 'done') {
              send('done', {});
              settled = true;
            } else {
              logger.warn(
                { event: 'enhance_upstream_error', status: chunk.status, detail: chunk.detail, userId },
                'prompt enhance failed',
              );
              send('error', failedToSseError(chunk));
              settled = true;
            }
          }
        } finally {
          // Explicit finally on the for-await consumer. The async iterator
          // protocol calls `provider.enhance`'s `return()` automatically on
          // any early exit (break, throw, return) — that's what releases
          // the underlying SSE reader + fetch. This block is empty by
          // design; its presence documents the contract for readers and
          // ensures any future cleanup added here cannot be skipped.
        }
        // Loop ended without a terminal event: a timeout that landed in the
        // inter-frame window, or a provider that returned without done/error.
        // Never leave the client hanging — a deliberate client disconnect
        // stays silent.
        if (!settled && !clientDisconnected()) {
          fail(timedOut() ? 'enhance_timeout' : 'enhance_truncated');
        }
      } catch (error) {
        if (!clientDisconnected()) {
          logger.error(
            { err: error, event: timedOut() ? 'enhance_timeout' : 'enhance_stream_error', timeoutMs, userId },
            timedOut() ? 'prompt enhance timed out' : 'prompt enhance stream crashed',
          );
          send('error', { message: SAFE_ERROR_MESSAGE });
        }
      }
    },
  }));
});

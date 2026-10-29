import { Hono } from 'hono';
import type { AiFillBackend } from '@atelier/shared';
import { TEXT_BACKEND_LABELS } from '@atelier/shared';
import type { AppEnv } from '../server-env';
import { draftPool } from '../orchestrator/llmAdmission';
import { withLlmSlot } from '../lifecycle/withLlmSlot';
import { aiFillTextProviderForConfig } from '../providers/textRouting';
import { findModel } from '../providers/registry';
import { parseBody } from './_http';
import { BrainstormCharactersRequestSchema } from './characters.schema';
import { failedToSseError } from '../lifecycle/llm-error';
import { classifyImageModelTarget } from '../prompts/gptImagePhrasing';
import { resolveTextBackend, resolveTextBackendEffort } from '../routing/textBackendPreference';
import { isSunburstModel } from '../prompts/gptSystemPrompt';
import { brainstormRouteTimeoutMs, textStreamDrainMs } from '../providers/cliproxyText.config';

const SAFE_ERROR_MESSAGE = "Couldn't brainstorm characters. Please try again.";

export const charactersRoutes = new Hono<AppEnv>().post('/prompts/characters/brainstorm', async (c) => {
  const parsed = await parseBody(c, BrainstormCharactersRequestSchema);
  if (!parsed.ok) return parsed.response;

  const logger = c.var.logger;
  const userId = c.var.userId;
  const entry = findModel(parsed.value.modelId, c.var.config);
  const target = classifyImageModelTarget(parsed.value.modelId);
  const targetPool = entry ? entry.model.pool === 'local' ? 'local' : 'cloud' : undefined;
  if (parsed.value.textBackend === 'gpt' && targetPool !== 'cloud') {
    return c.json({ error: `${TEXT_BACKEND_LABELS.gpt} supports cloud image models only; local or unknown targets cannot pin gpt` }, 400);
  }
  // Sunburst is fixed. Other targets retain explicit pins, preferences and Auto.
  const sunburst = isSunburstModel(entry?.model.id);
  const backend = (sunburst ? 'gpt' as const : parsed.value.textBackend)
    ?? resolveTextBackend(
         c.var.db, userId, 'brainstorm',
         target === 'gpt' ? 'gpt' : 'kimi',
         entry && targetPool !== undefined ? { targetModelId: entry.model.id, targetPool } : {},
       );
  // A pinned effort applies only when the pin serves the selected backend.
  const initialEffort = resolveTextBackendEffort(c.var.db, userId, 'brainstorm', backend);
  // One-shot transient failover partner: every non-Kimi backend hands over to
  // Kimi; Kimi has no partner and fails on its own terms.
  const otherBackend: AiFillBackend | null = backend === 'kimi' ? null : 'kimi';
  const count = Math.min(parsed.value.count, c.var.config.BRAINSTORM_MAX_COUNT);
  const input = {
    count,
    modelId: parsed.value.modelId,
    ...(parsed.value.brief === undefined ? {} : { brief: parsed.value.brief }),
    ...(parsed.value.layout === undefined ? {} : { layout: parsed.value.layout }),
    ...(parsed.value.medium === undefined ? {} : { medium: parsed.value.medium }),
    ...(parsed.value.variationSeed === undefined ? {} : { variationSeed: parsed.value.variationSeed }),
  };

  // The selected backend's stream drain (CLOUD_TIMEOUT_MS, longer for GLM) is
  // the budget once a backend has opened; the open envelope of both sequential
  // backend groups is added on top so a failover that finally opens is not cut
  // off mid-stream by the route deadline. The failover partner is never GLM.
  const timeoutMs = brainstormRouteTimeoutMs(
    textStreamDrainMs(backend, c.var.config.CLOUD_TIMEOUT_MS),
    c.var.config.BRAINSTORM_OPEN_TIMEOUT_MS,
    c.var.config.RESILIENT_MAX_ATTEMPTS,
    c.var.config.RESILIENT_MAX_BACKOFF_MS,
  );

  return withLlmSlot(c, draftPool, userId, 30, () => ({
    timeoutMs,
    disconnect: c.req.raw.signal,
    run: async ({ send, signal, timedOut, clientDisconnected }) => {
        // Brainstorm carries no image, so every selectable backend can write it. When the
        // selected backend fails transiently (timeout / 5xx after its own retry
        // policy) before a single prompt was emitted, hand the run to Kimi
        // once instead of failing the caller; Kimi itself has no partner. Refusals, quota, and
        // permanent failures stay on the selected backend. Resolves to whether
        // a terminal event was sent.
        const run = async (current: AiFillBackend, fallback: AiFillBackend | null): Promise<boolean> => {
          const provider = aiFillTextProviderForConfig(c.var.config, current);
          // The failover partner always differs from `backend`, so it keeps its default effort.
          const reasoningEffort = current === backend ? initialEffort : undefined;
          let emitted = 0;
          for await (const chunk of provider.brainstormCharacters(
            reasoningEffort === undefined ? input : { ...input, reasoningEffort },
            signal,
          )) {
            if (signal.aborted) break;
            if (chunk.type === 'prompt') {
              emitted += 1;
              send('prompt', { index: chunk.index, text: chunk.text });
            } else if (chunk.type === 'done') {
              send('done', { count: chunk.count });
              return true;
            } else if (fallback !== null && emitted === 0 && chunk.kind === 'transient') {
              logger.warn(
                { event: 'brainstorm_backend_fallback', from: current, to: fallback, status: chunk.status, detail: chunk.detail, userId },
                'brainstorm failing over to the other backend',
              );
              return run(fallback, null);
            } else {
              logger.warn(
                { event: 'brainstorm_upstream_error', backend: current, status: chunk.status, detail: chunk.detail, userId },
                'brainstorm characters failed',
              );
              send('error', failedToSseError(chunk));
              return true;
            }
          }
          return false;
        };
        try {
          const settled = await run(backend, sunburst ? null : otherBackend);
          if (!settled && !clientDisconnected()) {
            logger.error(
              { event: timedOut() ? 'brainstorm_timeout' : 'brainstorm_truncated', timeoutMs, userId },
              'brainstorm characters did not complete',
            );
            send('error', { message: SAFE_ERROR_MESSAGE });
          }
        } catch (error) {
          if (!clientDisconnected()) {
            logger.error(
              { err: error, event: timedOut() ? 'brainstorm_timeout' : 'brainstorm_stream_error', timeoutMs, userId },
              timedOut() ? 'brainstorm timed out' : 'brainstorm stream crashed',
            );
            send('error', { message: SAFE_ERROR_MESSAGE });
          }
        }
    },
  }));
});

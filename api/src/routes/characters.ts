import { Hono } from 'hono';
import type { AppEnv } from '../server-env';
import { draftPool } from '../orchestrator/llmAdmission';
import { withLlmSlot } from '../lifecycle/withLlmSlot';
import { textModelFailureBody, textProviderForResolved } from '../providers/textRouting';
import { findModel } from '../providers/registry';
import { parseBody } from './_http';
import { BrainstormCharactersRequestSchema } from './characters.schema';
import { failedToSseError } from '../lifecycle/llm-error';
import type { ResolveTextModelInput } from '../routing/textModelResolver';
import type { TextModelRecord } from '../db/textProviders';
import { brainstormRouteTimeoutMs, textStreamDrainMs } from '../providers/text/textBudgets';

const SAFE_ERROR_MESSAGE = "Couldn't brainstorm characters. Please try again.";

export const charactersRoutes = new Hono<AppEnv>().post('/prompts/characters/brainstorm', async (c) => {
  const parsed = await parseBody(c, BrainstormCharactersRequestSchema);
  if (!parsed.ok) return parsed.response;

  const logger = c.var.logger;
  const userId = c.var.userId;
  const text = c.var.text;
  const entry = findModel(parsed.value.modelId, c.var.config);
  const { textModelId } = parsed.value;
  // The request pin must name an enabled model.
  if (textModelId !== undefined && !text.snapshot.current().models.has(textModelId)) {
    return c.json({ error: 'This text model is not available', issues: [{ path: ['textModelId'], message: 'unknown or turned off' }] }, 400);
  }
  const route: ResolveTextModelInput = {
    userId,
    task: 'brainstorm',
    ...(entry ? { imageModelId: entry.model.id } : {}),
    ...(textModelId === undefined ? {} : { requestPin: textModelId }),
  };
  const resolved = text.resolve(route);
  if (!resolved.ok) return c.json(textModelFailureBody(resolved.reason), 409);
  // One-shot transient failover partner (spec § 2.3): the resolver's next
  // choice with the selected model excluded. A locked writer has none (the
  // resolver fails rather than cross it), and a screened model never hands
  // its request to an unscreened one.
  const next = text.resolve({ ...route, excludeModelIds: [resolved.model.id] });
  const partner: TextModelRecord | null = next.ok
    && next.model.id !== resolved.model.id
    && (!resolved.model.screenRequests || next.model.screenRequests)
    ? next.model
    : null;
  const count = Math.min(parsed.value.count, c.var.config.BRAINSTORM_MAX_COUNT);
  const input = {
    count,
    modelId: parsed.value.modelId,
    ...(parsed.value.brief === undefined ? {} : { brief: parsed.value.brief }),
    ...(parsed.value.layout === undefined ? {} : { layout: parsed.value.layout }),
    ...(parsed.value.medium === undefined ? {} : { medium: parsed.value.medium }),
    ...(parsed.value.variationSeed === undefined ? {} : { variationSeed: parsed.value.variationSeed }),
  };

  // The longer stream drain of the two models that may serve (CLOUD_TIMEOUT_MS,
  // longer for slow models) is the budget once one has opened; the open
  // envelope of both sequential attempts is added on top so a failover that
  // finally opens is not cut off mid-stream by the route deadline.
  const timeoutMs = brainstormRouteTimeoutMs(
    Math.max(
      textStreamDrainMs(resolved.model.latencyProfile, c.var.config.CLOUD_TIMEOUT_MS),
      partner === null ? 0 : textStreamDrainMs(partner.latencyProfile, c.var.config.CLOUD_TIMEOUT_MS),
    ),
    c.var.config.BRAINSTORM_OPEN_TIMEOUT_MS,
    c.var.config.RESILIENT_MAX_ATTEMPTS,
    c.var.config.RESILIENT_MAX_BACKOFF_MS,
  );

  return withLlmSlot(c, draftPool, userId, 30, () => ({
    timeoutMs,
    disconnect: c.req.raw.signal,
    run: async ({ send, signal, timedOut, clientDisconnected }) => {
        // Brainstorm carries no image, so every model can write it. When the
        // selected model fails transiently (timeout / 5xx after its own retry
        // policy) before a single prompt was emitted, hand the run to the
        // partner once instead of failing the caller; the partner has none.
        // Refusals, quota, and permanent failures stay on the selected model.
        // Resolves to whether a terminal event was sent.
        const run = async (current: TextModelRecord, fallback: TextModelRecord | null): Promise<boolean> => {
          const provider = textProviderForResolved(c.var.config, text, current);
          // A user's effort stays with the selected model; the partner keeps its row default.
          const reasoningEffort = current.id === resolved.model.id ? resolved.effort : undefined;
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
                { event: 'brainstorm_backend_fallback', from: current.id, to: fallback.id, status: chunk.status, detail: chunk.detail, userId },
                'brainstorm failing over to the partner model',
              );
              return run(fallback, null);
            } else {
              logger.warn(
                { event: 'brainstorm_upstream_error', textModelId: current.id, status: chunk.status, detail: chunk.detail, userId },
                'brainstorm characters failed',
              );
              send('error', failedToSseError(chunk));
              return true;
            }
          }
          return false;
        };
        try {
          const settled = await run(resolved.model, partner);
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

import { Hono } from 'hono';
import type { AppEnv } from '../../server-env';
import { ensureUser } from '../../db/users';
import { reorderOwned } from '../../db/reorder';
import type { DraftTemplateResult } from '../../providers/cliproxyText';
import { imageModelRouting, textModelFailureBody, textProviderForResolved } from '../../providers/textRouting';
import { failedToSseError } from '../../lifecycle/llm-error';
import { libraryOverviewForUser } from './libraryOverviewDb';
import { draftPool } from '../../orchestrator/llmAdmission';
import { withLlmSlot } from '../../lifecycle/withLlmSlot';
import { parseBody, parseParams } from '../_http';
import { DraftTemplateRequestSchema, IdParam, TemplateCreate, TemplatePatch } from '../prompts.schema';
import {
  countRows,
  isUniqueConstraintError,
  nextSortOrder,
  parseOrder,
  PromptLimitError,
  promptLibrary,
  templateById,
} from './_shared';

export const templatesRoutes = new Hono<AppEnv>()
  .post('/prompts/templates', async (c) => {
    const parsed = await parseBody(c, TemplateCreate);
    if (!parsed.ok) return parsed.response;
    if (Buffer.byteLength(parsed.value.body, 'utf8') > c.var.config.MAX_TEMPLATE_BODY_BYTES) {
      return c.json({ error: 'template body too large' }, 409);
    }

    const id = crypto.randomUUID();
    const now = Date.now();
    try {
      const created = c.var.db.transaction(() => {
        ensureUser(c.var.db, c.var.userId, now);
        const count = countRows(c.var.db, 'prompt_templates', c.var.userId);
        if (count >= c.var.config.MAX_PROMPT_TEMPLATES) throw new PromptLimitError('template limit reached');
        const next = nextSortOrder(c.var.db, 'prompt_templates', c.var.userId);
        c.var.db
          .query(
            `INSERT INTO prompt_templates
               (id, user_id, name, body, notes, sort_order, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(id, c.var.userId, parsed.value.name, parsed.value.body, parsed.value.notes ?? null, next, now, now);
        return templateById(c.var.db, c.var.userId, id);
      })();
      if (!created) return c.json({ error: 'internal error' }, 500);
      return c.json(created, 201);
    } catch (error) {
      if (error instanceof PromptLimitError) return c.json({ error: error.message }, 409);
      if (isUniqueConstraintError(error, 'prompt_templates')) return c.json({ error: 'name already used' }, 409);
      throw error;
    }
  })
  .patch('/prompts/templates/:id', async (c) => {
    const params = parseParams(c, IdParam);
    if (!params.ok) return params.response;
    const parsed = await parseBody(c, TemplatePatch);
    if (!parsed.ok) return parsed.response;
    if (
      parsed.value.body !== undefined &&
      Buffer.byteLength(parsed.value.body, 'utf8') > c.var.config.MAX_TEMPLATE_BODY_BYTES
    ) {
      return c.json({ error: 'template body too large' }, 409);
    }

    try {
      const updated = c.var.db.transaction(() => {
        const existing = templateById(c.var.db, c.var.userId, params.value.id);
        if (!existing) return null;
        const now = Date.now();
        const assignments: string[] = [];
        const values: (string | number | null)[] = [];
        if (parsed.value.name !== undefined) {
          assignments.push('name = ?');
          values.push(parsed.value.name);
        }
        if (parsed.value.body !== undefined) {
          assignments.push('body = ?');
          values.push(parsed.value.body);
        }
        if (parsed.value.notes !== undefined) {
          assignments.push('notes = ?');
          values.push(parsed.value.notes);
        }
        assignments.push('updated_at = ?');
        values.push(now, params.value.id, c.var.userId);
        c.var.db.run(
          `UPDATE prompt_templates SET ${assignments.join(', ')} WHERE id = ? AND user_id = ?`,
          values,
        );
        return templateById(c.var.db, c.var.userId, params.value.id);
      })();
      if (!updated) return c.body(null, 404);
      return c.json(updated);
    } catch (error) {
      if (isUniqueConstraintError(error, 'prompt_templates')) return c.json({ error: 'name already used' }, 409);
      throw error;
    }
  })
  .delete('/prompts/templates/:id', (c) => {
    const params = parseParams(c, IdParam);
    if (!params.ok) return params.response;
    c.var.db.query('DELETE FROM prompt_templates WHERE id = ? AND user_id = ?').run(params.value.id, c.var.userId);
    return c.body(null, 204);
  })
  .put('/prompts/templates/order', async (c) => {
    const parsed = await parseOrder(c);
    if (!parsed.ok) return parsed.response;
    const result = reorderOwned(c.var.db, c.var.userId, 'prompt_templates', parsed.value.orderedIds);
    if (result === 'duplicate') return c.json({ error: 'orderedIds contains duplicates' }, 400);
    if (result === 'mismatch') return c.json({ error: 'orderedIds must match current templates' }, 409);
    return c.json(promptLibrary(c.var.db, c.var.userId));
  })
  .post('/prompts/templates/draft', async (c) => {
    const parsed = await parseBody(c, DraftTemplateRequestSchema);
    if (!parsed.ok) return parsed.response;
    const { name, existingBody, description } = parsed.value;

    if (Buffer.byteLength(existingBody, 'utf8') > c.var.config.MAX_TEMPLATE_BODY_BYTES) {
      return c.json({ error: 'template body too large' }, 409);
    }

    const overview = libraryOverviewForUser(c.var.db, c.var.userId);

    const SAFE = "Couldn't draft the template. Please try again.";
    const logger = c.var.logger;
    const userId = c.var.userId;
    const resolved = c.var.text.resolve({ userId, task: 'template-draft', ...imageModelRouting(c.var.config, parsed.value.modelId) });
    if (!resolved.ok) return c.json(textModelFailureBody(resolved.reason), 409);
    const provider = textProviderForResolved(c.var.config, c.var.text, resolved.model);
    // SSE (not single-shot JSON): the upstream LLM call can outlive the
    // Cloudflare edge's ~100s idle cutoff, which would sever a plain-JSON
    // response with a silent 502. The shared helper emits a 15s :keepalive
    // and exactly one terminal `done`/`error` frame. Mirrors enhance.ts /
    // infer.ts. The provider call is non-streaming; we relay its single
    // result as one terminal frame.
    const timeoutMs = c.var.config.CLOUD_TIMEOUT_MS;
    return withLlmSlot(c, draftPool, userId, 30, () => ({
      timeoutMs,
      disconnect: c.req.raw.signal,
      run: async ({ send, signal, timedOut, clientDisconnected }) => {
        let result: DraftTemplateResult;
        try {
          result = await provider.draftTemplate(
            {
              name,
              existingBody,
              ...(description !== undefined ? { description } : {}),
              library: overview,
              ...(parsed.value.modelId ? { modelId: parsed.value.modelId } : {}),
              ...(resolved.effort === undefined ? {} : { reasoningEffort: resolved.effort }),
            },
            signal,
          );
        } catch (error) {
          // Deliberate client disconnect — silent, mirrors enhance.ts.
          if (clientDisconnected()) return;
          if (timedOut()) {
            logger.warn({ event: 'draft_template_timeout', timeoutMs, userId }, 'draft template timed out');
          } else {
            logger.error({ err: error, event: 'draft_template_crash', userId }, 'draft template crashed');
          }
          send('error', { message: SAFE });
          return;
        }

        if (result.type === 'failed') {
          // The non-streaming provider swallows AbortErrors thrown by fetch() with a
          // plain Error reason (Bun throws the reason object itself, not a DOMException,
          // so provider.catch's `err.name === 'AbortError'` check is false). Detect the
          // timeout case here too before logging it as an upstream error.
          if (timedOut()) {
            logger.warn({ event: 'draft_template_timeout', timeoutMs, userId }, 'draft template timed out');
            send('error', { message: SAFE });
            return;
          }
          logger.warn(
            { event: 'draft_template_upstream_error', status: result.status, userId },
            'draft template failed',
          );
          send('error', result.moderation ? failedToSseError(result) : { message: SAFE });
          return;
        }

        if (description !== undefined && result.payload.kind === 'clarify') {
          logger.warn(
            { event: 'draft_template_clarify_after_description', userId },
            'model re-asked for clarification despite a description',
          );
          send('error', { message: SAFE });
          return;
        }

        send('done', result.payload);
      },
    }));
  });

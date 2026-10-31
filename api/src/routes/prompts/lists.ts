import { Hono } from 'hono';
import { z } from 'zod';
import type { VariableOption } from '@atelier/shared';
import type { AppEnv } from '../../server-env';
import { ensureUser } from '../../db/users';
import { reorderOwned } from '../../db/reorder';
import type { DraftResult } from '../../providers/text/featureHelpers';
import { imageModelRouting, textModelFailureBody, textProviderForResolved } from '../../providers/textRouting';
import { failedToSseError } from '../../lifecycle/llm-error';
import { draftPool } from '../../orchestrator/llmAdmission';
import { withLlmSlot } from '../../lifecycle/withLlmSlot';
import { parseBody, parseParams } from '../_http';
import { DraftListBody, IdParam, ListCreate, ListPatch, OptionIdParam, OptionPatch, OptionsReplace } from '../prompts.schema';
import {
  countRows,
  existsList,
  isUniqueConstraintError,
  listById,
  nextSortOrder,
  ownedTagIds,
  parseOrder,
  PromptLimitError,
  promptLibrary,
  tagParentIndex,
  tagSetsOverlapThroughAncestors,
} from './_shared';

const ReplaceOptionV2 = OptionsReplace.shape.options.element.extend({
  id: z.uuid().optional(),
  excludeTagIds: OptionsReplace.shape.options.element.shape.tagIds.optional(),
}).superRefine((option, ctx) => {
  const excluded = new Set(option.excludeTagIds ?? []);
  if (option.tagIds.some((tagId) => excluded.has(tagId))) {
    ctx.addIssue({ code: 'custom', message: 'the same tag cannot be both require and exclude' });
  }
});
const OptionsReplaceV2 = OptionsReplace.extend({
  options: z.array(ReplaceOptionV2).max(2_000).refine(
    (options) => {
      const ids = options.flatMap((option) => option.id === undefined ? [] : [option.id]);
      return new Set(ids).size === ids.length;
    },
    { message: 'option ids must be unique' },
  ),
});
const OptionPatchV2 = z.object({
  ...OptionPatch.shape,
  excludeTagIds: OptionsReplace.shape.options.element.shape.tagIds.optional(),
}).strict().superRefine((option, ctx) => {
  if (
    option.tagIds !== undefined
    && option.excludeTagIds !== undefined
    && option.tagIds.some((tagId) => new Set(option.excludeTagIds).has(tagId))
  ) {
    ctx.addIssue({ code: 'custom', message: 'the same tag cannot be both require and exclude' });
  }
  if (
    option.value === undefined
    && option.tagIds === undefined
    && option.excludeTagIds === undefined
    && option.sortOrder === undefined
    && option.weight === undefined
  ) {
    ctx.addIssue({ code: 'custom', message: 'at least one field must be supplied' });
  }
});

const AUTO_SELECTION_REQUIRED = 'at least one option must remain available for automatic selection';

export const listsRoutes = new Hono<AppEnv>()
  .post('/prompts/lists', async (c) => {
    const parsed = await parseBody(c, ListCreate);
    if (!parsed.ok) return parsed.response;

    const id = crypto.randomUUID();
    const now = Date.now();
    try {
      const created = c.var.db.transaction(() => {
        ensureUser(c.var.db, c.var.userId, now);
        const count = countRows(c.var.db, 'variable_lists', c.var.userId);
        if (count >= c.var.config.MAX_VARIABLE_LISTS) throw new PromptLimitError('list limit reached');
        const next = nextSortOrder(c.var.db, 'variable_lists', c.var.userId);
        c.var.db
          .query(
            `INSERT INTO variable_lists
               (id, user_id, name, sort_order, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(id, c.var.userId, parsed.value.name, next, now, now);
        return listById(c.var.db, c.var.userId, id);
      })();
      if (!created) return c.json({ error: 'internal error' }, 500);
      return c.json(created, 201);
    } catch (error) {
      if (error instanceof PromptLimitError) return c.json({ error: error.message }, 409);
      if (isUniqueConstraintError(error, 'variable_lists')) return c.json({ error: 'name already used' }, 409);
      throw error;
    }
  })
  .patch('/prompts/lists/:id', async (c) => {
    const params = parseParams(c, IdParam);
    if (!params.ok) return params.response;
    const parsed = await parseBody(c, ListPatch);
    if (!parsed.ok) return parsed.response;

    try {
      const updated = c.var.db.transaction(() => {
        if (!existsList(c.var.db, c.var.userId, params.value.id)) return null;
        c.var.db
          .query('UPDATE variable_lists SET name = ?, updated_at = ? WHERE id = ? AND user_id = ?')
          .run(parsed.value.name, Date.now(), params.value.id, c.var.userId);
        return listById(c.var.db, c.var.userId, params.value.id);
      })();
      if (!updated) return c.body(null, 404);
      return c.json(updated);
    } catch (error) {
      if (isUniqueConstraintError(error, 'variable_lists')) return c.json({ error: 'name already used' }, 409);
      throw error;
    }
  })
  .delete('/prompts/lists/:id', (c) => {
    const params = parseParams(c, IdParam);
    if (!params.ok) return params.response;
    c.var.db.query('DELETE FROM variable_lists WHERE id = ? AND user_id = ?').run(params.value.id, c.var.userId);
    return c.body(null, 204);
  })
  .put('/prompts/lists/order', async (c) => {
    const parsed = await parseOrder(c);
    if (!parsed.ok) return parsed.response;
    const result = reorderOwned(c.var.db, c.var.userId, 'variable_lists', parsed.value.orderedIds);
    if (result === 'duplicate') return c.json({ error: 'orderedIds contains duplicates' }, 400);
    if (result === 'mismatch') return c.json({ error: 'orderedIds must match current lists' }, 409);
    return c.json(promptLibrary(c.var.db, c.var.userId));
  })
  .put('/prompts/lists/:id/options', async (c) => {
    const params = parseParams(c, IdParam);
    if (!params.ok) return params.response;
    const parsed = await parseBody(c, OptionsReplaceV2);
    if (!parsed.ok) return parsed.response;

    const result = c.var.db.transaction(() => {
      if (!existsList(c.var.db, c.var.userId, params.value.id)) return 'missing' as const;
      if (parsed.value.options.length > c.var.config.MAX_OPTIONS_PER_LIST) return 'too-many' as const;
      const tagIds = [...new Set(parsed.value.options.flatMap((option) => [
        ...option.tagIds,
        ...(option.excludeTagIds ?? []),
      ]))];
      if (!ownedTagIds(c.var.db, c.var.userId, tagIds)) return 'unknown-tag' as const;

      const current = listById(c.var.db, c.var.userId, params.value.id);
      const currentOptions = current?.options ?? [];
      const currentById = new Map(currentOptions.map((option) => [option.id, option]));
      const matchedCurrent = new Set<string>();
      const preservedByInput = new Map<number, VariableOption>();
      for (const [index, option] of parsed.value.options.entries()) {
        if (option.id === undefined) continue;
        const match = currentById.get(option.id);
        if (!match || matchedCurrent.has(match.id)) return 'unknown-option' as const;
        matchedCurrent.add(match.id);
        preservedByInput.set(index, match);
      }
      for (const [index, option] of parsed.value.options.entries()) {
        if (option.id !== undefined) continue;
        const candidates = currentOptions.filter((candidate) => (
          !matchedCurrent.has(candidate.id) && candidate.value === option.value
        ));
        const match = candidates.length === 1 ? candidates[0] : undefined;
        if (match) {
          matchedCurrent.add(match.id);
          preservedByInput.set(index, match);
        }
      }
      const hasUnpreservableMetadata = currentOptions.some((candidate) => (
        !matchedCurrent.has(candidate.id) && (candidate.excludeTagIds?.length ?? 0) > 0
      ));
      if (hasUnpreservableMetadata && parsed.value.options.some((option, index) => (
        option.id === undefined && option.excludeTagIds === undefined && !preservedByInput.has(index)
      ))) {
        return 'ambiguous-options' as const;
      }
      const resolvedOptions = parsed.value.options.map((option, index) => {
        const currentOption = preservedByInput.get(index);
        return {
          ...option,
          id: currentOption?.id ?? option.id ?? crypto.randomUUID(),
          excludeTagIds: option.excludeTagIds ?? currentOption?.excludeTagIds ?? [],
        };
      });
      const parentByTagId = tagParentIndex(c.var.db, c.var.userId);
      for (const option of resolvedOptions) {
        if (tagSetsOverlapThroughAncestors(parentByTagId, option.tagIds, option.excludeTagIds)) {
          return 'overlap' as const;
        }
      }
      // Clearing a list entirely stays legal (it predates manual-only weights and
      // the diagnosis layer already reports empty lists); the invariant only binds
      // a populated list to keeping one option the solver can actually pick.
      if (resolvedOptions.length > 0 && !resolvedOptions.some((option) => option.weight > 0)) {
        return 'no-auto-option' as const;
      }

      c.var.db
        .query(
          `DELETE FROM option_tags
            WHERE option_id IN (
              SELECT id FROM variable_options WHERE list_id = ? AND user_id = ?
            )`,
        )
        .run(params.value.id, c.var.userId);
      c.var.db.query('DELETE FROM variable_options WHERE list_id = ? AND user_id = ?').run(params.value.id, c.var.userId);

      const now = Date.now();
      const insertOption = c.var.db.query(
        `INSERT INTO variable_options (id, user_id, list_id, value, sort_order, weight, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertTag = c.var.db.query(
        'INSERT INTO option_tags (option_id, tag_id, polarity) VALUES (?, ?, ?)',
      );
      for (const option of resolvedOptions) {
        const optionId = option.id;
        insertOption.run(optionId, c.var.userId, params.value.id, option.value, option.sortOrder, option.weight, now);
        for (const tagId of option.tagIds) {
          insertTag.run(optionId, tagId, 'require');
        }
        for (const tagId of option.excludeTagIds) {
          insertTag.run(optionId, tagId, 'exclude');
        }
      }
      c.var.db
        .query('UPDATE variable_lists SET updated_at = ? WHERE id = ? AND user_id = ?')
        .run(now, params.value.id, c.var.userId);
      return listById(c.var.db, c.var.userId, params.value.id);
    })();
    if (result === 'missing') return c.body(null, 404);
    if (result === 'too-many') return c.json({ error: 'option limit reached' }, 409);
    if (result === 'unknown-tag') return c.json({ error: 'unknown tagId' }, 400);
    if (result === 'no-auto-option') return c.json({ error: AUTO_SELECTION_REQUIRED }, 400);
    if (result === 'unknown-option') return c.json({ error: 'unknown option id' }, 400);
    if (result === 'ambiguous-options') return c.json({ error: 'ambiguous option identity; include option ids' }, 400);
    if (result === 'overlap') return c.json({ error: 'the same tag cannot be both require and exclude' }, 400);
    if (!result) return c.json({ error: 'internal error' }, 500);
    return c.json(result);
  })
  .patch('/prompts/lists/:listId/options/:optionId', async (c) => {
    const params = parseParams(c, OptionIdParam);
    if (!params.ok) return params.response;
    const parsed = await parseBody(c, OptionPatchV2);
    if (!parsed.ok) return parsed.response;

    const referencedTagIds = [
      ...(parsed.value.tagIds ?? []),
      ...(parsed.value.excludeTagIds ?? []),
    ];
    if (!ownedTagIds(c.var.db, c.var.userId, [...new Set(referencedTagIds)])) {
      return c.json({ error: 'unknown tagIds' }, 400);
    }

    const now = Date.now();
    const updated = c.var.db.transaction(() => {
      const existing = c.var.db
        .query<{ weight: number }, [string, string, string]>(
          `SELECT weight FROM variable_options
            WHERE id = ? AND list_id = ? AND user_id = ? LIMIT 1`,
        )
        .get(params.value.optionId, params.value.listId, c.var.userId);
      if (!existing) return 'missing' as const;

      const currentTags = c.var.db.query<
        { tag_id: string; polarity: 'require' | 'exclude' },
        [string]
      >('SELECT tag_id, polarity FROM option_tags WHERE option_id = ?').all(params.value.optionId);
      const requiredTagIds = parsed.value.tagIds
        ?? currentTags.filter((tag) => tag.polarity === 'require').map((tag) => tag.tag_id);
      const excludeTagIds = parsed.value.excludeTagIds
        ?? currentTags.filter((tag) => tag.polarity === 'exclude').map((tag) => tag.tag_id);
      if (tagSetsOverlapThroughAncestors(
        tagParentIndex(c.var.db, c.var.userId),
        requiredTagIds,
        excludeTagIds,
      )) {
        return 'overlap' as const;
      }

      const resultingWeight = parsed.value.weight ?? existing.weight;
      if (resultingWeight === 0) {
        const otherAutomaticOption = c.var.db
          .query<{ one: number }, [string, string, string]>(
            `SELECT 1 AS one FROM variable_options
              WHERE list_id = ? AND user_id = ? AND id != ? AND weight > 0
              LIMIT 1`,
          )
          .get(params.value.listId, c.var.userId, params.value.optionId);
        if (!otherAutomaticOption) return 'no-auto-option' as const;
      }

      c.var.db
        .query(
          `UPDATE variable_options
              SET value = COALESCE(?, value),
                  sort_order = COALESCE(?, sort_order),
                  weight = COALESCE(?, weight)
            WHERE id = ? AND list_id = ? AND user_id = ?`,
        )
        .run(
          parsed.value.value ?? null,
          parsed.value.sortOrder ?? null,
          parsed.value.weight ?? null,
          params.value.optionId,
          params.value.listId,
          c.var.userId,
        );

      if (parsed.value.tagIds !== undefined || parsed.value.excludeTagIds !== undefined) {
        c.var.db
          .query('DELETE FROM option_tags WHERE option_id = ?')
          .run(params.value.optionId);
        const insertTag = c.var.db.query(
          'INSERT INTO option_tags (option_id, tag_id, polarity) VALUES (?, ?, ?)',
        );
        for (const tagId of requiredTagIds) {
          insertTag.run(params.value.optionId, tagId, 'require');
        }
        for (const tagId of excludeTagIds) {
          insertTag.run(params.value.optionId, tagId, 'exclude');
        }
      }

      c.var.db
        .query('UPDATE variable_lists SET updated_at = ? WHERE id = ? AND user_id = ?')
        .run(now, params.value.listId, c.var.userId);
      return 'updated' as const;
    })();

    if (updated === 'missing') return c.body(null, 404);
    if (updated === 'no-auto-option') return c.json({ error: AUTO_SELECTION_REQUIRED }, 400);
    if (updated === 'overlap') return c.json({ error: 'the same tag cannot be both require and exclude' }, 400);
    return c.body(null, 204);
  })
  .post('/prompts/lists/:id/draft', async (c) => {
    const params = parseParams(c, IdParam);
    if (!params.ok) return params.response;
    const parsed = await parseBody(c, DraftListBody);
    if (!parsed.ok) return parsed.response;
    if (!existsList(c.var.db, c.var.userId, params.value.id)) return c.body(null, 404);

    const SAFE = 'Couldn’t draft the list. Try a more specific name.';
    const MAX_DRAFT_VALUE_LEN = 2_000;
    const { name, existing, description } = parsed.value;
    // Each click drafts up to a target count of NEW values, bounded by the SAME
    // effective per-list option cap the save endpoint enforces. Two target tiers:
    //
    //   * SEED_TARGET (10) — empty list + user-supplied description (the "describe
    //     and seed" flow from the editor; client mediates).
    //   * EXPAND_TARGET (20) — every other call (name+existing only, OR clarify
    //     follow-up with description on a non-empty list).
    //
    // Sharing the save cap guarantees AI-drafted entries are always persistable:
    // draft can never push a list past what PUT /options will accept. A full list
    // cleanly yields zero new entries.
    const SEED_TARGET = 10;
    const EXPAND_TARGET = 20;
    const requested = existing.length === 0 && description !== undefined ? SEED_TARGET : EXPAND_TARGET;
    const target = Math.max(0, Math.min(requested, c.var.config.MAX_OPTIONS_PER_LIST - existing.length));

    const logger = c.var.logger;
    const userId = c.var.userId;
    const resolved = c.var.text.resolve({ userId, task: 'list-draft', ...imageModelRouting(c.var.config, parsed.value.modelId) });
    if (!resolved.ok) return c.json(textModelFailureBody(resolved.reason), 409);
    const textModel = resolved.model;
    return withLlmSlot(c, draftPool, userId, 30, () => {
    const provider = textProviderForResolved(c.var.config, c.var.text, textModel);
    // SSE (not single-shot JSON): the upstream LLM call can outlive the
    // Cloudflare edge's ~100s idle cutoff, which would sever a plain-JSON
    // response with a silent 502. The shared helper emits a 15s :keepalive
    // and exactly one terminal `done`/`error` frame. Mirrors enhance.ts /
    // infer.ts. Success and clarify both ride a terminal `done` frame; the
    // sanitized failure paths ride `error`.
    const timeoutMs = c.var.config.CLOUD_TIMEOUT_MS;
    return {
      timeoutMs,
      disconnect: c.req.raw.signal,
      run: async ({ send, signal, timedOut, clientDisconnected }) => {
        if (target === 0) {
          send('done', { kind: 'entries', entries: [] });
          return;
        }

        let result: DraftResult;
        try {
          result = await provider.draftList(
            description === undefined
              ? { name, existing, target, ...(parsed.value.modelId ? { modelId: parsed.value.modelId } : {}), ...(resolved.effort === undefined ? {} : { reasoningEffort: resolved.effort }) }
              : { name, existing, description, target, ...(parsed.value.modelId ? { modelId: parsed.value.modelId } : {}), ...(resolved.effort === undefined ? {} : { reasoningEffort: resolved.effort }) },
            signal,
          );
        } catch (error) {
          // Deliberate client disconnect — silent, mirrors enhance.ts / useGenerate.
          if (clientDisconnected()) return;
          if (timedOut()) {
            logger.warn({ event: 'draft_list_timeout', timeoutMs, userId }, 'draft list timed out');
          } else {
            logger.error({ err: error, event: 'draft_list_crash', userId }, 'draft list crashed');
          }
          send('error', { message: SAFE });
          return;
        }

        if (result.type === 'failed') {
          logger.warn(
            { event: 'draft_list_upstream_error', status: result.status, detail: result.detail, userId },
            'draft list failed',
          );
          send('error', result.moderation ? failedToSseError(result) : { message: SAFE });
          return;
        }

        if (result.payload.kind === 'clarify') {
          if (description !== undefined) {
            logger.warn(
              { event: 'draft_list_clarify_after_description', userId },
              'model re-asked for clarification despite a description',
            );
            send('error', { message: SAFE });
            return;
          }
          send('done', { kind: 'clarify', question: result.payload.question.slice(0, MAX_DRAFT_VALUE_LEN) });
          return;
        }

        const seen = new Set(existing.map((v) => v.trim().toLowerCase()));
        const entries: string[] = [];
        for (const raw of result.payload.entries) {
          const value = raw.trim();
          if (value.length === 0 || value.length > MAX_DRAFT_VALUE_LEN) continue;
          const key = value.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          entries.push(value);
          if (entries.length >= target) break;
        }
        send('done', { kind: 'entries', entries });
      },
    };
    });
  });

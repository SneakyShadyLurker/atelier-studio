import { assertNoNewTagOverlaps, hierarchyError, InvalidTagMutationError, type TagMembership } from '../../prompts/tagHierarchy';
import { maxUtf16Length } from '../../validation/stringLength';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../server-env';
import { ensureUser } from '../../db/users';
import { parseBody, parseParams } from '../_http';
import { DimensionCreate, DimensionPatch, IdParam, TagsReplace } from '../prompts.schema';
import { countRows, dimensionById, existsDimension, isUniqueConstraintError, PromptLimitError, tagParentIndex } from './_shared';

const Description = z.string().trim().min(1).check(maxUtf16Length(2_000));
const DimensionCreateV2 = DimensionCreate.extend({ description: Description.optional() });
const DimensionPatchV2 = z.object({
  name: DimensionPatch.shape.name.optional(),
  description: Description.nullable().optional(),
}).strict().refine(
  (body) => body.name !== undefined || body.description !== undefined,
  { message: 'at least one of name, description required' },
);
const TagV2 = TagsReplace.shape.tags.element.extend({
  parentId: z.uuid().nullable().optional(),
});
const TagsReplaceV2 = TagsReplace.extend({ tags: z.array(TagV2).max(2_000) });

interface PersistedTagInput {
  id: string;
  label: string;
  sortOrder: number;
  parentId: string | null;
}

export const dimensionsRoutes = new Hono<AppEnv>()
  .post('/prompts/dimensions', async (c) => {
    const parsed = await parseBody(c, DimensionCreateV2);
    if (!parsed.ok) return parsed.response;

    const id = crypto.randomUUID();
    const now = Date.now();
    try {
      const created = c.var.db.transaction(() => {
        ensureUser(c.var.db, c.var.userId, now);
        const count = countRows(c.var.db, 'tag_dimensions', c.var.userId);
        if (count >= c.var.config.MAX_TAG_DIMENSIONS) throw new PromptLimitError('dimension limit reached');
        c.var.db
          .query('INSERT INTO tag_dimensions (id, user_id, name, description, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(id, c.var.userId, parsed.value.name, parsed.value.description ?? null, now);
        return dimensionById(c.var.db, c.var.userId, id);
      })();
      if (!created) return c.json({ error: 'internal error' }, 500);
      return c.json(created, 201);
    } catch (error) {
      if (error instanceof PromptLimitError) return c.json({ error: error.message }, 409);
      if (isUniqueConstraintError(error, 'tag_dimensions')) return c.json({ error: 'name already used' }, 409);
      throw error;
    }
  })
  .patch('/prompts/dimensions/:id', async (c) => {
    const params = parseParams(c, IdParam);
    if (!params.ok) return params.response;
    const parsed = await parseBody(c, DimensionPatchV2);
    if (!parsed.ok) return parsed.response;

    try {
      const updated = c.var.db.transaction(() => {
        if (!existsDimension(c.var.db, c.var.userId, params.value.id)) return null;
        c.var.db
          .query(
            `UPDATE tag_dimensions
                SET name = COALESCE(?, name),
                    description = CASE WHEN ? THEN ? ELSE description END
              WHERE id = ? AND user_id = ?`,
          )
          .run(
            parsed.value.name ?? null,
            parsed.value.description !== undefined ? 1 : 0,
            parsed.value.description ?? null,
            params.value.id,
            c.var.userId,
          );
        return dimensionById(c.var.db, c.var.userId, params.value.id);
      })();
      if (!updated) return c.body(null, 404);
      return c.json(updated);
    } catch (error) {
      if (isUniqueConstraintError(error, 'tag_dimensions')) return c.json({ error: 'name already used' }, 409);
      throw error;
    }
  })
  .delete('/prompts/dimensions/:id', (c) => {
    const params = parseParams(c, IdParam);
    if (!params.ok) return params.response;
    c.var.db.query('DELETE FROM tag_dimensions WHERE id = ? AND user_id = ?').run(params.value.id, c.var.userId);
    return c.body(null, 204);
  })
  .put('/prompts/dimensions/:id/tags', async (c) => {
    const params = parseParams(c, IdParam);
    if (!params.ok) return params.response;
    const parsed = await parseBody(c, TagsReplaceV2);
    if (!parsed.ok) return parsed.response;

    try {
      const result = c.var.db.transaction(() => {
        if (!existsDimension(c.var.db, c.var.userId, params.value.id)) return 'missing' as const;
        if (parsed.value.tags.length > c.var.config.MAX_TAGS_PER_DIMENSION) return 'too-many' as const;
        const currentTags = c.var.db
          .query<{ id: string; label: string; parent_id: string | null }, [string, string]>(
            'SELECT id, label, parent_id FROM dimension_tags WHERE dimension_id = ? AND user_id = ?',
          )
          .all(params.value.id, c.var.userId);
        const currentIds = new Set(currentTags.map((tag) => tag.id));
        const suppliedIds = new Set<string>();
        for (const tag of parsed.value.tags) {
          if (tag.id === undefined) continue;
          if (!currentIds.has(tag.id) || suppliedIds.has(tag.id)) return 'unknown-tag' as const;
          suppliedIds.add(tag.id);
        }
        const currentParentById = new Map(currentTags.map((tag) => [tag.id, tag.parent_id] as const));
        const tags: PersistedTagInput[] = parsed.value.tags.map((tag) => ({
          id: tag.id ?? crypto.randomUUID(),
          label: tag.label,
          sortOrder: tag.sortOrder,
          parentId: Object.hasOwn(tag, 'parentId')
            ? (tag.parentId ?? null)
            : (tag.id === undefined ? null : (currentParentById.get(tag.id) ?? null)),
        }));
        const invalidHierarchy = hierarchyError(tags);
        if (invalidHierarchy !== null) return invalidHierarchy;
        if (new Set(tags.map((tag) => tag.label)).size !== tags.length) return 'duplicate-label' as const;
        // Prefetch all memberships of affected options once, including their
        // other dimensions, to compare conflict identities against before state.
        const rows = c.var.db.query<{ option_id: string; tag_id: string; polarity: 'require' | 'exclude' }, [string, string, string]>(
          `SELECT ot.option_id, ot.tag_id, ot.polarity FROM option_tags ot
             JOIN variable_options vo ON vo.id = ot.option_id AND vo.user_id = ?
            WHERE EXISTS (SELECT 1 FROM option_tags affected
              JOIN dimension_tags dt ON dt.id = affected.tag_id
              WHERE affected.option_id = ot.option_id AND dt.dimension_id = ? AND dt.user_id = ?)`,
        ).all(c.var.userId, params.value.id, c.var.userId);
        const before = new Map<string, { require: string[]; exclude: string[] }>();
        for (const row of rows) {
          const membership = before.get(row.option_id) ?? { require: [], exclude: [] };
          membership[row.polarity].push(row.tag_id);
          before.set(row.option_id, membership);
        }
        const retainedIds = new Set(tags.map((tag) => tag.id));
        const removedIds = new Set(currentTags.filter((tag) => !retainedIds.has(tag.id)).map((tag) => tag.id));
        const beforeParents = tagParentIndex(c.var.db, c.var.userId);
        const afterParents = new Map(beforeParents);
        for (const id of removedIds) afterParents.delete(id);
        for (const tag of tags) afterParents.set(tag.id, tag.parentId);
        const after = new Map<string, TagMembership>([...before].map(([id, membership]) => [id, {
          require: membership.require.filter((tagId) => !removedIds.has(tagId)),
          exclude: membership.exclude.filter((tagId) => !removedIds.has(tagId)),
        }]));
        assertNoNewTagOverlaps(beforeParents, before, afterParents, after);

        // SQLite uniqueness is immediate. Vacate retained labels first, then
        // delete omissions before publishing final labels or new rows.
        const occupiedLabels = new Set([...currentTags.map((tag) => tag.label), ...tags.map((tag) => tag.label)]);
        const stage = c.var.db.query('UPDATE dimension_tags SET label = ? WHERE id = ? AND dimension_id = ? AND user_id = ?');
        for (const tag of currentTags) {
          if (!retainedIds.has(tag.id)) continue;
          let label: string;
          do { label = `__atelier_staged_${crypto.randomUUID()}__`; } while (occupiedLabels.has(label));
          occupiedLabels.add(label);
          stage.run(label, tag.id, params.value.id, c.var.userId);
        }
        c.var.db.query('UPDATE dimension_tags SET parent_id = NULL WHERE dimension_id = ? AND user_id = ?')
          .run(params.value.id, c.var.userId);
        const remove = c.var.db.query('DELETE FROM dimension_tags WHERE id = ? AND dimension_id = ? AND user_id = ?');
        for (const id of removedIds) remove.run(id, params.value.id, c.var.userId);
        const update = c.var.db.query(
          `UPDATE dimension_tags
              SET label = ?, sort_order = ?, parent_id = ?
            WHERE id = ? AND dimension_id = ? AND user_id = ?`,
        );
        const insert = c.var.db.query(
          `INSERT INTO dimension_tags
             (id, user_id, dimension_id, label, sort_order, parent_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
        );
        for (const tag of tags) {
          if (currentIds.has(tag.id)) {
            update.run(tag.label, tag.sortOrder, null, tag.id, params.value.id, c.var.userId);
          } else {
            insert.run(tag.id, c.var.userId, params.value.id, tag.label, tag.sortOrder, null);
          }
        }
        const setParent = c.var.db.query('UPDATE dimension_tags SET parent_id = ? WHERE id = ? AND dimension_id = ? AND user_id = ?');
        for (const tag of tags) if (tag.parentId !== null) setParent.run(tag.parentId, tag.id, params.value.id, c.var.userId);
        return dimensionById(c.var.db, c.var.userId, params.value.id);
      })();
      if (result === 'missing') return c.body(null, 404);
      if (result === 'too-many') return c.json({ error: 'tag limit reached' }, 409);
      if (result === 'unknown-tag') return c.json({ error: 'unknown tagId' }, 400);
      if (result === 'unknown-parent') return c.json({ error: 'unknown parentId' }, 400);
      if (result === 'cycle') return c.json({ error: 'tag hierarchy cycle' }, 400);
      if (result === 'too-deep') return c.json({ error: 'tag hierarchy exceeds depth 8' }, 400);
      if (result === 'duplicate-label') return c.json({ error: 'name already used' }, 409);
      if (!result) return c.json({ error: 'internal error' }, 500);
      return c.json(result);
    } catch (error) {
      if (error instanceof InvalidTagMutationError) return c.json({ error: error.message }, 409);
      if (isUniqueConstraintError(error, 'dimension_tags')) return c.json({ error: 'name already used' }, 409);
      throw error;
    }
  });

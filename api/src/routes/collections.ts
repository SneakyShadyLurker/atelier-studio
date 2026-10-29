import { Hono } from 'hono';
import type { Collection, CollectionsResponse, LibrarySummary } from '@atelier/shared';
import type { CollectionRow } from '../db/types';
import type { AppEnv } from '../server-env';
import { CollectionParamSchema, CreateBody, PatchBody, ReorderBody } from './collections.schema';
import { parseBody, parseParams } from './_http';
import { ensureUser } from '../db/users';
import { isUniqueConstraintError } from '../db/constraints';
import { reorderOwned } from '../db/reorder';
import { ARCHIVE_VISIBLE_PREDICATE } from '../db/predicates';
import { withTimedDb } from '../observability/db';

const MAX_COLLECTIONS_PER_USER = 50;

interface CollectionWithCountRow extends CollectionRow {
  count: number;
  archived_count: number;
}

interface BatchSummaryRow {
  total_count: number;
  pinned_count: number;
  unsorted_count: number;
}

interface ArchiveSummaryRow {
  archived_total_count: number;
  archived_pinned_count: number;
  archived_unsorted_count: number;
}

// archived_counts subquery: `tiles JOIN batches ON id = batch_id` is index-
// only on the batches side via idx_batches_id_collection (migration 0018);
// the predicate is satisfied by idx_tiles_user_archived_seek on tiles.
const COLLECTION_WITH_COUNTS_SELECT = `SELECT c.id, c.user_id, c.name, c.sort_order, c.created_at,
              COALESCE(live_counts.count, 0) AS count,
              COALESCE(archived_counts.archived_count, 0) AS archived_count
         FROM collections c
         LEFT JOIN (
           SELECT collection_id, COUNT(*) AS count
             FROM batches
            WHERE user_id = ? AND archived_at IS NULL
            GROUP BY collection_id
         ) live_counts ON live_counts.collection_id = c.id
         LEFT JOIN (
           SELECT batches.collection_id, COUNT(*) AS archived_count
             FROM tiles
             JOIN batches ON batches.id = tiles.batch_id AND batches.user_id = tiles.user_id
            WHERE tiles.user_id = ? AND ${ARCHIVE_VISIBLE_PREDICATE}
            GROUP BY batches.collection_id
         ) archived_counts ON archived_counts.collection_id = c.id`;

class CollectionLimitError extends Error {
  constructor() {
    super('collection limit reached');
    this.name = 'CollectionLimitError';
  }
}

export const collectionsRoutes = new Hono<AppEnv>()
  .get('/collections', (c) => {
    const response: CollectionsResponse = withTimedDb(
      c.var.logger,
      { sqlPrefix: 'collections_rail', route: 'GET /api/collections' },
      () => ({
        items: listCollections(c.var.db, c.var.userId),
        summary: librarySummary(c.var.db, c.var.userId),
      }),
    );
    return c.json(response);
  })
  .post('/collections', async (c) => {
    const parsed = await parseBody(c, CreateBody);
    if (!parsed.ok) return parsed.response;

    const id = crypto.randomUUID();
    const now = Date.now();
    try {
      const created = c.var.db.transaction(() => {
        ensureUser(c.var.db, c.var.userId, now);
        const count = c.var.db
          .query<{ count: number }, [string]>('SELECT COUNT(*) AS count FROM collections WHERE user_id = ?')
          .get(c.var.userId)?.count ?? 0;
        if (count >= MAX_COLLECTIONS_PER_USER) throw new CollectionLimitError();
        const next = c.var.db
          .query<{ sort_order: number }, [string]>(
            'SELECT COALESCE(MAX(sort_order), -1) + 1 AS sort_order FROM collections WHERE user_id = ?',
          )
          .get(c.var.userId)?.sort_order ?? 0;
        c.var.db
          .query('INSERT INTO collections (id, user_id, name, sort_order, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(id, c.var.userId, parsed.value.name, next, now);
        return collectionById(c.var.db, c.var.userId, id);
      })();
      if (!created) return c.json({ error: 'internal error' }, 500);
      return c.json(created, 201);
    } catch (error) {
      if (error instanceof CollectionLimitError) return c.json({ error: 'collection limit reached' }, 409);
      if (isUniqueConstraintError(error, 'collections')) return c.json({ error: 'name already used' }, 409);
      throw error;
    }
  })
  .patch('/collections/:id', async (c) => {
    const params = parseParams(c, CollectionParamSchema);
    if (!params.ok) return params.response;
    const parsed = await parseBody(c, PatchBody);
    if (!parsed.ok) return parsed.response;

    try {
      const updated = c.var.db.transaction(() => {
        const existing = collectionById(c.var.db, c.var.userId, params.value.id);
        if (!existing) return null;
        c.var.db.query('UPDATE collections SET name = ? WHERE id = ? AND user_id = ?')
          .run(parsed.value.name, params.value.id, c.var.userId);
        return collectionById(c.var.db, c.var.userId, params.value.id);
      })();
      if (!updated) return c.body(null, 404);
      return c.json(updated);
    } catch (error) {
      if (isUniqueConstraintError(error, 'collections')) return c.json({ error: 'name already used' }, 409);
      throw error;
    }
  })
  .delete('/collections/:id', (c) => {
    const params = parseParams(c, CollectionParamSchema);
    if (!params.ok) return params.response;
    c.var.db.query('DELETE FROM collections WHERE id = ? AND user_id = ?').run(params.value.id, c.var.userId);
    return c.body(null, 204);
  })
  .put('/collections/order', async (c) => {
    const parsed = await parseBody(c, ReorderBody);
    if (!parsed.ok) return parsed.response;
    const { orderedIds } = parsed.value;

    const result = reorderOwned(c.var.db, c.var.userId, 'collections', orderedIds);
    if (result === 'duplicate') return c.json({ error: 'orderedIds contains duplicates' }, 400);
    if (result === 'mismatch') return c.json({ error: 'orderedIds must match current collections' }, 409);

    const response: CollectionsResponse = {
      items: listCollections(c.var.db, c.var.userId),
      summary: librarySummary(c.var.db, c.var.userId),
    };
    return c.json(response);
  });
function listCollections(db: AppEnv['Variables']['db'], userId: string): Collection[] {
  const rows = db
    .query<CollectionWithCountRow, [string, string, string]>(
      `${COLLECTION_WITH_COUNTS_SELECT}
        WHERE c.user_id = ?
        ORDER BY c.sort_order ASC, c.name ASC`,
    )
    .all(userId, userId, userId);
  return rows.map(toPublicCollection);
}

function collectionById(db: AppEnv['Variables']['db'], userId: string, id: string): Collection | null {
  const row = db
    .query<CollectionWithCountRow, [string, string, string, string]>(
      `${COLLECTION_WITH_COUNTS_SELECT}
        WHERE c.id = ? AND c.user_id = ?`,
    )
    .get(userId, userId, id, userId);
  return row ? toPublicCollection(row) : null;
}

// Recomputed on every GET /collections (rail) and PUT /collections/order.
// Two grouped aggregate queries (live + archived counts), both index-
// assisted (idx_tiles_user_archived_* covers the archived JOIN predicate).
// Accepted for v1 personal scale; if rail-poll cost ever shows in metrics
// the upgrade is a denormalized counter table maintained inside the
// archive/restore/delete/move/pin transactions — not ad-hoc memoization.
function librarySummary(db: AppEnv['Variables']['db'], userId: string): LibrarySummary {
  const batchCounts = db
    .query<BatchSummaryRow, [string]>(
      `SELECT COUNT(*) AS total_count,
              COALESCE(SUM(CASE WHEN pinned = 1 THEN 1 ELSE 0 END), 0) AS pinned_count,
              COALESCE(SUM(CASE WHEN collection_id IS NULL THEN 1 ELSE 0 END), 0) AS unsorted_count
         FROM batches
        WHERE user_id = ? AND archived_at IS NULL`,
    )
    .get(userId);
  const archivedCounts = db
    .query<ArchiveSummaryRow, [string]>(
      `SELECT COUNT(*) AS archived_total_count,
              COALESCE(SUM(CASE WHEN batches.pinned = 1 THEN 1 ELSE 0 END), 0) AS archived_pinned_count,
              COALESCE(SUM(CASE WHEN batches.collection_id IS NULL THEN 1 ELSE 0 END), 0) AS archived_unsorted_count
         FROM tiles
       JOIN batches ON batches.id = tiles.batch_id AND batches.user_id = tiles.user_id
      WHERE tiles.user_id = ? AND ${ARCHIVE_VISIBLE_PREDICATE}`,
    )
    .get(userId);
  return {
    totalCount: batchCounts?.total_count ?? 0,
    pinnedCount: batchCounts?.pinned_count ?? 0,
    unsortedCount: batchCounts?.unsorted_count ?? 0,
    archivedTotalCount: archivedCounts?.archived_total_count ?? 0,
    archivedPinnedCount: archivedCounts?.archived_pinned_count ?? 0,
    archivedUnsortedCount: archivedCounts?.archived_unsorted_count ?? 0,
  };
}

function toPublicCollection(row: CollectionWithCountRow): Collection {
  return {
    id: row.id,
    name: row.name,
    count: row.count,
    archivedCount: row.archived_count,
    createdAt: row.created_at,
  };
}

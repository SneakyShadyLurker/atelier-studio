import type { Database } from 'bun:sqlite';
import { assertNoNewTagOverlaps, inheritTagParent, InvalidTagMutationError } from './tagHierarchy';
import type { Config } from '../config';
import { mappedTagLabel, orderedOperations, tagIdentity } from './bundleOperations';
import type { LibrarySnapshot, RawBundle } from './inferTypes';

export class ApplyLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApplyLimitError';
  }
}

function countDimensions(db: Database, userId: string): number {
  return db.query<{ n: number }, [string]>('SELECT COUNT(*) n FROM tag_dimensions WHERE user_id = ?')
    .get(userId)?.n ?? 0;
}

export function applyBundlesGranular(
  db: Database,
  userId: string,
  config: Config,
  liveSnap: LibrarySnapshot,
  bundles: readonly RawBundle[],
): void {
  const dimIdByName = new Map(liveSnap.dimensions.map((d) => [d.name, d.id] as const));
  const nameByDimId = new Map(liveSnap.dimensions.map((d) => [d.id, d.name] as const));
  const tagIdByKey = new Map<string, string>();
  const createdTagIds = new Set<string>();
  for (const d of liveSnap.dimensions) {
    for (const t of d.tags) tagIdByKey.set(tagIdentity(d.id, t.label), t.id);
  }
  // One prefetch supplies independent size and append-order caches. Existing
  // sort orders may have gaps, so array length cannot be the append ordinal.
  // Keep IDs in canonical order for the rare safe-integer normalization path.
  const tagIdsByDim = new Map<string, string[]>();
  const maxTagSortByDim = new Map<string, number>();
  for (const d of liveSnap.dimensions) tagIdsByDim.set(d.id, []);
  const allTagRows = db
    .query<{ dimension_id: string; id: string; sort_order: number; parent_id: string | null }, [string]>(
      `SELECT dimension_id, id, sort_order, parent_id FROM dimension_tags WHERE user_id = ?
       ORDER BY dimension_id, sort_order, label, id`,
    )
    .all(userId);
  for (const row of allTagRows) {
    const arr = tagIdsByDim.get(row.dimension_id);
    if (arr) arr.push(row.id);
    else tagIdsByDim.set(row.dimension_id, [row.id]);
    maxTagSortByDim.set(row.dimension_id, Math.max(maxTagSortByDim.get(row.dimension_id) ?? -1, row.sort_order));
  }
  const beforeParents = new Map(allTagRows.map((row) => [row.id, row.parent_id]));
  const readMemberships = () => {
    const memberships = new Map<string, { require: string[]; exclude: string[] }>();
    for (const row of db.query<{ option_id: string; tag_id: string; polarity: 'require' | 'exclude' }, [string]>(
      `SELECT ot.option_id, ot.tag_id, ot.polarity FROM option_tags ot
       JOIN variable_options vo ON vo.id = ot.option_id WHERE vo.user_id = ?`,
    ).all(userId)) {
      const membership = memberships.get(row.option_id) ?? { require: [], exclude: [] };
      membership[row.polarity].push(row.tag_id);
      memberships.set(row.option_id, membership);
    }
    return memberships;
  };
  const beforeMemberships = readMemberships();
  const tagIdsOfDim = (dimId: string): string[] => {
    let arr = tagIdsByDim.get(dimId);
    if (!arr) {
      arr = [];
      tagIdsByDim.set(dimId, arr);
    }
    return arr;
  };

  const ensureTag = (dimId: string, label: string): string => {
    const key = tagIdentity(dimId, label);
    const known = tagIdByKey.get(key);
    if (known) return known;
    const cached = tagIdsOfDim(dimId);
    if (cached.length >= config.MAX_TAGS_PER_DIMENSION) {
      throw new ApplyLimitError('tag limit reached');
    }
    const id = crypto.randomUUID();
    let sort = (maxTagSortByDim.get(dimId) ?? -1) + 1;
    if (!Number.isSafeInteger(sort)) {
      // Normalize only this exhausted dimension, preserving IDs, hierarchy and
      // current canonical order. Never append an imprecise/equal ordinal.
      const updateSort = db.query('UPDATE dimension_tags SET sort_order = ? WHERE id = ? AND dimension_id = ? AND user_id = ?');
      cached.forEach((tagId, index) => { updateSort.run(index, tagId, dimId, userId); });
      sort = cached.length;
    }
    db.query('INSERT INTO dimension_tags (id, user_id, dimension_id, label, sort_order) VALUES (?, ?, ?, ?, ?)')
      .run(id, userId, dimId, label, sort);
    cached.push(id);
    maxTagSortByDim.set(dimId, sort);
    tagIdByKey.set(key, id);
    createdTagIds.add(id);
    return id;
  };
  const resolveRefs = (refs: readonly { dimName: string; label: string }[]) => {
    if (!refs.length) throw new InvalidTagMutationError('empty option tag bag');
    return refs.map((ref) => {
      const dimId = dimIdByName.get(ref.dimName);
      const tagId = dimId === undefined ? undefined : tagIdByKey.get(tagIdentity(dimId, ref.label));
      if (!ref.dimName.trim() || !ref.label.trim() || dimId === undefined || tagId === undefined) {
        throw new InvalidTagMutationError('option tag references an unknown dimension/tag');
      }
      return { dimId, tagId };
    });
  };

  for (const op of orderedOperations(bundles)) {
      if (op.op === 'createDimension') {
        if (dimIdByName.has(op.name)) continue;
        if (countDimensions(db, userId) >= config.MAX_TAG_DIMENSIONS) {
          throw new ApplyLimitError('dimension limit reached');
        }
        const id = crypto.randomUUID();
        db.query('INSERT INTO tag_dimensions (id, user_id, name, created_at) VALUES (?, ?, ?, ?)')
          .run(id, userId, op.name, Date.now());
        dimIdByName.set(op.name, id);
        nameByDimId.set(id, op.name);
        tagIdsByDim.set(id, []);
        maxTagSortByDim.set(id, -1);
        op.tags.forEach((label) => ensureTag(id, label));
      } else if (op.op === 'addTags') {
        const d = liveSnap.dimensions[op.dimIdx];
        if (!d) continue;
        if (!nameByDimId.has(d.id)) continue;
        op.tags.forEach((label) => ensureTag(d.id, label));
      } else if (op.op === 'renameDimension') {
        const d = liveSnap.dimensions[op.dimIdx];
        if (!d || !nameByDimId.has(d.id)) continue;
        db.query('UPDATE tag_dimensions SET name = ? WHERE id = ? AND user_id = ?')
          .run(op.newName, d.id, userId);
        dimIdByName.delete(nameByDimId.get(d.id) ?? d.name);
        dimIdByName.set(op.newName, d.id);
        nameByDimId.set(d.id, op.newName);
      } else if (op.op === 'mergeDimensions') {
        const from = liveSnap.dimensions[op.fromIdx];
        const into = liveSnap.dimensions[op.intoIdx];
        if (!from || !into || from.id === into.id) continue;
        if (!nameByDimId.has(from.id) || !nameByDimId.has(into.id)) continue;
        // Earlier merges may have added tags and hierarchy to this source.
        // Read the current rows so deleting the dimension cannot cascade away
        // memberships that the original snapshot did not yet contain.
        const sourceTags = db.query<{ id: string; label: string; parent_id: string | null }, [string, string]>(
          'SELECT id, label, parent_id FROM dimension_tags WHERE dimension_id = ? AND user_id = ? ORDER BY sort_order, label, id',
        ).all(from.id, userId);
        const targetIdBySourceId = new Map<string, string>();
        for (const ft of sourceTags) {
          targetIdBySourceId.set(ft.id, ensureTag(into.id, mappedTagLabel(op.tagMap, ft.label)));
        }
        for (const ft of sourceTags) {
          const intoTagId = targetIdBySourceId.get(ft.id);
          if (intoTagId === undefined) continue;
          db.query(
            `INSERT INTO option_tags (option_id, tag_id, polarity)
               SELECT ot.option_id, ?, ot.polarity FROM option_tags ot
                JOIN variable_options vo ON vo.id = ot.option_id
               WHERE ot.tag_id = ? AND vo.user_id = ?
               ON CONFLICT(option_id, tag_id) DO UPDATE SET polarity =
                 CASE WHEN option_tags.polarity = 'require' OR excluded.polarity = 'require'
                      THEN 'require' ELSE 'exclude' END`,
          ).run(intoTagId, ft.id, userId);
          db.query('DELETE FROM option_tags WHERE tag_id = ?').run(ft.id);
        }
        const targetParents = new Map(db.query<{ id: string; parent_id: string | null }, [string, string]>(
          'SELECT id, parent_id FROM dimension_tags WHERE dimension_id = ? AND user_id = ?',
        ).all(into.id, userId).map((tag) => [tag.id, tag.parent_id] as const));
        // Existing target hierarchy wins. Only tags created by this apply
        // inherit a mapped source parent, and the first source relationship wins.
        for (const ft of sourceTags) {
          if (ft.parent_id === null) continue;
          const targetChildId = targetIdBySourceId.get(ft.id);
          const targetParentId = targetIdBySourceId.get(ft.parent_id);
          if (
            targetChildId === undefined
            || targetParentId === undefined
            || targetChildId === targetParentId
            || !createdTagIds.has(targetChildId)
            || !inheritTagParent(targetParents, targetChildId, targetParentId)
          ) continue;
          db.query(
            'UPDATE dimension_tags SET parent_id = ? WHERE id = ? AND user_id = ? AND parent_id IS NULL',
          ).run(targetParentId, targetChildId, userId);
        }
        db.query('DELETE FROM tag_dimensions WHERE id = ? AND user_id = ?').run(from.id, userId);
        dimIdByName.delete(nameByDimId.get(from.id) ?? from.name);
        nameByDimId.delete(from.id);
        tagIdsByDim.delete(from.id);
        maxTagSortByDim.delete(from.id);
      } else if (op.op === 'addOption') {
        const list = liveSnap.lists[op.listIdx];
        if (!list) continue;
        const refs = resolveRefs(op.tags);
        const existing = db.query<{ id: string }, [string, string, string]>(
          'SELECT id FROM variable_options WHERE list_id = ? AND user_id = ? AND value = ?',
        ).get(list.id, userId, op.value);
        if (existing) throw new ApplyLimitError('option value already exists');
        const currentCount = db.query<{ n: number }, [string, string]>(
          'SELECT COUNT(*) n FROM variable_options WHERE list_id = ? AND user_id = ?',
        ).get(list.id, userId)?.n ?? 0;
        if (currentCount >= config.MAX_OPTIONS_PER_LIST) {
          throw new ApplyLimitError('option limit reached');
        }
        const optionId = crypto.randomUUID();
        db.query(
          `INSERT INTO variable_options (id, user_id, list_id, value, sort_order, weight, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(optionId, userId, list.id, op.value, currentCount, 1, Date.now());
        for (const { tagId } of refs) {
          db.query(
            `INSERT INTO option_tags (option_id, tag_id, polarity) VALUES (?, ?, 'require')
             ON CONFLICT(option_id, tag_id) DO UPDATE SET polarity = 'require'`,
          )
            .run(optionId, tagId);
        }
      } else {
        const list = liveSnap.lists[op.listIdx];
        const opt = list?.options[op.optionIdx];
        if (!list || !opt) continue;
        const touchedDimIds = new Set<string>();
        const wantTagIds: string[] = [];
        for (const { dimId, tagId } of resolveRefs(op.tags)) {
          touchedDimIds.add(dimId);
          wantTagIds.push(tagId);
        }
        for (const dimId of touchedDimIds) {
          const ids = tagIdsOfDim(dimId);
          if (ids.length === 0) continue;
          const ph = ids.map(() => '?').join(',');
          db.query(`DELETE FROM option_tags WHERE option_id = ? AND polarity = 'require' AND tag_id IN (${ph})`)
            .run(opt.id, ...ids);
        }
        const ins = db.query(
          `INSERT INTO option_tags (option_id, tag_id, polarity) VALUES (?, ?, 'require')
           ON CONFLICT(option_id, tag_id) DO UPDATE SET polarity = 'require'`,
        );
        for (const tid of wantTagIds) ins.run(opt.id, tid);
      }
  }
  const afterParents = new Map(db.query<{ id: string; parent_id: string | null }, [string]>(
    'SELECT id, parent_id FROM dimension_tags WHERE user_id = ?',
  ).all(userId).map((row) => [row.id, row.parent_id]));
  assertNoNewTagOverlaps(beforeParents, beforeMemberships, afterParents, readMemberships());
}

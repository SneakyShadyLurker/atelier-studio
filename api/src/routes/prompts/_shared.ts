import type { Context } from 'hono';
import type {
  DimensionTag,
  PromptLibraryResponse,
  PromptTemplate,
  TagDimension,
  VariableList,
  VariableOption,
} from '@atelier/shared';
import type { Database } from 'bun:sqlite';
import type {
  DimensionTagRow,
  PromptTemplateRow,
  TagDimensionRow,
  VariableListRow,
  VariableOptionRow,
} from '../../db/types';
import { getOrCreateUserCacheScope } from '../../db/users';
import type { AppEnv } from '../../server-env';
import { parseBody } from '../_http';
import { OrderBody } from '../prompts.schema';

// Shared row mappers, query helpers, and the limit-error type for the prompt
// library sub-routers (templates / lists / dimensions / infer).

export type PromptDb = AppEnv['Variables']['db'];

interface VariableOptionJoinedRow extends VariableOptionRow {
  tag_id: string | null;
  tag_sort_order: number | null;
  polarity: 'require' | 'exclude' | null;
}

interface MutableVariableOption {
  id: string;
  listId: string;
  value: string;
  tagIds: string[];
  excludeTagIds: string[];
  sortOrder: number;
  weight: number;
}

export class PromptLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptLimitError';
  }
}

export async function parseOrder(c: Context<AppEnv>): Promise<
  | { ok: true; value: { orderedIds: string[] } }
  | { ok: false; response: Response }
> {
  return parseBody(c, OrderBody);
}

export function promptLibrary(db: PromptDb, userId: string): PromptLibraryResponse {
  return {
    templates: listTemplates(db, userId),
    variableLists: listVariableLists(db, userId),
    dimensions: listDimensions(db, userId),
  };
}

export function promptLibraryRevisionTag(db: PromptDb, userId: string): string {
  const revision =
    db
      .query<{ revision: number }, [string]>(
        `SELECT revision
           FROM prompt_library_revisions
          WHERE user_id = ?`,
      )
      .get(userId)?.revision ?? 0;
  return `${getOrCreateUserCacheScope(db, userId)}:${revision.toString(16).padStart(16, '0')}`;
}

function listTemplates(db: PromptDb, userId: string): PromptTemplate[] {
  const rows = db
    .query<PromptTemplateRow, [string]>(
      `SELECT id, user_id, name, body, notes, sort_order, created_at, updated_at
         FROM prompt_templates
        WHERE user_id = ?
        ORDER BY sort_order ASC, name ASC`,
    )
    .all(userId);
  return rows.map(toPublicTemplate);
}

export function templateById(db: PromptDb, userId: string, id: string): PromptTemplate | null {
  const row = db
    .query<PromptTemplateRow, [string, string]>(
      `SELECT id, user_id, name, body, notes, sort_order, created_at, updated_at
         FROM prompt_templates
        WHERE id = ? AND user_id = ?`,
    )
    .get(id, userId);
  return row ? toPublicTemplate(row) : null;
}

function listVariableLists(db: PromptDb, userId: string): VariableList[] {
  const lists = db
    .query<VariableListRow, [string]>(
      `SELECT id, user_id, name, sort_order, created_at, updated_at
         FROM variable_lists
        WHERE user_id = ?
        ORDER BY sort_order ASC, name ASC`,
    )
    .all(userId);
  const optionsByList = optionsGroupedByList(db, userId);
  return lists.map((row) => toPublicList(row, optionsByList.get(row.id) ?? []));
}

export function existsList(db: PromptDb, userId: string, id: string): boolean {
  const row = db
    .query<{ one: number }, [string, string]>(
      `SELECT 1 AS one FROM variable_lists WHERE id = ? AND user_id = ? LIMIT 1`,
    )
    .get(id, userId);
  return row !== null;
}

export function listById(db: PromptDb, userId: string, id: string): VariableList | null {
  const row = db
    .query<VariableListRow, [string, string]>(
      `SELECT id, user_id, name, sort_order, created_at, updated_at
         FROM variable_lists
        WHERE id = ? AND user_id = ?`,
    )
    .get(id, userId);
  if (!row) return null;
  return toPublicList(row, optionsForList(db, userId, row.id));
}

// One LEFT JOIN shape for every option reader; callers append the WHERE and
// ORDER BY. Binds the user id for the dimension_tags scope first.
const OPTION_JOIN_SQL = `SELECT o.id, o.user_id, o.list_id, o.value, o.sort_order, o.weight, o.created_at,
              dt.id AS tag_id, dt.sort_order AS tag_sort_order, ot.polarity
         FROM variable_options o
         LEFT JOIN option_tags ot ON ot.option_id = o.id
         LEFT JOIN dimension_tags dt ON dt.id = ot.tag_id AND dt.user_id = ?`;

function optionsForList(db: PromptDb, userId: string, listId: string): VariableOption[] {
  const rows = db
    .query<VariableOptionJoinedRow, [string, string, string]>(
      `${OPTION_JOIN_SQL}
        WHERE o.user_id = ? AND o.list_id = ?
        ORDER BY o.sort_order ASC, o.value ASC, dt.sort_order ASC, ot.tag_id ASC`,
    )
    .all(userId, userId, listId);
  return collectOptions(rows);
}

// Rows arrive ordered by list, then by the per-list order, and collectOptions
// keeps first-seen order, so each group keeps its list's option order.
function optionsGroupedByList(db: PromptDb, userId: string): Map<string, VariableOption[]> {
  const rows = db
    .query<VariableOptionJoinedRow, [string, string]>(
      `${OPTION_JOIN_SQL}
        WHERE o.user_id = ?
        ORDER BY o.list_id ASC, o.sort_order ASC, o.value ASC, dt.sort_order ASC, ot.tag_id ASC`,
    )
    .all(userId, userId);
  return Map.groupBy(collectOptions(rows), (option) => option.listId);
}

// Folds joined option/tag rows into options in first-seen order; each tag
// lands in `tagIds` or `excludeTagIds` by its polarity.
function collectOptions(rows: readonly VariableOptionJoinedRow[]): VariableOption[] {
  const options = new Map<string, MutableVariableOption>();
  for (const row of rows) {
    let option = options.get(row.id);
    if (!option) {
      option = {
        id: row.id,
        listId: row.list_id,
        value: row.value,
        tagIds: [],
        excludeTagIds: [],
        sortOrder: row.sort_order,
        weight: row.weight,
      };
      options.set(row.id, option);
    }
    if (row.tag_id) (row.polarity === 'exclude' ? option.excludeTagIds : option.tagIds).push(row.tag_id);
  }
  return [...options.values()].map(toPublicOption);
}

function toPublicOption(option: MutableVariableOption): VariableOption {
  return {
    id: option.id,
    listId: option.listId,
    value: option.value,
    tagIds: option.tagIds,
    ...(option.excludeTagIds.length === 0 ? {} : { excludeTagIds: option.excludeTagIds }),
    sortOrder: option.sortOrder,
    weight: option.weight,
  };
}

function listDimensions(db: PromptDb, userId: string): TagDimension[] {
  const dimensions = db
    .query<TagDimensionRow, [string]>(
      `SELECT id, user_id, name, description, created_at
         FROM tag_dimensions
        WHERE user_id = ?
        ORDER BY name ASC`,
    )
    .all(userId);
  const tagsByDimension = tagsGroupedByDimension(db, userId);
  return dimensions.map((row) => toPublicDimension(row, tagsByDimension.get(row.id) ?? []));
}

export function existsDimension(db: PromptDb, userId: string, id: string): boolean {
  const row = db
    .query<{ one: number }, [string, string]>(
      `SELECT 1 AS one FROM tag_dimensions WHERE id = ? AND user_id = ? LIMIT 1`,
    )
    .get(id, userId);
  return row !== null;
}

export function dimensionById(db: PromptDb, userId: string, id: string): TagDimension | null {
  const row = db
    .query<TagDimensionRow, [string, string]>(
      `SELECT id, user_id, name, description, created_at
         FROM tag_dimensions
        WHERE id = ? AND user_id = ?`,
    )
    .get(id, userId);
  if (!row) return null;
  return toPublicDimension(row, tagsForDimension(db, userId, row.id));
}

function tagsForDimension(db: PromptDb, userId: string, dimensionId: string): DimensionTag[] {
  const rows = db
    .query<DimensionTagRow, [string, string]>(
      `SELECT id, user_id, dimension_id, label, sort_order, parent_id
         FROM dimension_tags
        WHERE user_id = ? AND dimension_id = ?
        ORDER BY sort_order ASC, label ASC`,
    )
    .all(userId, dimensionId);
  return rows.map(toPublicTag);
}

function tagsGroupedByDimension(db: PromptDb, userId: string): Map<string, DimensionTag[]> {
  const rows = db
    .query<DimensionTagRow, [string]>(
      `SELECT dt.id, dt.user_id, dt.dimension_id, dt.label, dt.sort_order, dt.parent_id
         FROM dimension_tags dt
         JOIN tag_dimensions td ON td.id = dt.dimension_id AND td.user_id = dt.user_id
        WHERE dt.user_id = ?
        ORDER BY dt.dimension_id ASC, dt.sort_order ASC, dt.label ASC`,
    )
    .all(userId);
  const grouped = new Map<string, DimensionTag[]>();
  for (const row of rows) {
    const current = grouped.get(row.dimension_id) ?? [];
    current.push(toPublicTag(row));
    grouped.set(row.dimension_id, current);
  }
  return grouped;
}

function toPublicTemplate(row: PromptTemplateRow): PromptTemplate {
  return {
    id: row.id,
    name: row.name,
    body: row.body,
    ...(row.notes === null ? {} : { notes: row.notes }),
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPublicList(row: VariableListRow, options: readonly VariableOption[]): VariableList {
  return {
    id: row.id,
    name: row.name,
    options,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPublicDimension(row: TagDimensionRow, tags: readonly DimensionTag[]): TagDimension {
  return {
    id: row.id,
    name: row.name,
    ...(row.description === null ? {} : { description: row.description }),
    tags,
  };
}

function toPublicTag(row: DimensionTagRow): DimensionTag {
  return {
    id: row.id,
    dimensionId: row.dimension_id,
    label: row.label,
    sortOrder: row.sort_order,
    ...(row.parent_id === null ? {} : { parentId: row.parent_id }),
  };
}

// Runtime allowlist for the interpolated table name in the count / next-sort
// helpers. The literal-union param types are the compile-time guard; this Set
// makes the no-injection invariant self-evident and fails loud at runtime if a
// future caller widens the parameter to a bare string.
const SCOPED_COUNT_TABLES: ReadonlySet<string> = new Set([
  'prompt_templates',
  'variable_lists',
  'tag_dimensions',
]);

export function countRows(db: Database, table: 'prompt_templates' | 'variable_lists' | 'tag_dimensions', userId: string): number {
  if (!SCOPED_COUNT_TABLES.has(table)) throw new Error(`invalid count table: ${JSON.stringify(table)}`);
  return db.query<{ count: number }, [string]>(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id = ?`).get(userId)?.count ?? 0;
}

export function nextSortOrder(db: Database, table: 'prompt_templates' | 'variable_lists', userId: string): number {
  if (!SCOPED_COUNT_TABLES.has(table)) throw new Error(`invalid sort-order table: ${JSON.stringify(table)}`);
  return db
    .query<{ sort_order: number }, [string]>(
      `SELECT COALESCE(MAX(sort_order), -1) + 1 AS sort_order FROM ${table} WHERE user_id = ?`,
    )
    .get(userId)?.sort_order ?? 0;
}

export function ownedTagIds(db: Database, userId: string, tagIds: readonly string[]): boolean {
  if (tagIds.length === 0) return true;
  const placeholders = tagIds.map(() => '?').join(', ');
  const rows = db
    .query<{ id: string }, string[]>(
      `SELECT id FROM dimension_tags WHERE user_id = ? AND id IN (${placeholders})`,
    )
    .all(userId, ...tagIds);
  return rows.length === tagIds.length;
}

export function tagParentIndex(db: Database, userId: string): ReadonlyMap<string, string | null> {
  const rows = db
    .query<{ id: string; parent_id: string | null }, [string]>(
      'SELECT id, parent_id FROM dimension_tags WHERE user_id = ?',
    )
    .all(userId);
  return new Map(rows.map((row) => [row.id, row.parent_id]));
}

export { tagSetsOverlapThroughAncestors } from '../../prompts/tagHierarchy';

export { isUniqueConstraintError } from '../../db/constraints';

// Shared Zod fragments for route schemas. Single source for the path-param,
// name, ref-image and scope-filter shapes that several routes would otherwise
// re-declare.
import { z } from 'zod';
import { MAX_DELETE_KEEP_UPLOADS } from '@atelier/shared';
import { PROMPT_LIBRARY_NAME_MAX_CHARS } from '@atelier/shared/prompt-limits';
import { maxUtf16Length } from '../validation/stringLength';

/**
 * A single UUID path parameter — `uuidParam('tileId')` builds
 * `z.object({ tileId: z.uuid() })`. Gives one place to evolve path-UUID
 * validation (e.g. branded ids) for every route at once.
 */
export function uuidParam<K extends string>(key: K) {
  return z.object({ [key]: z.uuid() } as Record<K, ReturnType<typeof z.uuid>>);
}

/**
 * History/archive scope filter `?collectionId=<uuid|null>`. The literal
 * `'null'` string selects the Unsorted scope (collection_id IS NULL).
 */
export const collectionIdFilter = z.union([z.literal('null'), z.uuid()]).optional();

/**
 * History/archive scope filter `?pinned=true`. Absent or anything else
 * normalizes to `undefined` (no pin filter).
 */
export const pinnedFilter = z
  .literal('true')
  .optional()
  .transform((value) => (value === 'true' ? (true as const) : undefined));

/**
 * Thread-delete `?keepUploads=<uuid>,<uuid>`: reference uploads the client's
 * composer still has attached, exempt from release so the next generation
 * does not lose them. Normalizes to an array (empty when absent).
 */
export const keepUploadsFilter = z
  .string()
  .optional()
  .transform((value) => (value ? value.split(',') : []))
  .pipe(z.array(z.uuid()).max(64));

// Optional DELETE bodies carry larger hold sets without growing the URL.
export const DeleteUploadsBodySchema = z.strictObject({
  keepUploads: z.array(z.uuid()).max(MAX_DELETE_KEEP_UPLOADS),
});

/**
 * User-chosen display name (collections and prompt-library templates, lists
 * and dimensions): trimmed, non-empty, at most 64 UTF-16 units.
 */
export const NameSchema = z.string().trim().min(1).check(maxUtf16Length(PROMPT_LIBRARY_NAME_MAX_CHARS));

/**
 * Reference-image upload ids: at most 10, no duplicates. Routes that require
 * at least one when present add `.min(1)` at the call site.
 */
export const refImageIdsSchema = z
  .array(z.uuid())
  .max(10)
  .refine((arr) => new Set(arr).size === arr.length, { message: 'duplicate refImageIds' });

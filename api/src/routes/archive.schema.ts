import { z } from 'zod';
import { collectionIdFilter, pinnedFilter, uuidParam } from './_schema';

export const ArchiveTileParamSchema = uuidParam('tileId');

// strictObject so a malformed/forgotten filter (e.g. q=, view=) returns 400
// instead of silently widening the scope to "everything archived".
export const ArchiveQuerySchema = z.strictObject({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(120).default(60),
  collectionId: collectionIdFilter,
  pinned: pinnedFilter,
});

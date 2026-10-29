import { z } from 'zod';
import { maxUtf16Length } from '../validation/stringLength';
import { MAX_HISTORY_Q_LEN } from '@atelier/shared';
import { collectionIdFilter, keepUploadsFilter, pinnedFilter, uuidParam } from './_schema';

export const UuidParamSchema = uuidParam('batchId');

export const TileDeleteParamSchema = z.object({
  batchId: z.uuid(),
  tileId: z.uuid(),
});

export const HistoryQuerySchema = z.object({
  cursor: z.string().optional(),
  // Intentional grain divergence (not drift): /history pages BATCHES, so
  // its window (web sends 30; schema default 20/max 50 for direct API
  // consumers) is deliberately smaller than archive.schema's TILE-grain
  // window (default 60/max 120). Keep the two greppably distinct.
  limit: z.coerce.number().int().min(1).max(50).default(20),
  collectionId: collectionIdFilter,
  pinned: pinnedFilter,
  q: z.string().check(maxUtf16Length(MAX_HISTORY_Q_LEN)).optional(),
});

// DELETE /history rejects GET-only filters (q, cursor, limit) so a search
// scope cannot silently widen to "everything in the collection/unsorted"
// when the server ignores params it does not handle.
export const HistoryDeleteQuerySchema = z.strictObject({
  collectionId: collectionIdFilter,
  pinned: pinnedFilter,
  keepUploads: keepUploadsFilter,
});

// Single-batch and single-tile DELETE /history accept only the upload hold.
export const ThreadDeleteQuerySchema = z.strictObject({
  keepUploads: keepUploadsFilter,
});

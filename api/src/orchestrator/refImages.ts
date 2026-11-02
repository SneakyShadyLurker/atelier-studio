import type { Database } from 'bun:sqlite';
import type { UploadRow } from '../db/types';
import { readArtifactBytes } from '../storage/files';
import type {
  GenerationContext,
  PreparedBatch,
  ResolvedGenerateRequest,
  ResolvedRefImage,
} from '../orchestrator';

export class RefImagesNotFoundError extends Error {
  constructor() {
    super('upload not found');
    this.name = 'RefImagesNotFoundError';
  }
}

type UploadRefRow = Pick<UploadRow, 'id' | 'ext' | 'mime' | 'size_bytes'>;

export async function resolveRefImagesAfterReservation(
  ctx: GenerationContext,
  _prepared: PreparedBatch,
): Promise<ResolvedGenerateRequest> {
  if (!ctx.request.refImageIds || ctx.request.refImageIds.length === 0 || ctx.request.refImages) return ctx.request;
  // This batch is already accepted. Detached terminal recovery owns failure
  // history and sequence/story settlement; keep its rows until that runs.
  const refImages = await loadRefImages(ctx.db, ctx.config.DATA_DIR, ctx.userId, ctx.request.refImageIds);
  if (refImages) return { ...ctx.request, refImages };
  throw new RefImagesNotFoundError();
}

// Ordered ref-image upload ids per tile, scoped to the user's tiles (and to
// archived tiles for the Archive view). Drive from tile_ref_images so its PK
// (tile_id, position) provides the ORDER BY natively; the id list binds as one
// JSON array, so page size never meets SQLite's parameter cap.
export function refImageIdsByTile(
  db: Database,
  userId: string,
  tileIds: readonly string[],
  { archivedOnly = false }: { archivedOnly?: boolean } = {},
): Map<string, string[]> {
  if (tileIds.length === 0) return new Map();
  const rows = db
    .query<{ tile_id: string; upload_id: string }, [string, string]>(
      `SELECT tile_ref_images.tile_id, tile_ref_images.upload_id
         FROM tile_ref_images
        WHERE tile_ref_images.tile_id IN (SELECT value FROM json_each(?))
          AND EXISTS (
            SELECT 1 FROM tiles
             WHERE tiles.id = tile_ref_images.tile_id AND tiles.user_id = ?
               ${archivedOnly ? 'AND tiles.archived_at IS NOT NULL' : ''}
          )
        ORDER BY tile_ref_images.tile_id ASC, tile_ref_images.position ASC`,
    )
    .all(JSON.stringify(tileIds), userId);
  const map = new Map<string, string[]>();
  for (const [tileId, refs] of Map.groupBy(rows, (row) => row.tile_id)) {
    map.set(tileId, refs.map((row) => row.upload_id));
  }
  return map;
}

// FK CASCADE clears tiles + tile_ref_images; uploads stay (ON DELETE RESTRICT).
// Drive the cascade manually inside a transaction instead of relying on
// `ON DELETE CASCADE` — that only fires when `foreign_keys=ON` is set on the
// CURRENT connection, which SQLite does not persist. `applyPragmas` is the
// only thing keeping cascade alive in prod, so this is defense in depth.
export function cleanupPreparedBatch(db: Database, userId: string, batchId: string): void {
  db.transaction(() => {
    db.query(
      `DELETE FROM tile_ref_images
       WHERE tile_id IN (SELECT id FROM tiles WHERE batch_id = ? AND user_id = ?)`,
    ).run(batchId, userId);
    db.query('DELETE FROM tiles WHERE batch_id = ? AND user_id = ?').run(batchId, userId);
    db.query('DELETE FROM batches WHERE id = ? AND user_id = ?').run(batchId, userId);
  })();
}

export function refImageByteTotal(db: Database, userId: string, refImageIds: readonly string[]): number | null {
  const rows = selectUploadRows(db, userId, refImageIds);
  if (!rows) return null;
  return rows.reduce((total, row) => total + row.size_bytes, 0);
}

export function refImageIdsForBatch(db: Database, batchId: string): string[] {
  return db
    .query<{ upload_id: string }, [string]>(
      `SELECT tri.upload_id
         FROM tile_ref_images tri
        WHERE tri.tile_id = (
          SELECT id FROM tiles WHERE batch_id = ? ORDER BY tile_index ASC LIMIT 1
        )
        ORDER BY tri.position ASC`,
    )
    .all(batchId)
    .map((row) => row.upload_id);
}

export async function loadRefImages(
  db: Database,
  dataDir: string,
  userId: string,
  refImageIds: readonly string[],
): Promise<ResolvedRefImage[] | null> {
  const rows = selectUploadRows(db, userId, refImageIds);
  if (!rows) return null;
  // Reads are independent files — fan out instead of awaiting serially on
  // the pre-stream critical path (up to 10 refs for Gemini). Promise.all
  // preserves array order, and selectUploadRows already pins row order.
  const artifacts = await Promise.all(
    rows.map((row) => readArtifactBytes(dataDir, 'uploads', userId, row.id, row.ext, row.mime)),
  );
  const images: ResolvedRefImage[] = [];
  for (const artifact of artifacts) {
    if (!artifact) return null;
    images.push({ bytes: artifact.bytes, mime: artifact.mime });
  }
  return images;
}

function selectUploadRows(db: Database, userId: string, refImageIds: readonly string[]): UploadRefRow[] | null {
  if (refImageIds.length === 0) return null;
  const placeholders = refImageIds.map(() => '?').join(',');
  const rows = db
    .query<UploadRefRow, string[]>(
      `SELECT id, ext, mime, size_bytes FROM uploads WHERE user_id = ? AND id IN (${placeholders})`,
    )
    .all(userId, ...refImageIds);
  if (rows.length !== refImageIds.length) return null;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered: UploadRefRow[] = [];
  for (const id of refImageIds) {
    const row = byId.get(id);
    if (!row) return null;
    ordered.push(row);
  }
  return ordered;
}

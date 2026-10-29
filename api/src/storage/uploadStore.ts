import type { Database } from 'bun:sqlite';
import {
  MAX_UPLOAD_FILE_BYTES,
  MAX_UPLOAD_INPUT_BYTES,
  type TileExt,
  type TileMime,
  type UploadRef,
} from '@atelier/shared';
import { reportIfCorruption } from '../db/integrity';
import { ensureUser } from '../db/users';
import type { AppLogger } from '../observability/logger';
import { artifactExists, deleteArtifact, writeAtomic } from './files';
import { normalizeUpload } from './normalizeUpload';

// The one definition of "something still needs this upload": a tile's
// reference list (live or archived), a batch's I2V source still, or a story
// still rendering (segment 1 is submitted from `stories.source_upload_id`, and
// a retry resubmits it). Parameter-free; interpolate
// into a statement whose FROM/UPDATE target is `uploads`.
export const SQL_UPLOAD_UNREFERENCED = `NOT EXISTS (SELECT 1 FROM tile_ref_images WHERE upload_id = uploads.id)
  AND NOT EXISTS (SELECT 1 FROM batches WHERE i2v_source_upload_id = uploads.id)
  AND NOT EXISTS (SELECT 1 FROM stories WHERE source_upload_id = uploads.id AND status = 'rendering')`;

// True when the user owns upload `uploadId` and its artifact is on disk. Async
// so request pre-flights never block the event loop (or a held writer lock)
// on stat(2).
export async function uploadArtifactExists(
  db: Database,
  dataDir: string,
  userId: string,
  uploadId: string,
): Promise<boolean> {
  const row = db
    .query<{ id: string; ext: string }, [string, string]>('SELECT id, ext FROM uploads WHERE user_id = ? AND id = ?')
    .get(userId, uploadId);
  return row !== null && artifactExists(dataDir, 'uploads', userId, row.id, row.ext);
}

export class InvalidUploadSizeError extends Error {
  constructor() {
    super('invalid file size');
    this.name = 'InvalidUploadSizeError';
  }
}

export interface StoreUploadOptions {
  readonly db: Database;
  readonly dataDir: string;
  readonly logger: AppLogger;
  readonly userId: string;
  readonly bytes: Uint8Array;
  readonly signal: AbortSignal;
  readonly sourceTileId?: string;
}

interface NormalizedUpload {
  readonly bytes: Uint8Array;
  readonly sniffed: {
    readonly ext: TileExt;
    readonly mime: TileMime;
    readonly width: number;
    readonly height: number;
  };
}

export async function storeUpload(options: StoreUploadOptions): Promise<UploadRef> {
  const { db, dataDir, logger, userId, bytes, signal, sourceTileId } = options;
  if (bytes.byteLength <= 0 || bytes.byteLength > MAX_UPLOAD_INPUT_BYTES) {
    throw new InvalidUploadSizeError();
  }

  const normalized: NormalizedUpload = await normalizeUpload(bytes, signal);
  const storedBytes = normalized.bytes;
  const { sniffed } = normalized;
  if (storedBytes.byteLength > MAX_UPLOAD_FILE_BYTES) throw new InvalidUploadSizeError();
  if (storedBytes !== bytes) {
    logger.info({ userId, mime: sniffed.mime, bytes: storedBytes.byteLength }, 'upload normalized');
  }

  const uploadId = crypto.randomUUID();
  const createdAt = Date.now();
  const sha256 = new Bun.CryptoHasher('sha256').update(storedBytes).digest('hex');
  const sizeBytes = storedBytes.byteLength;
  const response: UploadRef = {
    id: uploadId,
    mime: sniffed.mime,
    ext: sniffed.ext,
    sizeBytes,
    width: sniffed.width,
    height: sniffed.height,
    createdAt,
  };

  await writeAtomic(dataDir, 'uploads', userId, uploadId, sniffed.ext, storedBytes);
  try {
    db.transaction(() => {
      ensureUser(db, userId, createdAt);
      db.query(
        `INSERT INTO uploads
          (id, user_id, ext, mime, size_bytes, width, height, sha256, created_at, source_tile_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        uploadId,
        userId,
        sniffed.ext,
        sniffed.mime,
        sizeBytes,
        sniffed.width,
        sniffed.height,
        sha256,
        createdAt,
        sourceTileId ?? null,
      );
    })();
  } catch (error) {
    try {
      deleteArtifact(dataDir, 'uploads', userId, uploadId, sniffed.ext);
    } catch (unlinkError) {
      logger.warn(
        { err: unlinkError, uploadId },
        'upload artifact unlink after row-insert failure failed; will be reaped at next boot',
      );
    }
    reportIfCorruption(error, logger, { phase: 'upload_store', uploadId });
    throw error;
  }

  return response;
}

/**
 * Upload ids referenced by the tiles or I2V source of every batch selected by
 * `batchIdsSql` (a parameterised `SELECT id …` subquery). Collect these inside
 * the delete transaction, BEFORE the rows go, then hand them to
 * `releaseUploads` after commit. Over-inclusion is harmless: release re-checks
 * every reference.
 */
export function uploadIdsForBatchScope(
  db: Database,
  batchIdsSql: string,
  params: readonly (string | number)[],
): string[] {
  return db
    .query<{ id: string }, (string | number)[]>(
      `SELECT tri.upload_id AS id
         FROM tile_ref_images tri
         JOIN tiles t ON t.id = tri.tile_id
        WHERE t.batch_id IN (${batchIdsSql})
       UNION
       SELECT i2v_source_upload_id AS id
         FROM batches
        WHERE i2v_source_upload_id IS NOT NULL
          AND id IN (${batchIdsSql})`,
    )
    .all(...params, ...params)
    .map((row) => row.id);
}

export interface ReleaseUploadsOptions {
  readonly db: Database;
  readonly dataDir: string;
  readonly logger: AppLogger;
  readonly userId: string;
  readonly uploadIds: readonly string[];
  /** Uploads the client still holds (composer chips); never released here. */
  readonly keep?: readonly string[];
}

/**
 * Deletes the row and artifact of every candidate upload that nothing
 * references any more, so reference media lives exactly as long as the
 * threads that used it. Call after the thread-delete transaction commits.
 * Unused uploads are not candidates; the boot TTL reaper owns those.
 */
export function releaseUploads(options: ReleaseUploadsOptions): void {
  const { db, dataDir, logger, userId } = options;
  const keep = new Set(options.keep);
  const candidates = [...new Set(options.uploadIds)].filter((id) => !keep.has(id));
  if (candidates.length === 0) return;
  const deleteRow = db.query<{ id: string; ext: TileExt }, [string, string]>(
    `DELETE FROM uploads WHERE id = ? AND user_id = ? AND ${SQL_UPLOAD_UNREFERENCED} RETURNING id, ext`,
  );
  const released = db.transaction(() => candidates.flatMap((id) => {
    const row = deleteRow.get(id, userId);
    return row ? [row] : [];
  }))();
  for (const row of released) {
    try {
      deleteArtifact(dataDir, 'uploads', userId, row.id, row.ext);
    } catch (error) {
      logger.warn({ err: error, uploadId: row.id }, 'released upload unlink failed; will be reaped at next boot');
    }
  }
  if (released.length > 0) logger.info({ userId, count: released.length }, 'released uploads of deleted threads');
}

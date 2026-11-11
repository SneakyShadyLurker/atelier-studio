import type { Database } from 'bun:sqlite';
import { isVideoMime, type MediaExt, type MediaMime, type TileExt, type TileMime } from '@atelier/shared';
import type { AppLogger } from '../observability/logger';
import { reportIfCorruption } from '../db/integrity';
import { selectDoneTile } from '../db/doneTile';
import { deleteArtifact, readArtifactBytes, writeAtomic } from './files';
import { FfmpegCommandError, FfmpegOutputTooLargeError } from './ffmpeg';
import { extractPosterWebp } from './posterFrame';
import { generateThumb, neutralPosterWebp, ThumbDecodeError } from './thumbGen';
import { withSingleFlightAndCap } from './thumbRuntime';

interface ThumbnailInput {
  readonly db: Database;
  readonly dataDir: string;
  readonly userId: string;
  readonly tileId: string;
  readonly ext: MediaExt;
  readonly mime: MediaMime;
  readonly logger: AppLogger;
  readonly sourceBytes?: Uint8Array;
}

function isDeterministicPosterFailure(error: unknown): boolean {
  return error instanceof FfmpegCommandError
    || error instanceof FfmpegOutputTooLargeError
    || error instanceof ThumbDecodeError;
}

// Prewarm and lazy GET share ownership through publication, including the
// post-write tombstone check. A caller's abort never cancels admitted work.
export function ensureThumbnail(input: ThumbnailInput, signal?: AbortSignal): Promise<Uint8Array> {
  const { db, dataDir, userId, tileId, ext, mime, logger } = input;
  return withSingleFlightAndCap(`${userId}/${tileId}`, async () => {
    // A streaming GET may have missed just before another flight published.
    const cached = await readArtifactBytes(dataDir, 'thumbs', userId, tileId, 'webp', 'image/webp');
    if (cached) return cached.bytes;
    const source = input.sourceBytes ?? (await readArtifactBytes(dataDir, 'images', userId, tileId, ext, mime))?.bytes;
    if (!source) throw new ThumbDecodeError(new Error('source artifact missing'));
    let bytes: Uint8Array;
    if (isVideoMime(mime)) {
      try {
        bytes = await extractPosterWebp(source);
      } catch (error) {
        logger.warn({ err: error, tileId }, 'poster frame extraction failed');
        const placeholder = await neutralPosterWebp();
        // A timeout, a spawn failure or queue pressure says nothing about the
        // clip, so the placeholder is served but not stored and the next
        // request retries. A clip ffmpeg or sharp cannot decode fails the
        // same way every time; storing the placeholder keeps it from
        // rerunning ffmpeg on every request.
        if (!isDeterministicPosterFailure(error)) return placeholder;
        bytes = placeholder;
      }
    } else {
      bytes = await generateThumb(source);
    }
    await writeAtomic(dataDir, 'thumbs', userId, tileId, 'webp', bytes);
    let exists: boolean;
    try {
      exists = selectDoneTile(db, tileId, userId) !== null;
    } catch (error) {
      reportIfCorruption(error, logger, { phase: 'thumbnail_publish', tileId });
      throw error;
    }
    if (!exists) {
      try {
        deleteArtifact(dataDir, 'thumbs', userId, tileId, 'webp');
      } catch (error) {
        logger.warn({ err: error, tileId }, 'thumb unlink after deleted-row recheck failed');
      }
    }
    return bytes;
  }, signal);
}

// Upload thumbnails share the `thumbs` root with tile thumbnails. Tile ids are
// UUIDs, which never start with `u`, so this prefix cannot collide with a
// tile's key while still passing writeAtomic's artifact-id validation.
export function uploadThumbnailKey(uploadId: string): string {
  return `u-${uploadId}`;
}

interface UploadThumbnailInput {
  readonly db: Database;
  readonly dataDir: string;
  readonly userId: string;
  readonly uploadId: string;
  readonly ext: TileExt;
  readonly mime: TileMime;
  readonly logger: AppLogger;
}

function uploadExists(db: Database, uploadId: string, userId: string): boolean {
  return db
    .query<{ id: string }, [string, string]>('SELECT id FROM uploads WHERE id = ? AND user_id = ?')
    .get(uploadId, userId) !== null;
}

// Same queue, single flight and post-write recheck as tile thumbnails: an
// upload released while its thumbnail was encoding must not leave the
// thumbnail behind.
export function ensureUploadThumbnail(input: UploadThumbnailInput, signal?: AbortSignal): Promise<Uint8Array> {
  const { db, dataDir, userId, uploadId, ext, mime, logger } = input;
  const key = uploadThumbnailKey(uploadId);
  return withSingleFlightAndCap(`${userId}/${key}`, async () => {
    const cached = await readArtifactBytes(dataDir, 'thumbs', userId, key, 'webp', 'image/webp');
    if (cached) return cached.bytes;
    const source = (await readArtifactBytes(dataDir, 'uploads', userId, uploadId, ext, mime))?.bytes;
    if (!source) throw new ThumbDecodeError(new Error('source upload missing'));
    const bytes = await generateThumb(source);
    await writeAtomic(dataDir, 'thumbs', userId, key, 'webp', bytes);
    let exists: boolean;
    try {
      exists = uploadExists(db, uploadId, userId);
    } catch (error) {
      reportIfCorruption(error, logger, { phase: 'upload_thumbnail_publish', uploadId });
      throw error;
    }
    if (!exists) deleteUploadThumbnail(dataDir, userId, uploadId, logger);
    return bytes;
  }, signal);
}

// Best effort: a leftover thumbnail is unreachable once its upload row is gone.
export function deleteUploadThumbnail(dataDir: string, userId: string, uploadId: string, logger: AppLogger): void {
  try {
    deleteArtifact(dataDir, 'thumbs', userId, uploadThumbnailKey(uploadId), 'webp');
  } catch (error) {
    logger.warn({ err: error, uploadId }, 'upload thumb unlink failed');
  }
}

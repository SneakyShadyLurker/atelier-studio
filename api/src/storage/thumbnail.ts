import type { Database } from 'bun:sqlite';
import { isVideoMime, type MediaExt, type MediaMime } from '@atelier/shared';
import type { AppLogger } from '../observability/logger';
import { reportIfCorruption } from '../db/integrity';
import { selectDoneTile } from '../db/doneTile';
import { deleteArtifact, readArtifactBytes, writeAtomic } from './files';
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
        bytes = await neutralPosterWebp();
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

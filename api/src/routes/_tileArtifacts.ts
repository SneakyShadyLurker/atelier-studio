import type { Context } from 'hono';
import type { MediaExt } from '@atelier/shared';
import type { AppEnv } from '../server-env';
import { deleteArtifact } from '../storage/files';

/**
 * Unlinks a hard-deleted tile's artifact and thumbnail after the delete has
 * committed. A failed unlink is logged and left to the boot orphan sweep: the
 * row is already gone, so the request still succeeds.
 */
export function unlinkTileArtifactsBestEffort(c: Context<AppEnv>, userId: string, tileId: string, ext: MediaExt): void {
  try {
    deleteArtifact(c.var.config.DATA_DIR, 'images', userId, tileId, ext);
  } catch (error) {
    c.var.logger.warn({ err: error, userId, tileId, ext }, 'tile delete: artifact unlink failed; will be reaped at next boot');
  }
  try {
    deleteArtifact(c.var.config.DATA_DIR, 'thumbs', userId, tileId, 'webp');
  } catch (error) {
    c.var.logger.warn({ err: error, userId, tileId }, 'tile delete: thumb unlink failed; will be reaped at next boot');
  }
}

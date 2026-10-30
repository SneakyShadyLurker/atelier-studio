import { Hono } from 'hono';
import { isVideoMime } from '@atelier/shared';
import type { AppEnv } from '../server-env';
import { streamArtifact } from '../storage/files';
import { ensureThumbnail } from '../storage/thumbnail';
import { ImageParamSchema } from './images.schema';
import { parseParams } from './_http';
import { selectDoneTile } from '../db/doneTile';
import { ThumbQueueFullError } from '../storage/thumbRuntime';
import { artifactResponseHeaders, artifactStreamResponse } from './_artifact-response';
import { StorageSealedError } from '../storage/crypto';
import { acquireDecryptedVideo } from '../storage/decryptedVideoCache';
import { videoResponse } from './_video-response';

export const imagesRoutes = new Hono<AppEnv>()
  .get('/img/:tileId', async (c) => {
    const params = parseParams(c, ImageParamSchema);
    if (!params.ok) return params.response;
    const row = selectDoneTile(c.var.db, params.value.tileId, c.var.userId);
    if (!row) return c.body(null, 404);
    // Clips need HTTP Range (iOS playback, seeking): serve a short-lived
    // tmpfs copy through a reader lease, retaining its budget until EOF/cancel.
    if (isVideoMime(row.mime)) {
      const video = await acquireDecryptedVideo(c.var.config.DATA_DIR, c.var.userId, params.value.tileId, row.ext);
      if (video) return videoResponse(video, c.req.raw);
      // No seekable copy available right now (cache budget full): a Range
      // request must not silently get a full-body 200 (iOS rejects it).
      if (c.req.header('Range')) return c.body(null, 503, { 'Retry-After': '2' });
    }
    // Streams and authenticates the age-encrypted artifact chunk by chunk —
    // no whole-file buffering on the highest-volume GET in the api.
    const artifact = await streamArtifact(c.var.config.DATA_DIR, 'images', c.var.userId, params.value.tileId, row.ext, {
      signal: c.req.raw.signal,
    });
    if (!artifact) return c.body(null, 404);
    return artifactStreamResponse(artifact, artifactResponseHeaders(row.mime), (error) => {
      c.var.logger.error({ err: error, tileId: params.value.tileId }, 'artifact_decrypt_failed');
    });
  })
  .get('/img/:tileId/thumb', async (c) => {
    const params = parseParams(c, ImageParamSchema);
    if (!params.ok) return params.response;
    const row = selectDoneTile(c.var.db, params.value.tileId, c.var.userId);
    if (!row) return c.body(null, 404);

    const cached = await streamArtifact(c.var.config.DATA_DIR, 'thumbs', c.var.userId, params.value.tileId, 'webp', {
      signal: c.req.raw.signal,
    });
    if (cached) {
      return artifactStreamResponse(cached, artifactResponseHeaders('image/webp'), (error) => {
        c.var.logger.error({ err: error, tileId: params.value.tileId }, 'artifact_decrypt_failed');
      });
    }

    let thumbBytes: Uint8Array;
    try {
      thumbBytes = await ensureThumbnail({
        db: c.var.db, dataDir: c.var.config.DATA_DIR, userId: c.var.userId,
        tileId: params.value.tileId, ext: row.ext, mime: row.mime, logger: c.var.logger,
      }, c.req.raw.signal);
    } catch (error) {
      if (error instanceof ThumbQueueFullError) {
        c.var.logger.warn({ tileId: params.value.tileId }, 'thumb queue full');
        return c.body(null, 503, { 'Retry-After': '5' });
      }
      if (error instanceof StorageSealedError) {
        c.var.logger.warn({ tileId: params.value.tileId }, 'thumb source read while storage sealed');
        return c.body(null, 503, { 'Retry-After': '5' });
      }
      c.var.logger.error({ err: error, tileId: params.value.tileId }, 'thumb generation failed');
      return c.body(null, 500);
    }

    const currentRow = selectDoneTile(c.var.db, params.value.tileId, c.var.userId);
    if (!currentRow) {
      return c.body(null, 404);
    }

    return new Response(thumbBytes, { headers: artifactResponseHeaders('image/webp') });
  });

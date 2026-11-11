import type { Database } from 'bun:sqlite';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { MAX_UPLOAD_FILE_BYTES as SHARED_MAX_UPLOAD_FILE_BYTES, MAX_UPLOAD_INPUT_BYTES } from '@atelier/shared';
import { TILE_EXTS, TILE_MIMES, type TileExt, type TileMime } from '@atelier/shared';
import type { AppEnv } from '../server-env';
import { deleteArtifact, readArtifactBytes, streamArtifact } from '../storage/files';
import { parseParams } from './_http';
import { UploadParamSchema } from './uploads.schema';
import { ImageParamSchema } from './images.schema';
import { selectDoneTile } from '../db/doneTile';
import { reportIfCorruption } from '../db/integrity';
import { StorageSealedError } from '../storage/crypto';
import { deleteUploadThumbnail, ensureUploadThumbnail, uploadThumbnailKey } from '../storage/thumbnail';
import { ThumbQueueFullError } from '../storage/thumbRuntime';
import { UploadQueueFullError, withUploadSlot } from './uploads-runtime';
import { artifactResponseHeaders, artifactStreamResponse } from './_artifact-response';
import { isAbortError } from '../lifecycle/abort';
import { ImageTooLargeError, UnsupportedImageError } from '../storage/normalizeUpload';
import { TranscodeTimeoutError } from '../storage/heicDecode';
import { InvalidUploadSizeError, SQL_UPLOAD_UNREFERENCED, storeUpload } from '../storage/uploadStore';

export const MAX_UPLOAD_FILE_BYTES = SHARED_MAX_UPLOAD_FILE_BYTES;
export const MAX_UPLOAD_REQUEST_BYTES = MAX_UPLOAD_INPUT_BYTES + 3 * 1024 * 1024; // 50 MB input + 3 MB multipart headroom

// Bun.serve enforces the same constant before app.fetch in production.
// Hono's bodyLimit is the app-level backstop for direct app.fetch tests
// and any future runtime path that reaches the multipart parser.
const uploadBodyLimit = bodyLimit({
  maxSize: MAX_UPLOAD_REQUEST_BYTES,
  onError: (c) => c.json({ error: 'request body too large' }, 413),
});

interface UploadRow {
  ext: TileExt;
  mime: TileMime;
  user_id: string;
}

function selectUpload(db: Database, uploadId: string, userId: string): UploadRow | null {
  return db
    .query<UploadRow, [string, string]>('SELECT ext, mime, user_id FROM uploads WHERE id = ? AND user_id = ?')
    .get(uploadId, userId);
}

const tileExts: ReadonlySet<string> = new Set(TILE_EXTS);
const tileMimes: ReadonlySet<string> = new Set(TILE_MIMES);
const isTileExt = (ext: string): ext is TileExt => tileExts.has(ext);
const isTileMime = (mime: string): mime is TileMime => tileMimes.has(mime);

// One owner for turning bytes into a stored upload and its response, so a
// server-side copy (source-upload) answers exactly like a browser upload.
async function storeUploadResponse(c: Context<AppEnv>, bytes: Uint8Array): Promise<Response> {
  try {
    const response = await storeUpload({
      db: c.var.db,
      dataDir: c.var.config.DATA_DIR,
      logger: c.var.logger,
      userId: c.var.userId,
      bytes,
      signal: c.req.raw.signal,
    });
    return c.json(response, 201);
  } catch (error) {
    if (error instanceof ImageTooLargeError) return c.json({ error: 'image too large' }, 400);
    if (error instanceof UnsupportedImageError) return c.json({ error: 'unsupported image' }, 400);
    if (error instanceof InvalidUploadSizeError) return c.json({ error: 'image too large' }, 400);
    if (error instanceof TranscodeTimeoutError) {
      c.var.logger.warn({ userId: c.var.userId }, 'upload transcode timed out');
      return c.json({ error: 'image processing timed out' }, 400);
    }
    if (isAbortError(error)) return new Response(null, { status: 499 });
    c.var.logger.error({ err: error }, 'upload normalize failed');
    return c.json({ error: 'internal error' }, 500);
  }
}

export const uploadsRoutes = new Hono<AppEnv>()
  .post(
    '/uploads',
    // Permanent header-only rejections answer before admission, so a full
    // queue never turns them into a retryable 503. Neither reads the body.
    (c, next) => {
      const contentType = c.req.header('Content-Type') ?? '';
      if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
        return c.json({ error: 'multipart/form-data required' }, 400);
      }
      return next();
    },
    // bodyLimit rejects a declared Content-Length without reading; with
    // Transfer-Encoding it must read the body, so that case waits for admission.
    (c, next) => {
      const { headers } = c.req.raw;
      if (headers.has('Content-Length') && !headers.has('Transfer-Encoding')) return uploadBodyLimit(c, next);
      return next();
    },
    // Admission must enclose bodyLimit too: it buffers chunked requests before
    // the multipart handler runs. Hono owns the downstream response via c.res.
    async (c, next) => {
      try {
        await withUploadSlot(c.var.userId, next, c.req.raw.signal);
        if (c.req.raw.signal.aborted) c.res = new Response(null, { status: 499 });
        return undefined;
      } catch (error) {
        if (c.req.raw.signal.aborted) return new Response(null, { status: 499 });
        if (error instanceof UploadQueueFullError) {
          c.var.logger.warn({ userId: c.var.userId }, 'upload queue full');
          return c.body(null, 503, { 'Retry-After': '5' });
        }
        throw error;
      }
    },
    uploadBodyLimit,
    async (c) => {
      // Body buffering and normalization both run inside the upload slot, so
      // transient request memory is bounded by the envelope cap × pool size.
      const body = await c.req.parseBody();
      const file = body.file;
      if (!(file instanceof File)) return c.json({ error: 'file required' }, 400);
      if (file.size <= 0 || file.size > MAX_UPLOAD_INPUT_BYTES) return c.json({ error: 'invalid file size' }, 400);

      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.byteLength <= 0 || bytes.byteLength > MAX_UPLOAD_INPUT_BYTES) return c.json({ error: 'invalid file size' }, 400);

      return storeUploadResponse(c, bytes);
    },
  )
  .get('/uploads/:uploadId', async (c) => {
    const params = parseParams(c, UploadParamSchema);
    if (!params.ok) return params.response;
    const row = c.var.db
      .query<UploadRow, [string, string]>('SELECT ext, mime, user_id FROM uploads WHERE id = ? AND user_id = ?')
      .get(params.value.uploadId, c.var.userId);
    if (!row) return c.body(null, 404);
    const artifact = await streamArtifact(c.var.config.DATA_DIR, 'uploads', row.user_id, params.value.uploadId, row.ext, {
      signal: c.req.raw.signal,
    });
    if (!artifact) return c.body(null, 404);
    return artifactStreamResponse(artifact, artifactResponseHeaders(row.mime), (error) => {
      c.var.logger.error({ err: error, uploadId: params.value.uploadId }, 'artifact_decrypt_failed');
    });
  })
  // Small previews of a reference (Lightbox strip, Composer chips, the video
  // loading backdrop) read this instead of the full original. Same queue,
  // single flight and headers as /img/:tileId/thumb.
  .get('/uploads/:uploadId/thumb', async (c) => {
    const params = parseParams(c, UploadParamSchema);
    if (!params.ok) return params.response;
    const { uploadId } = params.value;
    const row = selectUpload(c.var.db, uploadId, c.var.userId);
    if (!row) return c.body(null, 404);

    const cached = await streamArtifact(c.var.config.DATA_DIR, 'thumbs', c.var.userId, uploadThumbnailKey(uploadId), 'webp', {
      signal: c.req.raw.signal,
    });
    if (cached) {
      return artifactStreamResponse(cached, artifactResponseHeaders('image/webp'), (error) => {
        c.var.logger.error({ err: error, uploadId }, 'artifact_decrypt_failed');
      });
    }

    let thumbBytes: Uint8Array;
    try {
      thumbBytes = await ensureUploadThumbnail({
        db: c.var.db, dataDir: c.var.config.DATA_DIR, userId: c.var.userId,
        uploadId, ext: row.ext, mime: row.mime, logger: c.var.logger,
      }, c.req.raw.signal);
    } catch (error) {
      if (error instanceof ThumbQueueFullError) {
        c.var.logger.warn({ uploadId }, 'thumb queue full');
        return c.body(null, 503, { 'Retry-After': '5' });
      }
      if (error instanceof StorageSealedError) {
        c.var.logger.warn({ uploadId }, 'thumb source read while storage sealed');
        return c.body(null, 503, { 'Retry-After': '5' });
      }
      c.var.logger.error({ err: error, uploadId }, 'thumb generation failed');
      return c.body(null, 500);
    }

    if (!selectUpload(c.var.db, uploadId, c.var.userId)) return c.body(null, 404);
    return new Response(thumbBytes, { headers: artifactResponseHeaders('image/webp') });
  })
  .delete('/uploads/:uploadId', (c) => {
    const params = parseParams(c, UploadParamSchema);
    if (!params.ok) return params.response;
    const row = c.var.db
      .query<UploadRow, [string, string]>('SELECT ext, mime, user_id FROM uploads WHERE id = ? AND user_id = ?')
      .get(params.value.uploadId, c.var.userId);
    if (!row) return c.body(null, 204);

    const referenced = c.var.db
      .query(`DELETE FROM uploads WHERE id = ? AND user_id = ? AND ${SQL_UPLOAD_UNREFERENCED}`)
      .run(params.value.uploadId, c.var.userId).changes === 0;
    if (referenced) return c.json({ error: 'upload still referenced' }, 409);

    try {
      deleteArtifact(c.var.config.DATA_DIR, 'uploads', row.user_id, params.value.uploadId, row.ext);
    } catch (error) {
      c.var.logger.warn({ err: error, uploadId: params.value.uploadId }, 'upload artifact delete failed');
    }
    deleteUploadThumbnail(c.var.config.DATA_DIR, row.user_id, params.value.uploadId, c.var.logger);
    return c.body(null, 204);
  })
  // Animate and Tell Story need a finished still as an upload. Copying it here
  // spares the browser a download and re-upload of the full original; the
  // bytes go through the same admission, normalization and limits as
  // POST /uploads, so the stored upload matches what that path would store.
  // source_tile_id stays unset: it marks a video-extension predecessor, and
  // an image tile is never one.
  .post('/tiles/:tileId/source-upload', async (c) => {
    if (c.req.raw.body) return c.json({ error: 'source upload requests must have no body' }, 400);
    const params = parseParams(c, ImageParamSchema);
    if (!params.ok) return params.response;
    const { tileId } = params.value;
    // Same visibility as GET /img/:tileId; clips are not reference stills.
    const tile = selectDoneTile(c.var.db, tileId, c.var.userId);
    if (!tile || !isTileMime(tile.mime) || !isTileExt(tile.ext)) return c.body(null, 404);
    const { ext, mime } = tile;

    try {
      return await withUploadSlot(c.var.userId, async () => {
        const artifact = await readArtifactBytes(c.var.config.DATA_DIR, 'images', c.var.userId, tileId, ext, mime, {
          signal: c.req.raw.signal,
        });
        if (!artifact) return c.body(null, 404);
        const { bytes } = artifact;
        if (bytes.byteLength <= 0 || bytes.byteLength > MAX_UPLOAD_INPUT_BYTES) return c.json({ error: 'invalid file size' }, 400);
        return storeUploadResponse(c, bytes);
      }, c.req.raw.signal);
    } catch (error) {
      if (isAbortError(error) || c.req.raw.signal.aborted) return new Response(null, { status: 499 });
      if (error instanceof UploadQueueFullError) {
        c.var.logger.warn({ userId: c.var.userId }, 'upload queue full');
        return c.body(null, 503, { 'Retry-After': '5' });
      }
      if (error instanceof StorageSealedError) return c.json({ error: 'storage sealed' }, 503, { 'Retry-After': '5' });
      if (!reportIfCorruption(error, c.var.logger, { phase: 'source_upload', tileId })) {
        c.var.logger.error({ err: error, tileId }, 'source upload failed');
      }
      return c.json({ error: 'internal error' }, 500);
    }
  });

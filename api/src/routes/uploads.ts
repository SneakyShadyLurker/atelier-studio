import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { MAX_UPLOAD_FILE_BYTES as SHARED_MAX_UPLOAD_FILE_BYTES, MAX_UPLOAD_INPUT_BYTES } from '@atelier/shared';
import type { TileExt, TileMime } from '@atelier/shared';
import type { AppEnv } from '../server-env';
import { deleteArtifact, streamArtifact } from '../storage/files';
import { parseParams } from './_http';
import { UploadParamSchema } from './uploads.schema';
import { UploadQueueFullError, withUploadSlot } from './uploads-runtime';
import { artifactResponseHeaders, artifactStreamResponse } from './_artifact-response';
import { isAbortError } from '../lifecycle/abort';
import { ImageTooLargeError, UnsupportedImageError } from '../storage/normalizeUpload';
import { TranscodeTimeoutError } from '../storage/heicDecode';
import { InvalidUploadSizeError, SQL_UPLOAD_UNREFERENCED, storeUpload } from '../storage/uploadStore';

export const MAX_UPLOAD_FILE_BYTES = SHARED_MAX_UPLOAD_FILE_BYTES;
export const MAX_UPLOAD_REQUEST_BYTES = MAX_UPLOAD_INPUT_BYTES + 3 * 1024 * 1024; // 50 MB input + 3 MB multipart headroom

interface UploadRow {
  ext: TileExt;
  mime: TileMime;
  user_id: string;
}

export const uploadsRoutes = new Hono<AppEnv>()
  .post(
    '/uploads',
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
    // Bun.serve enforces the same constant before app.fetch in production.
    // Hono's bodyLimit is the app-level backstop for direct app.fetch tests
    // and any future runtime path that reaches the multipart parser.
    bodyLimit({
      maxSize: MAX_UPLOAD_REQUEST_BYTES,
      onError: (c) => c.json({ error: 'request body too large' }, 413),
    }),
    async (c) => {
      const contentType = c.req.header('Content-Type') ?? '';
      if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
        return c.json({ error: 'multipart/form-data required' }, 400);
      }

      // Body buffering and normalization both run inside the upload slot, so
      // transient request memory is bounded by the envelope cap × pool size.
      const body = await c.req.parseBody();
      const file = body.file;
      if (!(file instanceof File)) return c.json({ error: 'file required' }, 400);
      if (file.size <= 0 || file.size > MAX_UPLOAD_INPUT_BYTES) return c.json({ error: 'invalid file size' }, 400);

      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.byteLength <= 0 || bytes.byteLength > MAX_UPLOAD_INPUT_BYTES) return c.json({ error: 'invalid file size' }, 400);

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
    return c.body(null, 204);
  });

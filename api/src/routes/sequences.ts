import { Hono } from 'hono';
import type { MediaExt } from '@atelier/shared';
import type { AppEnv } from '../server-env';
import { reportIfCorruption } from '../db/integrity';
import { dissolveSequence, getSequenceTail, unlinkBatch } from '../db/sequences';
import { isAbortError } from '../lifecycle/abort';
import {
  applySequenceMutationEffect,
  type SequenceMutationEffect,
} from '../orchestrator/sequenceLifecycle';
import { streamArtifact } from '../storage/files';
import { StorageSealedError } from '../storage/crypto';
import { withDecryptedArtifactFiles } from '../storage/decryptedTemp';
import { decryptedVideoFile } from '../storage/decryptedVideoCache';
import { extractLastFramePng } from '../storage/lastFrame';
import {
  InvalidUploadSizeError,
  storeUpload,
} from '../storage/uploadStore';
import { ImageTooLargeError, UnsupportedImageError } from '../storage/normalizeUpload';
import { TranscodeTimeoutError } from '../storage/heicDecode';
import { artifactResponseHeaders, artifactStreamResponse } from './_artifact-response';
import { parseParams } from './_http';
import { HandoffTileParamSchema, SequenceParamSchema } from './sequences.schema';
import { videoSequencesGate } from './sequences.gate';

interface HandoffTileRow {
  readonly ext: MediaExt;
}

interface MasterRow {
  readonly user_id: string;
  readonly master_updated_at: number | null;
}

let beforeTailMutationForTests: (() => void) | null = null;

export function setBeforeTailMutationForTests(hook: (() => void) | null): void {
  beforeTailMutationForTests = hook;
}

export const sequencesRoutes = new Hono<AppEnv>()
  // Path-scoped: a sub-app `*` would gate every /api path mounted after it.
  .use('/tiles/:tileId/handoff-frame', videoSequencesGate)
  .use('/sequences/*', videoSequencesGate)
  .post('/tiles/:tileId/handoff-frame', async (c) => {
    const params = parseParams(c, HandoffTileParamSchema);
    if (!params.ok) return params.response;
    const tile = c.var.db.query<HandoffTileRow, [string, string]>(
      `SELECT t.ext
         FROM tiles t
         JOIN batches b ON b.id = t.batch_id AND b.user_id = t.user_id
        WHERE t.id = ?
          AND t.user_id = ?
          AND t.status = 'done'
          AND t.ext = 'mp4'
          AND t.mime = 'video/mp4'
          AND b.status = 'done'`,
    ).get(params.value.tileId, c.var.userId);
    if (!tile) return c.body(null, 404);

    try {
      const signal = c.req.raw.signal;
      const png = await withDecryptedArtifactFiles(
        c.var.config.DATA_DIR,
        [{ root: 'images', userId: c.var.userId, artifactId: params.value.tileId, ext: tile.ext }],
        { signal },
        ([path]) => {
          if (path === undefined) throw new Error('decrypted handoff source missing');
          return extractLastFramePng(path, { signal });
        },
      );
      if (png === null) return c.body(null, 404);
      const upload = await storeUpload({
        db: c.var.db,
        dataDir: c.var.config.DATA_DIR,
        logger: c.var.logger,
        userId: c.var.userId,
        bytes: png,
        signal: c.req.raw.signal,
        sourceTileId: params.value.tileId,
      });
      return c.json({ uploadId: upload.id });
    } catch (error) {
      if (isAbortError(error) || c.req.raw.signal.aborted) {
        return new Response(null, { status: 499 });
      }
      if (error instanceof StorageSealedError) return c.json({ error: 'storage sealed' }, 503, { 'Retry-After': '5' });
      if (
        error instanceof InvalidUploadSizeError
        || error instanceof ImageTooLargeError
        || error instanceof UnsupportedImageError
        || error instanceof TranscodeTimeoutError
      ) {
        c.var.logger.warn({ err: error, tileId: params.value.tileId }, 'handoff frame storage failed');
        return c.json({ error: 'handoff frame extraction failed' }, 500);
      }
      if (!reportIfCorruption(error, c.var.logger, {
        phase: 'handoff_frame',
        tileId: params.value.tileId,
      })) {
        c.var.logger.error({ err: error, tileId: params.value.tileId }, 'handoff frame extraction failed');
      }
      return c.json({ error: 'handoff frame extraction failed' }, 500);
    }
  })
  .get('/sequences/:id/master', async (c) => {
    const params = parseParams(c, SequenceParamSchema);
    if (!params.ok) return params.response;
    const row = c.var.db.query<MasterRow, [string, string]>(
      `SELECT user_id, master_updated_at
         FROM video_sequences
        WHERE id = ? AND user_id = ? AND master_status = 'ready'`,
    ).get(params.value.id, c.var.userId);
    if (!row) return c.body(null, 404);
    // Range for <video> playback/seeking: see storage/decryptedVideoCache.ts.
    // Topology advances before the master changes. Only committed publication
    // identity keys bytes, including requests while an appended tail renders.
    const isCurrentPublication = (): boolean => c.var.db.query<MasterRow, [string, string]>(
      `SELECT user_id, master_updated_at FROM video_sequences
        WHERE id = ? AND user_id = ? AND master_status = 'ready'`,
    ).get(params.value.id, c.var.userId)?.master_updated_at === row.master_updated_at;
    const video = await decryptedVideoFile(
      c.var.config.DATA_DIR,
      row.user_id,
      params.value.id,
      'mp4',
      String(row.master_updated_at),
      isCurrentPublication,
    );
    if (!isCurrentPublication()) return c.body(null, 503, { 'Retry-After': '2' });
    if (video) return new Response(video, { headers: artifactResponseHeaders('video/mp4') });
    if (c.req.header('Range')) return c.body(null, 503, { 'Retry-After': '2' });
    const artifact = await streamArtifact(
      c.var.config.DATA_DIR,
      'images',
      row.user_id,
      params.value.id,
      'mp4',
      { signal: c.req.raw.signal },
    );
    if (!isCurrentPublication()) {
      await artifact?.stream.cancel().catch(() => undefined);
      return c.body(null, 503, { 'Retry-After': '2' });
    }
    if (!artifact) return c.body(null, 404);
    return artifactStreamResponse(artifact, artifactResponseHeaders('video/mp4'), (error) => {
      c.var.logger.error({ err: error, sequenceId: params.value.id }, 'artifact_decrypt_failed');
    });
  })
  .delete('/sequences/:id/tail', (c) => {
    const params = parseParams(c, SequenceParamSchema);
    if (!params.ok) return params.response;
    beforeTailMutationForTests?.();
    const result = c.var.db.transaction(() => {
      const owned = c.var.db.query<{ id: string }, [string, string]>(
        'SELECT id FROM video_sequences WHERE id = ? AND user_id = ?',
      ).get(params.value.id, c.var.userId);
      if (!owned) return { status: 'not-found' as const };
      const inFlight = c.var.db.query<{ one: number }, [string, string]>(
        `SELECT 1 AS one FROM batches
          WHERE sequence_id = ? AND user_id = ? AND status IN ('queued', 'running') LIMIT 1`,
      ).get(params.value.id, c.var.userId);
      if (inFlight) return { status: 'in-flight' as const };
      const tail = getSequenceTail(c.var.db, c.var.userId, params.value.id);
      if (!tail) return { status: 'not-found' as const };
      const unlinked = unlinkBatch(c.var.db, c.var.userId, params.value.id, tail.batch.id);
      if (unlinked.status === 'not-found') return { status: 'not-found' as const };
      if (unlinked.remainingSegmentCount >= 2) {
        return {
          status: 'ok' as const,
          effect: {
            kind: 'restitch' as const,
            sequenceId: params.value.id,
            batchId: tail.batch.id,
          },
        };
      }
      const dissolved = dissolveSequence(c.var.db, c.var.userId, params.value.id);
      if (dissolved.status === 'not-found') return { status: 'not-found' as const };
      return {
        status: 'ok' as const,
        effect: {
          kind: 'delete-master' as const,
          sequenceId: dissolved.sequence.id,
          userId: dissolved.sequence.userId,
        },
      };
    }).immediate();
    if (result.status === 'not-found') return c.body(null, 404);
    if (result.status === 'in-flight') {
      return c.json({ error: 'sequence-in-flight' }, 409);
    }
    applySequenceMutationEffect(
      c.var.config,
      c.var.logger,
      result.effect satisfies SequenceMutationEffect,
    );
    return c.body(null, 204);
  });

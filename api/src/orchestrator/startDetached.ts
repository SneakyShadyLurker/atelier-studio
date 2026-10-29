import type { Database } from 'bun:sqlite';
import type { Config } from '../config';
import { reportIfCorruption } from '../db/integrity';
import type { GenerationContext, PreparedBatch } from '../orchestrator';
import { RefImagesNotFoundError } from './refImages';
import * as bus from './bus';
import { failBatchTerminally } from './failBatchTerminally';

export type StartDetachedContext = GenerationContext & {
  readonly db: Database;
  readonly config: Config;
  readonly runBatchPipeline: (prepared: PreparedBatch, ctx: GenerationContext) => Promise<void> | void;
};

export async function startOrchestratorDetached(
  prepared: PreparedBatch,
  ctx: StartDetachedContext,
): Promise<void> {
  try {
    await ctx.runBatchPipeline(prepared, ctx);
  } catch (err) {
    // Background path — never reaches the request-scoped onError handler, so
    // tile finalize writes hitting a damaged DB would otherwise go untagged.
    if (!reportIfCorruption(err, ctx.logger, { phase: 'detached_pipeline', batchId: prepared.batch.id })) {
      ctx.logger.error({ err, batchId: prepared.batch.id }, 'detached pipeline failure');
    }
    try {
      failBatchTerminally(
        ctx.db,
        ctx.config,
        ctx.logger,
        prepared.batch.id,
        err instanceof RefImagesNotFoundError ? 'upstream rejected' : 'internal error',
        {
          emitTerminal: (frame) => { bus.broadcastTerminal(prepared.batch.id, frame); },
          close: () => { bus.closeBatch(prepared.batch.id); },
        },
      );
    } catch (cleanupErr) {
      ctx.logger.error({ err: cleanupErr, batchId: prepared.batch.id }, 'detached pipeline cleanup failed');
    }
  } finally {
    // Release any slots still reserved after the pipeline settles — on BOTH the
    // success and failure paths. A queued batch reserves entry.count slots up
    // front, but a per-tile DELETE in the dequeue→BYOK-load window can leave
    // prepared.tiles.length < entry.count; onTileSettled then releases only one
    // slot per prepared tile, so the leftover reservation would leak until
    // process restart. onSyncFailure (releaseRemaining) is idempotent via its
    // outstanding>0 guard, so it is a no-op when the count already matched.
    ctx.onSyncFailure();
    bus.closeBatch(prepared.batch.id);
  }
}

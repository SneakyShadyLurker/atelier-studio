import type { Pool } from '@atelier/shared';
import { terminalFrame } from '../lifecycle/sse';
import { reportIfCorruption } from '../db/integrity';
import { transitionQueuedToRunning } from '../db/queueOps';
import { capsForPool } from '../providers/registry';
import * as bus from './bus';
import { failBatchAtDequeue, revalidateAtDequeue, type DequeueContext } from './revalidate';
import * as queue from './queue';
import type { QueueEntry } from './queue';
import { consumePause } from './upstreamGate';
import { isStorageSealed } from '../storage/crypto';
import { createReservationReleaser, type ReservationReleaser } from './concurrency';

let shutdownDrain = false;

export function beginShutdownDrain(): void {
  shutdownDrain = true;
}

export function resetShutdownDrainForTests(): void {
  shutdownDrain = false;
}

export interface DequeueRuntimeContext extends DequeueContext {
  readonly acquireFor: (
    pool: Pool,
    userId: string,
    count: number,
  ) => { readonly ok: true } | { readonly ok: false; readonly reason: 'global' | 'per-user' };
  readonly releaseFor: (pool: Pool, userId: string, count: number) => void;
  readonly startOrchestratorDetached: (entry: QueueEntry, reservation: ReservationReleaser) => Promise<void>;
  readonly prepareQueued?: () => boolean;
  readonly queueEpoch: number;
}

// Admission may reject a stale/oversized head before acquiring any slots.
// Its terminal DB write can fail; a kick must never undo an accepted POST or
// turn a release microtask into an uncaught exception. Do not retry a failed
// kick here: another capacity/queue event can retry remaining work.
export function kickDequeueNext(pool: Pool, ctx: DequeueRuntimeContext): void {
  try { tryDequeueNext(pool, ctx); }
  catch (error) {
    if (!reportIfCorruption(error, ctx.logger, { phase: 'queue_kick', pool })) {
      ctx.logger.error({ err: error, pool }, 'queue kick failed');
    }
  }
}

export function scheduleDequeueNext(pool: Pool, ctx: DequeueRuntimeContext): void {
  queueMicrotask(() => { kickDequeueNext(pool, ctx); });
}

export function tryDequeueNext(pool: Pool, ctx: DequeueRuntimeContext): void {
  if (shutdownDrain || (pool === 'local' && ctx.prepareQueued && !ctx.prepareQueued())) return;
  for (;;) {
    const head = findNextAcquirable(pool, ctx);
    if (!head) return;
    // The detached starter takes over successful reservations. Until then,
    // synchronous cleanup and rejected startup share one idempotent release.
    const reservation = createReservationReleaser(
      head.count,
      (count) => { ctx.releaseFor(pool, head.userId, count); },
      () => { scheduleDequeueNext(pool, ctx); },
    );
    const { releaseRemaining } = reservation;

    let claimed = false;
    try {
      const startedAt = transitionQueuedToRunning(ctx.db, head.batchId);
      claimed = startedAt !== null;
      if (startedAt === null) {
        releaseRemaining();
        queue.removeById(pool, head.batchId);
        continue;
      }

      const validation = revalidateAtDequeue(ctx, head);
      if (!validation.ok) {
        releaseRemaining();
        queue.removeById(pool, head.batchId);
        failBatchAtDequeue(ctx, head, validation.reason);
        continue;
      }

      queue.noteDispatchedFromQueue(pool, head);
      queue.removeById(pool, head.batchId);
      bus.broadcastTerminal(
        head.batchId,
        terminalFrame('queue', { batchId: head.batchId, status: 'running', startedAt }),
      );
      void ctx.startOrchestratorDetached(head, reservation).catch((err: unknown) => {
        // The body of this .catch must not itself reject — its return value
        // is discarded by `void`, so any throw becomes an unhandled rejection.
        // Wrap every fallible step. The kick path intentionally re-enters
        // tryDequeueNext from a fresh microtask, matching the outer catch.
        ctx.logger.error({ err, batchId: head.batchId, pool }, 'dequeued batch failed to start');
        queueMicrotask(() => {
          try {
            releaseRemaining();
          } catch (releaseErr) {
            ctx.logger.error(
              { err: releaseErr, batchId: head.batchId },
              'dequeued batch release/kick failed',
            );
          }
        });
        try {
          failBatchAtDequeue(ctx, head, 'internal error');
        } catch (failErr) {
          ctx.logger.error({ err: failErr, batchId: head.batchId }, 'dequeued batch start cleanup failed');
        }
      });
    } catch (err) {
      if (!reportIfCorruption(err, ctx.logger, { phase: 'dequeue', batchId: head.batchId, pool })) {
        ctx.logger.error({ err, batchId: head.batchId, pool }, 'dequeue failure');
      }
      releaseRemaining();
      if (claimed) {
        try {
          failBatchAtDequeue(ctx, head, 'internal error');
        } catch (failErr) {
          ctx.logger.error({ err: failErr, batchId: head.batchId }, 'dequeue failure cleanup failed');
        }
      }
      queue.removeById(pool, head.batchId);
      // Flatten the recursive retry onto a fresh microtask so a long
      // stall-storm cannot grow the synchronous stack frame-by-frame. The
      // outer for(;;) below still iterates normally; the microtask is the
      // floor that guarantees we re-poke the queue even if some future
      // change adds a `continue`/`break` to the catch.
      scheduleDequeueNext(pool, ctx);
    }
  }
}

function findNextAcquirable(pool: Pool, ctx: DequeueRuntimeContext): QueueEntry | undefined {
  if (shutdownDrain) return undefined;
  // Dispatched work may read stored (encrypted) artifacts: refs, I2V sources,
  // extend tails. Hold the queue until the host agent unseals storage; the
  // unseal listener in server.ts kicks every pool.
  if (isStorageSealed()) return undefined;
  if (consumePause(pool) === 'pause') return undefined;
  if (pool === 'byok') return findNextByokAcquirable(ctx);
  for (;;) {
    const entry = queue.peekNext(pool);
    if (entry?.epoch !== ctx.queueEpoch) return undefined;
    if (entryExceedsCurrentCaps(pool, ctx, entry)) {
      queue.removeById(pool, entry.batchId);
      failBatchAtDequeue(ctx, entry, 'internal error');
      continue;
    }
    const acquired = ctx.acquireFor(pool, entry.userId, entry.count);
    return acquired.ok ? entry : undefined;
  }
}

function findNextByokAcquirable(ctx: DequeueRuntimeContext): QueueEntry | undefined {
  const blockedUsers = new Set<string>();
  for (const entry of [...queue.entries('byok')]) {
    if (entry.epoch !== ctx.queueEpoch) return undefined;
    if (entryExceedsCurrentCaps('byok', ctx, entry)) {
      queue.removeById('byok', entry.batchId);
      failBatchAtDequeue(ctx, entry, 'internal error');
      continue;
    }
    if (blockedUsers.has(entry.userId)) continue;

    const acquired = ctx.acquireFor('byok', entry.userId, entry.count);
    if (acquired.ok) return entry;
    if (acquired.reason === 'global') return undefined;
    blockedUsers.add(entry.userId);
  }
  return undefined;
}

function entryExceedsCurrentCaps(pool: Pool, ctx: DequeueRuntimeContext, entry: QueueEntry): boolean {
  const caps = capsForPool(ctx.config, pool);
  if (entry.count > caps.perUserCap) return true;
  return caps.globalCap !== null && entry.count > caps.globalCap;
}

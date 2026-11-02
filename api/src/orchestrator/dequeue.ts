import type { Pool, TileErrorCategory } from '@atelier/shared';
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
export const DEQUEUE_RETRY_MS = 250;
interface RetryState { epoch: number; delay: number; timer?: ReturnType<typeof setTimeout> }
// One timer per domain/pool: unrelated unknown-user failures cannot lengthen
// the first storage-claim retry, and neither claim domain delays settlement.
const retryLanes = {
  claim: new Map<Pool, RetryState>(), deferredClaim: new Map<Pool, RetryState>(), settlement: new Map<Pool, RetryState>(),
};
type RetryLane = keyof typeof retryLanes;
type ClaimRetryLane = Exclude<RetryLane, 'settlement'>;
const failedClaims = new Map<string, { pool: Pool; entry: QueueEntry; lane: ClaimRetryLane; attemptedAt?: number }>();
const terminalRetries = new Map<string, { pool: Pool; entry: QueueEntry; reason: TileErrorCategory }>();

function clearRetry(lane: RetryLane, pool: Pool): void {
  clearTimeout(retryLanes[lane].get(pool)?.timer);
  retryLanes[lane].delete(pool);
}

function clearRetryIfSettled(lane: RetryLane, pool: Pool): void {
  if (lane === 'settlement') {
    for (const pending of terminalRetries.values()) if (pending.pool === pool) return;
  } else {
    for (const pending of failedClaims.values()) if (pending.pool === pool && pending.lane === lane) return;
  }
  clearRetry(lane, pool);
}

function forgetClaim(batchId: string, pool: Pool): void {
  const previous = failedClaims.get(batchId);
  if (previous && failedClaims.delete(batchId)) clearRetryIfSettled(previous.lane, pool);
}

function rememberClaimFailure(pool: Pool, entry: QueueEntry, lane: ClaimRetryLane, attemptedAt?: number): void {
  const previous = failedClaims.get(entry.batchId);
  const stamp = attemptedAt ?? previous?.attemptedAt;
  failedClaims.set(entry.batchId, { pool, entry, lane, ...(stamp === undefined ? {} : { attemptedAt: stamp }) });
  if (previous && previous.lane !== lane) clearRetryIfSettled(previous.lane, pool);
}

function clearRetries(): void {
  for (const lane of Object.values(retryLanes)) {
    for (const retry of lane.values()) clearTimeout(retry.timer);
    lane.clear();
  }
  failedClaims.clear();
  terminalRetries.clear();
}

function scheduleRetry(lane: RetryLane, pool: Pool, ctx: DequeueRuntimeContext): void {
  if (shutdownDrain || ctx.queueEpoch !== queue.currentEpoch()) return;
  const registry = retryLanes[lane];
  const current = registry.get(pool);
  if (current?.epoch === ctx.queueEpoch && current.timer) {
    return;
  }
  clearTimeout(current?.timer);
  const delay = current?.epoch === ctx.queueEpoch
    ? Math.min(current.delay * 2, 30_000)
    : DEQUEUE_RETRY_MS;
  const state: RetryState = { epoch: ctx.queueEpoch, delay };
  const timer = setTimeout(() => {
    if (registry.get(pool) !== state) return;
    delete state.timer;
    if (!shutdownDrain && ctx.queueEpoch === queue.currentEpoch()) kickDequeueNext(pool, ctx);
    else {
      registry.delete(pool);
      const owned = lane === 'settlement' ? terminalRetries : failedClaims;
      for (const [id, pending] of owned) {
        if (pending.pool === pool && pending.entry.epoch === ctx.queueEpoch
          && (lane === 'settlement' || failedClaims.get(id)?.lane === lane)) owned.delete(id);
      }
    }
  }, delay);
  timer.unref();
  state.timer = timer;
  registry.set(pool, state);
}

// Once failure settlement owns an entry, it no longer belongs in the runnable
// queue. A failed write is retained here before removal, allowing later jobs
// to progress without abandoning the durable batch or retrying in a tight loop.
function settleOrPark(
  pool: Pool,
  ctx: DequeueRuntimeContext,
  entry: QueueEntry,
  reason: TileErrorCategory,
): void {
  const ownsQueue = !shutdownDrain && entry.epoch === ctx.queueEpoch && ctx.queueEpoch === queue.currentEpoch();
  // A detached starter still owes its original DB a terminal write, including
  // while draining or after a queue reset. Only current owners may mutate the
  // live queue/retry projection; old contexts cannot remove a new epoch's work.
  const pending = terminalRetries.get(entry.batchId);
  try {
    failBatchAtDequeue(ctx, entry, reason, {
      emitDoneOnEmpty: ownsQueue && pending?.entry.epoch === entry.epoch && pending.pool === pool,
    });
    if (ownsQueue) {
      terminalRetries.delete(entry.batchId);
      clearRetryIfSettled('settlement', pool);
    }
  } catch (error) {
    const corruption = reportIfCorruption(error, ctx.logger, { phase: 'dequeue_settlement', batchId: entry.batchId, pool });
    if (!corruption) {
      ctx.logger.error({ err: error, batchId: entry.batchId, pool }, 'dequeue terminal settlement failed');
    }
    if (ownsQueue) {
      terminalRetries.set(entry.batchId, { pool, entry, reason });
      // Constraint repairs can recover without restart. Keep periodic retries
      // bounded by the pool backoff while unrelated runnable work progresses.
      scheduleRetry('settlement', pool, ctx);
    }
  }
  if (ownsQueue) queue.removeById(pool, entry.batchId);
}

function sqliteCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    && typeof error.code === 'string' ? error.code : undefined;
}

function claimConstraintError(error: unknown): boolean {
  return /^SQLITE_CONSTRAINT(?:_|$)/.test(sqliteCode(error) ?? '');
}

// Disk/connection failures say nothing about the queued request. Keep it
// queued while the host recovers; only a row constraint can terminally reject
// an unclaimed batch. Uncoded failures retry without blocking other users.
function recoverableDatabaseError(error: unknown): boolean {
  return /^SQLITE_(?:BUSY|LOCKED|FULL|IOERR|READONLY|INTERRUPT|ABORT|CANTOPEN|NOMEM|PROTOCOL|SCHEMA)(?:_|$)/
    .test(sqliteCode(error) ?? '');
}

export function beginShutdownDrain(): void {
  shutdownDrain = true;
  clearRetries();
}

export function resetShutdownDrainForTests(): void {
  shutdownDrain = false;
  clearRetries();
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

function pruneRetryOwnership(pool: Pool, ctx: DequeueRuntimeContext): boolean {
  for (const lane of ['claim', 'deferredClaim', 'settlement'] as const) {
    for (const [retryPool, state] of retryLanes[lane]) {
      if (state.epoch !== ctx.queueEpoch) clearRetry(lane, retryPool);
    }
  }
  if (failedClaims.size === 0 && terminalRetries.size === 0) return true;
  let queuedIds: Set<string> | undefined;
  for (const lane of ['claim', 'deferredClaim', 'settlement'] as const) {
    const owned = lane === 'settlement' ? terminalRetries : failedClaims;
    for (const [id, pending] of owned) {
      if (pending.entry.epoch !== ctx.queueEpoch) { owned.delete(id); continue; }
      if (pending.pool !== pool) continue;
      if (lane !== 'settlement' && failedClaims.get(id)?.lane !== lane) continue;
      let row: { status: string; archived_at: number | null; started_at: number | null } | null;
      try {
        row = ctx.db.query<{ status: string; archived_at: number | null; started_at: number | null }, [string]>(
          'SELECT status, archived_at, started_at FROM batches WHERE id=?',
        ).get(id);
      } catch (error) {
        if (!reportIfCorruption(error, ctx.logger, { phase: 'dequeue_retry_inspection', batchId: id, pool })) {
          ctx.logger.error({ err: error, batchId: id, pool }, 'dequeue retry inspection failed');
        }
        if (lane === 'settlement') scheduleRetry(lane, pool, ctx);
        else {
          rememberClaimFailure(pool, pending.entry, 'claim');
          scheduleRetry('claim', pool, ctx);
        }
        return false;
      }
      if (lane !== 'settlement' && (row?.status !== 'queued' || row.archived_at !== null)) {
        const failed = failedClaims.get(id);
        forgetClaim(id, pool);
        if (row?.status === 'running' && row.started_at === failed?.attemptedAt) {
          // The failed statement committed our timestamp. Settle this claim;
          // never start it again or terminally settle another writer's stamp.
          settleOrPark(pool, ctx, pending.entry, 'internal error');
        } else queue.removeById(pool, id);
      } else if (lane !== 'settlement') {
        queuedIds ??= new Set(queue.entries(pool).map((entry) => entry.batchId));
        if (!queuedIds.has(id)) forgetClaim(id, pool);
      } else if (!row) terminalRetries.delete(id);
    }
    clearRetryIfSettled(lane, pool);
  }
  return true;
}

function deferQueuedClaims(pool: Pool, ctx: DequeueRuntimeContext): void {
  if (shutdownDrain || ctx.queueEpoch !== queue.currentEpoch()) return;
  const head = queue.peekNext(pool);
  if (!head) return;
  rememberClaimFailure(pool, head, 'claim');
  scheduleRetry('claim', pool, ctx);
}

// Admission may reject a stale/oversized head before acquiring any slots.
// Its terminal DB write can fail; a kick must never undo an accepted POST or
// turn a release microtask into an uncaught exception. Retry failed writes
// without dropping their durable queue ownership.
export function kickDequeueNext(pool: Pool, ctx: DequeueRuntimeContext): void {
  try { tryDequeueNext(pool, ctx); }
  catch (error) {
    const corruption = reportIfCorruption(error, ctx.logger, { phase: 'queue_kick', pool });
    if (!corruption) {
      ctx.logger.error({ err: error, pool }, 'queue kick failed');
    }
    if (corruption || recoverableDatabaseError(error)) deferQueuedClaims(pool, ctx);
  }
}

export function scheduleDequeueNext(pool: Pool, ctx: DequeueRuntimeContext): void {
  queueMicrotask(() => { kickDequeueNext(pool, ctx); });
}

export function tryDequeueNext(pool: Pool, ctx: DequeueRuntimeContext): void {
  if (shutdownDrain || ctx.queueEpoch !== queue.currentEpoch() || !pruneRetryOwnership(pool, ctx)) return;
  // Snapshot eligibility before any failed row rearms the settlement timer:
  // every parked row owns one attempt on this due pass.
  if (!retryLanes.settlement.get(pool)?.timer) {
    for (const pending of [...terminalRetries.values()]) {
      if (pending.pool === pool) settleOrPark(pool, ctx, pending.entry, pending.reason);
    }
  }
  if (retryLanes.claim.get(pool)?.timer) return;
  if (pool === 'local' && ctx.prepareQueued && !ctx.prepareQueued()) return;
  const failedUsers = new Set<string>();
  if (retryLanes.deferredClaim.get(pool)?.timer) {
    for (const pending of failedClaims.values()) {
      if (pending.pool === pool && pending.lane === 'deferredClaim') failedUsers.add(pending.entry.userId);
    }
  }
  for (;;) {
    const head = findNextAcquirable(pool, ctx, failedUsers);
    if (!head) return;
    // The detached starter takes over successful reservations. Until then,
    // synchronous cleanup and rejected startup share one idempotent release.
    let kickAfterRelease = true;
    const reservation = createReservationReleaser(
      head.count,
      (count) => { ctx.releaseFor(pool, head.userId, count); },
      () => { if (kickAfterRelease) scheduleDequeueNext(pool, ctx); },
    );
    const { releaseRemaining } = reservation;

    let claimed = false;
    const attemptedAt = Date.now();
    try {
      const startedAt = transitionQueuedToRunning(ctx.db, head.batchId, undefined, attemptedAt);
      claimed = startedAt !== null;
      forgetClaim(head.batchId, pool);
      if (startedAt === null) {
        releaseRemaining();
        queue.removeById(pool, head.batchId);
        continue;
      }
      const validation = revalidateAtDequeue(ctx, head);
      if (!validation.ok) {
        releaseRemaining();
        settleOrPark(pool, ctx, head, validation.reason);
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
        settleOrPark(pool, ctx, head, 'internal error');
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
      });
    } catch (err) {
      const corruption = reportIfCorruption(err, ctx.logger, { phase: 'dequeue', batchId: head.batchId, pool });
      if (!corruption) {
        ctx.logger.error({ err, batchId: head.batchId, pool }, 'dequeue failure');
      }
      if (claimed || (!corruption && claimConstraintError(err))) {
        forgetClaim(head.batchId, pool);
        if (corruption) kickAfterRelease = false;
        settleOrPark(pool, ctx, head, 'internal error');
        releaseRemaining();
        if (corruption) { deferQueuedClaims(pool, ctx); return; }
        continue;
      }
      // Unknown failures back off for this user while unrelated users proceed.
      // Operational storage failures have a separate blocking retry domain.
      kickAfterRelease = false;
      const blockClaims = corruption || recoverableDatabaseError(err);
      const lane = blockClaims ? 'claim' : 'deferredClaim';
      rememberClaimFailure(pool, head, lane, attemptedAt);
      scheduleRetry(lane, pool, ctx);
      releaseRemaining();
      if (blockClaims) return;
      failedUsers.add(head.userId);
    }
  }
}

function findNextAcquirable(pool: Pool, ctx: DequeueRuntimeContext, excludedUsers: ReadonlySet<string>): QueueEntry | undefined {
  if (shutdownDrain) return undefined;
  // Dispatched work may read stored (encrypted) artifacts: refs, I2V sources,
  // extend tails. Hold the queue until the host agent unseals storage; the
  // unseal listener in server.ts kicks every pool.
  if (isStorageSealed()) return undefined;
  if (consumePause(pool) === 'pause') return undefined;
  if (pool === 'byok') return findNextByokAcquirable(ctx, excludedUsers);
  for (;;) {
    const entry = queue.peekNext(pool, undefined, excludedUsers);
    if (entry?.epoch !== ctx.queueEpoch) return undefined;
    if (entryExceedsCurrentCaps(pool, ctx, entry)) {
      settleOrPark(pool, ctx, entry, 'internal error');
      continue;
    }
    const acquired = ctx.acquireFor(pool, entry.userId, entry.count);
    return acquired.ok ? entry : undefined;
  }
}

function findNextByokAcquirable(ctx: DequeueRuntimeContext, excludedUsers: ReadonlySet<string>): QueueEntry | undefined {
  const blockedUsers = new Set(excludedUsers);
  for (const entry of [...queue.entries('byok')]) {
    if (entry.epoch !== ctx.queueEpoch) return undefined;
    if (excludedUsers.has(entry.userId)) continue;
    if (entryExceedsCurrentCaps('byok', ctx, entry)) {
      settleOrPark('byok', ctx, entry, 'internal error');
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

import type { Database } from 'bun:sqlite';
import type { Pool } from '@atelier/shared';

interface RebuildLogger {
  warn(messageOrObject: unknown, message?: string): void;
}

export interface QueueEntryInput {
  readonly batchId: string;
  readonly userId: string;
  readonly modelId: string;
  readonly count: number;
  readonly queuedAt: number;
}

export interface QueueEntry extends QueueEntryInput {
  readonly epoch: number;
  readonly promptPreparation?: 'pending' | 'ready';
}

const changeListeners = new Set<() => void>();
let changeScheduled = false;

// Queue mutation never runs subscriber DB work inline. Coalescing also keeps
// bulk deletion/rebuild from launching one wakeup per removed tile or batch.
function changed(): void {
  if (changeScheduled) return;
  changeScheduled = true;
  queueMicrotask(() => {
    changeScheduled = false;
    for (const listener of [...changeListeners]) {
      if (changeListeners.has(listener)) listener();
    }
  });
}

export function subscribeQueueChanges(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => { changeListeners.delete(listener); };
}

export function setPromptPreparation(batchId: string, entryEpoch: number, state: 'pending' | 'ready' | undefined): boolean {
  const index = queues.local.findIndex((entry) => entry.batchId === batchId && entry.epoch === entryEpoch);
  const entry = queues.local[index];
  if (!entry) return false;
  if (entry.promptPreparation !== state) {
    const next = { ...entry };
    if (state === undefined) delete next.promptPreparation;
    else next.promptPreparation = state;
    queues.local[index] = next;
    changed();
  }
  return true;
}

export interface QueueScheduling {
  readonly affinityKeyOf: (modelId: string) => string;
  readonly maxHeadWaitMs: number;
}

const DEFAULT_QUEUE_SCHEDULING: QueueScheduling = {
  affinityKeyOf: (modelId) => modelId,
  maxHeadWaitMs: 600_000,
};

let scheduling = DEFAULT_QUEUE_SCHEDULING;
let lastLocalKey: string | undefined;
// batchId → monotonic ms when a real dispatch first jumped ahead of it.
const passedOverSince = new Map<string, number>();

export function configureQueueScheduling(next: QueueScheduling): void {
  scheduling = next;
  // `lastLocalKey` was derived through the previous `affinityKeyOf`; a
  // mapping swap orphans it.
  lastLocalKey = undefined;
  passedOverSince.clear();
}

export function noteDispatched(pool: Pool, modelId: string): void {
  if (pool === 'local') lastLocalKey = scheduling.affinityKeyOf(modelId);
}

// Dequeue-path bookkeeping, called BEFORE the picked entry is removed: records
// the dispatched key and starts the passed-over clock for every older entry the
// pick jumped ahead of, excluding pending entries and their FIFO-blocked tails
// (first skip only, later skips must not restart it).
export function noteDispatchedFromQueue(pool: Pool, picked: QueueEntry, now = performance.now()): void {
  noteDispatched(pool, picked.modelId);
  if (pool !== 'local') return;
  const blockedUsers = new Set<string>();
  for (const entry of queues.local) {
    if (entry.batchId === picked.batchId) break;
    if (entry.promptPreparation === 'pending') {
      blockedUsers.add(entry.userId);
      continue;
    }
    if (blockedUsers.has(entry.userId)) continue;
    if (!passedOverSince.has(entry.batchId)) passedOverSince.set(entry.batchId, now);
  }
}

const queues: Record<Pool, QueueEntry[]> = {
  shared: [],
  byok: [],
  local: [],
};

let epoch = 0;

export function currentEpoch(): number {
  return epoch;
}

export function enqueue(pool: Pool, entry: QueueEntryInput): void {
  queues[pool].push({ ...entry, epoch });
  changed();
}

export function entries(pool: Pool): readonly QueueEntry[] {
  return queues[pool];
}

// Starvation bound, measured as time PASSED OVER by affinity — never queue age.
// Queue age would trip the bound while the first job is still rendering (one
// video job outlasts the default bound) and on every restart (rebuilt rows keep
// their original `created_at`), disabling affinity exactly where it pays off.
// Stamps are monotonic (`performance.now()`), so wall-clock jumps neither age
// nor rejuvenate a head.
function headMustRun(head: QueueEntry, now: number): boolean {
  const since = passedOverSince.get(head.batchId);
  return since !== undefined && now - since >= scheduling.maxHeadWaitMs;
}

// Affinity chooses only among each user's oldest remaining ready entry.
// `peekNext` and `positionOf` share the projection, including its FIFO barriers.
function pickLocal(
  head: QueueEntry,
  oldestMatching: QueueEntry | undefined,
  lastKey: string | undefined,
  now: number,
): QueueEntry {
  if (lastKey === undefined || headMustRun(head, now)) return head;
  return oldestMatching ?? head;
}

// Advance one FIFO cursor per user. A pending head blocks that user's entire
// tail, while other users remain eligible for affinity and starvation handling.
// One `now` for every step projects order without predicting render duration.
function projectedLocalOrder(now: number, excludedUsers?: ReadonlySet<string>): { ready: QueueEntry[]; blocked: QueueEntry[] } {
  interface Candidate { entry: QueueEntry; index: number }
  const byUser = new Map<string, { entries: Candidate[]; cursor: number }>();
  for (const [index, entry] of queues.local.entries()) {
    if (excludedUsers?.has(entry.userId)) continue;
    let user = byUser.get(entry.userId);
    if (!user) {
      user = { entries: [], cursor: 0 };
      byUser.set(entry.userId, user);
    }
    user.entries.push({ entry, index });
  }
  const emitted = new Set<string>();
  const ready: QueueEntry[] = [];
  let key = lastLocalKey;
  for (;;) {
    let head: Candidate | undefined;
    let matching: Candidate | undefined;
    for (const user of byUser.values()) {
      const candidate = user.entries[user.cursor];
      if (!candidate || candidate.entry.promptPreparation === 'pending') continue;
      if (!head || candidate.index < head.index) head = candidate;
      if (key !== undefined && scheduling.affinityKeyOf(candidate.entry.modelId) === key
        && (!matching || candidate.index < matching.index)) matching = candidate;
    }
    if (!head) return { ready, blocked: queues.local.filter((entry) => !emitted.has(entry.batchId)) };
    const picked = pickLocal(head.entry, matching?.entry, key, now);
    ready.push(picked);
    emitted.add(picked.batchId);
    key = scheduling.affinityKeyOf(picked.modelId);
    const user = byUser.get(picked.userId);
    if (user) {
      user.cursor += 1;
      if (user.cursor === user.entries.length) byUser.delete(picked.userId);
    }
  }
}

export function peekNext(pool: Pool, now = performance.now(), excludedUsers?: ReadonlySet<string>): QueueEntry | undefined {
  if (pool !== 'local') return queues[pool].find((entry) => !excludedUsers?.has(entry.userId));
  return projectedLocalOrder(now, excludedUsers).ready[0];
}

// Test-only helpers (exposed via __queueTest): the dequeue loop uses peekNext +
// removeById (id-keyed, because revalidation can fail a head entry), never a
// positional pop or raw head/length reads.
function peekHead(pool: Pool): QueueEntry | undefined {
  return queues[pool][0];
}

function lengthOf(pool: Pool): number {
  return queues[pool].length;
}

function popHead(pool: Pool): QueueEntry | undefined {
  const entry = queues[pool].shift();
  if (entry) changed();
  return entry;
}

export function removeById(pool: Pool, batchId: string): boolean {
  const entries = queues[pool];
  const index = entries.findIndex((entry) => entry.batchId === batchId);
  if (index === -1) return false;
  entries.splice(index, 1);
  passedOverSince.delete(batchId);
  changed();
  return true;
}

export function updateCount(pool: Pool, batchId: string, count: number): boolean {
  if (count <= 0) return removeById(pool, batchId);
  const entries = queues[pool];
  const index = entries.findIndex((entry) => entry.batchId === batchId);
  if (index === -1) return false;
  const current = entries[index];
  if (!current) return false;
  entries[index] = { ...current, count };
  changed();
  return true;
}

// Position in dispatch order: the array index for shared/byok, the projected
// affinity order for local.
export function positionOf(pool: Pool, batchId: string, now = performance.now()): number {
  const projection = pool === 'local' ? projectedLocalOrder(now) : undefined;
  // Blocked tails retain acceptance order, so a ready successor never appears
  // ahead of its own pending predecessor.
  const ordered = projection ? [...projection.ready, ...projection.blocked] : queues[pool];
  return ordered.findIndex((entry) => entry.batchId === batchId);
}

const VALID_POOLS: ReadonlySet<string> = new Set(['shared', 'byok', 'local']);

function validateRebuildRow(row: {
  id: string;
  user_id: string;
  model_id: string;
  pool: Pool;
  created_at: number;
  count: number;
}): QueueEntryInput {
  if (typeof row.id !== 'string' || row.id.length === 0) throw new Error('invalid batch id');
  if (typeof row.user_id !== 'string' || row.user_id.length === 0) throw new Error('invalid user id');
  if (typeof row.model_id !== 'string' || row.model_id.length === 0) throw new Error('invalid model id');
  if (!VALID_POOLS.has(row.pool)) throw new Error(`invalid pool ${row.pool}`);
  if (!Number.isFinite(row.created_at)) throw new Error('invalid created_at');
  if (!Number.isInteger(row.count) || row.count <= 0) throw new Error('invalid loading count');
  return {
    batchId: row.id,
    userId: row.user_id,
    modelId: row.model_id,
    count: row.count,
    queuedAt: row.created_at,
  };
}

export function rebuildFromDb(
  db: Database,
  logger?: RebuildLogger,
  slotsFor: (modelId: string, loadingTiles: number) => number = (_modelId, loadingTiles) => loadingTiles,
): void {
  resetQueueForTests();
  const rows = db
    .query<
      { id: string; user_id: string; model_id: string; pool: Pool; created_at: number; count: number },
      []
    >(
      `SELECT id, user_id, model_id, pool, created_at,
              (SELECT COUNT(*) FROM tiles WHERE batch_id = batches.id AND status='loading') AS count
         FROM batches
        WHERE status='queued'
          AND archived_at IS NULL
          AND EXISTS (
            SELECT 1 FROM tiles
             WHERE batch_id = batches.id
               AND user_id = batches.user_id
               AND status='loading'
          )
        ORDER BY created_at, id`,
    )
    .all();

  for (const row of rows) {
    try {
      const entry = validateRebuildRow(row);
      enqueue(row.pool, { ...entry, count: slotsFor(entry.modelId, entry.count) });
    } catch (error) {
      logger?.warn(
        { err: error, event: 'queue_rebuild_row_skipped', batchId: row.id },
        'skipped malformed queued batch during queue rebuild',
      );
    }
  }
}

export function resetQueueForTests(): void {
  epoch += 1;
  lastLocalKey = undefined;
  passedOverSince.clear();
  queues.shared.length = 0;
  queues.byok.length = 0;
  queues.local.length = 0;
  changed();
}

// Test-only handle for the vestigial positional popHead (production dequeues
// id-keyed via peekNext + removeById).
export const __queueTest = { peekHead, lengthOf, popHead };

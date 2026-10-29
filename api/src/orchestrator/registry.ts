// In-memory registry of in-flight generation streams keyed by batchId.
// Lets DELETE /history/* routes find the per-batch and per-tile
// AbortControllers and signal cancellation before deleting DB rows.
// Entries carry userId so the route-side lookup is owner-scoped: a user who
// guesses another user's batchId cannot trigger a registry abort and stop
// another user's upstream API call.
//
// Resets at boot. v1 ships single-process Bun, so this is authoritative.

export interface BatchEntry {
  readonly userId: string;
  readonly batchController: AbortController;
  readonly tileControllers: Map<string, AbortController>;
  // The batch's top-level settle promise (Promise.allSettled of every
  // runTile, then the done-event + cleanup chain). Initialized to a
  // resolved placeholder at registerBatch time so callers (incl.
  // snapshotBatchDonePromises) can always await it without an undefined
  // check; runBatchPipeline overwrites the placeholder with the real
  // pending promise via setBatchDonePromise. The synchronous-window
  // register-then-runBatchPipeline-start transition is unchanged from the
  // earlier `Promise<unknown> | undefined` shape — the placeholder just
  // removes the per-reader `if (donePromise)` guard. SIGTERM drain awaits
  // these so the per-tile terminal SQLite writes (emitFailed/emitCanceled/
  // the done UPDATE) finish before db.close().
  donePromise: Promise<unknown>;
}

const registry = new Map<string, BatchEntry>();

function createEntry(userId: string, controller: AbortController): BatchEntry {
  return {
    userId,
    batchController: controller,
    tileControllers: new Map(),
    donePromise: Promise.resolve(),
  };
}

function seedTileControllers(entry: BatchEntry, tileIds: string[]): void {
  for (const tileId of tileIds) {
    if (!entry.tileControllers.has(tileId)) {
      entry.tileControllers.set(tileId, new AbortController());
    }
  }
}

export function preRegisterBatch(batchId: string, userId: string, tileIds: string[] = []): BatchEntry {
  const existing = registry.get(batchId);
  if (existing) {
    if (existing.userId !== userId) throw new Error(`batch ${batchId} already registered for another user`);
    seedTileControllers(existing, tileIds);
    return existing;
  }
  const entry = createEntry(userId, new AbortController());
  seedTileControllers(entry, tileIds);
  registry.set(batchId, entry);
  return entry;
}

export function registerBatch(batchId: string, userId: string, controller: AbortController): BatchEntry {
  const existing = registry.get(batchId);
  if (existing) {
    if (existing.userId !== userId) throw new Error(`batch ${batchId} already registered for another user`);
    return existing;
  }
  const entry = createEntry(userId, controller);
  registry.set(batchId, entry);
  return entry;
}

// Test-only (exposed via __registryTest): superseded in production by
// getOrCreateTileController, whose single-lookup create+register closed the
// detached-controller mint race the old `get() ?? new AbortController()` +
// separate registerTile pattern caused. Kept solely as a test-setup primitive.
function registerTile(batchId: string, tileId: string, controller: AbortController): void {
  const entry = registry.get(batchId);
  if (!entry) return;
  entry.tileControllers.set(tileId, controller);
}

export function getBatchForUser(batchId: string, userId: string): BatchEntry | undefined {
  const entry = registry.get(batchId);
  return entry?.userId === userId ? entry : undefined;
}

// Return the canonical per-tile controller, creating + registering it under a
// single synchronous entry lookup when the tile was not pre-seeded. runTile and
// a concurrent DELETE then always converge on the SAME AbortController: the
// prior `get(...) ?? new AbortController()` + separate registerTile minted a
// detached controller runTile immediately overwrote, so a DELETE landing in
// that window aborted a stale instance. Returns a detached, unregistered
// controller only when the batch entry is gone (already settled) — nothing
// to cancel then.
export function getOrCreateTileController(batchId: string, userId: string, tileId: string): AbortController {
  const entry = getBatchForUser(batchId, userId);
  if (!entry) return new AbortController();
  const existing = entry.tileControllers.get(tileId);
  if (existing) return existing;
  const created = new AbortController();
  entry.tileControllers.set(tileId, created);
  return created;
}

export function unregisterTile(batchId: string, tileId: string): void {
  registry.get(batchId)?.tileControllers.delete(tileId);
}

export function unregisterBatch(batchId: string): void {
  registry.delete(batchId);
}

// Snapshot every in-flight batch's controller so the boot path can abort
// everything at SIGTERM. Returns a fresh array — mutating the registry while
// iterating its live Map would be unsafe.
export function snapshotBatchControllers(): AbortController[] {
  return Array.from(registry.values(), (entry) => entry.batchController);
}

// Attach the batch's top-level settle promise so SIGTERM drain can await it.
// No-ops if the batch already unregistered (it settled — nothing to drain).
export function setBatchDonePromise(batchId: string, donePromise: Promise<unknown>): void {
  const entry = registry.get(batchId);
  if (entry) entry.donePromise = donePromise;
}

// Snapshot the settle promises of every still-registered batch so the boot
// path can wait for orchestrator workers to finish their terminal SQLite
// writes before closing the DB. Already-settled batches have unregistered
// themselves and need no draining, so excluding them is correct.
export function snapshotBatchDonePromises(): Promise<unknown>[] {
  return Array.from(registry.values(), (entry) => entry.donePromise);
}

export function resetRegistryForTests(): void {
  registry.clear();
}

// Test-only handle for the vestigial registerTile primitive (production uses
// getOrCreateTileController). Mirrors __orchestratorTest — keeps it reachable
// from tests without an importable production surface.
export const __registryTest = { registerTile };

import type { TemplateConflict } from '@atelier/shared';
import type { RawBundle, StoredProposal } from './inferTypes';

// In-memory, single Bun process (spec §5.1 / §10): proposals are short-lived
// and lost on redeploy -- acceptable, the user re-runs AI. This is the trust
// boundary -- clients never carry resolved writes.
const store = new Map<string, StoredProposal>();
let nowFn: () => number = () => Date.now();

type StoredProposalInput =
  Omit<StoredProposal, 'version' | 'conflicts' | 'rescueAttempted' | 'baseTemplateHash' | 'inFlightRescues'> &
  Partial<Pick<StoredProposal, 'version' | 'conflicts' | 'rescueAttempted' | 'baseTemplateHash' | 'inFlightRescues'>>;

export function _setNowForTests(fn: (() => number) | null): void {
  nowFn = fn ?? (() => Date.now());
}

export const PROPOSAL_TTL_MS = 10 * 60 * 1000;
// Per-user cap (mirrors api/src/orchestrator/concurrency.ts inFlightByUser
// precedent). Eviction is SCOPED to the inserting user — an allowlisted
// co-tenant cannot evict another user's pending proposal. The global
// safety cap is intentionally a soft ceiling: MAX_PROPOSALS_PER_USER * #users.
export const MAX_PROPOSALS_PER_USER = 4;

// Background sweeper. Without this, expired proposals only get pruned when a
// subsequent /infer or /apply touches the store — a user who runs one
// /infer and walks away would leave that proposal in memory for the lifetime
// of the process. Bun's `setInterval` returns a `Timer` whose `unref()`
// detaches it from the process-keepalive set so a node-style "no work left"
// shutdown isn't held open by the sweeper. 60s cadence matches the audit's
// finding (04-data.md § proposalStore pruneExpired).
const SWEEPER_INTERVAL_MS = 60_000;
const sweeper = setInterval(() => {
  pruneExpired();
}, SWEEPER_INTERVAL_MS);
sweeper.unref();

export function _clearProposalStoreForTests(): void {
  store.clear();
}

export function _proposalCountForTests(): number {
  return store.size;
}

function pruneExpired(now = nowFn()): void {
  for (const [id, proposal] of store) {
    if (proposal.expiresAt !== 0 && proposal.expiresAt < now) {
      store.delete(id);
    }
  }
}

function enforceUserCap(userId: string): void {
  // Map preserves insertion order — oldest-first iteration. Evict only this
  // user's oldest entries until they're at the cap.
  let userCount = 0;
  for (const proposal of store.values()) {
    if (proposal.userId === userId) userCount++;
  }
  if (userCount <= MAX_PROPOSALS_PER_USER) return;
  for (const [id, proposal] of store) {
    if (userCount <= MAX_PROPOSALS_PER_USER) break;
    if (proposal.userId !== userId) continue;
    if (proposal.inFlightRescues > 0) continue;
    store.delete(id);
    userCount--;
  }
  for (const [id, proposal] of store) {
    if (userCount <= MAX_PROPOSALS_PER_USER) break;
    if (proposal.userId !== userId) continue;
    store.delete(id);
    userCount--;
  }
}

export function putProposal(p: StoredProposalInput): string {
  pruneExpired();
  const id = crypto.randomUUID();
  // Defensive: existing callers may not yet pass the new fields. Immutable
  // spread + defaults narrows StoredProposalInput → StoredProposal without
  // mutating the caller's input or casting.
  const stored: StoredProposal = {
    ...p,
    rescueAttempted: p.rescueAttempted ?? new Set(),
    version: typeof p.version === 'number' ? p.version : 0,
    conflicts: p.conflicts ?? [],
    baseTemplateHash: typeof p.baseTemplateHash === 'string' ? p.baseTemplateHash : '',
    inFlightRescues: typeof p.inFlightRescues === 'number' ? p.inFlightRescues : 0,
  };
  store.set(id, stored);
  enforceUserCap(stored.userId);
  return id;
}

export function takeProposalForUser(id: string, userId: string): StoredProposal | null {
  // Reap stragglers on read too: putProposal is otherwise the only pruning
  // trigger, so a proposal whose owner never writes again would sit in the
  // map past its TTL forever.
  pruneExpired();
  const p = store.get(id);
  if (p?.userId !== userId) return null;
  if (p.expiresAt !== 0 && p.expiresAt < nowFn()) {
    store.delete(id);
    return null;
  }
  return p;
}

export function deleteProposal(id: string): void {
  store.delete(id);
}

export type BeginRescueResult =
  | { ok: true; proposal: StoredProposal; version: number }
  | { ok: false; reason: 'not-found' | 'expired' | 'unauthorized' | 'already-attempted' };

export function beginRescueAttempt(id: string, userId: string, templateName: string): BeginRescueResult {
  pruneExpired();
  const p = store.get(id);
  if (!p) return { ok: false, reason: 'not-found' };
  if (p.userId !== userId) return { ok: false, reason: 'unauthorized' };
  if (p.expiresAt !== 0 && p.expiresAt < nowFn()) {
    store.delete(id);
    return { ok: false, reason: 'expired' };
  }
  if (p.rescueAttempted.has(templateName)) return { ok: false, reason: 'already-attempted' };
  p.rescueAttempted.add(templateName);
  p.inFlightRescues += 1;
  p.version += 1;
  return { ok: true, proposal: p, version: p.version };
}

export function releaseRescueInFlight(id: string, expectedVersion: number): void {
  const p = store.get(id);
  if (p?.version !== expectedVersion) return;
  p.inFlightRescues = Math.max(0, p.inFlightRescues - 1);
}

export type CommitRescueResult =
  | { ok: true }
  | { ok: false; reason: 'not-found' | 'version-changed' };

export function commitRescueBundle(
  id: string,
  expectedVersion: number,
  bundle: RawBundle,
  updatedConflicts: readonly TemplateConflict[],
): CommitRescueResult {
  const p = store.get(id);
  if (!p) return { ok: false, reason: 'not-found' };
  if (p.version !== expectedVersion) {
    p.inFlightRescues = Math.max(0, p.inFlightRescues - 1);
    return { ok: false, reason: 'version-changed' };
  }
  p.rawBundles.push(bundle);
  p.conflicts = [...updatedConflicts];
  p.inFlightRescues = Math.max(0, p.inFlightRescues - 1);
  p.version += 1;
  return { ok: true };
}

// Sibling of commitRescueBundle for rescue-failed SSE paths. The cap is
// already consumed (beginRescueAttempt set rescueAttempted), but the
// stored conflicts list still carries the pre-attempt `rescueAttempted: false`
// — so the SSE rescue-failed payload would advertise stale state. Persist
// the flipped conflicts on the stored proposal so a subsequent /apply
// reflects "rescue tried + failed" for the template.
export function commitRescueFailed(
  id: string,
  expectedVersion: number,
  updatedConflicts: readonly TemplateConflict[],
): CommitRescueResult {
  const p = store.get(id);
  if (!p) return { ok: false, reason: 'not-found' };
  if (p.version !== expectedVersion) {
    p.inFlightRescues = Math.max(0, p.inFlightRescues - 1);
    return { ok: false, reason: 'version-changed' };
  }
  p.conflicts = [...updatedConflicts];
  p.inFlightRescues = Math.max(0, p.inFlightRescues - 1);
  p.version += 1;
  return { ok: true };
}

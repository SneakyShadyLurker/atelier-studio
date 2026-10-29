import { test, expect, afterEach } from 'bun:test';
import {
  putProposal,
  beginRescueAttempt,
  commitRescueBundle,
  commitRescueFailed,
  takeProposalForUser,
  deleteProposal,
  _clearProposalStoreForTests,
} from './proposalStore';
import type { TemplateConflict } from '@atelier/shared';

afterEach(() => { _clearProposalStoreForTests(); });

test('beginRescueAttempt marks template and bumps version atomically', () => {
  const id = putProposal({
    userId: 'u1', rawBundles: [], baseSnapshotHash: 'h', expiresAt: Date.now() + 60_000,
    version: 0, conflicts: [], rescueAttempted: new Set(),
  });
  const r1 = beginRescueAttempt(id, 'u1', 'tmplA');
  expect(r1.ok).toBe(true);
  if (!r1.ok) throw new Error();
  expect(r1.version).toBe(1);
});

test('beginRescueAttempt returns already-attempted on second call for same template', () => {
  const id = putProposal({
    userId: 'u1', rawBundles: [], baseSnapshotHash: 'h', expiresAt: Date.now() + 60_000,
    version: 0, conflicts: [], rescueAttempted: new Set(),
  });
  beginRescueAttempt(id, 'u1', 'tmplA');
  const r2 = beginRescueAttempt(id, 'u1', 'tmplA');
  expect(r2.ok).toBe(false);
  if (r2.ok) throw new Error();
  expect(r2.reason).toBe('already-attempted');
});

test('commitRescueBundle fails on version mismatch', () => {
  const id = putProposal({
    userId: 'u1', rawBundles: [], baseSnapshotHash: 'h', expiresAt: Date.now() + 60_000,
    version: 0, conflicts: [], rescueAttempted: new Set(),
  });
  const r1 = beginRescueAttempt(id, 'u1', 'tmplA');
  if (!r1.ok) throw new Error();
  // Simulate apply happening -- deletes the proposal
  deleteProposal(id);
  const commit = commitRescueBundle(id, r1.version, { key: 'rescue:tmplA', ops: [], dependsOn: [] }, []);
  expect(commit.ok).toBe(false);
  if (commit.ok) throw new Error();
  expect(commit.reason).toBe('not-found');
});

test('commitRescueBundle appends bundle and bumps version', () => {
  const id = putProposal({
    userId: 'u1', rawBundles: [], baseSnapshotHash: 'h', expiresAt: Date.now() + 60_000,
    version: 0, conflicts: [], rescueAttempted: new Set(),
  });
  const r1 = beginRescueAttempt(id, 'u1', 'tmplA');
  if (!r1.ok) throw new Error();
  const commit = commitRescueBundle(
    id, r1.version,
    { key: 'rescue:tmplA', ops: [], dependsOn: [] },
    [],
  );
  expect(commit.ok).toBe(true);
  const proposal = takeProposalForUser(id, 'u1');
  expect(proposal?.rawBundles).toHaveLength(1);
  expect(proposal?.version).toBe(2);
});

test('commitRescueFailed persists flipped conflicts without appending a bundle', () => {
  // Fix 3: rescue-failed paths must persist the spent-cap state so a
  // follow-up /apply sees rescueAttempted:true on the matching conflict.
  const initialConflicts: TemplateConflict[] = [
    { templateName: 'tmplA', reason: 'unsat', culpritBundleKeys: ['b1'], rescueAttempted: false, culpritKind: 'local' },
    { templateName: 'tmplB', reason: 'unsat', culpritBundleKeys: ['b2'], rescueAttempted: false, culpritKind: 'local' },
  ];
  const id = putProposal({
    userId: 'u1', rawBundles: [], baseSnapshotHash: 'h', expiresAt: Date.now() + 60_000,
    version: 0, conflicts: initialConflicts, rescueAttempted: new Set(),
  });
  const r1 = beginRescueAttempt(id, 'u1', 'tmplA');
  if (!r1.ok) throw new Error();
  const updatedConflicts: TemplateConflict[] = initialConflicts.map((c) =>
    c.templateName === 'tmplA' ? { ...c, rescueAttempted: true } : c,
  );
  const commit = commitRescueFailed(id, r1.version, updatedConflicts);
  expect(commit.ok).toBe(true);
  const proposal = takeProposalForUser(id, 'u1');
  // No bundle appended on failure.
  expect(proposal?.rawBundles).toHaveLength(0);
  // Version bumped (1 by begin + 1 by failed commit).
  expect(proposal?.version).toBe(2);
  // Conflicts persisted with the flipped flag.
  expect(proposal?.conflicts.find((c) => c.templateName === 'tmplA')?.rescueAttempted).toBe(true);
  expect(proposal?.conflicts.find((c) => c.templateName === 'tmplB')?.rescueAttempted).toBe(false);
});

test('commitRescueFailed fails on version mismatch', () => {
  const id = putProposal({
    userId: 'u1', rawBundles: [], baseSnapshotHash: 'h', expiresAt: Date.now() + 60_000,
    version: 0, conflicts: [], rescueAttempted: new Set(),
  });
  const r1 = beginRescueAttempt(id, 'u1', 'tmplA');
  if (!r1.ok) throw new Error();
  // Simulate apply happening — deletes the proposal.
  deleteProposal(id);
  const commit = commitRescueFailed(id, r1.version, []);
  expect(commit.ok).toBe(false);
  if (commit.ok) throw new Error();
  expect(commit.reason).toBe('not-found');
});

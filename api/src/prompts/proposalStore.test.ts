import { afterEach, describe, expect, test } from 'bun:test';
import {
  beginRescueAttempt,
  commitRescueBundle,
  putProposal,
  releaseRescueInFlight,
  takeProposalForUser,
  _clearProposalStoreForTests,
  _proposalCountForTests,
  _setNowForTests,
} from './proposalStore';

describe('proposalStore', () => {
  afterEach(() => {
    _setNowForTests(null);
    _clearProposalStoreForTests();
  });

  test('put returns id; get scoped to same user', () => {
    const id = putProposal({ userId: 'alice', rawBundles: [], baseSnapshotHash: 'h', expiresAt: 0 });
    expect(takeProposalForUser(id, 'alice')?.baseSnapshotHash).toBe('h');
  });

  test('foreign user cannot read another user proposal', () => {
    const id = putProposal({ userId: 'alice', rawBundles: [], baseSnapshotHash: 'h', expiresAt: 0 });
    expect(takeProposalForUser(id, 'mallory')).toBeNull();
  });

  test('expired proposal is not returned', () => {
    _setNowForTests(() => 1000);
    const id = putProposal({ userId: 'u', rawBundles: [], baseSnapshotHash: 'h', expiresAt: 500 });
    expect(takeProposalForUser(id, 'u')).toBeNull();
  });

  test('abandoned expired proposals are pruned on insert', () => {
    _setNowForTests(() => 1000);
    putProposal({ userId: 'u', rawBundles: [], baseSnapshotHash: 'old', expiresAt: 900 });
    expect(_proposalCountForTests()).toBe(1);
    _setNowForTests(() => 1100);
    putProposal({ userId: 'u', rawBundles: [], baseSnapshotHash: 'new', expiresAt: 2000 });
    expect(_proposalCountForTests()).toBe(1);
  });

  test('per-user cap evicts ONLY this user\'s oldest, never another user\'s proposal', async () => {
    const { MAX_PROPOSALS_PER_USER } = await import('./proposalStore');
    // Victim user has a valid pending proposal.
    const victimId = putProposal({ userId: 'victim', rawBundles: [], baseSnapshotHash: 'v', expiresAt: 0 });

    // Attacker fills past the per-user cap.
    const attackerIds: string[] = [];
    for (let i = 0; i < MAX_PROPOSALS_PER_USER + 2; i++) {
      attackerIds.push(putProposal({ userId: 'attacker', rawBundles: [], baseSnapshotHash: `a${i}`, expiresAt: 0 }));
    }

    // Victim's proposal must still be readable — attacker churn does NOT
    // touch other users' state (cross-user FIFO eviction is gone).
    expect(takeProposalForUser(victimId, 'victim')?.baseSnapshotHash).toBe('v');

    // Attacker's oldest were evicted; only the last MAX_PROPOSALS_PER_USER remain.
    const attackerStillAlive = attackerIds.filter((id) => takeProposalForUser(id, 'attacker') !== null);
    expect(attackerStillAlive.length).toBe(MAX_PROPOSALS_PER_USER);
  });

  test('per-user cap skips oldest proposal while its rescue attempt is in flight', async () => {
    const { MAX_PROPOSALS_PER_USER } = await import('./proposalStore');
    const ids: string[] = [];
    for (let i = 0; i < MAX_PROPOSALS_PER_USER; i++) {
      ids.push(putProposal({ userId: 'u', rawBundles: [], baseSnapshotHash: `h${i}`, expiresAt: 0 }));
    }
    const rescue = beginRescueAttempt(ids[0] ?? '', 'u', 'template-a');
    expect(rescue.ok).toBe(true);

    const newest = putProposal({ userId: 'u', rawBundles: [], baseSnapshotHash: 'new', expiresAt: 0 });

    expect(takeProposalForUser(ids[0] ?? '', 'u')?.baseSnapshotHash).toBe('h0');
    expect(takeProposalForUser(ids[1] ?? '', 'u')).toBeNull();
    expect(takeProposalForUser(newest, 'u')?.baseSnapshotHash).toBe('new');
  });

  test('completed rescue attempts are eligible for cap eviction again', async () => {
    const { MAX_PROPOSALS_PER_USER } = await import('./proposalStore');
    const ids: string[] = [];
    for (let i = 0; i < MAX_PROPOSALS_PER_USER; i++) {
      ids.push(putProposal({ userId: 'u', rawBundles: [], baseSnapshotHash: `h${i}`, expiresAt: 0 }));
    }
    const rescue = beginRescueAttempt(ids[0] ?? '', 'u', 'template-a');
    if (!rescue.ok) throw new Error('expected rescue start');
    expect(commitRescueBundle(ids[0] ?? '', rescue.version, {
      key: 'rescue:k',
      dependsOn: [],
      ops: [{ op: 'addOption', listIdx: 0, value: 'value', tags: [{ dimName: 'template', label: 'template-a' }] }],
    }, [])).toEqual({ ok: true });

    putProposal({ userId: 'u', rawBundles: [], baseSnapshotHash: 'new', expiresAt: 0 });

    expect(takeProposalForUser(ids[0] ?? '', 'u')).toBeNull();
  });

  test('released pre-stream rescue attempts are eligible for cap eviction again', async () => {
    const { MAX_PROPOSALS_PER_USER } = await import('./proposalStore');
    const ids: string[] = [];
    for (let i = 0; i < MAX_PROPOSALS_PER_USER; i++) {
      ids.push(putProposal({ userId: 'u', rawBundles: [], baseSnapshotHash: `h${i}`, expiresAt: 0 }));
    }
    const rescue = beginRescueAttempt(ids[0] ?? '', 'u', 'template-a');
    if (!rescue.ok) throw new Error('expected rescue start');
    releaseRescueInFlight(ids[0] ?? '', rescue.version);

    putProposal({ userId: 'u', rawBundles: [], baseSnapshotHash: 'new', expiresAt: 0 });

    expect(takeProposalForUser(ids[0] ?? '', 'u')).toBeNull();
  });
});

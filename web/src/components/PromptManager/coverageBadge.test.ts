import { describe, expect, test } from 'bun:test';
import type { LibraryCoverageResponse } from '@atelier/shared';
import { coverageBadgeState } from './coverageBadge';

const base: LibraryCoverageResponse = {
  untaggedByList: [],
  lowCoverageLists: [],
  orphanTags: [],
  missingDimensions: [],
  librarySnapshotHash: 'h',
  templatesDigest: 'd',
};

describe('coverageBadgeState', () => {
  test('healthy when there are no untagged options', () => {
    expect(coverageBadgeState(base)).toEqual({ tone: 'healthy', untaggedCount: 0 });
  });

  test('pending count sums untagged across all list groups', () => {
    const r: LibraryCoverageResponse = {
      ...base,
      untaggedByList: [
        { listId: 'l1', listName: 'a', dim: 'Genre', untaggedCount: 3 },
        { listId: 'l2', listName: 'b', dim: 'Genre', untaggedCount: 2 },
      ],
    };
    expect(coverageBadgeState(r)).toEqual({ tone: 'pending', untaggedCount: 5 });
  });

  test('cleanup-only (orphan/missing, zero untagged) stays healthy tone', () => {
    const r: LibraryCoverageResponse = {
      ...base,
      orphanTags: [{ dim: 'Genre', label: 'X' }],
      missingDimensions: [{ listName: 'a', dim: 'Genre' }],
    };
    expect(coverageBadgeState(r)).toEqual({ tone: 'healthy', untaggedCount: 0 });
  });
});

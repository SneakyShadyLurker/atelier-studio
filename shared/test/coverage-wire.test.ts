import { expect, test } from 'bun:test';
import type { LibraryCoverageResponse, _NoUserIdInWire } from '../src/index';

test('LibraryCoverageResponse shape is constructible and assignable', () => {
  const r: LibraryCoverageResponse = {
    untaggedByList: [
      { listId: 'l1', listName: 'fantasy_role', dim: 'Genre', untaggedCount: 3 },
    ],
    lowCoverageLists: [
      { listName: 'camera', dim: 'Era', coverage: 0.5, taggedCount: 1, totalCount: 2 },
    ],
    orphanTags: [{ dim: 'Genre', label: 'Steampunk' }],
    missingDimensions: [{ listName: 'fantasy_role', dim: 'Genre' }],
    librarySnapshotHash: 'abc',
    templatesDigest: 'def',
  };
  expect(r.untaggedByList[0]?.listId).toBe('l1');
  expect(r.lowCoverageLists[0]?.coverage).toBe(0.5);
  // Compile-time backstop: the trap tuple must include the new entry.
  const _trap: _NoUserIdInWire = [] as unknown as _NoUserIdInWire;
  expect(Array.isArray(_trap)).toBe(true);
});

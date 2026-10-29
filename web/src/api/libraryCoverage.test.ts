import { describe, expect, test } from 'bun:test';
import { isLibraryCoverageResponse, libraryCoverageKeys, libraryCoverageOpts } from './libraryCoverage';

describe('libraryCoverage type guards + factories', () => {
  test('accepts a valid response', () => {
    expect(isLibraryCoverageResponse({
      untaggedByList: [{ listId: 'l1', listName: 'fantasy_role', dim: 'Genre', untaggedCount: 2 }],
      lowCoverageLists: [],
      orphanTags: [],
      missingDimensions: [],
      librarySnapshotHash: 'h',
      templatesDigest: 'd',
    })).toBe(true);
  });

  test('rejects a missing array section', () => {
    expect(isLibraryCoverageResponse({
      untaggedByList: [],
      lowCoverageLists: [],
      orphanTags: [],
      librarySnapshotHash: 'h',
      templatesDigest: 'd',
    })).toBe(false);
  });

  test('rejects a bad untagged group', () => {
    expect(isLibraryCoverageResponse({
      untaggedByList: [{ listName: 'x', dim: 'Genre', untaggedCount: 'two' }],
      lowCoverageLists: [],
      orphanTags: [],
      missingDimensions: [],
      librarySnapshotHash: 'h',
      templatesDigest: 'd',
    })).toBe(false);
  });

  test('key factory + opts are stable', () => {
    expect(libraryCoverageKeys.current()).toEqual(['libraryCoverage', 'current']);
    expect(libraryCoverageOpts().staleTime).toBe(30_000);
    expect(libraryCoverageOpts(false).enabled).toBe(false);
  });
});

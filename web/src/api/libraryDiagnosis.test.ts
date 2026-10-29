import { describe, expect, test } from 'bun:test';
import type { LibraryDiagnosisResponse } from '@atelier/shared';
import {
  isConflictingPair,
  isLibraryDiagnosisEntry,
  isLibraryDiagnosisResponse,
  libraryDiagnosisKeys,
} from './libraryDiagnosis';

describe('libraryDiagnosis client', () => {
  test('libraryDiagnosisKeys factory yields stable, hierarchical keys', () => {
    expect(libraryDiagnosisKeys.all()).toEqual(['libraryDiagnosis']);
    expect(libraryDiagnosisKeys.current()).toEqual(['libraryDiagnosis', 'current']);
  });

  test('isConflictingPair accepts valid shapes and rejects invalid ones', () => {
    expect(isConflictingPair({ listA: 'a', listB: 'b', dimensionName: 'D' })).toBe(true);
    expect(isConflictingPair({ listA: 'a', listB: 'b' })).toBe(false);
    expect(isConflictingPair(null)).toBe(false);
    expect(isConflictingPair({ listA: 1, listB: 'b', dimensionName: 'D' })).toBe(false);
  });

  test('isLibraryDiagnosisEntry accepts valid shapes', () => {
    expect(isLibraryDiagnosisEntry({ templateName: 'X', satisfiable: true })).toBe(true);
    expect(isLibraryDiagnosisEntry({
      templateName: 'X', satisfiable: false, reason: 'r',
      conflictingPairs: [{ listA: 'a', listB: 'b', dimensionName: 'D' }],
    })).toBe(true);
  });

  test('isLibraryDiagnosisEntry rejects invalid shapes', () => {
    expect(isLibraryDiagnosisEntry({ templateName: 'X' })).toBe(false);
    expect(isLibraryDiagnosisEntry({ templateName: 'X', satisfiable: 'no' })).toBe(false);
    expect(isLibraryDiagnosisEntry({ templateName: 'X', satisfiable: true, reason: 7 })).toBe(false);
    expect(isLibraryDiagnosisEntry({ templateName: 'X', satisfiable: true, conflictingPairs: [{ bad: 1 }] })).toBe(false);
  });

  test('isLibraryDiagnosisResponse accepts a valid shape', () => {
    const valid: LibraryDiagnosisResponse = {
      templates: [{ templateName: 'X', satisfiable: true }],
      librarySnapshotHash: 'abc',
      templatesDigest: 'def',
    };
    expect(isLibraryDiagnosisResponse(valid)).toBe(true);
  });

  test('isLibraryDiagnosisResponse rejects invalid shapes', () => {
    expect(isLibraryDiagnosisResponse(null)).toBe(false);
    expect(isLibraryDiagnosisResponse({})).toBe(false);
    expect(isLibraryDiagnosisResponse({ templates: 'oops' })).toBe(false);
    expect(isLibraryDiagnosisResponse({ templates: [], librarySnapshotHash: 1, templatesDigest: 'x' })).toBe(false);
  });
});

import { describe, expect, spyOn, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { DIAGNOSIS_VERSION, DIAGNOSIS_VERSION_HEADER } from '@atelier/shared';
import type { LibraryDiagnosisResponse } from '@atelier/shared';
import {
  isConflictingPair,
  isLibraryDiagnosisEntry,
  isLibraryDiagnosisResponse,
  libraryDiagnosisKeys,
  libraryDiagnosisOpts,
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
    expect(isLibraryDiagnosisEntry({ templateName: 'X', satisfiable: null, reason: 'diagnosis budget exceeded' })).toBe(true);
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
    expect(isLibraryDiagnosisResponse({ ...valid, incompleteTemplateNames: ['Unknown'] })).toBe(true);
  });

  test('isLibraryDiagnosisResponse rejects invalid shapes', () => {
    expect(isLibraryDiagnosisResponse(null)).toBe(false);
    expect(isLibraryDiagnosisResponse({})).toBe(false);
    expect(isLibraryDiagnosisResponse({ templates: 'oops' })).toBe(false);
    expect(isLibraryDiagnosisResponse({ templates: [], librarySnapshotHash: 1, templatesDigest: 'x' })).toBe(false);
    expect(isLibraryDiagnosisResponse({ templates: [], librarySnapshotHash: 'x', templatesDigest: 'x', incompleteTemplateNames: [1] })).toBe(false);
  });

  for (const satisfiable of [true, null]) {
    test(`requests representation2 and accepts ${satisfiable === null ? 'modern unknown' : 'old API boolean'} payloads`, async () => {
      const payload = { templates: [{ templateName: 'T', satisfiable }], librarySnapshotHash: 'h', templatesDigest: 'd' };
      const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign((...args: Parameters<typeof globalThis.fetch>) => {
        const headers = new Headers(args[1]?.headers);
        expect(headers.get(DIAGNOSIS_VERSION_HEADER)).toBe(DIAGNOSIS_VERSION);
        expect(headers.get('Accept')).toBe('application/json');
        return Promise.resolve(Response.json(payload));
      }, { preconnect: globalThis.fetch.preconnect }));
      const client = new QueryClient();
      try {
        const options = libraryDiagnosisOpts();
        if (typeof options.queryFn !== 'function') throw new Error('missing diagnosis query');
        expect(await options.queryFn({ client, queryKey: options.queryKey, signal: new AbortController().signal, meta: undefined })).toEqual(payload);
      } finally { fetch.mockRestore(); client.clear(); }
    });
  }
});

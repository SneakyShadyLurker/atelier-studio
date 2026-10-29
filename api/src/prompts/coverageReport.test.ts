import { describe, expect, test } from 'bun:test';
import type { PromptLibraryResponse } from '@atelier/shared';
import { coverageReport, coverageWarnings, orphanTagsAtRest } from './coverageReport';
import type { LibrarySnapshot, RawBundle } from './inferTypes';
import { toLibrarySnapshot } from './librarySnapshot';

// Preview-snapshot helper: every option carries a globally-unique tagIdx
// scheme that matches what applyBundlesToSnapshot would produce on a real
// proposal — coverageWarnings reads tagIdxs directly off the preview snap.
const previewSnap = (override: Partial<LibrarySnapshot> = {}): LibrarySnapshot => ({
  dimensions: [
    {
      idx: 0,
      id: 'D_franchise',
      name: 'Franchise',
      tags: [
        { idx: 0, id: 'T_sw', label: 'Star Wars' },
        { idx: 1, id: 'T_dune', label: 'Dune' },
        { idx: 2, id: 'T_cthulhu', label: 'Cthulhu Mythos' }, // ORPHAN: no option uses it
      ],
    },
    {
      idx: 1,
      id: 'D_genre',
      name: 'Genre',
      tags: [
        { idx: 3, id: 'T_scifi', label: 'Science Fiction' },
        { idx: 4, id: 'T_modern', label: 'Modern Earth' },
      ],
    },
  ],
  lists: [
    {
      idx: 0,
      id: 'L_ff',
      name: 'fantasy_franchise',
      options: [
        { idx: 0, id: 'o0', value: 'Star Wars', weight: 1, tagIdxs: [0, 3] },
        { idx: 1, id: 'o1', value: 'Dune', weight: 1, tagIdxs: [1, 3] },
        { idx: 2, id: 'o2', value: 'Cthulhu Mythos', weight: 1, tagIdxs: [] }, // wildcard
      ],
    },
    {
      idx: 1,
      id: 'L_mood',
      name: 'mood',
      options: [{ idx: 0, id: 'm0', value: 'intimate', weight: 1, tagIdxs: [] }],
    },
  ],
  ...override,
});

describe('coverageWarnings', () => {
  test('flags an orphanTag when a created tag has zero option assignments in the preview', () => {
    const bundles: RawBundle[] = [{
      key: 'create:Franchise',
      ops: [
        { op: 'createDimension', name: 'Franchise', tags: ['Star Wars', 'Dune', 'Cthulhu Mythos'] },
        { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'Franchise', label: 'Star Wars' }] },
        { op: 'assignOptionTags', listIdx: 0, optionIdx: 1, tags: [{ dimName: 'Franchise', label: 'Dune' }] },
        // No assignment for Cthulhu Mythos → orphan tag.
      ],
      dependsOn: [],
    }];
    const out = coverageWarnings(bundles, previewSnap());
    const orphan = out.find((w) => w.kind === 'orphanTag');
    expect(orphan).toBeDefined();
    if (orphan?.kind === 'orphanTag') {
      expect(orphan.dim).toBe('Franchise');
      expect(orphan.label).toBe('Cthulhu Mythos');
    }
  });

  test('flags lowCoverage when a name-implied list stays below 90% on the implied dim', () => {
    // fantasy_franchise: 2 of 3 options tagged on Franchise = 66.7% → low.
    const bundles: RawBundle[] = [{
      key: 'create:Franchise',
      ops: [
        { op: 'createDimension', name: 'Franchise', tags: ['Star Wars', 'Dune', 'Cthulhu Mythos'] },
      ],
      dependsOn: [],
    }];
    const out = coverageWarnings(bundles, previewSnap());
    const low = out.find((w) => w.kind === 'lowCoverage' && w.dim === 'Franchise');
    expect(low).toBeDefined();
    if (low?.kind === 'lowCoverage') {
      expect(low.listName).toBe('fantasy_franchise');
      expect(low.taggedCount).toBe(2);
      expect(low.totalCount).toBe(3);
      expect(low.coverage).toBeCloseTo(2 / 3, 2);
    }
  });

  test('NO lowCoverage when a list meets the 90% threshold', () => {
    const snap: LibrarySnapshot = previewSnap({
      lists: [
        {
          idx: 0,
          id: 'L_ff',
          name: 'fantasy_franchise',
          options: [
            // 10 options, 10 tagged on Franchise = 100% coverage.
            ...Array.from({ length: 10 }, (_, i) => ({
              idx: i,
              id: `o${i}`,
              value: `v${i}`,
              weight: 1,
              tagIdxs: [0, 3] as const,
            })),
          ].map((o) => ({ ...o, tagIdxs: [...o.tagIdxs] })),
        },
      ],
    });
    const out = coverageWarnings([], snap);
    expect(out.filter((w) => w.kind === 'lowCoverage' && w.dim === 'Franchise')).toHaveLength(0);
  });

  test('NO warnings for lists whose name has no implied dim (mood/pose/atmosphere)', () => {
    const out = coverageWarnings([], previewSnap());
    // mood is the only non-implied list in the fixture; no warnings for it.
    expect(out.some((w) => w.kind === 'lowCoverage' && w.listName === 'mood')).toBe(false);
    expect(out.some((w) => w.kind === 'missingDimension' && w.listName === 'mood')).toBe(false);
  });

  test('flags missingDimension when the implied dim doesn\'t exist in the preview', () => {
    // fantasy_franchise on a preview snap that has no Franchise dim at all.
    const snap: LibrarySnapshot = previewSnap({
      dimensions: [
        {
          idx: 0,
          id: 'D_genre',
          name: 'Genre',
          tags: [{ idx: 0, id: 'T_scifi', label: 'Science Fiction' }],
        },
      ],
      lists: [
        {
          idx: 0,
          id: 'L_ff',
          name: 'fantasy_franchise',
          options: [{ idx: 0, id: 'o0', value: 'Star Wars', weight: 1, tagIdxs: [0] }],
        },
      ],
    });
    const out = coverageWarnings([], snap);
    const missing = out.find((w) => w.kind === 'missingDimension' && w.dim === 'Franchise');
    expect(missing).toBeDefined();
  });

  test('orphan detection covers addTags ops (not just createDimension)', () => {
    // Existing Franchise dim; addTags adds Cthulhu Mythos with no assignment.
    const snap = previewSnap();
    const bundles: RawBundle[] = [{
      key: 'extend:D_franchise',
      ops: [
        { op: 'addTags', dimIdx: 0, tags: ['Cthulhu Mythos'] },
      ],
      dependsOn: [],
    }];
    const out = coverageWarnings(bundles, snap);
    const orphan = out.find((w) => w.kind === 'orphanTag' && w.label === 'Cthulhu Mythos');
    expect(orphan).toBeDefined();
  });

  test('an empty list produces no lowCoverage warning (avoids divide-by-zero noise)', () => {
    const snap: LibrarySnapshot = previewSnap({
      lists: [{ idx: 0, id: 'L_ff', name: 'fantasy_franchise', options: [] }],
    });
    const out = coverageWarnings([], snap);
    expect(out.filter((w) => w.kind === 'lowCoverage')).toHaveLength(0);
  });
});

function lib(over: Partial<PromptLibraryResponse> = {}): PromptLibraryResponse {
  return { templates: [], variableLists: [], dimensions: [], ...over };
}

test('empty library yields empty sections and string hashes', () => {
  const r = coverageReport(lib());
  expect(r.untaggedByList).toEqual([]);
  expect(r.lowCoverageLists).toEqual([]);
  expect(r.orphanTags).toEqual([]);
  expect(r.missingDimensions).toEqual([]);
  expect(typeof r.librarySnapshotHash).toBe('string');
  expect(typeof r.templatesDigest).toBe('string');
});

test('untagged options on a name-implied list are grouped with the list id', () => {
  // fantasy_role implies dimension "Genre" (per coverageHints LIST_NAME_IMPLIES_DIMS).
  // The dimension exists with one tag, but both options are untagged on it.
  const r = coverageReport(lib({
    dimensions: [{ id: 'd1', name: 'Genre', tags: [{ id: 't1', dimensionId: 'd1', label: 'Fantasy', sortOrder: 0 }] }],
    variableLists: [{
      id: 'L1', name: 'fantasy_role', sortOrder: 0, createdAt: 0, updatedAt: 0,
      options: [
        { id: 'o1', listId: 'L1', value: 'paladin', tagIds: [], sortOrder: 0, weight: 1 },
        { id: 'o2', listId: 'L1', value: 'rogue', tagIds: [], sortOrder: 1, weight: 1 },
      ],
    }],
  }));
  const group = r.untaggedByList.find((g) => g.listName === 'fantasy_role' && g.dim === 'Genre');
  expect(group).toBeTruthy();
  expect(group?.listId).toBe('L1');
  expect(group?.untaggedCount).toBe(2);
});

test('low-coverage list (<90%) is surfaced with counts', () => {
  // 1 of 2 tagged on Genre = 50% < 90%.
  const r = coverageReport(lib({
    dimensions: [{ id: 'd1', name: 'Genre', tags: [{ id: 't1', dimensionId: 'd1', label: 'Fantasy', sortOrder: 0 }] }],
    variableLists: [{
      id: 'L1', name: 'fantasy_role', sortOrder: 0, createdAt: 0, updatedAt: 0,
      options: [
        { id: 'o1', listId: 'L1', value: 'paladin', tagIds: ['t1'], sortOrder: 0, weight: 1 },
        { id: 'o2', listId: 'L1', value: 'rogue', tagIds: [], sortOrder: 1, weight: 1 },
      ],
    }],
  }));
  const low = r.lowCoverageLists.find((l) => l.listName === 'fantasy_role' && l.dim === 'Genre');
  expect(low?.taggedCount).toBe(1);
  expect(low?.totalCount).toBe(2);
  expect(low?.coverage).toBeCloseTo(0.5, 5);
});

test('excluded tags count as coverage and tag usage', () => {
  const r = coverageReport(lib({
    dimensions: [{ id: 'd1', name: 'Genre', tags: [{ id: 't1', dimensionId: 'd1', label: 'Fantasy', sortOrder: 0 }] }],
    variableLists: [{
      id: 'L1', name: 'fantasy_role', sortOrder: 0, createdAt: 0, updatedAt: 0,
      options: [{
        id: 'o1', listId: 'L1', value: 'not fantasy', tagIds: [], excludeTagIds: ['t1'],
        sortOrder: 0, weight: 1,
      }],
    }],
  }));

  expect(r.untaggedByList).toEqual([]);
  expect(r.lowCoverageLists).toEqual([]);
  expect(r.orphanTags).toEqual([]);
});

test('manual-only untagged options do not lower automatic coverage or appear as wildcard gaps', () => {
  const r = coverageReport(lib({
    dimensions: [{ id: 'd1', name: 'Genre', tags: [{ id: 't1', dimensionId: 'd1', label: 'Fantasy', sortOrder: 0 }] }],
    variableLists: [{
      id: 'L1', name: 'fantasy_role', sortOrder: 0, createdAt: 0, updatedAt: 0,
      options: [
        { id: 'o1', listId: 'L1', value: 'paladin', tagIds: ['t1'], sortOrder: 0, weight: 1 },
        { id: 'o2', listId: 'L1', value: 'manual special case', tagIds: [], sortOrder: 1, weight: 0 },
      ],
    }],
  }));

  expect(r.untaggedByList).toEqual([]);
  expect(r.lowCoverageLists).toEqual([]);
});

test('missing implied dimension is surfaced under missingDimensions', () => {
  // fantasy_role implies Genre, but no Genre dimension exists.
  const r = coverageReport(lib({
    dimensions: [],
    variableLists: [{
      id: 'L1', name: 'fantasy_role', sortOrder: 0, createdAt: 0, updatedAt: 0,
      options: [{ id: 'o1', listId: 'L1', value: 'paladin', tagIds: [], sortOrder: 0, weight: 1 }],
    }],
  }));
  expect(r.missingDimensions.some((m) => m.listName === 'fantasy_role' && m.dim === 'Genre')).toBe(true);
});

test('orphanTagsAtRest surfaces a dimension tag with zero option assignments', () => {
  // Genre has two tags. Only "Fantasy" is used by an option; "SciFi" is an
  // orphan at rest. coverageWarnings([], snap) would emit NEITHER (the orphan
  // branch only runs over bundle ops) — orphanTagsAtRest computes it directly.
  const snap = toLibrarySnapshot(lib({
    dimensions: [{
      id: 'd1', name: 'Genre', tags: [
        { id: 't1', dimensionId: 'd1', label: 'Fantasy', sortOrder: 0 },
        { id: 't2', dimensionId: 'd1', label: 'SciFi', sortOrder: 1 },
      ],
    }],
    variableLists: [{
      id: 'L1', name: 'fantasy_role', sortOrder: 0, createdAt: 0, updatedAt: 0,
      options: [{ id: 'o1', listId: 'L1', value: 'paladin', tagIds: ['t1'], sortOrder: 0, weight: 1 }],
    }],
  }));
  const orphans = orphanTagsAtRest(snap);
  expect(orphans.some((o) => o.dim === 'Genre' && o.label === 'SciFi')).toBe(true);
  expect(orphans.some((o) => o.dim === 'Genre' && o.label === 'Fantasy')).toBe(false);
});

test('coverageReport surfaces the orphan tag computed at rest', () => {
  const r = coverageReport(lib({
    dimensions: [{
      id: 'd1', name: 'Genre', tags: [
        { id: 't1', dimensionId: 'd1', label: 'Fantasy', sortOrder: 0 },
        { id: 't2', dimensionId: 'd1', label: 'SciFi', sortOrder: 1 },
      ],
    }],
    variableLists: [{
      id: 'L1', name: 'fantasy_role', sortOrder: 0, createdAt: 0, updatedAt: 0,
      options: [{ id: 'o1', listId: 'L1', value: 'paladin', tagIds: ['t1'], sortOrder: 0, weight: 1 }],
    }],
  }));
  expect(r.orphanTags.some((o) => o.dim === 'Genre' && o.label === 'SciFi')).toBe(true);
});

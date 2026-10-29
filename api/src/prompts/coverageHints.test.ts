import { describe, expect, test } from 'bun:test';
import { buildCoverageHints, buildCoverageHintsForList, impliedDimensionsForList } from './coverageHints';
import type { LibrarySnapshot } from './inferTypes';

describe('impliedDimensionsForList', () => {
  test('legal prototype-shaped names have no inherited heuristic', () => {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(impliedDimensionsForList(name)).toEqual([]);
    }
  });
  test('returns implied dims for the canonical list names from the production library', () => {
    expect(impliedDimensionsForList('fantasy_franchise')).toEqual(['Franchise', 'Genre']);
    expect(impliedDimensionsForList('fantasy_race')).toEqual(['Franchise', 'Genre']);
    expect(impliedDimensionsForList('fantasy_role')).toEqual(['Genre']);
    expect(impliedDimensionsForList('fantasy_outfit')).toEqual(['Genre']);
    expect(impliedDimensionsForList('fantasy_location')).toEqual(['Genre']);
    expect(impliedDimensionsForList('scifi_role')).toEqual(['Genre']);
    expect(impliedDimensionsForList('scifi_outfit')).toEqual(['Genre']);
    expect(impliedDimensionsForList('scifi_location')).toEqual(['Genre']);
    expect(impliedDimensionsForList('Job')).toEqual(['Genre']);
    expect(impliedDimensionsForList('modern_outfit')).toEqual(['Genre']);
    expect(impliedDimensionsForList('modern_location')).toEqual(['Genre']);
    expect(impliedDimensionsForList('outfit')).toEqual(['Genre']);
    expect(impliedDimensionsForList('location')).toEqual(['Genre']);
    expect(impliedDimensionsForList('camera')).toEqual(['Era', 'Medium']);
    expect(impliedDimensionsForList('image_type')).toEqual(['Medium']);
    expect(impliedDimensionsForList('era')).toEqual(['Era']);
  });

  test('normalises case + underscore/space/hyphen variants', () => {
    expect(impliedDimensionsForList('Fantasy Franchise')).toEqual(['Franchise', 'Genre']);
    expect(impliedDimensionsForList('fantasy-franchise')).toEqual(['Franchise', 'Genre']);
    expect(impliedDimensionsForList('FANTASY_FRANCHISE')).toEqual(['Franchise', 'Genre']);
  });

  test('returns empty for lists that have no consistent dimension membership', () => {
    expect(impliedDimensionsForList('mood')).toEqual([]);
    expect(impliedDimensionsForList('pose')).toEqual([]);
    expect(impliedDimensionsForList('hair-color')).toEqual([]);
    expect(impliedDimensionsForList('expression')).toEqual([]);
    expect(impliedDimensionsForList('atmosphere')).toEqual([]);
  });
});

const mkSnap = (override: Partial<LibrarySnapshot> = {}): LibrarySnapshot => ({
  dimensions: [
    {
      idx: 0,
      id: 'D_franchise',
      name: 'Franchise',
      tags: [
        { idx: 0, id: 'T_sw', label: 'Star Wars' },
        { idx: 1, id: 'T_dune', label: 'Dune' },
      ],
    },
    {
      idx: 1,
      id: 'D_genre',
      name: 'Genre',
      tags: [
        { idx: 2, id: 'T_scifi', label: 'Science Fiction' },
        { idx: 3, id: 'T_modern', label: 'Modern Earth' },
      ],
    },
  ],
  lists: [
    {
      idx: 0,
      id: 'L_ff',
      name: 'fantasy_franchise',
      options: [
        // tagged on Franchise + Genre → not a coverage gap
        { idx: 0, id: 'o0', value: 'George Lucas\' Star Wars', weight: 1, tagIdxs: [0, 2] },
        // tagged on Genre only → still a coverage gap on Franchise
        { idx: 1, id: 'o1', value: 'Frank Herbert\'s Dune', weight: 1, tagIdxs: [2] },
        // untagged on both → coverage gap on Franchise AND Genre
        { idx: 2, id: 'o2', value: 'H.P. Lovecraft\'s Cthulhu Mythos', weight: 1, tagIdxs: [] },
      ],
    },
    {
      idx: 1,
      id: 'L_mood',
      name: 'mood',
      options: [
        { idx: 0, id: 'm0', value: 'intimate', weight: 1, tagIdxs: [] },
      ],
    },
  ],
  ...override,
});

describe('buildCoverageHints', () => {
  test('reports untagged option idxs per (list, implied dim) and skips lists with no implied dim', () => {
    const hints = buildCoverageHints(mkSnap());
    // fantasy_franchise implies Franchise + Genre → two hint entries.
    // mood has no implied dim → no hint.
    const ff = hints.filter((h) => h.listName === 'fantasy_franchise');
    expect(ff).toHaveLength(2);
    const franchiseHint = ff.find((h) => h.dim === 'Franchise');
    const genreHint = ff.find((h) => h.dim === 'Genre');
    // Star Wars tagged on Franchise → not in hint. Dune + Cthulhu untagged.
    expect(franchiseHint?.untaggedOptionIdxs).toEqual([1, 2]);
    // Star Wars + Dune both tagged on Genre → only Cthulhu untagged.
    expect(genreHint?.untaggedOptionIdxs).toEqual([2]);
    expect(hints.some((h) => h.listName === 'mood')).toBe(false);
  });

  test('when an implied dim doesn\'t exist yet, every option counts as untagged on it', () => {
    // First-run snapshot: dimensions empty, lists populated. The hint must
    // call out all 3 fantasy_franchise options on both Franchise and Genre.
    const snap = mkSnap({ dimensions: [] });
    const hints = buildCoverageHints(snap);
    const ff = hints.filter((h) => h.listName === 'fantasy_franchise');
    expect(ff).toHaveLength(2);
    expect(ff.find((h) => h.dim === 'Franchise')?.untaggedOptionIdxs).toEqual([0, 1, 2]);
    expect(ff.find((h) => h.dim === 'Genre')?.untaggedOptionIdxs).toEqual([0, 1, 2]);
  });

  test('omits a hint entry entirely when coverage is already complete', () => {
    const snap = mkSnap({
      lists: [
        {
          idx: 0,
          id: 'L_ff',
          name: 'fantasy_franchise',
          options: [
            { idx: 0, id: 'o0', value: 'sw', weight: 1, tagIdxs: [0, 2] },
            { idx: 1, id: 'o1', value: 'dune', weight: 1, tagIdxs: [1, 2] },
          ],
        },
      ],
    });
    expect(buildCoverageHints(snap)).toEqual([]);
  });

  test('treats an excluded tag as a polarity-aware dimension constraint', () => {
    const snap = mkSnap({
      lists: [{
        idx: 0,
        id: 'L_role',
        name: 'fantasy_role',
        options: [{ idx: 0, id: 'o0', value: 'not modern', weight: 1, tagIdxs: [], excludeTagIdxs: [3] }],
      }],
    });
    expect(buildCoverageHints(snap)).toEqual([]);
  });

  test('does not ask the infer model to tag an untagged manual-only option', () => {
    const snap = mkSnap({
      lists: [{
        idx: 0,
        id: 'L_role',
        name: 'fantasy_role',
        options: [
          { idx: 0, id: 'automatic', value: 'paladin', weight: 1, tagIdxs: [2] },
          { idx: 1, id: 'manual', value: 'special case', weight: 0, tagIdxs: [] },
        ],
      }],
    });

    expect(buildCoverageHints(snap)).toEqual([]);
  });
});

const requireList = (snap: LibrarySnapshot, idx: number): LibrarySnapshot['lists'][number] => {
  const list = snap.lists[idx];
  if (!list) throw new Error(`fixture list ${idx} missing`);
  return list;
};

describe('buildCoverageHintsForList', () => {
  test('returns hints scoped to one list (the chunked-dispatch use case)', () => {
    const snap = mkSnap();
    const hints = buildCoverageHintsForList(snap, requireList(snap, 0));
    expect(hints).toHaveLength(2);
    expect(hints.every((h) => h.listName === 'fantasy_franchise')).toBe(true);
  });

  test('respects scopedOptionIdxs so a chunk only sees its own option range', () => {
    const snap = mkSnap();
    // Chunk that only contains option idx 2 (the Cthulhu wildcard).
    const hints = buildCoverageHintsForList(snap, requireList(snap, 0), new Set([2]));
    const franchiseHint = hints.find((h) => h.dim === 'Franchise');
    const genreHint = hints.find((h) => h.dim === 'Genre');
    expect(franchiseHint?.untaggedOptionIdxs).toEqual([2]);
    expect(genreHint?.untaggedOptionIdxs).toEqual([2]);
  });

  test('returns empty for lists whose name has no implied dim (mood/pose/atmosphere)', () => {
    const snap = mkSnap();
    expect(buildCoverageHintsForList(snap, requireList(snap, 1))).toEqual([]);
  });
});

import { describe, expect, it, test } from 'bun:test';
import type { PromptLibraryResponse } from '@atelier/shared';
import { TAG_COHERENCE_PARITY_FIXTURES } from '../../../shared/src/tagCoherence.fixtures';
import { conflicts, tagDimOf, templateSatisfiable, coherenceWarnings, _setMaxNodesForTests, templateSatisfiableBranchAware, templateSatisfiableByOccurrences } from './dimensionCoherence';
import type { LibrarySnapshot } from './inferTypes';
import { toLibrarySnapshot } from './librarySnapshot';

const snap: LibrarySnapshot = {
  dimensions: [{ idx: 0, id: 'd', name: 'Franchise', tags: [
    { idx: 0, id: 't0', label: 'Warhammer' },
    { idx: 1, id: 't1', label: 'Star Trek' },
  ] }],
  lists: [
    { idx: 0, id: 'lr', name: 'Races', options: [
      { idx: 0, id: 'orc', value: 'Orc', weight: 1, tagIdxs: [0] },
      { idx: 1, id: 'ori', value: 'Orion', weight: 1, tagIdxs: [1] },
      { idx: 2, id: 'hum', value: 'Human', weight: 1, tagIdxs: [] },
    ] },
    { idx: 1, id: 'lf', name: 'Franchises', options: [
      { idx: 0, id: 'wh', value: 'WH', weight: 1, tagIdxs: [0] },
      { idx: 1, id: 'st', value: 'ST', weight: 1, tagIdxs: [1] },
    ] },
  ],
};

describe('tag coherence v2 parity fixtures', () => {
  for (const fixture of TAG_COHERENCE_PARITY_FIXTURES) {
    test(fixture.name, () => {
      const lib: PromptLibraryResponse = {
        templates: [],
        dimensions: [{
          id: 'franchise',
          name: 'Franchise',
          tags: [
            { id: 'witcher', dimensionId: 'franchise', label: 'The Witcher', sortOrder: 0 },
            { id: 'witcher-games', dimensionId: 'franchise', label: 'The Witcher games', sortOrder: 1, parentId: 'witcher' },
            { id: 'trek', dimensionId: 'franchise', label: 'Star Trek', sortOrder: 2 },
            { id: 'dune', dimensionId: 'franchise', label: 'Dune', sortOrder: 3 },
          ],
        }],
        variableLists: [{
          id: 'pair',
          name: 'pair',
          sortOrder: 0,
          createdAt: 0,
          updatedAt: 0,
          options: [fixture.a, fixture.b].map((tags, index) => ({
            id: `option-${index}`,
            listId: 'pair',
            value: `option ${index}`,
            tagIds: tags.require,
            excludeTagIds: tags.exclude,
            sortOrder: index,
            weight: 1,
          })),
        }],
      };
      const paritySnapshot = toLibrarySnapshot(lib);
      const [a, b] = paritySnapshot.lists[0]?.options ?? [];
      if (!a || !b) throw new Error('expected parity options');
      const tagDimensions = tagDimOf(paritySnapshot);
      expect(conflicts(a, b, tagDimensions)).toBe(fixture.expectedConflict);
      expect(conflicts(b, a, tagDimensions)).toBe(fixture.expectedConflict);
    });
  }
});

describe('dimensionCoherence', () => {
  test('a template referencing both lists is satisfiable (Orc+WH / Orion+ST / Human+any)', () => {
    expect(templateSatisfiable(['Races', 'Franchises'], snap)).toBe(true);
  });

  test('same local tag positions on different dimensions do not conflict', () => {
    const multi: LibrarySnapshot = {
      dimensions: [
        { idx: 0, id: 'd1', name: 'Shape', tags: [{ idx: 0, id: 'round', label: 'Round' }] },
        { idx: 1, id: 'd2', name: 'Color', tags: [{ idx: 1, id: 'red', label: 'Red' }] },
      ],
      lists: [
        { idx: 0, id: 'l1', name: 'Shapes', options: [{ idx: 0, id: 'ball', value: 'Ball', weight: 1, tagIdxs: [0] }] },
        { idx: 1, id: 'l2', name: 'Colors', options: [{ idx: 0, id: 'scarlet', value: 'Scarlet', weight: 1, tagIdxs: [1] }] },
      ],
    };
    expect(templateSatisfiable(['Shapes', 'Colors'], multi)).toBe(true);
  });

  test('over-constrained pair is detected as unsatisfiable', () => {
    const bad: LibrarySnapshot = structuredClone(snap);
    const races = bad.lists[0];
    const franchises = bad.lists[1];
    if (!races || !franchises) throw new Error('expected fixture lists');
    races.options = [{ idx: 0, id: 'orc', value: 'Orc', weight: 1, tagIdxs: [0] }];
    franchises.options = [{ idx: 0, id: 'st', value: 'ST', weight: 1, tagIdxs: [1] }];
    expect(templateSatisfiable(['Races', 'Franchises'], bad)).toBe(false);
  });

  test('manual-only options do not create an automatic satisfying path', () => {
    const manualOnlyPath: LibrarySnapshot = {
      dimensions: [{ idx: 0, id: 'd', name: 'Genre', tags: [
        { idx: 0, id: 'fantasy', label: 'Fantasy' },
        { idx: 1, id: 'scifi', label: 'Science fiction' },
      ] }],
      lists: [
        { idx: 0, id: 'a', name: 'A', options: [
          { idx: 0, id: 'a-fantasy', value: 'fantasy', weight: 1, tagIdxs: [0] },
        ] },
        { idx: 1, id: 'b', name: 'B', options: [
          { idx: 0, id: 'b-scifi', value: 'science fiction', weight: 1, tagIdxs: [1] },
          { idx: 1, id: 'b-fantasy-manual', value: 'fantasy manual', weight: 0, tagIdxs: [0] },
        ] },
      ],
    };

    expect(templateSatisfiable(['A', 'B'], manualOnlyPath)).toBe(false);
  });

  test('coherenceWarnings flags the offending template by name', () => {
    const bad: LibrarySnapshot = structuredClone(snap);
    const races = bad.lists[0];
    const franchises = bad.lists[1];
    if (!races || !franchises) throw new Error('expected fixture lists');
    races.options = [{ idx: 0, id: 'orc', value: 'Orc', weight: 1, tagIdxs: [0] }];
    franchises.options = [{ idx: 0, id: 'st', value: 'ST', weight: 1, tagIdxs: [1] }];
    const w = coherenceWarnings([{ name: 'Scene', lists: ['Races', 'Franchises'] }], bad);
    expect(w).toEqual([{ templateName: 'Scene', detail: 'no coherent combination across: Races, Franchises' }]);
  });

  test('templateSatisfiable bails out under a node-budget cap (conservative false when exceeded)', () => {
    _setMaxNodesForTests(1); // force the cap to fire on the first interior node
    try {
      const snap = {
        dimensions: [],
        lists: [
          { idx: 0, id: 'a', name: 'A', options: [{ idx: 0, id: 'a0', value: 'a0', weight: 1, tagIdxs: [] }, { idx: 1, id: 'a1', value: 'a1', weight: 1, tagIdxs: [] }] },
          { idx: 1, id: 'b', name: 'B', options: [{ idx: 0, id: 'b0', value: 'b0', weight: 1, tagIdxs: [] }, { idx: 1, id: 'b1', value: 'b1', weight: 1, tagIdxs: [] }] },
        ],
      };
      // Without the cap this returns true (untagged options are wildcards → trivially satisfiable).
      // With the cap fired, it returns the conservative false — the guard protects the event loop.
      expect(templateSatisfiable(['A', 'B'], snap)).toBe(false);
    } finally {
      _setMaxNodesForTests(null);
    }
  });

  test('templateSatisfiable shares node budget when nodeBudgetRef is passed', () => {
    const snap: LibrarySnapshot = {
      dimensions: [],
      lists: [{ idx: 0, id: 'l1', name: 'a', options: [{ idx: 0, id: 'o1', value: 'x', weight: 1, tagIdxs: [] }] }],
    };
    const budgetRef = { nodes: 0 };
    const ok = templateSatisfiable(['a'], snap, { nodeBudgetRef: budgetRef, totalBudget: 100 });
    expect(ok).toBe(true);
    expect(budgetRef.nodes).toBeGreaterThan(0);
  });

  test('rejected pairs consume the budget and stop scanning large incompatible domains', () => {
    let tagReads = 0;
    const large: LibrarySnapshot = {
      dimensions: snap.dimensions,
      lists: [0, 1].map((tagIdx) => ({
        idx: tagIdx, id: `list-${tagIdx}`, name: `L${tagIdx}`,
        options: Array.from({ length: 500 }, (_, idx) => ({
          idx, id: `${tagIdx}-${idx}`, value: `${idx}`, weight: 1,
          get tagIdxs() { tagReads += 1; return [tagIdx]; },
        })),
      })),
    };
    const budgetRef = { nodes: 0 };
    expect(templateSatisfiable(['L0', 'L1'], large, { nodeBudgetRef: budgetRef, totalBudget: 12 })).toBe(false);
    expect(budgetRef.nodes).toBe(13);
    // A rejected comparison used to be free, causing thousands of tag-map
    // rebuilds even though the recursive-node budget was tiny.
    expect(tagReads).toBeLessThan(12);
  });

  test('templateSatisfiable returns false when shared budget is exhausted before solve', () => {
    const snap: LibrarySnapshot = {
      dimensions: [],
      lists: [{ idx: 0, id: 'l1', name: 'a', options: [{ idx: 0, id: 'o1', value: 'x', weight: 1, tagIdxs: [] }] }],
    };
    const budgetRef = { nodes: 100 };
    const ok = templateSatisfiable(['a'], snap, { nodeBudgetRef: budgetRef, totalBudget: 100 });
    expect(ok).toBe(false);
  });
});

// Branch-aware satisfiability tests
// Snapshot: one Weather scope dimension with two tags (outdoor-exposed, indoor-sheltered).
// Three lists: interior_location (indoor only), exterior_location (outdoor only),
// weather_anchor (outdoor only). interior + outdoor lists together = unsatisfiable eagerly.
const weatherSnap: LibrarySnapshot = {
  dimensions: [
    {
      idx: 0, id: 'd-weather', name: 'Weather scope', tags: [
        { idx: 0, id: 't-out', label: 'outdoor-exposed' },
        { idx: 1, id: 't-in', label: 'indoor-sheltered' },
      ],
    },
  ],
  lists: [
    {
      idx: 0, id: 'l-interior', name: 'interior_location',
      options: [{ idx: 0, id: 'o-bed', value: 'bedroom', weight: 1, tagIdxs: [1] }],
    },
    {
      idx: 1, id: 'l-exterior', name: 'exterior_location',
      options: [{ idx: 0, id: 'o-roof', value: 'rooftop', weight: 1, tagIdxs: [0] }],
    },
    {
      idx: 2, id: 'l-weather', name: 'weather_anchor',
      options: [{ idx: 0, id: 'o-rain', value: 'rain', weight: 1, tagIdxs: [0] }],
    },
  ],
};

describe('templateSatisfiableBranchAware', () => {
  it('flags eager-style unsatisfiable bodies as unsatisfiable, but lazy branch-split as satisfiable', () => {
    // Eager template: all three lists co-slot. interior + outdoor weather conflict.
    const eagerBody = '{{var::interior_location}} {{var::exterior_location}} {{var::weather_anchor}}';
    expect(templateSatisfiableBranchAware(eagerBody, weatherSnap)).toBe(false);
    // Lazy template: random splits interior from exterior+weather. Each branch satisfiable independently.
    const lazyBody = '{{random::{{var::interior_location}}::{{var::exterior_location}}, {{var::weather_anchor}}}}';
    expect(templateSatisfiableBranchAware(lazyBody, weatherSnap)).toBe(true);
  });

  it('reports unsatisfiable when ANY branch is unsatisfiable', () => {
    // Branch 1 mixes interior + outdoor weather — unsatisfiable.
    // Branch 2 mixes exterior + outdoor weather — satisfiable.
    const body = '{{random::{{var::interior_location}}, {{var::weather_anchor}}::{{var::exterior_location}}, {{var::weather_anchor}}}}';
    expect(templateSatisfiableBranchAware(body, weatherSnap)).toBe(false);
  });

  it('preserves eager behaviour when no randoms present', () => {
    const body = '{{var::interior_location}} {{var::weather_anchor}}';
    expect(templateSatisfiableBranchAware(body, weatherSnap)).toBe(false);
  });
});

describe('templateSatisfiableBranchAware budgetOpts', () => {
  it('forwards budgetOpts to the inner solver', () => {
    // exterior_location + weather_anchor is satisfiable without a budget constraint
    // (both options carry tag idx 0 = outdoor-exposed, so they're compatible).
    const sat = '{{var::exterior_location}} {{var::weather_anchor}}';
    expect(templateSatisfiableBranchAware(sat, weatherSnap)).toBe(true);
    // With a totalBudget of 1 the SAT solver fires the cap and returns the conservative false.
    expect(templateSatisfiableBranchAware(sat, weatherSnap, { totalBudget: 1 })).toBe(false);
  });
});

describe('templateSatisfiableByOccurrences — subject clustering', () => {
  // One dimension "era" (idx 0) with two disjoint tags (idx 0=modern, 1=retro).
  // `look` has two fully-tagged, mutually-conflicting options.
  const occSnap: LibrarySnapshot = {
    dimensions: [{ idx: 0, id: 'era', name: 'Era', tags: [{ idx: 0, id: 'modern', label: 'Modern' }, { idx: 1, id: 'retro', label: 'Retro' }] }],
    lists: [{ idx: 0, id: 'look', name: 'look', options: [
      { idx: 0, id: 'm', value: 'MODERN', weight: 1, tagIdxs: [0] },
      { idx: 1, id: 'r', value: 'RETRO', weight: 1, tagIdxs: [1] },
    ] }],
  };

  test('two DISTINCT subjects on the same conflicting list ARE satisfiable (was UNSAT under name-dedup)', () => {
    expect(templateSatisfiableByOccurrences(
      [{ listName: 'look', subject: 1 }, { listName: 'look', subject: 2 }], occSnap,
    )).toBe(true);
  });

  test('TWO conflicting lists in the SAME subject are UNSAT', () => {
    const twoLists: LibrarySnapshot = {
      dimensions: occSnap.dimensions,
      lists: [
        { idx: 0, id: 'a', name: 'a', options: [{ idx: 0, id: 'am', value: 'AM', weight: 1, tagIdxs: [0] }] },
        { idx: 1, id: 'b', name: 'b', options: [{ idx: 1, id: 'br', value: 'BR', weight: 1, tagIdxs: [1] }] },
      ],
    };
    expect(templateSatisfiableByOccurrences(
      [{ listName: 'a', subject: 1 }, { listName: 'b', subject: 1 }], twoLists,
    )).toBe(false);
  });

  test('subject-vs-scene conflict is UNSAT (scene bridges)', () => {
    const twoLists: LibrarySnapshot = {
      dimensions: occSnap.dimensions,
      lists: [
        { idx: 0, id: 'a', name: 'a', options: [{ idx: 0, id: 'am', value: 'AM', weight: 1, tagIdxs: [0] }] },
        { idx: 1, id: 'b', name: 'b', options: [{ idx: 1, id: 'br', value: 'BR', weight: 1, tagIdxs: [1] }] },
      ],
    };
    expect(templateSatisfiableByOccurrences(
      [{ listName: 'a', subject: 1 }, { listName: 'b', subject: null }], twoLists,
    )).toBe(false);
  });

  test('cross-subject conflict (a@1 vs b@2) IS satisfiable', () => {
    const twoLists: LibrarySnapshot = {
      dimensions: occSnap.dimensions,
      lists: [
        { idx: 0, id: 'a', name: 'a', options: [{ idx: 0, id: 'am', value: 'AM', weight: 1, tagIdxs: [0] }] },
        { idx: 1, id: 'b', name: 'b', options: [{ idx: 1, id: 'br', value: 'BR', weight: 1, tagIdxs: [1] }] },
      ],
    };
    expect(templateSatisfiableByOccurrences(
      [{ listName: 'a', subject: 1 }, { listName: 'b', subject: 2 }], twoLists,
    )).toBe(true);
  });
});

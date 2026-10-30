import { describe, expect, test } from 'bun:test';
import { _setDiagnosisNodeBudgetForTests, diagnoseLibrary } from './libraryDiagnosis';
import type { PromptLibraryResponse } from '@atelier/shared';

// Minimal-fixture helper: 1 list with 1 option, 0 dimensions/templates.
function makeLib(parts: Partial<PromptLibraryResponse> = {}): PromptLibraryResponse {
  return {
    templates: [],
    variableLists: [],
    dimensions: [],
    ...parts,
  };
}

describe('diagnoseLibrary', () => {
  test('healthy library returns satisfiable=true for every template', () => {
    const lib = makeLib({
      templates: [
        { id: 't1', name: 'Only-one-slot', body: '{{var::A}}', sortOrder: 0, createdAt: 0, updatedAt: 0 },
      ],
      variableLists: [
        { id: 'lA', name: 'A', sortOrder: 0, createdAt: 0, updatedAt: 0, options: [
          { id: 'a1', listId: 'lA', value: 'opt-a1', sortOrder: 0, tagIds: [], weight: 1 },
        ] },
      ],
      dimensions: [],
    });

    const result = diagnoseLibrary(lib);

    expect(result.templates.length).toBe(1);
    expect(result.templates[0]?.templateName).toBe('Only-one-slot');
    expect(result.templates[0]?.satisfiable).toBe(true);
    expect(result.librarySnapshotHash).toBeTruthy();
    expect(result.templatesDigest).toBeTruthy();
  });

  test('broken template (two lists with disjoint tag values on shared dim) flags a conflicting pair', () => {
    // Dim D with two values v1, v2. List A's only option carries v1; List B's only option carries v2.
    // Template uses both lists => guaranteed-fail on D.
    const lib = makeLib({
      templates: [
        { id: 't1', name: 'Broken', body: '{{var::A}} and {{var::B}}', sortOrder: 0, createdAt: 0, updatedAt: 0 },
      ],
      variableLists: [
        { id: 'lA', name: 'A', sortOrder: 0, createdAt: 0, updatedAt: 0, options: [
          { id: 'a1', listId: 'lA', value: 'a', sortOrder: 0, tagIds: ['tag_v1'], weight: 1 },
        ] },
        { id: 'lB', name: 'B', sortOrder: 1, createdAt: 0, updatedAt: 0, options: [
          { id: 'b1', listId: 'lB', value: 'b', sortOrder: 0, tagIds: ['tag_v2'], weight: 1 },
        ] },
      ],
      dimensions: [
        { id: 'D', name: 'D', tags: [
          { id: 'tag_v1', dimensionId: 'D', label: 'v1', sortOrder: 0 },
          { id: 'tag_v2', dimensionId: 'D', label: 'v2', sortOrder: 1 },
        ] },
      ],
    });

    const result = diagnoseLibrary(lib);

    const broken = result.templates.find((t) => t.templateName === 'Broken');
    expect(broken?.satisfiable).toBe(false);
    expect(broken?.conflictingPairs?.length ?? 0).toBeGreaterThan(0);
    const pair = broken?.conflictingPairs?.[0];
    expect([pair?.listA, pair?.listB].sort()).toEqual(['A', 'B']);
    expect(pair?.dimensionName).toBe('D');
  });

  test('branch-aware conflict explanation reports only pairs from failing branches', () => {
    const lib = makeLib({
      templates: [
        {
          id: 't-random-conflict',
          name: 'Branched-conflict',
          body: '{{random::{{var::A}} {{var::B}}::{{var::C}}}}',
          sortOrder: 0,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      variableLists: [
        { id: 'lA', name: 'A', sortOrder: 0, createdAt: 0, updatedAt: 0, options: [
          { id: 'a1', listId: 'lA', value: 'a', sortOrder: 0, tagIds: ['tag_v1'], weight: 1 },
        ] },
        { id: 'lB', name: 'B', sortOrder: 1, createdAt: 0, updatedAt: 0, options: [
          { id: 'b1', listId: 'lB', value: 'b', sortOrder: 0, tagIds: ['tag_v2'], weight: 1 },
        ] },
        { id: 'lC', name: 'C', sortOrder: 2, createdAt: 0, updatedAt: 0, options: [
          { id: 'c1', listId: 'lC', value: 'c', sortOrder: 0, tagIds: ['tag_v1'], weight: 1 },
        ] },
      ],
      dimensions: [
        { id: 'D', name: 'D', tags: [
          { id: 'tag_v1', dimensionId: 'D', label: 'v1', sortOrder: 0 },
          { id: 'tag_v2', dimensionId: 'D', label: 'v2', sortOrder: 1 },
        ] },
      ],
    });

    const result = diagnoseLibrary(lib);

    const branched = result.templates.find((t) => t.templateName === 'Branched-conflict');
    expect(branched?.satisfiable).toBe(false);
    expect(branched?.conflictingPairs?.map((pair) => [pair.listA, pair.listB].sort().join('/'))).toEqual(['A/B']);
    expect(branched?.reason).toBe('no satisfying combination across A, B');
  });

  test('a proved branch conflict remains false when its explanation exhausts the request budget', () => {
    _setDiagnosisNodeBudgetForTests(5);
    try {
      const lib = makeLib({
        templates: [
          {
            id: 't-budget',
            name: 'Budgeted',
            body: '{{random::{{var::A}} {{var::B}}::{{var::C}} {{var::D}}}}',
            sortOrder: 0,
            createdAt: 0,
            updatedAt: 0,
          },
        ],
        variableLists: [
          { id: 'lA', name: 'A', sortOrder: 0, createdAt: 0, updatedAt: 0, options: [
            { id: 'a1', listId: 'lA', value: 'a', sortOrder: 0, tagIds: ['tag_v1'], weight: 1 },
          ] },
          { id: 'lB', name: 'B', sortOrder: 1, createdAt: 0, updatedAt: 0, options: [
            { id: 'b1', listId: 'lB', value: 'b', sortOrder: 0, tagIds: ['tag_v2'], weight: 1 },
          ] },
          { id: 'lC', name: 'C', sortOrder: 2, createdAt: 0, updatedAt: 0, options: [
            { id: 'c1', listId: 'lC', value: 'c', sortOrder: 0, tagIds: [], weight: 1 },
          ] },
          { id: 'lD', name: 'D', sortOrder: 3, createdAt: 0, updatedAt: 0, options: [
            { id: 'd1', listId: 'lD', value: 'd', sortOrder: 0, tagIds: [], weight: 1 },
          ] },
        ],
        dimensions: [
          { id: 'D', name: 'D', tags: [
            { id: 'tag_v1', dimensionId: 'D', label: 'v1', sortOrder: 0 },
            { id: 'tag_v2', dimensionId: 'D', label: 'v2', sortOrder: 1 },
          ] },
        ],
      });

      const result = diagnoseLibrary(lib);

      expect(result.templates[0]).toMatchObject({
        templateName: 'Budgeted',
        satisfiable: false,
        reason: 'no satisfying combination; conflict explanation incomplete (diagnosis budget exceeded)',
      });
      expect(result.templates[0]?.conflictingPairs).toBeUndefined();
    } finally {
      _setDiagnosisNodeBudgetForTests(null);
    }
  });

  test('template referencing a missing list is unsatisfiable with explicit reason', () => {
    const lib = makeLib({
      templates: [
        { id: 't1', name: 'DanglingRef', body: '{{var::DeletedList}}', sortOrder: 0, createdAt: 0, updatedAt: 0 },
      ],
      variableLists: [], // DeletedList does not exist
      dimensions: [],
    });

    const result = diagnoseLibrary(lib);

    const entry = result.templates[0];
    expect(entry?.satisfiable).toBe(false);
    expect(entry?.reason).toMatch(/missing or empty list/);
    expect(entry?.reason).toMatch(/DeletedList/);
  });

  for (const { size, budget, phase } of [
    { size: 100, budget: 500, phase: 'SAT comparisons' },
    { size: 3, budget: 32, phase: 'pair-hint comparisons after both SAT walks' },
  ]) {
    test(`${phase} exhaust the shared diagnostic budget without publishing partial hints`, () => {
      const lib = makeLib({
        templates: [{ id: 't', name: 'Budgeted', body: '{{var::A}} {{var::B}}', sortOrder: 0, createdAt: 0, updatedAt: 0 }],
        variableLists: ['A', 'B'].map((name, listIdx) => ({
          id: name, name, sortOrder: listIdx, createdAt: 0, updatedAt: 0,
          options: Array.from({ length: size }, (_, idx) => ({
            id: `${name}-${idx}`, listId: name, value: `${idx}`, sortOrder: idx, weight: 1, tagIds: [`tag-${listIdx}`],
          })),
        })),
        dimensions: [{ id: 'd', name: 'D', tags: [0, 1].map((idx) => ({
          id: `tag-${idx}`, dimensionId: 'd', label: `${idx}`, sortOrder: idx,
        })) }],
      });
      _setDiagnosisNodeBudgetForTests(budget);
      try {
        expect(diagnoseLibrary(lib).templates[0]).toEqual({
          templateName: 'Budgeted', satisfiable: phase === 'SAT comparisons' ? null : false,
          reason: phase === 'SAT comparisons'
            ? 'diagnosis budget exceeded'
            : 'no satisfying combination; conflict explanation incomplete (diagnosis budget exceeded)',
        });
      } finally {
        _setDiagnosisNodeBudgetForTests(null);
      }
    });
  }

  test('template referencing an empty list (0 options) is unsatisfiable', () => {
    const lib = makeLib({
      templates: [
        { id: 't1', name: 'EmptyListRef', body: '{{var::A}}', sortOrder: 0, createdAt: 0, updatedAt: 0 },
      ],
      variableLists: [
        { id: 'lA', name: 'A', sortOrder: 0, createdAt: 0, updatedAt: 0, options: [] },
      ],
    });

    const result = diagnoseLibrary(lib);

    expect(result.templates[0]?.satisfiable).toBe(false);
    expect(result.templates[0]?.reason).toMatch(/missing or empty list/);
  });

  test('a manual-only compatibility path does not make a template report satisfiable', () => {
    const lib = makeLib({
      templates: [
        { id: 't1', name: 'ManualOnlyPath', body: '{{var::A}} {{var::B}}', sortOrder: 0, createdAt: 0, updatedAt: 0 },
      ],
      variableLists: [
        { id: 'lA', name: 'A', sortOrder: 0, createdAt: 0, updatedAt: 0, options: [
          { id: 'a1', listId: 'lA', value: 'fantasy', sortOrder: 0, tagIds: ['fantasy'], weight: 1 },
        ] },
        { id: 'lB', name: 'B', sortOrder: 1, createdAt: 0, updatedAt: 0, options: [
          { id: 'b1', listId: 'lB', value: 'science fiction', sortOrder: 0, tagIds: ['scifi'], weight: 1 },
          { id: 'b2', listId: 'lB', value: 'fantasy manual', sortOrder: 1, tagIds: ['fantasy'], weight: 0 },
        ] },
      ],
      dimensions: [{ id: 'genre', name: 'Genre', tags: [
        { id: 'fantasy', dimensionId: 'genre', label: 'Fantasy', sortOrder: 0 },
        { id: 'scifi', dimensionId: 'genre', label: 'Science fiction', sortOrder: 1 },
      ] }],
    });

    expect(diagnoseLibrary(lib).templates[0]?.satisfiable).toBe(false);
  });

  test('two inexpensive healthy templates fit within the shared request budget', () => {
    const lib = makeLib({
      templates: [
        { id: 't1', name: 'First', body: '{{var::A}} {{var::B}}', sortOrder: 0, createdAt: 0, updatedAt: 0 },
        { id: 't2', name: 'Second', body: '{{var::A}} {{var::B}}', sortOrder: 1, createdAt: 0, updatedAt: 0 },
      ],
      variableLists: [
        { id: 'lA', name: 'A', sortOrder: 0, createdAt: 0, updatedAt: 0, options: [
          { id: 'a1', listId: 'lA', value: 'a', sortOrder: 0, tagIds: [], weight: 1 },
        ] },
        { id: 'lB', name: 'B', sortOrder: 1, createdAt: 0, updatedAt: 0, options: [
          { id: 'b1', listId: 'lB', value: 'b', sortOrder: 0, tagIds: [], weight: 1 },
        ] },
      ],
    });

    const result = diagnoseLibrary(lib);
    expect(result.templates.every((t) => t.satisfiable)).toBe(true);
  });

  test('templates with fewer than 2 slots are always satisfiable', () => {
    const lib = makeLib({
      templates: [
        { id: 't1', name: 'Zero-slots', body: 'no slots here', sortOrder: 0, createdAt: 0, updatedAt: 0 },
        { id: 't2', name: 'One-slot', body: '{{var::A}}', sortOrder: 1, createdAt: 0, updatedAt: 0 },
      ],
      variableLists: [
        { id: 'lA', name: 'A', sortOrder: 0, createdAt: 0, updatedAt: 0, options: [
          { id: 'a1', listId: 'lA', value: 'a', sortOrder: 0, tagIds: [], weight: 1 },
        ] },
      ],
    });

    const result = diagnoseLibrary(lib);
    expect(result.templates.every((t) => t.satisfiable)).toBe(true);
  });

  // Regression: branch-aware lazy-random semantics (Task 6, Phase 1)
  // {{random::}} wraps two branches with disjoint tag schemes. Each branch is
  // independently satisfiable, so the template must NOT be flagged. Without
  // templateSatisfiableBranchAware (i.e. using the old eager templateSatisfiable),
  // the flat union of lists {interior, exterior, weather} would fail on the
  // location dimension and this template would be incorrectly flagged.
  test('{{random::}} template with branch-disjoint tag schemes is NOT flagged unsatisfiable', () => {
    // Location dimension: indoor-sheltered vs outdoor-exposed.
    // interior options  → tagged indoor-sheltered only
    // exterior options  → tagged outdoor-exposed only
    // weather options   → tagged outdoor-exposed only
    //
    // Branch 0: {{var::interior}}           — uses only indoor-sheltered → satisfiable
    // Branch 1: {{var::exterior}}, {{var::weather}} — uses only outdoor-exposed → satisfiable
    // Flat union {interior, exterior, weather} with eager check → FAIL (disjoint tags)
    const lib = makeLib({
      templates: [
        {
          id: 't-random',
          name: 'Branched-random',
          body: '{{random::{{var::interior}}::{{var::exterior}}, {{var::weather}}}}',
          sortOrder: 0, createdAt: 0, updatedAt: 0,
        },
        // Control: same lists, no random wrapper → eager template → must still be flagged
        {
          id: 't-eager',
          name: 'Eager-conflict',
          body: '{{var::interior}} {{var::weather}}',
          sortOrder: 1, createdAt: 0, updatedAt: 0,
        },
      ],
      variableLists: [
        {
          id: 'lI', name: 'interior', sortOrder: 0, createdAt: 0, updatedAt: 0,
          options: [
            { id: 'i1', listId: 'lI', value: 'living room', sortOrder: 0, tagIds: ['tag_indoor'], weight: 1 },
          ],
        },
        {
          id: 'lE', name: 'exterior', sortOrder: 1, createdAt: 0, updatedAt: 0,
          options: [
            { id: 'e1', listId: 'lE', value: 'garden', sortOrder: 0, tagIds: ['tag_outdoor'], weight: 1 },
          ],
        },
        {
          id: 'lW', name: 'weather', sortOrder: 2, createdAt: 0, updatedAt: 0,
          options: [
            { id: 'w1', listId: 'lW', value: 'sunny', sortOrder: 0, tagIds: ['tag_outdoor'], weight: 1 },
          ],
        },
      ],
      dimensions: [
        {
          id: 'dim-location', name: 'location',
          tags: [
            { id: 'tag_indoor', dimensionId: 'dim-location', label: 'indoor-sheltered', sortOrder: 0 },
            { id: 'tag_outdoor', dimensionId: 'dim-location', label: 'outdoor-exposed', sortOrder: 1 },
          ],
        },
      ],
    });

    const result = diagnoseLibrary(lib);

    const branched = result.templates.find((t) => t.templateName === 'Branched-random');
    expect(branched?.satisfiable).toBe(true);

    // Control: flat eager template mixing indoor + outdoor lists IS flagged.
    const eager = result.templates.find((t) => t.templateName === 'Eager-conflict');
    expect(eager?.satisfiable).toBe(false);
  });
  test('explains a local exclusion conflict through ancestor-expanded polarity', () => {
    const lib = makeLib({
      templates: [{ id: 't', name: 'Excluded', body: '{{var::A}} {{var::B}}', sortOrder: 0, createdAt: 0, updatedAt: 0 }],
      dimensions: [{ id: 'd', name: 'Franchise', tags: [
        { id: 'parent', dimensionId: 'd', label: 'Parent', sortOrder: 0 },
        { id: 'child', dimensionId: 'd', label: 'Child', sortOrder: 1, parentId: 'parent' },
      ] }],
      variableLists: [
        { id: 'a', name: 'A', sortOrder: 0, createdAt: 0, updatedAt: 0, options: [
          { id: 'ao', listId: 'a', value: 'a', tagIds: [], excludeTagIds: ['parent'], sortOrder: 0, weight: 1 },
        ] },
        { id: 'b', name: 'B', sortOrder: 1, createdAt: 0, updatedAt: 0, options: [
          { id: 'bo', listId: 'b', value: 'b', tagIds: ['child'], sortOrder: 0, weight: 1 },
        ] },
      ],
    });

    expect(diagnoseLibrary(lib).templates[0]?.conflictingPairs).toEqual([
      { listA: 'A', listB: 'B', dimensionName: 'Franchise' },
    ]);
  });

  test('does not blame compatible parent and child requirements for another pair making the template unsatisfiable', () => {
    const option = (id: string, listId: string, tagIds: string[]) => ({
      id, listId, value: id, tagIds, sortOrder: 0, weight: 1,
    });
    const lib = makeLib({
      templates: [{ id: 't', name: 'Mixed', body: '{{var::A}} {{var::B}} {{var::C}} {{var::D}}', sortOrder: 0, createdAt: 0, updatedAt: 0 }],
      dimensions: [{ id: 'd', name: 'Franchise', tags: [
        { id: 'parent', dimensionId: 'd', label: 'Parent', sortOrder: 0 },
        { id: 'child', dimensionId: 'd', label: 'Child', sortOrder: 1, parentId: 'parent' },
        { id: 'other', dimensionId: 'd', label: 'Other', sortOrder: 2 },
      ] }],
      variableLists: [
        { id: 'a', name: 'A', sortOrder: 0, createdAt: 0, updatedAt: 0, options: [option('ao', 'a', ['parent'])] },
        { id: 'b', name: 'B', sortOrder: 1, createdAt: 0, updatedAt: 0, options: [option('bo', 'b', ['child'])] },
        { id: 'c', name: 'C', sortOrder: 2, createdAt: 0, updatedAt: 0, options: [option('co', 'c', ['parent'])] },
        { id: 'd-list', name: 'D', sortOrder: 3, createdAt: 0, updatedAt: 0, options: [option('do', 'd-list', ['other'])] },
      ],
    });

    const pairs = diagnoseLibrary(lib).templates[0]?.conflictingPairs ?? [];
    expect(pairs).toContainEqual({ listA: 'C', listB: 'D', dimensionName: 'Franchise' });
    expect(pairs).not.toContainEqual({ listA: 'A', listB: 'B', dimensionName: 'Franchise' });
  });
});

test('unrelated library size and prose do not spend the solver comparison budget', () => {
  const tagIds = Array.from({ length: 50 }, (_, i) => `tag-${i}`);
  const lib = makeLib({
    templates: Array.from({ length: 4 }, (_, i) => ({
      id: `t-${i}`, name: `T-${i}`, body: `${'prose '.repeat(10_000)} {{var::A}} {{var::B}}`,
      sortOrder: i, createdAt: 0, updatedAt: 0,
    })),
    variableLists: [
      ...['A', 'B'].map((name, i) => ({
        id: name, name, sortOrder: i, createdAt: 0, updatedAt: 0,
        options: [{ id: name, listId: name, value: name, sortOrder: 0, weight: 1, tagIds: [] }],
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        id: `unused-${i}`, name: `Unused ${i}`, sortOrder: i + 2, createdAt: 0, updatedAt: 0,
        options: Array.from({ length: 500 }, (_, j) => ({
          id: `unused-${i}-${j}`, listId: `unused-${i}`, value: String(j),
          sortOrder: j, weight: 1, tagIds,
        })),
      })),
    ],
    dimensions: [0, 1].map((i) => ({
      id: `d-${i}`, name: `Dimension ${i}`,
      tags: tagIds.slice(i * 25, (i + 1) * 25).map((id, j) => ({
        id, dimensionId: `d-${i}`, label: id, sortOrder: j,
      })),
    })),
  });
  const work = { nodes: 0 };
  const result = diagnoseLibrary(lib, { nodeBudgetRef: work, totalBudget: 200_000 });
  expect(result.templates.every((entry) => entry.satisfiable === true)).toBe(true);
  expect(work.nodes).toBeLessThan(1_000);
});

test('fixed fair quotas preserve hard, easy and broken verdicts and explanations across permutations', () => {
  const bodies = ['{{var::H1}} {{var::H2}}', '{{var::E1}} {{var::E2}}', '{{var::B1}} {{var::B2}}', '{{var::E1}}', '{{var::Missing}}'];
  const templates = ['Hard', 'Easy', 'Broken', 'Trivial', 'Missing'].map((name, i) => ({
    id: name, name, body: bodies[i] ?? '', sortOrder: i, createdAt: 0, updatedAt: 0,
  }));
  const lib = makeLib({
    templates,
    variableLists: ['H1', 'H2', 'E1', 'E2', 'B1', 'B2'].map((name, i) => ({
      id: name, name, sortOrder: i, createdAt: 0, updatedAt: 0,
      options: Array.from({ length: name.startsWith('H') ? 500 : 1 }, (_, j) => ({
        id: `${name}-${j}`, listId: name, value: String(j), sortOrder: j, weight: 1,
        tagIds: name.startsWith('E') ? [] : [`tag-${i % 2}`],
      })),
    })),
    dimensions: [{ id: 'd', name: 'D', tags: [0, 1].map((i) => ({
      id: `tag-${i}`, dimensionId: 'd', label: String(i), sortOrder: i,
    })) }],
  });
  const byName = (result: ReturnType<typeof diagnoseLibrary>) => Object.fromEntries(result.templates.map((entry) => [entry.templateName, entry]));
  const expected = byName(diagnoseLibrary(lib, { nodeBudgetRef: { nodes: 137 }, totalBudget: 3000 }));
  expect(expected.Hard?.satisfiable).toBeNull();
  expect(expected.Easy?.satisfiable).toBe(true);
  expect(expected.Broken?.satisfiable).toBe(false);
  expect(expected.Broken?.conflictingPairs).toHaveLength(1);
  for (const ordered of [templates, [...templates].reverse(), [...templates.slice(2), ...templates.slice(0, 2)]]) {
    const work = { nodes: 137 };
    expect(byName(diagnoseLibrary({ ...lib, templates: ordered }, { nodeBudgetRef: work, totalBudget: 3000 }))).toEqual(expected);
    expect(work.nodes).toBeLessThanOrEqual(3000);
  }
  const tiny = { nodes: 10 };
  const exhausted = diagnoseLibrary(lib, { nodeBudgetRef: tiny, totalBudget: 13 });
  expect(exhausted.templates.slice(0, 3).every((entry) => entry.satisfiable === null)).toBe(true);
  expect(tiny.nodes).toBe(13); // three quotas of one, excluding failed-spend sentinels
});

test('one request budget bounds diagnosis across fifty hard templates', () => {
  const lib = makeLib({
    templates: Array.from({ length: 50 }, (_, i) => ({
      id: `t-${i}`, name: `T-${i}`, body: '{{var::A}} {{var::B}}', sortOrder: i, createdAt: 0, updatedAt: 0,
    })),
    variableLists: ['A', 'B'].map((name, listIdx) => ({
      id: name, name, sortOrder: listIdx, createdAt: 0, updatedAt: 0,
      options: Array.from({ length: 500 }, (_, i) => ({
        id: `${name}-${i}`, listId: name, value: String(i), sortOrder: i, weight: 1, tagIds: [`tag-${listIdx}`],
      })),
    })),
    dimensions: [{ id: 'd', name: 'D', tags: [0, 1].map((i) => ({
      id: `tag-${i}`, dimensionId: 'd', label: String(i), sortOrder: i,
    })) }],
  });
  const work = { nodes: 0 };
  const result = diagnoseLibrary(lib, { nodeBudgetRef: work, totalBudget: 200_000 });
  expect(work.nodes).toBeLessThanOrEqual(200_000);
  expect(result.templates).toHaveLength(50);
  expect(result.templates.every((entry) => entry.satisfiable === null && entry.reason === 'diagnosis budget exceeded')).toBe(true);
  const cheapTemplates = [
    { id: 'cheap-healthy', name: 'Cheap healthy', body: '{{var::A}}', sortOrder: 0, createdAt: 0, updatedAt: 0 },
    { id: 'cheap-missing', name: 'Cheap missing', body: '{{var::Missing}}', sortOrder: 0, createdAt: 0, updatedAt: 0 },
    { id: 'cheap-empty', name: 'Cheap empty', body: '{{var::Empty}}', sortOrder: 0, createdAt: 0, updatedAt: 0 },
  ];
  for (const templates of [[...lib.templates, ...cheapTemplates], [...cheapTemplates, ...lib.templates]]) {
    const bounded = { nodes: 0 };
    const diagnosis = diagnoseLibrary({
      ...lib, templates,
      variableLists: [...lib.variableLists, { id: 'empty', name: 'Empty', sortOrder: 2, createdAt: 0, updatedAt: 0, options: [] }],
    }, { nodeBudgetRef: bounded, totalBudget: 200_000 });
    expect(diagnosis.templates.find((entry) => entry.templateName === 'Cheap healthy')?.satisfiable).toBe(true);
    expect(diagnosis.templates.find((entry) => entry.templateName === 'Cheap missing')).toMatchObject({
      satisfiable: false, reason: 'missing or empty list(s): Missing',
    });
    expect(diagnosis.templates.find((entry) => entry.templateName === 'Cheap empty')).toMatchObject({
      satisfiable: false, reason: 'missing or empty list(s): Empty',
    });
    expect(diagnosis.templates.find((entry) => entry.templateName === 'T-0')?.satisfiable).toBeNull();
    expect(bounded.nodes).toBeLessThanOrEqual(200_001);
  }
});

describe('diagnoseLibrary subject awareness', () => {
  test('cross-subject template (a@1 + b@2) is satisfiable in library diagnosis', () => {
    const lib = makeLib({
      templates: [
        { id: 't', name: 'cross', body: '{{var::a@1}} {{var::b@2}}', sortOrder: 0, createdAt: 0, updatedAt: 0 },
      ],
      variableLists: [
        { id: 'la', name: 'a', sortOrder: 0, createdAt: 0, updatedAt: 0, options: [
          { id: 'am', listId: 'la', value: 'AM', sortOrder: 0, tagIds: ['modern'], weight: 1 },
        ] },
        { id: 'lb', name: 'b', sortOrder: 1, createdAt: 0, updatedAt: 0, options: [
          { id: 'br', listId: 'lb', value: 'BR', sortOrder: 0, tagIds: ['retro'], weight: 1 },
        ] },
      ],
      dimensions: [
        { id: 'era', name: 'Era', tags: [
          { id: 'modern', dimensionId: 'era', label: 'Modern', sortOrder: 0 },
          { id: 'retro', dimensionId: 'era', label: 'Retro', sortOrder: 1 },
        ] },
      ],
    });
    const out = diagnoseLibrary(lib);
    expect(out.templates.find((e) => e.templateName === 'cross')?.satisfiable).toBe(true);
  });

  test('same-subject template (a@1 + b@1) is unsatisfiable in library diagnosis', () => {
    const lib = makeLib({
      templates: [
        { id: 't', name: 'same', body: '{{var::a@1}} {{var::b@1}}', sortOrder: 0, createdAt: 0, updatedAt: 0 },
      ],
      variableLists: [
        { id: 'la', name: 'a', sortOrder: 0, createdAt: 0, updatedAt: 0, options: [
          { id: 'am', listId: 'la', value: 'AM', sortOrder: 0, tagIds: ['modern'], weight: 1 },
        ] },
        { id: 'lb', name: 'b', sortOrder: 1, createdAt: 0, updatedAt: 0, options: [
          { id: 'br', listId: 'lb', value: 'BR', sortOrder: 0, tagIds: ['retro'], weight: 1 },
        ] },
      ],
      dimensions: [
        { id: 'era', name: 'Era', tags: [
          { id: 'modern', dimensionId: 'era', label: 'Modern', sortOrder: 0 },
          { id: 'retro', dimensionId: 'era', label: 'Retro', sortOrder: 1 },
        ] },
      ],
    });
    const out = diagnoseLibrary(lib);
    expect(out.templates.find((e) => e.templateName === 'same')?.satisfiable).toBe(false);
  });
});

import { describe, expect, test } from 'bun:test';
import { pickRescueTargetList } from './rescueTargetSelection';
import type { LibrarySnapshot } from './inferTypes';

// Snapshot scaffolding mirrors the patterns in diagnoseTemplateConflicts.test.ts.
// Tag idxs MUST be unique snapshot-globally. Dim names MUST be unique.

describe('pickRescueTargetList', () => {
  test('smallest viable list wins on tiebreak', () => {
    // Snapshot: ONE dimension D with tag v1 (idx 0). Three lists, each
    // with a single UNTAGGED option (no conflicts anywhere).
    // - Every list is viable (replacing any one with a wildcard keeps the
    //   template satisfiable — in fact, it was satisfiable to begin with
    //   since untagged options never conflict).
    // - Conflict edge counts are all 0 (each list has 1 option → 0 pairs).
    // - Domain sizes: A=1, B=2, C=3.
    // Expectation: smallest domain (A) wins on the tiebreak.
    const snap: LibrarySnapshot = {
      dimensions: [
        { idx: 0, id: 'D', name: 'D', tags: [
          { idx: 0, id: 't_v1', label: 'v1' },
        ] },
      ],
      lists: [
        { idx: 0, id: 'lA', name: 'A', options: [
          { idx: 0, id: 'a0', value: 'a0', weight: 1, tagIdxs: [] },
        ] },
        { idx: 1, id: 'lB', name: 'B', options: [
          { idx: 0, id: 'b0', value: 'b0', weight: 1, tagIdxs: [] },
          { idx: 1, id: 'b1', value: 'b1', weight: 1, tagIdxs: [] },
        ] },
        { idx: 2, id: 'lC', name: 'C', options: [
          { idx: 0, id: 'c0', value: 'c0', weight: 1, tagIdxs: [] },
          { idx: 1, id: 'c1', value: 'c1', weight: 1, tagIdxs: [] },
          { idx: 2, id: 'c2', value: 'c2', weight: 1, tagIdxs: [] },
        ] },
      ],
    };
    const out = pickRescueTargetList(snap, [{ listName: 'A', subject: null }, { listName: 'B', subject: null }, { listName: 'C', subject: null }]);
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error('expected ok');
    expect(out.listName).toBe('A');
  });

  test('manual-only options do not inflate the rescue domain-size tiebreak', () => {
    const snap: LibrarySnapshot = {
      dimensions: [],
      lists: [
        { idx: 0, id: 'lA', name: 'A', options: [
          { idx: 0, id: 'a0', value: 'a0', weight: 1, tagIdxs: [] },
          { idx: 1, id: 'a1', value: 'a1 manual', weight: 0, tagIdxs: [] },
          { idx: 2, id: 'a2', value: 'a2 manual', weight: 0, tagIdxs: [] },
        ] },
        { idx: 1, id: 'lB', name: 'B', options: [
          { idx: 0, id: 'b0', value: 'b0', weight: 1, tagIdxs: [] },
          { idx: 1, id: 'b1', value: 'b1', weight: 1, tagIdxs: [] },
        ] },
      ],
    };

    const out = pickRescueTargetList(snap, [
      { listName: 'A', subject: null },
      { listName: 'B', subject: null },
    ]);
    expect(out).toEqual({ ok: true, listName: 'A' });
  });

  test('ranking exhaustion retains a target with fully verified viability', () => {
    const snap: LibrarySnapshot = {
      dimensions: [{ idx: 0, id: 'd', name: 'D', tags: [
        { idx: 0, id: 'red', label: 'Red' }, { idx: 1, id: 'blue', label: 'Blue' },
      ] }],
      lists: [
        { idx: 0, id: 'a', name: 'A', options: Array.from({ length: 500 }, (_, idx) => ({
          idx, id: `a-${idx}`, value: `${idx}`, weight: 1, tagIdxs: [idx % 2],
        })) },
        { idx: 1, id: 'b', name: 'B', options: [{ idx: 0, id: 'bo', value: 'B', weight: 1, tagIdxs: [0] }] },
      ],
    };
    const budgetRef = { nodes: 0 };
    expect(pickRescueTargetList(snap, [
      { listName: 'A', subject: null }, { listName: 'B', subject: null },
    ], { nodeBudgetRef: budgetRef, totalBudget: 10 })).toEqual({ ok: true, listName: 'A' });
    expect(budgetRef.nodes).toBe(11);
  });

  for (const { totalBudget, expected } of [
    { totalBudget: 3, expected: { ok: false, reason: 'no-target' } },
    { totalBudget: 7, expected: { ok: true, listName: 'A' } },
  ] as const) {
    test(`viability exhaustion ${totalBudget === 3 ? 'cannot invent a target before a complete verdict' : 'retains an earlier fully verified target'}`, () => {
      const snap: LibrarySnapshot = {
        dimensions: [],
        lists: ['A', 'B'].map((name, idx) => ({
          idx, id: name, name,
          options: [{ idx: 0, id: `${name}-option`, value: name, weight: 1, tagIdxs: [] }],
        })),
      };
      const budgetRef = { nodes: 0 };
      expect(pickRescueTargetList(snap, [
        { listName: 'A', subject: null }, { listName: 'B', subject: null },
      ], { nodeBudgetRef: budgetRef, totalBudget })).toEqual(expected);
      expect(budgetRef.nodes).toBe(totalBudget + 1);
    });
  }

  test('a broken 500-option domain retains a verified rescue target within the default ranking budget', () => {
    const snap: LibrarySnapshot = {
      dimensions: [{ idx: 0, id: 'd', name: 'D', tags: [
        { idx: 0, id: 'red', label: 'Red' }, { idx: 1, id: 'blue', label: 'Blue' },
      ] }],
      lists: [
        { idx: 0, id: 'a', name: 'A', options: Array.from({ length: 500 }, (_, idx) => ({
          idx, id: `a-${idx}`, value: `${idx}`, weight: 1, tagIdxs: [0],
        })) },
        { idx: 1, id: 'b', name: 'B', options: [{ idx: 0, id: 'bo', value: 'B', weight: 1, tagIdxs: [1] }] },
      ],
    };
    expect(pickRescueTargetList(snap, [
      { listName: 'A', subject: null }, { listName: 'B', subject: null },
    ])).toEqual({ ok: true, listName: 'A' });
  });

  test('counterexample (finding #6) — picks B not A', () => {
    // A = {red}, B = {blue}, C = {red, green}, single dimension D.
    // Pairwise conflict on D: A.red vs B.blue (disjoint), B.blue vs
    // C.{red,green} (disjoint on EITHER C option), A.red vs C.red
    // (overlap → no conflict), A.red vs C.green (disjoint → conflict).
    // Template ['A','B','C'] is unsatisfiable — B.blue cannot coexist
    // with anything in C on D.
    //
    // Viability:
    //   - Remove A → wildcard,B,C: B.blue still conflicts with both
    //     C.red and C.green on D. NOT viable.
    //   - Remove B → A,wildcard,C: A.red + wildcard + C.red has no
    //     conflict (A.red == C.red overlap; wildcard has 0 tags). Viable.
    //   - Remove C → A,B,wildcard: A.red vs B.blue conflict. NOT viable.
    //
    // Only B is viable → algorithm must pick B, even though A has the
    // smallest domain (1 option). This is the counterexample.
    const snap: LibrarySnapshot = {
      dimensions: [
        { idx: 0, id: 'D', name: 'D', tags: [
          { idx: 0, id: 't_red', label: 'red' },
          { idx: 1, id: 't_blue', label: 'blue' },
          { idx: 2, id: 't_green', label: 'green' },
        ] },
      ],
      lists: [
        { idx: 0, id: 'lA', name: 'A', options: [
          { idx: 0, id: 'a_red', value: 'red', weight: 1, tagIdxs: [0] },
        ] },
        { idx: 1, id: 'lB', name: 'B', options: [
          { idx: 0, id: 'b_blue', value: 'blue', weight: 1, tagIdxs: [1] },
        ] },
        { idx: 2, id: 'lC', name: 'C', options: [
          { idx: 0, id: 'c_red', value: 'red', weight: 1, tagIdxs: [0] },
          { idx: 1, id: 'c_green', value: 'green', weight: 1, tagIdxs: [2] },
        ] },
      ],
    };
    const out = pickRescueTargetList(snap, [{ listName: 'A', subject: null }, { listName: 'B', subject: null }, { listName: 'C', subject: null }]);
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error('expected ok');
    expect(out.listName).toBe('B');
  });

  test('no viable target — no list exclusion leaves the rest satisfiable', () => {
    // Three lists in the template:
    //   - A and B have an unavoidable pairwise conflict on dimension D
    //     (A's only option tagged v1, B's only option tagged v2; disjoint).
    //   - C has zero options (already empty domain).
    //
    // Viability check:
    //   - Wildcard A: A gets a 0-tag wildcard, B unchanged, C still empty.
    //     templateSatisfiable returns false because C's domain is empty.
    //     NOT viable.
    //   - Wildcard B: symmetric, C still empty → NOT viable.
    //   - Wildcard C: C gets a 0-tag wildcard option (now non-empty), but
    //     A.v1 vs B.v2 still conflict on D regardless of C's wildcard.
    //     NOT viable.
    //
    // No viable target → returns { ok: false, reason: 'no-target' }.
    const snap: LibrarySnapshot = {
      dimensions: [
        { idx: 0, id: 'D', name: 'D', tags: [
          { idx: 0, id: 't_v1', label: 'v1' },
          { idx: 1, id: 't_v2', label: 'v2' },
        ] },
      ],
      lists: [
        { idx: 0, id: 'lA', name: 'A', options: [
          { idx: 0, id: 'a_v1', value: 'a_v1', weight: 1, tagIdxs: [0] },
        ] },
        { idx: 1, id: 'lB', name: 'B', options: [
          { idx: 0, id: 'b_v2', value: 'b_v2', weight: 1, tagIdxs: [1] },
        ] },
        { idx: 2, id: 'lC', name: 'C', options: [] },
      ],
    };
    const out = pickRescueTargetList(snap, [{ listName: 'A', subject: null }, { listName: 'B', subject: null }, { listName: 'C', subject: null }]);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('expected not ok');
    expect(out.reason).toBe('no-target');
  });
});

describe('pickRescueTargetList — occurrence-aware viability', () => {
  const occSnap: LibrarySnapshot = {
    dimensions: [{ idx: 0, id: 'era', name: 'Era', tags: [
      { idx: 0, id: 'modern', label: 'Modern' }, { idx: 1, id: 'retro', label: 'Retro' },
    ] }],
    lists: [
      { idx: 0, id: 'a', name: 'a', options: [{ idx: 0, id: 'am', value: 'AM', weight: 1, tagIdxs: [0] }] },
      { idx: 1, id: 'b', name: 'b', options: [{ idx: 0, id: 'br', value: 'BR', weight: 1, tagIdxs: [1] }] },
      { idx: 2, id: 'c', name: 'c', options: [{ idx: 0, id: 'cm', value: 'CM', weight: 1, tagIdxs: [0] }] },
    ],
  };

  test('same-subject conflict picks a viable bridging list', () => {
    // Subject 1 references a (modern), b (retro), c (modern).
    // Pairwise era conflicts: a↔b (modern/retro), b↔c (retro/modern). a↔c agree.
    // Wildcard-substitution viability:
    //   - wildcard(a): b(retro)↔c(modern) still conflict → a NOT viable.
    //   - wildcard(b): a(modern)↔c(modern) agree, wildcard bridges → b VIABLE.
    //   - wildcard(c): a(modern)↔b(retro) still conflict → c NOT viable.
    // Only `b` is viable — the algorithm must pick it.
    const occ = [
      { listName: 'a', subject: 1 }, { listName: 'b', subject: 1 }, { listName: 'c', subject: 1 },
    ];
    const out = pickRescueTargetList(occSnap, occ);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.listName).toBe('b');
  });

  test('cross-subject layout is not spuriously rejected', () => {
    // a@1 + b@2 are unconstrained → already satisfiable, but if rescue is still
    // invoked the selection must remain valid (any viable target or no-target,
    // never a crash / name-based misjudgement).
    const occ = [{ listName: 'a', subject: 1 }, { listName: 'b', subject: 2 }];
    const out = pickRescueTargetList(occSnap, occ);
    if (out.ok) {
      expect(typeof out.listName).toBe('string');
    } else {
      expect(out.reason).toBe('no-target');
    }
  });
});

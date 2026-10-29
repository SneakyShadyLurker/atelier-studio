import { describe, expect, test } from 'bun:test';
import { diagnoseTemplateConflicts, DIAGNOSIS_BUDGET_EXCEEDED_REASON } from './diagnoseTemplateConflicts';
import type { LibrarySnapshot, RawBundle } from './inferTypes';

// Snapshot scaffolding helpers --------------------------------------------
//
// Two shared snapshot shapes used across the four tests below. The
// `singleDim2Lists` snapshot has one dimension D with three tag values
// (v1, v2, v3), and lists A, B, C each holding ONE untagged option. The
// bundles drive `assignOptionTags` ops to attach disjoint tag values to
// the options — that's the only thing that creates the conflicts the
// algorithm has to diagnose.

const singleDim3ListsSnap: LibrarySnapshot = {
  dimensions: [
    { idx: 0, id: 'D', name: 'D', tags: [
      { idx: 0, id: 't_v1', label: 'v1' },
      { idx: 1, id: 't_v2', label: 'v2' },
      { idx: 2, id: 't_v3', label: 'v3' },
    ] },
  ],
  lists: [
    { idx: 0, id: 'lA', name: 'A', options: [{ idx: 0, id: 'a0', value: 'a_opt', weight: 1, tagIdxs: [] }] },
    { idx: 1, id: 'lB', name: 'B', options: [{ idx: 0, id: 'b0', value: 'b_opt', weight: 1, tagIdxs: [] }] },
    { idx: 2, id: 'lC', name: 'C', options: [{ idx: 0, id: 'c0', value: 'c_opt', weight: 1, tagIdxs: [] }] },
  ],
};

const singleDim2ListsSnap: LibrarySnapshot = {
  dimensions: [
    { idx: 0, id: 'D', name: 'D', tags: [
      { idx: 0, id: 't_v1', label: 'v1' },
      { idx: 1, id: 't_v2', label: 'v2' },
    ] },
  ],
  lists: [
    { idx: 0, id: 'lA', name: 'A', options: [{ idx: 0, id: 'a0', value: 'a_opt', weight: 1, tagIdxs: [] }] },
    { idx: 1, id: 'lB', name: 'B', options: [{ idx: 0, id: 'b0', value: 'b_opt', weight: 1, tagIdxs: [] }] },
  ],
};

describe('diagnoseTemplateConflicts', () => {
  test('500 real creation bundles exhaust the default budget without unbounded structural previews', () => {
    const bundles: RawBundle[] = Array.from({ length: 500 }, (_, idx) => ({
      key: `create:D${idx}`, dependsOn: [], ops: [{ op: 'createDimension', name: `D${idx}`, tags: ['a', 'b'] }],
    }));
    const snap: LibrarySnapshot = { dimensions: [], lists: [
      { idx: 0, id: 'filled', name: 'Filled', options: [{ idx: 0, id: 'o', value: 'v', weight: 1, tagIdxs: [] }] },
      { idx: 1, id: 'empty', name: 'Empty', options: [] },
    ] };
    const result = diagnoseTemplateConflicts(bundles, snap, [{ name: 'T', lists: ['Filled', 'Empty'] }]);
    expect(result).toEqual([{
      templateName: 'T', reason: DIAGNOSIS_BUDGET_EXCEEDED_REASON,
      culpritBundleKeys: [], rescueAttempted: false, culpritKind: 'non-local',
    }]);
  }, 30000);

  test('diagnosis ignores commented missing and conflicting variables', () => {
    const bundles: RawBundle[] = [{ key: 'assign', dependsOn: [], ops: [
      { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'D', label: 'v1' }] },
      { op: 'assignOptionTags', listIdx: 1, optionIdx: 0, tags: [{ dimName: 'D', label: 'v2' }] },
    ] }];
    expect(diagnoseTemplateConflicts(bundles, singleDim2ListsSnap, [{
      name: 'T', lists: ['A'], body: '{{var::A}}{{// {{var::B}} {{var::Missing}} }}',
    }])).toEqual([]);
  });

  test('stops a 500-bundle subset search at a tiny budget with the canonical exhaustion result', () => {
    const bundles: RawBundle[] = Array.from({ length: 500 }, (_, idx) => ({
      key: `independent-${idx}`, dependsOn: [], ops: [],
    }));
    const snap: LibrarySnapshot = { dimensions: [], lists: [
      { idx: 0, id: 'empty', name: 'Empty', options: [] },
      { idx: 1, id: 'other', name: 'Other', options: [] },
    ] };
    expect(diagnoseTemplateConflicts(bundles, snap, [{ name: 'T', lists: ['Empty', 'Other'] }], {
      totalNodeBudget: 510, maxCulpritSubsetSize: 4,
    })).toEqual([{
      templateName: 'T', reason: DIAGNOSIS_BUDGET_EXCEEDED_REASON,
      culpritBundleKeys: [], rescueAttempted: false, culpritKind: 'non-local',
    }]);
  });

  test('Test A — single-bundle culprit (common case)', () => {
    // Template refs A and B; each option gets a disjoint tag on D from a
    // separate bundle. Removing either bundle leaves only one tagged
    // option (the other is a wildcard) → satisfiable. First-match wins,
    // so the algorithm should pick the FIRST bundle in iteration order.
    const rawBundles: RawBundle[] = [
      { key: 'bX', dependsOn: [], ops: [
        { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'D', label: 'v1' }] },
      ] },
      { key: 'bY', dependsOn: [], ops: [
        { op: 'assignOptionTags', listIdx: 1, optionIdx: 0, tags: [{ dimName: 'D', label: 'v2' }] },
      ] },
    ];
    const out = diagnoseTemplateConflicts(
      rawBundles,
      singleDim2ListsSnap,
      [{ name: 'T', lists: ['A', 'B'] }],
    );
    expect(out).toHaveLength(1);
    const conflict = out[0];
    if (!conflict) throw new Error('expected one conflict');
    expect(conflict.templateName).toBe('T');
    expect(conflict.culpritKind).toBe('local');
    expect(conflict.culpritBundleKeys).toHaveLength(1);
    expect(conflict.culpritBundleKeys[0]).toBe('bX'); // first-match wins
    expect(conflict.rescueAttempted).toBe(false);
    expect(conflict.reason).toContain('A, B');
  });

  test('Test B — counterexample, two-bundle culprit', () => {
    // Template refs A, B, C; each option gets a DISJOINT tag value on the
    // single dimension D. Removing ANY ONE bundle leaves two options with
    // disjoint tag values (e.g. {v2, v3}) → still unsatisfiable. Removing
    // any TWO leaves a single tagged option (other two wildcards) →
    // satisfiable. Algorithm must find a 2-bundle culprit.
    const rawBundles: RawBundle[] = [
      { key: 'bX', dependsOn: [], ops: [
        { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'D', label: 'v1' }] },
      ] },
      { key: 'bY', dependsOn: [], ops: [
        { op: 'assignOptionTags', listIdx: 1, optionIdx: 0, tags: [{ dimName: 'D', label: 'v2' }] },
      ] },
      { key: 'bZ', dependsOn: [], ops: [
        { op: 'assignOptionTags', listIdx: 2, optionIdx: 0, tags: [{ dimName: 'D', label: 'v3' }] },
      ] },
    ];
    const out = diagnoseTemplateConflicts(
      rawBundles,
      singleDim3ListsSnap,
      [{ name: 'T', lists: ['A', 'B', 'C'] }],
    );
    expect(out).toHaveLength(1);
    const conflict = out[0];
    if (!conflict) throw new Error('expected one conflict');
    expect(conflict.templateName).toBe('T');
    expect(conflict.culpritKind).toBe('local');
    expect(conflict.culpritBundleKeys).toHaveLength(2);
    // First combination of size 2 in (bX,bY,bZ) order is (bX,bY).
    expect(conflict.culpritBundleKeys).toEqual(['bX', 'bY']);
    expect(conflict.rescueAttempted).toBe(false);
  });

  test('Test C — non-local fallback when subset cap is too small', () => {
    // Same setup as Test B but maxCulpritSubsetSize=1 forces non-local.
    const rawBundles: RawBundle[] = [
      { key: 'bX', dependsOn: [], ops: [
        { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'D', label: 'v1' }] },
      ] },
      { key: 'bY', dependsOn: [], ops: [
        { op: 'assignOptionTags', listIdx: 1, optionIdx: 0, tags: [{ dimName: 'D', label: 'v2' }] },
      ] },
      { key: 'bZ', dependsOn: [], ops: [
        { op: 'assignOptionTags', listIdx: 2, optionIdx: 0, tags: [{ dimName: 'D', label: 'v3' }] },
      ] },
    ];
    const out = diagnoseTemplateConflicts(
      rawBundles,
      singleDim3ListsSnap,
      [{ name: 'T', lists: ['A', 'B', 'C'] }],
      { maxCulpritSubsetSize: 1 },
    );
    expect(out).toHaveLength(1);
    const conflict = out[0];
    if (!conflict) throw new Error('expected one conflict');
    expect(conflict.templateName).toBe('T');
    expect(conflict.culpritKind).toBe('non-local');
    expect(conflict.culpritBundleKeys).toEqual([]);
    expect(conflict.reason).toContain('culprit set larger than diagnosis bound');
  });

  test('Test E — empty-list template charges budget (no unmetered outer search)', () => {
    // Pathological: a template references a list (B) that exists but has
    // ZERO options. `templateSatisfiable` returns false in that case, so
    // every subset attempt in Phase 1/2 produces a 'still unsat' answer
    // and the algorithm tries every combination up to maxSubsetSize.
    // Before Fix 1, the empty-domain early return did NOT charge the
    // shared budget, so Phase 1/2 enumeration ran with effectively zero
    // budget consumption per SAT call — pegging the event loop.
    // Post-Fix 1, every templateSatisfiable call charges 1 node BEFORE
    // the empty-domain check, AND every subset attempt charges 1 node
    // before invoking the solver. With a tight budget the algorithm must
    // give up quickly and return culpritKind:'non-local' with 'budget' in
    // the reason.
    const emptyListSnap: LibrarySnapshot = {
      dimensions: [
        { idx: 0, id: 'D', name: 'D', tags: [
          { idx: 0, id: 't_v1', label: 'v1' },
          { idx: 1, id: 't_v2', label: 'v2' },
        ] },
      ],
      lists: [
        { idx: 0, id: 'lA', name: 'A', options: [{ idx: 0, id: 'a0', value: 'a_opt', weight: 1, tagIdxs: [] }] },
        // B is referenced by the template but has zero options.
        { idx: 1, id: 'lB', name: 'B', options: [] },
      ],
    };
    // 30 no-op bundles → 30 single-elim attempts + C(30,2)=435 size-2
    // attempts + ... up to maxCulpritSubsetSize=4. Without budget
    // metering on the outer loop, that's an unbounded grind.
    const rawBundles: RawBundle[] = Array.from({ length: 30 }, (_, i) => ({
      key: `b${i}`,
      dependsOn: [],
      ops: [],
    }));
    const start = performance.now();
    const out = diagnoseTemplateConflicts(
      rawBundles,
      emptyListSnap,
      [{ name: 'T', lists: ['A', 'B'] }],
      { totalNodeBudget: 50 },
    );
    const elapsedMs = performance.now() - start;
    expect(out).toHaveLength(1);
    const conflict = out[0];
    if (!conflict) throw new Error('expected one conflict');
    expect(conflict.templateName).toBe('T');
    expect(conflict.culpritKind).toBe('non-local');
    // No-op bundles can never restore satisfiability (B is empty), so no
    // culprit subset exists; with metered subset enumeration the algorithm
    // exhausts the budget and emits the non-local "larger than diagnosis
    // bound" sentinel. The pre-Fix-1 behaviour was the same SHAPE of
    // output, but with unmetered outer enumeration it took O(C(N,k))
    // SAT calls instead of stopping at the budget.
    expect(conflict.culpritBundleKeys).toEqual([]);
    expect(conflict.reason.toLowerCase()).toMatch(/diagnosis bound|budget/);
    // With proper metering, the call returns within milliseconds even for
    // a deliberately pathological input. Generous threshold so CI noise
    // doesn't flake — the unmetered baseline would take seconds.
    expect(elapsedMs).toBeLessThan(500);
  });

  test('Test D — budget exhaustion across multiple templates', () => {
    // Two failing templates. With a very small totalNodeBudget, the first
    // template gets its diagnosis (uses some budget) and the second hits
    // the budget check and is reported as non-local with 'budget' in the
    // reason. The first template's diagnosis must succeed within budget.
    const rawBundles: RawBundle[] = [
      { key: 'bX', dependsOn: [], ops: [
        { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'D', label: 'v1' }] },
      ] },
      { key: 'bY', dependsOn: [], ops: [
        { op: 'assignOptionTags', listIdx: 1, optionIdx: 0, tags: [{ dimName: 'D', label: 'v2' }] },
      ] },
    ];
    // Provide a budget that comfortably covers ONE template's diagnosis
    // (initial passWithAll + single-elimination ~2-3 SAT calls) but is
    // exhausted during the second template. Each structural preview costs 20
    // units for these two bundles and seven source/result snapshot entries.
    const out = diagnoseTemplateConflicts(
      rawBundles,
      singleDim2ListsSnap,
      [
        { name: 'T1', lists: ['A', 'B'] },
        { name: 'T2', lists: ['A', 'B'] },
      ],
      { totalNodeBudget: 35 },
    );
    expect(out).toHaveLength(2);
    const [t1, t2] = out;
    if (!t1 || !t2) throw new Error('expected two conflicts');
    expect(t1.templateName).toBe('T1');
    expect(t1.culpritKind).toBe('local');
    expect(t1.culpritBundleKeys).toEqual(['bX']);
    expect(t2.templateName).toBe('T2');
    expect(t2.culpritKind).toBe('non-local');
    expect(t2.reason).toContain('budget');
  });
});

// ---------------------------------------------------------------------------
// Branch-aware tests
// ---------------------------------------------------------------------------
//
// Fixture: two lists A and B on a single dimension D with tags v1 and v2.
// Bundle bX assigns v1 to A's option, bundle bY assigns v2 to B's option.
// With both bundles applied, A and B conflict (disjoint tag values on D).
//
// Branch-aware bodies let us isolate one branch that references both lists
// (conflicting) from another that references only one (satisfiable), verifying
// that the algorithm correctly attributes the failure to the failing branch
// and reports no conflict for the passing branch.

describe('diagnoseTemplateConflicts — branch-aware (body provided)', () => {
  // Reuse singleDim2ListsSnap from the outer scope — available in the same
  // file via closure.
  const rawBundles: RawBundle[] = [
    { key: 'bX', dependsOn: [], ops: [
      { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'D', label: 'v1' }] },
    ] },
    { key: 'bY', dependsOn: [], ops: [
      { op: 'assignOptionTags', listIdx: 1, optionIdx: 0, tags: [{ dimName: 'D', label: 'v2' }] },
    ] },
  ];

  test('branch 0 conflicts, branch 1 is satisfiable → one conflict attributed to branch 0', () => {
    // Branch 0: references both A and B → conflict (disjoint tags on D).
    // Branch 1: references only A → satisfiable (< 2 lists, no pairwise constraint).
    const body = '{{random::{{var::A}} {{var::B}}::{{var::A}}}}';
    const out = diagnoseTemplateConflicts(rawBundles, singleDim2ListsSnap, [
      { name: 'Mixed', lists: ['A', 'B'], body },
    ]);
    expect(out).toHaveLength(1);
    const conflict = out[0];
    if (!conflict) throw new Error('expected one conflict');
    expect(conflict.templateName).toBe('Mixed');
    expect(conflict.inBranch).toBe(0);
    expect(conflict.totalBranches).toBe(2);
    expect(conflict.culpritKind).toBe('local');
  });

  test('every branch independently satisfiable → no conflicts', () => {
    // Branch 0: only A → satisfiable.
    // Branch 1: only B → satisfiable.
    const body = '{{random::{{var::A}}::{{var::B}}}}';
    const out = diagnoseTemplateConflicts(rawBundles, singleDim2ListsSnap, [
      { name: 'OK', lists: ['A', 'B'], body },
    ]);
    expect(out).toEqual([]);
  });

  test('body with no randoms (single shape) that conflicts — no inBranch/totalBranches', () => {
    // Single shape references both A and B → conflict; no randoms so
    // shapes.length === 1 → inBranch/totalBranches must be absent.
    const body = '{{var::A}} {{var::B}}';
    const out = diagnoseTemplateConflicts(rawBundles, singleDim2ListsSnap, [
      { name: 'NoRandom', lists: ['A', 'B'], body },
    ]);
    expect(out).toHaveLength(1);
    const conflict = out[0];
    if (!conflict) throw new Error('expected one conflict');
    expect(conflict.inBranch).toBeUndefined();
    expect(conflict.totalBranches).toBeUndefined();
  });

  test('body with no randoms (single shape) that is satisfiable → no conflicts', () => {
    // Single shape references only A → satisfiable.
    const body = '{{var::A}} some static text';
    const out = diagnoseTemplateConflicts(rawBundles, singleDim2ListsSnap, [
      { name: 'NoRandomOK', lists: ['A'], body },
    ]);
    expect(out).toEqual([]);
  });

  test('backward compat — TemplateRefs without body uses pre-extracted lists', () => {
    // Legacy caller: no body, lists=['A','B'], both disjointly tagged → conflict.
    const out = diagnoseTemplateConflicts(rawBundles, singleDim2ListsSnap, [
      { name: 'Legacy', lists: ['A', 'B'] },
    ]);
    expect(out).toHaveLength(1);
    const conflict = out[0];
    if (!conflict) throw new Error('expected one conflict');
    expect(conflict.templateName).toBe('Legacy');
    expect(conflict.inBranch).toBeUndefined();
    expect(conflict.totalBranches).toBeUndefined();
  });

  test('branch 1 conflicts, branch 0 is satisfiable → one conflict attributed to branch 1', () => {
    // Branch 0: only A → satisfiable.
    // Branch 1: both A and B → conflict.
    // Verifies attribution to the correct (first failing) branch index.
    const body = '{{random::{{var::A}}::{{var::A}} {{var::B}}}}';
    const out = diagnoseTemplateConflicts(rawBundles, singleDim2ListsSnap, [
      { name: 'MixedRev', lists: ['A', 'B'], body },
    ]);
    expect(out).toHaveLength(1);
    const conflict = out[0];
    if (!conflict) throw new Error('expected one conflict');
    expect(conflict.templateName).toBe('MixedRev');
    expect(conflict.inBranch).toBe(1);
    expect(conflict.totalBranches).toBe(2);
  });
});

describe('diagnoseTemplateConflicts subject awareness', () => {
  const subjectSnap: LibrarySnapshot = {
    dimensions: [{ idx: 0, id: 'era', name: 'Era', tags: [{ idx: 0, id: 'modern', label: 'Modern' }, { idx: 1, id: 'retro', label: 'Retro' }] }],
    lists: [
      { idx: 0, id: 'a', name: 'a', options: [{ idx: 0, id: 'am', value: 'AM', weight: 1, tagIdxs: [0] }] },
      { idx: 1, id: 'b', name: 'b', options: [{ idx: 1, id: 'br', value: 'BR', weight: 1, tagIdxs: [1] }] },
    ],
  };

  test('a@1 + b@2 (cross-subject) reports no conflict', () => {
    const out = diagnoseTemplateConflicts([], subjectSnap, [
      { name: 'cross', lists: ['a', 'b'], body: '{{var::a@1}} {{var::b@2}}' },
    ]);
    expect(out).toEqual([]);
  });

  test('a@1 + b@1 (same subject, disjoint tags) reports a conflict', () => {
    const out = diagnoseTemplateConflicts([], subjectSnap, [
      { name: 'same', lists: ['a', 'b'], body: '{{var::a@1}} {{var::b@1}}' },
    ]);
    expect(out.length).toBe(1);
    expect(out[0]?.templateName).toBe('same');
  });
});

test('costly culprit search cannot contaminate later full-proposal SAT verdicts', () => {
  const bundles: RawBundle[] = Array.from({ length: 40 }, (_, idx) => ({
    key: `create:D${idx}`, dependsOn: [], ops: [{ op: 'createDimension', name: `D${idx}`, tags: ['a', 'b'] }],
  }));
  const snap: LibrarySnapshot = { dimensions: [], lists: [
    { idx: 0, id: 'a', name: 'A', options: [{ idx: 0, id: 'oa', value: 'a', weight: 1, tagIdxs: [] }] },
    { idx: 1, id: 'b', name: 'B', options: [{ idx: 0, id: 'ob', value: 'b', weight: 1, tagIdxs: [] }] },
    { idx: 2, id: 'empty', name: 'Empty', options: [] },
  ] };
  const templates = [
    { name: 'Early UNSAT', lists: ['A', 'Empty'], body: '{{var::A}}{{var::Empty}}' },
    { name: 'Later SAT', lists: ['A', 'B'], body: '{{var::A}}{{var::B}}' },
  ];
  const result = diagnoseTemplateConflicts(bundles, snap, templates);
  expect(result.map((conflict) => conflict.templateName)).toEqual(['Early UNSAT']);
  expect(result[0]?.reason).toBe(DIAGNOSIS_BUDGET_EXCEEDED_REASON);
  // Keep global verdict exhaustion conservative independently of search.
  expect(diagnoseTemplateConflicts([], snap, templates, { totalNodeBudget: 1 }).map((conflict) => conflict.templateName))
    .toEqual(['Early UNSAT', 'Later SAT']);
});

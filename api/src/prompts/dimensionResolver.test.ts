import { describe, expect, test } from 'bun:test';
import { resolveProposal, resolveProposalForInference, INFERENCE_VALIDATION_BUDGET_REASON, applyBundlesToSnapshot, __resolverTest } from './dimensionResolver';
import type { LibrarySnapshot, RawBundle, RawInferOp } from './inferTypes';
import { templateSatisfiable } from './dimensionCoherence';
import { dependenciesForTagReferences } from './bundleOperations';
import { bundleClosure } from './closureWalk';
import { diagnoseTemplateConflicts, DIAGNOSIS_BUDGET_EXCEEDED_REASON } from './diagnoseTemplateConflicts';

function req<T>(value: T | undefined, message = 'expected value'): T {
  if (value === undefined) throw new Error(message);
  return value;
}

const snap: LibrarySnapshot = {
  dimensions: [{ idx: 0, id: 'd0', name: 'Era', tags: [{ idx: 0, id: 'tg0', label: 'Ancient' }] }],
  lists: [{ idx: 0, id: 'l0', name: 'Races', options: [
    { idx: 0, id: 'o0', value: 'Orc', weight: 1, tagIdxs: [] },
    { idx: 1, id: 'o1', value: 'Orion', weight: 1, tagIdxs: [] },
  ] }],
};

describe('inference safe normalization', () => {
  const original: LibrarySnapshot = {
    dimensions: [{ idx: 0, id: 'era', name: 'Era', tags: [
      { idx: 0, id: 'parent', label: 'parent' },
      { idx: 1, id: 'child', label: 'child', parentIdx: 0 },
    ] }],
    lists: [{ idx: 0, id: 'list', name: 'L', options: [
      { idx: 0, id: 'option', value: 'v', weight: 1, tagIdxs: [], excludeTagIdxs: [0] },
    ] }],
  };
  const bad: RawInferOp = { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'Era', label: 'child' }] };

  test('keeps independent valid bundles and rejects an ancestor-overlapping assignment without changing the raw resolver', () => {
    const ops: RawInferOp[] = [bad, { op: 'createDimension', name: 'Mood', tags: ['happy'] }];
    expect(resolveProposal(ops, original).rejected).toEqual([]);
    const result = resolveProposalForInference(ops, original);
    expect(result.rawBundles.map((bundle) => bundle.key)).toEqual(['create:Mood']);
    expect(result.rejected).toEqual([{ reason: 'the same tag cannot be both require and exclude', count: 1 }]);
    expect(result.preview).toEqual(applyBundlesToSnapshot(original, result.rawBundles));
    expect(original.dimensions).toHaveLength(1);
    const none = resolveProposalForInference([bad], original);
    expect(none.display).toEqual([]);
    expect(none.rejected).toEqual(result.rejected);
  });

  test('valid final repairs win even with no fallback budget', () => {
    const repaired = resolveProposalForInference([bad, {
      op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'Era', label: 'parent' }],
    }], original, { previewWorkBudget: 0 });
    expect(repaired.rejected).toEqual([]);
    expect(repaired.rawBundles[0]?.opOrder).toEqual([0, 1]);
    expect(repaired.preview.lists[0]?.options[0]?.excludeTagIdxs ?? []).toEqual([]);
  });

  test('fallback accepts dependency cycles as complete closures and preserves operation order', () => {
    const result = resolveProposalForInference([
      { op: 'createDimension', name: 'X', tags: ['x'] },
      { op: 'createDimension', name: 'Y', tags: ['y'] },
      { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'X', label: 'x' }, { dimName: 'Y', label: 'y' }] },
      { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'Y', label: 'y' }, { dimName: 'X', label: 'x' }] },
      bad,
    ], original);
    expect(result.rejected.map((item) => item.count)).toEqual([1]);
    expect(result.rawBundles.map((bundle) => bundle.key)).toEqual(['create:X', 'create:Y']);
    expect(result.rawBundles[0]?.dependsOn).toContain('create:Y');
    expect(result.rawBundles[1]?.dependsOn).toContain('create:X');
    expect(bundleClosure(result.rawBundles, ['create:X'])).toEqual(result.rawBundles);
    expect(result.rawBundles.map((bundle) => bundle.opOrder)).toEqual([[0, 2], [1, 3]]);
    expect(result.preview).toEqual(applyBundlesToSnapshot(original, result.rawBundles));
  });

  test('reevaluates an earlier failed merge when a later accepted closure repairs it', () => {
    const snapshot: LibrarySnapshot = {
      dimensions: [
        { idx: 0, id: 'from', name: 'From', tags: [{ idx: 0, id: 'p', label: 'parent' }, { idx: 1, id: 'c', label: 'child', parentIdx: 0 }] },
        { idx: 1, id: 'into', name: 'Into', tags: [{ idx: 2, id: 'target', label: 'parent' }] },
        { idx: 2, id: 'bad', name: 'Bad', tags: [{ idx: 3, id: 'bp', label: 'parent' }, { idx: 4, id: 'bc', label: 'child', parentIdx: 3 }] },
      ],
      lists: [{ idx: 0, id: 'l', name: 'L', options: [
        { idx: 0, id: 'o0', value: 'v0', weight: 1, tagIdxs: [1], excludeTagIdxs: [2] },
        { idx: 1, id: 'o1', value: 'v1', weight: 1, tagIdxs: [], excludeTagIdxs: [3] },
      ] }],
    };
    const result = resolveProposalForInference([
      { op: 'mergeDimensions', fromIdx: 0, intoIdx: 1, tagMap: {} },
      { op: 'createDimension', name: 'New', tags: ['new'] },
      { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'Into', label: 'parent' }, { dimName: 'New', label: 'new' }] },
      { op: 'assignOptionTags', listIdx: 0, optionIdx: 1, tags: [{ dimName: 'Bad', label: 'child' }] },
    ], snapshot);
    expect(result.rawBundles.map((bundle) => bundle.key)).toEqual(['merge:from', 'create:New']);
    expect(result.rawBundles[1]?.dependsOn).toContain('merge:from');
    expect(result.rejected.map((item) => item.count)).toEqual([1]);
    expect(result.preview.dimensions.some((dimension) => dimension.id === 'from')).toBe(false);
    expect(result.preview.lists[0]?.options[0]?.excludeTagIdxs ?? []).toEqual([]);
  });

  test('large dense membership bags bound fallback work and report exhaustion explicitly', () => {
    const dense = structuredClone(original);
    const required: number[] = []; const excluded: number[] = [];
    for (let dimIdx = 1; dimIdx <= 20; dimIdx += 1) {
      const root = dimIdx * 100;
      const tags: LibrarySnapshot['dimensions'][number]['tags'] = [{ idx: root, id: `t${root}`, label: 'root' }];
      for (let child = 1; child <= 28; child += 1) {
        tags.push({ idx: root + child, id: `t${root + child}`, label: `child${child}`, parentIdx: root });
        (child <= 14 ? required : excluded).push(root + child);
      }
      dense.dimensions.push({ idx: dimIdx, id: `d${dimIdx}`, name: `D${dimIdx}`, tags });
    }
    req(dense.lists[0]).options = Array.from({ length: 100 }, (_, idx) => ({
      idx, id: `o${idx}`, value: `v${idx}`, weight: 1, tagIdxs: [...required], excludeTagIdxs: [0, ...excluded],
    }));
    const result = resolveProposalForInference([bad, { op: 'createDimension', name: 'Good', tags: ['good'] }], dense,
      { previewWorkBudget: 40_000 });
    expect(result.rawBundles).toEqual([]);
    expect(result.rejected).toEqual([{ reason: INFERENCE_VALIDATION_BUDGET_REASON, count: 2 }]);
  });

  test('retries an earlier assignment after an independent accepted bundle repairs its final state', () => {
    const snapshot = structuredClone(original);
    snapshot.dimensions.push({ idx: 1, id: 'bad', name: 'Bad', tags: [
      { idx: 2, id: 'bp', label: 'parent' }, { idx: 3, id: 'bc', label: 'child', parentIdx: 2 },
    ] });
    req(snapshot.lists[0]).options.push({ idx: 1, id: 'other', value: 'other', weight: 1, tagIdxs: [], excludeTagIdxs: [2] });
    const result = resolveProposalForInference([
      bad,
      { op: 'createDimension', name: 'Repair', tags: ['repair'] },
      { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'Era', label: 'parent' }, { dimName: 'Repair', label: 'repair' }] },
      { op: 'assignOptionTags', listIdx: 0, optionIdx: 1, tags: [{ dimName: 'Bad', label: 'child' }] },
    ], snapshot);
    expect(result.rawBundles.map((bundle) => bundle.key)).toEqual(['extend:era', 'create:Repair']);
    expect(result.rawBundles[1]?.dependsOn).toEqual([]);
    expect(result.rejected.map((item) => item.count)).toEqual([1]);
    expect(result.preview.lists[0]?.options[0]?.excludeTagIdxs ?? []).toEqual([]);
  });

  test('many independent candidates stop at the budget while retaining validated work', () => {
    const ops: RawInferOp[] = [bad, ...Array.from({ length: 500 }, (_, idx): RawInferOp => ({
      op: 'createDimension', name: `Good${idx}`, tags: ['good'],
    }))];
    const result = resolveProposalForInference(ops, original, { previewWorkBudget: 10_000 });
    expect(result.rawBundles.map((bundle) => bundle.key)).toEqual(['create:Good0', 'create:Good1']);
    expect(result.rejected).toEqual([{ reason: INFERENCE_VALIDATION_BUDGET_REASON, count: 499 }]);
    expect(result.preview).toEqual(applyBundlesToSnapshot(original, result.rawBundles));
  });
});

describe('merged tag supplier identity', () => {
  const original: LibrarySnapshot = {
    dimensions: [
      { idx: 0, id: 'A', name: 'A', tags: [{ idx: 0, id: 'a', label: 'a' }] },
      { idx: 1, id: 'B', name: 'B', tags: [{ idx: 1, id: 'b', label: 'b' }] },
      { idx: 2, id: 'C', name: 'C', tags: [{ idx: 2, id: 'c', label: 'c' }] },
      { idx: 3, id: 'Bad', name: 'Bad', tags: [
        { idx: 3, id: 'parent', label: 'parent' }, { idx: 4, id: 'child', label: 'child', parentIdx: 3 },
      ] },
    ],
    lists: [{ idx: 0, id: 'L', name: 'L', options: [
      { idx: 0, id: 'o0', value: 'v0', weight: 1, tagIdxs: [] },
      { idx: 1, id: 'o1', value: 'v1', weight: 1, tagIdxs: [] },
      { idx: 2, id: 'o2', value: 'v2', weight: 1, tagIdxs: [], excludeTagIdxs: [3] },
    ] }],
  };
  const bad: RawInferOp = { op: 'assignOptionTags', listIdx: 0, optionIdx: 2, tags: [{ dimName: 'Bad', label: 'child' }] };

  for (const chained of [false, true]) {
    for (const mergedFirst of [false, true]) {
      for (const fallback of [false, true]) {
        test(`actual merge supplier resolves all dependencies (chained=${chained}, merged first=${mergedFirst}, fallback=${fallback})`, () => {
          const ops: RawInferOp[] = [{ op: 'mergeDimensions', fromIdx: 0, intoIdx: 1, tagMap: {} }];
          if (chained) ops.push({ op: 'mergeDimensions', fromIdx: 1, intoIdx: 2, tagMap: { a: 'remapped' } });
          ops.push({ op: 'createDimension', name: 'X', tags: ['x'] });
          const merged = { dimName: chained ? 'A' : 'B', label: 'a' };
          const created = { dimName: 'X', label: 'x' };
          ops.push({ op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: mergedFirst ? [merged, created] : [created, merged] });
          if (fallback) ops.push(bad);
          const result = resolveProposalForInference(ops, original);
          expect(result.rejected).toEqual(fallback ? [{ reason: 'the same tag cannot be both require and exclude', count: 1 }] : []);
          const keys = new Set(result.rawBundles.map((bundle) => bundle.key));
          expect(keys).toEqual(new Set(chained ? ['merge:A', 'merge:B', 'create:X'] : ['merge:A', 'create:X']));
          for (const bundle of [...result.rawBundles, ...result.display]) {
            for (const dependency of bundle.dependsOn) expect(keys.has(dependency)).toBe(true);
          }
          const hostKey = mergedFirst ? (chained ? 'merge:B' : 'merge:A') : 'create:X';
          const host = req(result.rawBundles.find((bundle) => bundle.key === hostKey));
          expect(host.opOrder).toEqual(chained ? (mergedFirst ? [1, 3] : [2, 3]) : (mergedFirst ? [0, 2] : [1, 2]));
          expect(result.display.find((bundle) => bundle.key === hostKey)?.kind).toBe(mergedFirst ? 'merge' : 'create');
          expect(host.dependsOn).toContain(mergedFirst ? 'create:X' : (chained ? 'merge:B' : 'merge:A'));
          const assignment = req(host.ops.find((op) => op.op === 'assignOptionTags'));
          const targetRef = { dimName: chained ? 'C' : 'B', label: chained ? 'remapped' : 'a' };
          expect(assignment.tags).toEqual(mergedFirst ? [targetRef, created] : [created, targetRef]);
          const selected = bundleClosure(result.rawBundles, [hostKey]);
          expect(new Set(selected.map((bundle) => bundle.key))).toEqual(keys);
          const preview = applyBundlesToSnapshot(original, selected);
          const targetTag = req(req(preview.dimensions.find((dimension) => dimension.name === targetRef.dimName)).tags.find((tag) => tag.label === targetRef.label));
          const newTag = req(req(preview.dimensions.find((dimension) => dimension.name === 'X')).tags[0]);
          expect(req(req(preview.lists[0]).options[0]).tagIdxs.toSorted((a, b) => a - b)).toEqual([targetTag.idx, newTag.idx].toSorted((a, b) => a - b));
          expect(result.preview).toEqual(preview);
        });
      }
    }
  }

  test('opposite tag orders form an atomic merge/create cycle without phantom suppliers during fallback', () => {
    const result = resolveProposalForInference([
      { op: 'mergeDimensions', fromIdx: 0, intoIdx: 1, tagMap: {} },
      { op: 'createDimension', name: 'X', tags: ['x'] },
      { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'X', label: 'x' }, { dimName: 'B', label: 'a' }] },
      { op: 'assignOptionTags', listIdx: 0, optionIdx: 1, tags: [{ dimName: 'B', label: 'a' }, { dimName: 'X', label: 'x' }] },
      bad,
    ], original);
    expect(result.rejected).toEqual([{ reason: 'the same tag cannot be both require and exclude', count: 1 }]);
    expect(result.rawBundles.map((bundle) => ({ key: bundle.key, dependsOn: bundle.dependsOn, opOrder: bundle.opOrder }))).toEqual([
      { key: 'merge:A', dependsOn: ['create:X'], opOrder: [0, 3] },
      { key: 'create:X', dependsOn: ['merge:A'], opOrder: [1, 2] },
    ]);
    expect(result.display.map((bundle) => bundle.kind)).toEqual(['merge', 'create']);
    expect(bundleClosure(result.rawBundles, ['create:X'])).toEqual(result.rawBundles);
    expect(bundleClosure(result.rawBundles, ['merge:A'])).toEqual(result.rawBundles);
    expect(result.preview.lists[0]?.options[0]?.tagIdxs.toSorted()).toEqual(result.preview.lists[0]?.options[1]?.tagIdxs.toSorted());
    expect(result.preview.lists[0]?.options[0]?.tagIdxs).toHaveLength(2);
    expect(result.preview).toEqual(applyBundlesToSnapshot(original, result.rawBundles));
  });
});

test('rescue reference prerequisites preserve actual raw keys and exclude unrelated suppliers', () => {
  const original: LibrarySnapshot = { dimensions: [
    { idx: 0, id: 'a', name: 'A', tags: [{ id: 'ta', idx: 0, label: 'a' }] },
    { idx: 1, id: 'b', name: 'B', tags: [{ id: 'tb', idx: 1, label: 'b' }] },
    { idx: 2, id: 'c', name: 'C', tags: [] },
  ], lists: [] };
  const scenarios: { ops: RawInferOp[]; ref: { dimName: string; label: string }; needed: number[] }[] = [
    { ops: [{ op: 'createDimension', name: 'X', tags: ['x'] }], ref: { dimName: 'X', label: 'x' }, needed: [0] },
    { ops: [{ op: 'addTags', dimIdx: 0, tags: ['x'] }], ref: { dimName: 'A', label: 'x' }, needed: [0] },
    { ops: [{ op: 'renameDimension', dimIdx: 0, newName: 'X' }], ref: { dimName: 'X', label: 'a' }, needed: [0] },
    { ops: [{ op: 'mergeDimensions', fromIdx: 0, intoIdx: 1, tagMap: { a: 'x' } }], ref: { dimName: 'B', label: 'x' }, needed: [0] },
    { ops: [
      { op: 'mergeDimensions', fromIdx: 0, intoIdx: 1, tagMap: { a: 'x' } },
      { op: 'mergeDimensions', fromIdx: 1, intoIdx: 2, tagMap: { x: 'z' } },
      { op: 'createDimension', name: 'B', tags: ['reused'] },
    ], ref: { dimName: 'B', label: 'reused' }, needed: [0, 1, 2] },
  ];
  for (const scenario of scenarios) {
    const bundles: RawBundle[] = scenario.ops.map((op, index) => ({ key: `actual opaque key ${index}`, ops: [op], dependsOn: [], opOrder: [index] }));
    bundles.push({ key: 'unrelated', ops: [{ op: 'createDimension', name: 'unrelated', tags: ['unrelated'] }], dependsOn: [] });
    expect(dependenciesForTagReferences(original, bundles, [scenario.ref]).sort())
      .toEqual(scenario.needed.map((index) => `actual opaque key ${index}`).sort());
  }
});

test('diagnosis treats a subset missing a tag supplier as invalid rather than a restoring wildcard', () => {
  const original: LibrarySnapshot = { dimensions: [], lists: ['A', 'B'].map((name, idx) => ({
    id: name, name, idx, options: [{ id: `${name}0`, idx: 0, value: name, weight: 1, tagIdxs: [] }],
  })) };
  const bundles: RawBundle[] = [
    { key: 'supplier', dependsOn: [], ops: [{ op: 'createDimension', name: 'Genre', tags: ['x', 'y'] }] },
    { key: 'a', dependsOn: ['supplier'], ops: [{ op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'Genre', label: 'x' }] }] },
    { key: 'b', dependsOn: ['supplier'], ops: [{ op: 'assignOptionTags', listIdx: 1, optionIdx: 0, tags: [{ dimName: 'Genre', label: 'y' }] }] },
  ];
  const conflicts = diagnoseTemplateConflicts(bundles, original, [{ name: 'T', lists: ['A', 'B'] }]);
  expect(conflicts).toHaveLength(1);
  expect(conflicts[0]?.culpritBundleKeys).not.toContain('supplier');
  expect(conflicts[0]?.culpritBundleKeys).toContain('a');
});

test('dense membership replay consumes the bounded diagnosis preview budget', () => {
  const required: number[] = []; const excluded: number[] = [];
  const dimensions = Array.from({ length: 20 }, (_, dimensionIdx) => {
    const rootIdx = dimensionIdx * 29;
    const tags: LibrarySnapshot['dimensions'][number]['tags'] = [{ idx: rootIdx, id: `t${rootIdx}`, label: 'root' }];
    for (let child = 0; child < 28; child += 1) {
      const idx = rootIdx + child + 1;
      tags.push({ idx, id: `t${idx}`, label: `tag${child}`, parentIdx: rootIdx });
      (child < 14 ? required : excluded).push(idx);
    }
    return { idx: dimensionIdx, id: `d${dimensionIdx}`, name: `D${dimensionIdx}`, tags };
  });
  const original: LibrarySnapshot = {
    dimensions,
    lists: ['A', 'B'].map((name, idx) => ({ id: name, idx, name,
      options: Array.from({ length: 50 }, (_, optionIdx) => ({
        id: `${name}${optionIdx}`, idx: optionIdx, value: `${name}${optionIdx}`, weight: 1,
        tagIdxs: required.slice(), excludeTagIdxs: excluded.slice(),
      })),
    })),
  };
  const conflicts = diagnoseTemplateConflicts([
    { key: 'unrelated', dependsOn: [], ops: [{ op: 'createDimension', name: 'Unrelated', tags: ['tag'] }] },
  ], original, [{ name: 'T', lists: ['A', 'B'] }], { totalNodeBudget: 40_000 });
  expect(conflicts).toHaveLength(1);
  expect(conflicts[0]?.reason).toBe(DIAGNOSIS_BUDGET_EXCEEDED_REASON);
  expect(conflicts[0]?.culpritKind).toBe('non-local');
});

describe('resolveProposal', () => {
  test('repeated per-dimension replacements cannot retain an earlier compatible membership', () => {
    const original: LibrarySnapshot = {
      dimensions: [{ idx: 0, id: 'd', name: 'Genre', tags: [
        { idx: 0, id: 'f', label: 'Fantasy' }, { idx: 1, id: 'm', label: 'Modern' },
      ] }],
      lists: ['A', 'B'].map((name, idx) => ({ idx, id: name, name, options: [
        { idx: 0, id: `${name}-0`, value: name, weight: 1, tagIdxs: [] },
      ] })),
    };
    const bundles: RawBundle[] = [{ key: 'assign', dependsOn: [], ops: [
      { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'Genre', label: 'Fantasy' }] },
      { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'Genre', label: 'Modern' }] },
      { op: 'assignOptionTags', listIdx: 1, optionIdx: 0, tags: [{ dimName: 'Genre', label: 'Fantasy' }] },
    ] }];
    const preview = applyBundlesToSnapshot(original, bundles);
    expect(preview.lists[0]?.options[0]?.tagIdxs).toEqual([1]);
    expect(templateSatisfiable(['A', 'B'], preview)).toBe(false);
  });

  test('create + dependent assignment form one bundle', () => {
    const ops: RawInferOp[] = [
      { op: 'createDimension', name: 'Franchise', tags: ['Warhammer', 'Star Trek'] },
      { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'Franchise', label: 'Warhammer' }] },
    ];
    const r = resolveProposal(ops, snap);
    const create = req(r.display.find((b) => b.key === 'create:Franchise'));
    expect(create.kind).toBe('create');
    expect(create.defaultChecked).toBe(true);
    expect(create.optionCount).toBe(1);
    expect(req(r.rawBundles.find((b) => b.key === 'create:Franchise')).ops).toHaveLength(2);
  });

  test('out-of-range dimIdx is rejected with reason+count, not applied', () => {
    const r = resolveProposal([{ op: 'addTags', dimIdx: 9, tags: ['x'] }], snap);
    expect(r.display).toHaveLength(0);
    expect(r.rejected).toEqual([{ reason: 'dimension index out of range', count: 1 }]);
  });

  test('merge widening: option gaining tags from both merged dims flagged in impact', () => {
    const s2: LibrarySnapshot = {
      dimensions: [
        { idx: 0, id: 'dA', name: 'A', tags: [{ idx: 0, id: 'a0', label: 'x' }] },
        { idx: 1, id: 'dB', name: 'B', tags: [{ idx: 1, id: 'b0', label: 'y' }] },
      ],
      lists: [{ idx: 0, id: 'l0', name: 'L', options: [
        { idx: 0, id: 'o0', value: 'both', weight: 1, tagIdxs: [0, 1] },
      ] }],
    };
    const r = resolveProposal([{ op: 'mergeDimensions', fromIdx: 1, intoIdx: 0, tagMap: { y: 'y' } }], s2);
    const m = req(r.display.find((b) => b.kind === 'merge'));
    expect(m.destructive).toBe(true);
    expect(m.defaultChecked).toBe(true);
    expect(m.impact).toMatch(/1 option/);
  });

  test('rename colliding with an existing dimension name is rejected', () => {
    const s3: LibrarySnapshot = {
      dimensions: [
        { idx: 0, id: 'd0', name: 'Era', tags: [] },
        { idx: 1, id: 'd1', name: 'Mood', tags: [] },
      ],
      lists: [],
    };
    const r = resolveProposal([{ op: 'renameDimension', dimIdx: 1, newName: 'Era' }], s3);
    expect(r.rejected).toEqual([{ reason: 'rename would collide with an existing dimension name', count: 1 }]);
  });

  test('applyBundlesToSnapshot preserves untouched dimension tags on an option', () => {
    const s4: LibrarySnapshot = {
      dimensions: [{ idx: 0, id: 'dKeep', name: 'Keep', tags: [{ idx: 0, id: 'k0', label: 'keepme' }] }],
      lists: [{ idx: 0, id: 'l0', name: 'L', options: [{ idx: 0, id: 'o0', value: 'v', weight: 1, tagIdxs: [0] }] }],
    };
    const { rawBundles } = resolveProposal(
      [
        { op: 'createDimension', name: 'New', tags: ['n'] },
        { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'New', label: 'n' }] },
      ],
      s4,
    );
    const after = applyBundlesToSnapshot(s4, rawBundles);
    const opt = req(req(after.lists[0]).options[0]);
    const keepTag = req(req(after.dimensions.find((d) => d.name === 'Keep')).tags[0]).idx;
    expect(opt.tagIdxs).toContain(keepTag);
  });

  test('applyBundlesToSnapshot rebuilds parent and polarity closure after global reindexing', () => {
    const snapshot: LibrarySnapshot = {
      dimensions: [
        { idx: 0, id: 'd-first', name: 'First', tags: [{ idx: 0, id: 'first-tag', label: 'first' }] },
        { idx: 1, id: 'd-franchise', name: 'Franchise', tags: [
          { idx: 1, id: 'witcher', label: 'The Witcher' },
          { idx: 2, id: 'witcher-games', label: 'The Witcher games', parentIdx: 1 },
        ] },
      ],
      lists: [{ idx: 0, id: 'list', name: 'role', options: [{
        idx: 0,
        id: 'option',
        value: 'monster hunter',
        weight: 1,
        tagIdxs: [1],
        excludeTagIdxs: [2],
        expandedExcludeTagIdxs: [2, 1],
      }] }],
    };
    const bundles: RawBundle[] = [{
      key: 'extend:d-first',
      ops: [{ op: 'addTags', dimIdx: 0, tags: ['inserted'] }],
      dependsOn: [],
    }];

    const after = applyBundlesToSnapshot(snapshot, bundles);
    const franchise = req(after.dimensions.find((dimension) => dimension.id === 'd-franchise'));
    const parent = req(franchise.tags.find((tag) => tag.id === 'witcher'));
    const child = req(franchise.tags.find((tag) => tag.id === 'witcher-games'));
    const option = req(req(after.lists[0]).options[0]);
    expect(child.parentIdx).toBe(parent.idx);
    expect(option.tagIdxs).toEqual([parent.idx]);
    expect(option.excludeTagIdxs).toEqual([child.idx]);
    expect(option.expandedExcludeTagIdxs).toEqual([child.idx, parent.idx]);
  });

  test('applyBundlesToSnapshot maps a source parent and child onto newly-created target hierarchy', () => {
    const snapshot: LibrarySnapshot = {
      dimensions: [
        { idx: 0, id: 'from', name: 'From', tags: [
          { idx: 0, id: 'source-parent', label: 'parent' },
          { idx: 1, id: 'source-child', label: 'child', parentIdx: 0 },
        ] },
        { idx: 1, id: 'into', name: 'Into', tags: [] },
      ],
      lists: [],
    };
    const after = applyBundlesToSnapshot(snapshot, [{
      key: 'merge:From',
      ops: [{
        op: 'mergeDimensions',
        fromIdx: 0,
        intoIdx: 1,
        tagMap: { parent: 'target parent', child: 'target child' },
      }],
      dependsOn: [],
    }]);
    const target = req(after.dimensions.find((dimension) => dimension.id === 'into'));
    const parent = req(target.tags.find((tag) => tag.label === 'target parent'));
    const child = req(target.tags.find((tag) => tag.label === 'target child'));
    expect(child.parentIdx).toBe(parent.idx);
  });

  test('applyBundlesToSnapshot makes an assigned require tag win an existing exclude collision', () => {
    const snapshot: LibrarySnapshot = {
      dimensions: [{ idx: 0, id: 'dimension', name: 'Franchise', tags: [
        { idx: 0, id: 'tag', label: 'mapped' },
      ] }],
      lists: [{ idx: 0, id: 'list', name: 'list', options: [{
        idx: 0, id: 'option', value: 'option', weight: 1, tagIdxs: [], excludeTagIdxs: [0],
      }] }],
    };
    const after = applyBundlesToSnapshot(snapshot, [{
      key: 'assign:list',
      ops: [{
        op: 'assignOptionTags', listIdx: 0, optionIdx: 0,
        tags: [{ dimName: 'Franchise', label: 'mapped' }],
      }],
      dependsOn: [],
    }]);
    const option = req(req(after.lists[0]).options[0]);

    expect(option.tagIdxs).toEqual([0]);
    expect(option.excludeTagIdxs).toBeUndefined();
  });

  test('assignOptionTags referencing tags from two new dimensions adds a cross-bundle dependsOn edge', () => {
    const s: LibrarySnapshot = {
      dimensions: [],
      lists: [{ idx: 0, id: 'l', name: 'L', options: [{ idx: 0, id: 'o', value: 'v', weight: 1, tagIdxs: [] }] }],
    };
    const r = resolveProposal(
      [
        { op: 'createDimension', name: 'Franchise', tags: ['Warhammer'] },
        { op: 'createDimension', name: 'Era', tags: ['Medieval'] },
        { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [
          { dimName: 'Franchise', label: 'Warhammer' },
          { dimName: 'Era', label: 'Medieval' },
        ] },
      ],
      s,
    );
    const host = req(r.display.find((b) => b.optionCount > 0));
    const other = host.dimensionName === 'Franchise' ? 'create:Era' : 'create:Franchise';
    expect(host.dependsOn).toContain(other);
    const rawHost = req(r.rawBundles.find((b) => b.key === host.key));
    expect(rawHost.dependsOn).toContain(other);
  });

  test('resolveProposal rewrites assignOptionTags refs targeting a merged-away dim via tagMap (no silent drop)', () => {
    const s: LibrarySnapshot = {
      dimensions: [
        { idx: 0, id: 'A', name: 'A', tags: [{ idx: 0, id: 'a_x', label: 'x' }] },
        { idx: 1, id: 'B', name: 'B', tags: [{ idx: 1, id: 'b_y', label: 'y' }] },
      ],
      lists: [{ idx: 0, id: 'l', name: 'L', options: [{ idx: 0, id: 'o', value: 'v', weight: 1, tagIdxs: [] }] }],
    };
    const r = resolveProposal(
      [
        { op: 'mergeDimensions', fromIdx: 1, intoIdx: 0, tagMap: { y: 'y' } },
        { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'B', label: 'y' }] },
      ],
      s,
    );
    // The actual merge supplies A.y, so its bundle hosts the rewritten
    // assignment atomically and retains the merge display kind.
    const assignBundle = req(r.rawBundles.find((b) => b.ops.some((o) => o.op === 'assignOptionTags')));
    expect(assignBundle.key).toBe('merge:B');
    const assignOp = req(assignBundle.ops.find((o) => o.op === 'assignOptionTags'));
    expect(assignOp.tags).toEqual([{ dimName: 'A', label: 'y' }]);
    expect(assignBundle.dependsOn).toEqual([]);
    expect(assignBundle.ops.map((op) => op.op)).toEqual(['mergeDimensions', 'assignOptionTags']);
    expect(assignBundle.opOrder).toEqual([0, 1]);
    expect(r.display.find((bundle) => bundle.key === assignBundle.key)?.kind).toBe('merge');
  });

  test('applyBundlesToSnapshot REPLACES option memberships within touched dimensions (mirrors SQL apply, not unions)', () => {
    const s: LibrarySnapshot = {
      dimensions: [{ idx: 0, id: 'm', name: 'Mood', tags: [
        { idx: 0, id: 'tcalm', label: 'Calm' },
        { idx: 1, id: 'tbright', label: 'Bright' },
      ] }],
      lists: [{ idx: 0, id: 'l', name: 'L', options: [
        { idx: 0, id: 'o', value: 'v', weight: 1, tagIdxs: [0] },
      ] }],
    };
    const { rawBundles } = resolveProposal(
      [{ op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'Mood', label: 'Bright' }] }],
      s,
    );
    const after = applyBundlesToSnapshot(s, rawBundles);
    const o = req(req(after.lists[0]).options[0]);
    const mood = req(after.dimensions.find((d) => d.name === 'Mood'));
    const labels = mood.tags.filter((t) => o.tagIdxs.includes(t.idx)).map((t) => t.label);
    expect(labels).toEqual(['Bright']);
  });

  test('applyBundlesToSnapshot re-points option memberships through merge tagMap', () => {
    const s: LibrarySnapshot = {
      dimensions: [
        { idx: 0, id: 'A', name: 'A', tags: [{ idx: 0, id: 'a_x', label: 'x' }] },
        { idx: 1, id: 'B', name: 'B', tags: [{ idx: 1, id: 'b_y', label: 'y' }] },
      ],
      lists: [{ idx: 0, id: 'l', name: 'L', options: [
        { idx: 0, id: 'o', value: 'v', weight: 1, tagIdxs: [1] },
      ] }],
    };
    const { rawBundles } = resolveProposal(
      [{ op: 'mergeDimensions', fromIdx: 1, intoIdx: 0, tagMap: { y: 'y' } }],
      s,
    );
    const after = applyBundlesToSnapshot(s, rawBundles);
    expect(after.dimensions.map((d) => d.name)).toEqual(['A']);
    const o = req(req(after.lists[0]).options[0]);
    const labels = req(after.dimensions[0]).tags.filter((t) => o.tagIdxs.includes(t.idx)).map((t) => t.label);
    expect(labels).toEqual(['y']);
  });

  test('applyBundlesToSnapshot handles TWO merges without index drift', () => {
    const s: LibrarySnapshot = {
      dimensions: [
        { idx: 0, id: 'A', name: 'A', tags: [{ idx: 0, id: 'a0', label: 'a' }] },
        { idx: 1, id: 'B', name: 'B', tags: [{ idx: 1, id: 'b0', label: 'b' }] },
        { idx: 2, id: 'C', name: 'C', tags: [{ idx: 2, id: 'c0', label: 'c' }] },
      ],
      lists: [],
    };
    const { rawBundles } = resolveProposal(
      [
        { op: 'mergeDimensions', fromIdx: 1, intoIdx: 0, tagMap: { b: 'b' } },
        { op: 'mergeDimensions', fromIdx: 2, intoIdx: 0, tagMap: { c: 'c' } },
      ],
      s,
    );
    const after = applyBundlesToSnapshot(s, rawBundles);
    expect(after.dimensions.map((d) => d.name).sort()).toEqual(['A']);
    expect(req(after.dimensions[0]).tags.map((t) => t.label).sort()).toEqual(['a', 'b', 'c']);
  });

  test('applyBundlesToSnapshot creates new option for addOption op', () => {
    const snap: LibrarySnapshot = {
      dimensions: [{ idx: 0, id: 'd1', name: 'era', tags: [{ idx: 0, id: 't1', label: 'modern' }] }],
      lists: [{ idx: 0, id: 'l1', name: 'outfit', options: [{ idx: 0, id: 'o1', value: 'tshirt', weight: 1, tagIdxs: [] }] }],
    };
    const bundles: RawBundle[] = [
      {
        key: 'rescue:portrait',
        ops: [{ op: 'addOption', listIdx: 0, value: 'vintage rocker jacket', tags: [{ dimName: 'era', label: 'modern' }] }],
        dependsOn: [],
      },
    ];
    const next = applyBundlesToSnapshot(snap, bundles);
    expect(next.lists[0]?.options).toHaveLength(2);
    expect(next.lists[0]?.options[1]?.value).toBe('vintage rocker jacket');
    expect(next.lists[0]?.options[1]?.tagIdxs).toEqual([0]); // tag idx 0 = era:modern after reindex
  });

  test('resolveProposal rejects addOption whose value already exists in target list', () => {
    const snap: LibrarySnapshot = {
      dimensions: [],
      lists: [{ idx: 0, id: 'l1', name: 'outfit', options: [
        { idx: 0, id: 'o1', value: 'tshirt', weight: 1, tagIdxs: [] },
        { idx: 1, id: 'o2', value: 'jacket', weight: 1, tagIdxs: [] },
      ] }],
    };
    const ops: RawInferOp[] = [
      { op: 'addOption', listIdx: 0, value: 'jacket', tags: [{ dimName: 'era', label: 'modern' }] },
    ];
    const { rawBundles, rejected } = resolveProposal(ops, snap);
    expect(rawBundles).toHaveLength(0);
    expect(rejected.find((r) => r.reason === 'addOption value already exists in target list')).toBeDefined();
  });

  test('resolveProposal passes addOption with novel value without creating a bundle', () => {
    const snap: LibrarySnapshot = {
      dimensions: [],
      lists: [{ idx: 0, id: 'l1', name: 'outfit', options: [{ idx: 0, id: 'o1', value: 'tshirt', weight: 1, tagIdxs: [] }] }],
    };
    const ops: RawInferOp[] = [
      { op: 'addOption', listIdx: 0, value: 'vintage jacket', tags: [{ dimName: 'era', label: 'modern' }] },
    ];
    const { rawBundles, rejected } = resolveProposal(ops, snap);
    expect(rawBundles).toHaveLength(0); // resolver doesn't bundle addOption; rescue route does
    expect(rejected).toEqual([]);
  });
});

describe('__resolverTest.countWidenedOptions', () => {
  test('counts options carrying tags from both merged dims', () => {
    const s: LibrarySnapshot = {
      dimensions: [
        { idx: 0, id: 'dA', name: 'A', tags: [{ idx: 0, id: 'a0', label: 'x' }] },
        { idx: 1, id: 'dB', name: 'B', tags: [{ idx: 1, id: 'b0', label: 'y' }] },
      ],
      lists: [{ idx: 0, id: 'l0', name: 'L', options: [
        { idx: 0, id: 'o0', value: 'both', weight: 1, tagIdxs: [0, 1] },
        { idx: 1, id: 'o1', value: 'onlyA', weight: 1, tagIdxs: [0] },
        { idx: 2, id: 'o2', value: 'none', weight: 1, tagIdxs: [] },
      ] }],
    };
    expect(__resolverTest.countWidenedOptions(req(s.dimensions[1]), req(s.dimensions[0]), s)).toBe(1);
  });
});

describe('__resolverTest.resolveAssignHost (forgotten-tag wildcard guard)', () => {
  const dimByName = new Map(snap.dimensions.map((d) => [d.name, d] as const));

  test('rejects an option tag referencing an unknown dimension/tag', () => {
    const op = { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'Nope', label: 'ghost' }] } as const;
    const r = __resolverTest.resolveAssignHost({ ...op, tags: [...op.tags] }, snap, dimByName, new Map(), new Map());
    expect(r).toEqual({ ok: false, reason: 'option tag references an unknown dimension/tag' });
  });

  test('resolves a live-DB ref to an extend host on the existing dim', () => {
    const op = { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'Era', label: 'Ancient' }] } as const;
    const r = __resolverTest.resolveAssignHost({ ...op, tags: [...op.tags] }, snap, dimByName, new Map(), new Map());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.host).toBe('extend:d0');
  });
});

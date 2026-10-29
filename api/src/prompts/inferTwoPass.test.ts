import { describe, expect, test } from 'bun:test';
import {
  chunkListBatches,
  DEFAULT_CHUNK_SIZE,
  needsTwoPass,
  reconcilePass2AddTags,
  remapChunkOps,
  runBatchesParallel,
  runBatchesPartial,
  splitForTwoPass,
} from './inferTwoPass';
import type { RawInferOp } from './inferTypes';
import type { LibrarySnapshot, SnapList } from './inferTypes';
import { applyBundlesToSnapshot, resolveProposal } from './dimensionResolver';

function reconcile(pass1: RawInferOp[], pass2: RawInferOp[], count: number): RawInferOp[] {
  const original: LibrarySnapshot = {
    dimensions: Array.from({ length: count }, (_, idx) => ({ idx, id: `d${idx}`, name: `D${idx}`, tags: [] })),
    lists: [],
  };
  const enriched = applyBundlesToSnapshot(original, resolveProposal(pass1, original).rawBundles);
  return reconcilePass2AddTags(pass1, pass2, original, enriched);
}

describe('inferTwoPass', () => {
  test('needsTwoPass true when snapshot json exceeds the input token budget', () => {
    expect(needsTwoPass('x'.repeat(60_000), 0, 12_000, 16_000)).toBe(true);
    expect(needsTwoPass('small', 0, 12_000, 16_000)).toBe(false);
  });

  test('needsTwoPass true when projected output for assignOptionTags exceeds the output budget', () => {
    // Even if the input snapshot is small, a library with many options
    // produces enough assignOptionTags output to risk truncation. Trigger
    // two-pass to chunk per-list before the model's completion ceiling.
    expect(needsTwoPass('small', 1000, 12_000, 16_000)).toBe(true);
    expect(needsTwoPass('small', 200, 12_000, 16_000)).toBe(false);
  });

  test('splitForTwoPass yields a sampled taxonomy snapshot + per-list batches', () => {
    const snap: LibrarySnapshot = {
      dimensions: [],
      lists: [
        { idx: 0, id: 'l', name: 'L', options: Array.from({ length: 40 }, (_, i) =>
          ({ idx: i, id: `o${i}`, value: `v${i}`, weight: 1, tagIdxs: [] })) },
      ],
    };
    const { taxonomySnap, listBatches } = splitForTwoPass(snap, 10);
    expect(taxonomySnap.lists[0]?.options.length).toBeLessThanOrEqual(10);
    expect(listBatches.flat()).toHaveLength(1);
  });

  test('remapBatchOps remaps the model’s per-batch listIdx back to the original snapshot idx', async () => {
    const { remapBatchOps } = await import('./inferTwoPass');
    // Batch contains a single list whose ORIGINAL idx in the snapshot is 1.
    const batch = [{ idx: 1, id: 'b', name: 'B', options: [] }];
    // The model only sees one list and addresses it as listIdx: 0 — without
    // remap, this op would later hit snap.lists[0] (corrupting list[0]).
    const ops = [
      { op: 'assignOptionTags' as const, listIdx: 0, optionIdx: 0, tags: [{ dimName: 'X', label: 'y' }] },
    ];
    const remapped = remapBatchOps(ops, batch);
    expect(remapped).toHaveLength(1);
    if (remapped[0]?.op === 'assignOptionTags') {
      expect(remapped[0].listIdx).toBe(1);
    } else {
      throw new Error('expected assignOptionTags');
    }
  });

  test('remapBatchOps drops misaddressed ops rather than letting them corrupt list[0]', async () => {
    const { remapBatchOps } = await import('./inferTwoPass');
    const batch = [{ idx: 3, id: 'b', name: 'B', options: [] }];
    const ops = [
      { op: 'assignOptionTags' as const, listIdx: 9, optionIdx: 0, tags: [{ dimName: 'X', label: 'y' }] }, // out of batch range
    ];
    expect(remapBatchOps(ops, batch)).toEqual([]);
  });

  test('remapBatchOps passes through non-list-addressed ops untouched', async () => {
    const { remapBatchOps } = await import('./inferTwoPass');
    const batch = [{ idx: 1, id: 'b', name: 'B', options: [] }];
    const ops = [
      { op: 'createDimension' as const, name: 'X', tags: ['a'] },
      { op: 'addTags' as const, dimIdx: 0, tags: ['b'] },
    ];
    expect(remapBatchOps(ops, batch)).toEqual(ops);
  });
});

describe('chunkListBatches', () => {
  const makeList = (idx: number, name: string, count: number): SnapList => ({
    idx,
    id: `L${idx}`,
    name,
    options: Array.from({ length: count }, (_, i) => ({
      idx: i,
      id: `o${idx}_${i}`,
      value: `v${idx}_${i}`,
      weight: 1,
      tagIdxs: [],
    })),
  });

  test('short list (≤ chunk size) produces a single chunk with offset 0', () => {
    const lists = [makeList(0, 'short', 10)];
    const chunks = chunkListBatches(lists, 30);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.optionOffset).toBe(0);
    expect(chunks[0]?.list.options).toHaveLength(10);
  });

  test('long list splits into N chunks of size ≤ chunkSize', () => {
    // 104 options at chunk size 30 → 4 chunks (30, 30, 30, 14).
    const lists = [makeList(0, 'outfit', 104)];
    const chunks = chunkListBatches(lists, 30);
    expect(chunks).toHaveLength(4);
    expect(chunks.map((c) => c.optionOffset)).toEqual([0, 30, 60, 90]);
    expect(chunks.map((c) => c.list.options.length)).toEqual([30, 30, 30, 14]);
  });

  test('local option idxs are reset to 0..N-1 in each slice so the model sees a consistent scheme', () => {
    const lists = [makeList(0, 'job', 96)];
    const chunks = chunkListBatches(lists, 30);
    // The middle chunk's options must be addressed as 0..29 locally even
    // though their global idxs were 30..59 in the original snapshot.
    const mid = chunks[1];
    expect(mid?.optionOffset).toBe(30);
    expect(mid?.list.options.map((o) => o.idx)).toEqual(
      Array.from({ length: 30 }, (_, i) => i),
    );
    // The underlying values come from the right slice — chunk[1] options
    // start at global option 30.
    expect(mid?.list.options[0]?.value).toBe('v0_30');
    expect(mid?.list.options[29]?.value).toBe('v0_59');
  });

  test('chunks preserve list metadata (id, name, idx) across slices', () => {
    const lists = [makeList(7, 'location', 71)];
    const chunks = chunkListBatches(lists, 30);
    expect(chunks).toHaveLength(3);
    for (const c of chunks) {
      expect(c.list.idx).toBe(7);
      expect(c.list.id).toBe('L7');
      expect(c.list.name).toBe('location');
    }
  });

  test('chunks across multiple lists preserve stable list-then-chunk ordering', () => {
    const lists = [
      makeList(0, 'a', 5),
      makeList(1, 'b', 75),
      makeList(2, 'c', 10),
    ];
    const chunks = chunkListBatches(lists, 30);
    // Expected order: a (1 chunk), b (3 chunks), c (1 chunk) = 5 chunks.
    expect(chunks.map((c) => c.list.idx)).toEqual([0, 1, 1, 1, 2]);
  });

  test('DEFAULT_CHUNK_SIZE is the published default for callers that don\'t pass one', () => {
    expect(DEFAULT_CHUNK_SIZE).toBe(30);
    const lists = [makeList(0, 'x', 31)];
    const chunks = chunkListBatches(lists);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.list.options).toHaveLength(30);
    expect(chunks[1]?.list.options).toHaveLength(1);
  });
});

describe('remapChunkOps', () => {
  test('adds optionOffset to local optionIdx and rewrites listIdx to global', () => {
    const ops = [
      { op: 'assignOptionTags' as const, listIdx: 0, optionIdx: 5, tags: [{ dimName: 'D', label: 'x' }] },
    ];
    const out = remapChunkOps(ops, 7, 30, 30);
    expect(out).toHaveLength(1);
    if (out[0]?.op === 'assignOptionTags') {
      expect(out[0].listIdx).toBe(7);
      expect(out[0].optionIdx).toBe(35);
    } else {
      throw new Error('expected assignOptionTags');
    }
  });

  test('drops ops whose local optionIdx is outside the slice length', () => {
    const ops = [
      { op: 'assignOptionTags' as const, listIdx: 0, optionIdx: 99, tags: [{ dimName: 'D', label: 'x' }] },
    ];
    expect(remapChunkOps(ops, 0, 0, 30)).toEqual([]);
  });

  test('passes through non-assignment ops untouched (createDimension, addTags)', () => {
    const ops = [
      { op: 'createDimension' as const, name: 'X', tags: ['a'] },
      { op: 'addTags' as const, dimIdx: 0, tags: ['b'] },
    ];
    expect(remapChunkOps(ops, 0, 0, 30)).toEqual(ops);
  });
});

describe('runBatchesParallel', () => {
  test('preserves task order in results regardless of completion order', async () => {
    const settle = [50, 5, 30, 10, 1, 20];
    const tasks = settle.map((delay, i) => () =>
      new Promise<number>((resolve) => { setTimeout(() => { resolve(i); }, delay); }));
    const results = await runBatchesParallel(tasks, 3);
    expect(results).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test('dispatches up to `concurrency` tasks simultaneously and never more', async () => {
    let inFlight = 0;
    let peak = 0;
    const make = () => async (): Promise<number> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight -= 1;
      return 1;
    };
    const tasks = Array.from({ length: 12 }, make);
    const results = await runBatchesParallel(tasks, 4);
    expect(results).not.toBeNull();
    expect(results?.length).toBe(12);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1); // proves parallelism actually happened
  });

  test('returns null and stops dispatching further tasks on first null result', async () => {
    const dispatched: number[] = [];
    const tasks = Array.from({ length: 10 }, (_, i) => async (): Promise<number | null> => {
      dispatched.push(i);
      await new Promise((r) => setTimeout(r, 5));
      return i === 2 ? null : i;
    });
    const results = await runBatchesParallel(tasks, 2);
    expect(results).toBeNull();
    // With cap=2 and task 2 returning null on its first turn, tasks 0..3 may
    // get dispatched before the bail-out lands, but the tail (e.g. 8, 9)
    // must NOT have started.
    expect(dispatched).not.toContain(9);
    expect(dispatched).not.toContain(8);
  });

  test('propagates exceptions thrown by a task (e.g. AbortError) out to the caller', async () => {
    const tasks: (() => Promise<number | null>)[] = [
      () => Promise.resolve(1),
      () => Promise.reject(new DOMException('aborted', 'AbortError')),
      () => Promise.resolve(3),
    ];
    let err: unknown;
    try { await runBatchesParallel(tasks, 2); }
    catch (e) { err = e; }
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe('AbortError');
  });

  test('empty task list returns empty results without dispatching', async () => {
    const results = await runBatchesParallel([], 4);
    expect(results).toEqual([]);
  });

  test('concurrency greater than task count is clamped to task count', async () => {
    let peak = 0;
    let inFlight = 0;
    const tasks = Array.from({ length: 3 }, () => async (): Promise<number> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return 1;
    });
    const results = await runBatchesParallel(tasks, 100);
    expect(results?.length).toBe(3);
    expect(peak).toBeLessThanOrEqual(3);
  });

  test('onFirstFailure fires exactly once on the first null result', async () => {
    let callCount = 0;
    // Three tasks, all return null synchronously — multiple workers may
    // observe null in the same microtask. The callback must still fire once.
    const tasks: (() => Promise<null>)[] = [
      () => Promise.resolve(null),
      () => Promise.resolve(null),
      () => Promise.resolve(null),
    ];
    const result = await runBatchesParallel(tasks, 3, {
      onFirstFailure: () => { callCount += 1; },
    });
    expect(result).toBeNull();
    expect(callCount).toBe(1);
  });

  test('onFirstFailure drains in-flight tasks that throw AbortError after the signal aborts', async () => {
    // Models the production wiring: route aborts the shared AbortSignal in
    // its onFirstFailure callback; in-flight upstream calls then reject with
    // AbortError. runBatchesParallel must NOT surface that throw — it must
    // recognize it as deliberate post-bail cancellation and return null.
    const ac = new AbortController();
    const tasks: (() => Promise<number | null>)[] = [
      () => Promise.resolve(null), // fails immediately
      () => new Promise<number | null>((resolve, reject) => {
        // Reject when the controller aborts.
        ac.signal.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        }, { once: true });
        // Otherwise resolve eventually so we don't leak.
        setTimeout(() => { resolve(2); }, 50);
      }),
      () => new Promise<number | null>((resolve, reject) => {
        ac.signal.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        }, { once: true });
        setTimeout(() => { resolve(3); }, 50);
      }),
    ];
    const result = await runBatchesParallel(tasks, 3, {
      onFirstFailure: () => { ac.abort(); },
    });
    // Caller-visible behaviour: ordinary null return, no throw.
    expect(result).toBeNull();
  });

  test('throws when a task throws BEFORE any failure has been observed', async () => {
    // A non-abort exception should still propagate — only deliberate
    // post-bail AbortErrors get swallowed. This guards the catch-on-bail
    // branch from masking real bugs.
    const tasks: (() => Promise<number | null>)[] = [
      () => Promise.reject(new Error('upstream EHOSTUNREACH')),
      () => Promise.resolve(2),
    ];
    let caught: unknown;
    try { await runBatchesParallel(tasks, 2); }
    catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('upstream EHOSTUNREACH');
  });
});

describe('runBatchesPartial', () => {
  test('returns results in original order, empty failedIndexes when all succeed', async () => {
    const tasks = Array.from({ length: 5 }, (_, i) => () => Promise.resolve(i));
    const { results, failedIndexes } = await runBatchesPartial(tasks, 2);
    expect(results).toEqual([0, 1, 2, 3, 4]);
    expect(failedIndexes).toEqual([]);
  });

  test('collects null results into failedIndexes; does NOT abort siblings', async () => {
    const dispatched: number[] = [];
    const tasks = Array.from({ length: 10 }, (_, i) => async () => {
      dispatched.push(i);
      await new Promise((r) => setTimeout(r, 5));
      return i === 2 ? null : i;
    });
    const { results, failedIndexes } = await runBatchesPartial(tasks, 2);
    expect(failedIndexes).toEqual([2]);
    expect(results[2]).toBe(null);
    expect(results.filter((v) => v !== null)).toEqual([0, 1, 3, 4, 5, 6, 7, 8, 9]);
    expect(dispatched.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test('onTaskComplete fires with original index for both success and failure', async () => {
    const events: { i: number; ok: boolean }[] = [];
    const tasks = [
      () => Promise.resolve('a'),
      () => Promise.resolve(null),
      () => Promise.resolve('c'),
    ];
    await runBatchesPartial(tasks, 1, {
      onTaskComplete: (i, ok) => events.push({ i, ok }),
    });
    expect(events).toEqual([{ i: 0, ok: true }, { i: 1, ok: false }, { i: 2, ok: true }]);
  });

  test('propagates exceptions thrown by a task (e.g. AbortError) out to the caller', async () => {
    const tasks = [
      () => Promise.resolve(1),
      () => Promise.reject(new DOMException('aborted', 'AbortError')),
      () => Promise.resolve(3),
    ] as (() => Promise<number | null>)[];
    let caught: unknown;
    try {
      await runBatchesPartial(tasks, 2);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DOMException);
  });

  test('stops dispatching when outer signal aborts; still waits for in-flight', async () => {
    const ac = new AbortController();
    let dispatched = 0;
    const tasks = Array.from({ length: 10 }, () => async () => {
      dispatched += 1;
      if (dispatched === 2) ac.abort();
      await new Promise((r) => setTimeout(r, 5));
      return dispatched;
    });
    const { failedIndexes } = await runBatchesPartial(tasks, 1, { signal: ac.signal });
    expect(dispatched).toBeLessThan(10);
    expect(failedIndexes.length).toBeGreaterThan(0);
  });
});

describe('reconcilePass2AddTags', () => {
  test('translates surviving indices after merges and folds accepted creations after a rejected create', () => {
    const original: LibrarySnapshot = {
      dimensions: ['A', 'B', 'C'].map((name, idx) => ({ idx, id: name, name, tags: [] })),
      lists: [{ idx: 0, id: 'l', name: 'L', options: [{ idx: 0, id: 'o', value: 'v', weight: 1, tagIdxs: [] }] }],
    };
    const pass1: RawInferOp[] = [
      { op: 'mergeDimensions', fromIdx: 0, intoIdx: 1, tagMap: {} },
      { op: 'createDimension', name: 'B', tags: ['rejected'] },
      { op: 'createDimension', name: 'New', tags: ['first'] },
    ];
    const enriched = applyBundlesToSnapshot(original, resolveProposal(pass1, original).rawBundles);
    expect(enriched.dimensions.map((dim) => dim.id)).toEqual(['B', 'C', 'new:New']);
    const pass2: RawInferOp[] = [
      { op: 'addTags', dimIdx: 1, tags: ['C-tag'] },
      { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'C', label: 'C-tag' }] },
      { op: 'addTags', dimIdx: 2, tags: ['second'] },
      { op: 'renameDimension', dimIdx: 0, newName: 'RenamedB' },
      { op: 'mergeDimensions', fromIdx: 1, intoIdx: 0, tagMap: {} },
    ];
    const out = reconcilePass2AddTags(pass1, pass2, original, enriched);
    expect(out[0]).toEqual({ op: 'addTags', dimIdx: 2, tags: ['C-tag'] });
    expect(out[2]).toEqual({ op: 'renameDimension', dimIdx: 1, newName: 'RenamedB' });
    expect(out[3]).toEqual({ op: 'mergeDimensions', fromIdx: 2, intoIdx: 1, tagMap: {} });
    expect(pass1[2]).toEqual({ op: 'createDimension', name: 'New', tags: ['first', 'second'] });
    const resolved = resolveProposal([...pass1, ...out.slice(0, 2)], original);
    const final = applyBundlesToSnapshot(original, resolved.rawBundles);
    const c = final.dimensions.find((dim) => dim.id === 'C');
    expect(c?.tags.map((tag) => tag.label)).toEqual(['C-tag']);
    expect(final.lists[0]?.options[0]?.tagIdxs).toEqual(c?.tags.map((tag) => tag.idx));
  });

  test('folds Pass-2 addTags against a Pass-1-created dim back into the Pass-1 createDimension op', () => {
    // Pre-state: original snap had 2 dims. Pass 1 created "Franchise" at
    // enriched idx 2. Pass 2 sees enrichedTaxonomy and emits addTags{2,
    // ["Warhammer"]} — without translation this would be rejected as out-of-
    // range against the original 2-dim snap.
    const pass1: RawInferOp[] = [
      { op: 'createDimension', name: 'Franchise', tags: ['Star Wars', 'Dune'] },
    ];
    const pass2: RawInferOp[] = [
      { op: 'addTags', dimIdx: 2, tags: ['Warhammer'] },
      { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'Franchise', label: 'Warhammer' }] },
    ];
    const out = reconcile(pass1, pass2, 2);
    // Pass-1 op was mutated in place to carry the absorbed label.
    const create = pass1[0];
    if (create?.op !== 'createDimension') throw new Error('expected createDimension');
    expect(create.tags).toEqual(['Star Wars', 'Dune', 'Warhammer']);
    // The addTags op was consumed; the assignOptionTags survives unchanged.
    expect(out).toHaveLength(1);
    expect(out[0]?.op).toBe('assignOptionTags');
  });

  test('dedupes when Pass-2 addTags label already exists in the Pass-1 createDimension', () => {
    const pass1: RawInferOp[] = [
      { op: 'createDimension', name: 'Genre', tags: ['Modern Earth', 'Fantasy'] },
    ];
    const pass2: RawInferOp[] = [
      { op: 'addTags', dimIdx: 2, tags: ['Fantasy', 'Sci-Fi'] }, // Fantasy dupe
    ];
    reconcile(pass1, pass2, 2);
    const create = pass1[0];
    if (create?.op !== 'createDimension') throw new Error('expected createDimension');
    expect(create.tags).toEqual(['Modern Earth', 'Fantasy', 'Sci-Fi']);
  });

  test('passes through addTags against original-snap dims unchanged', () => {
    const pass1: RawInferOp[] = [];
    const pass2: RawInferOp[] = [
      { op: 'addTags', dimIdx: 0, tags: ['extra'] }, // dimIdx 0 < originalDimCount=2
    ];
    const out = reconcile(pass1, pass2, 2);
    expect(out).toEqual(pass2);
  });

  test('drops out-of-range addTags that don\'t map to any Pass-1 createDimension', () => {
    // Pass 1 didn't create any dims, but Pass 2 somehow emits an out-of-range
    // addTags. Better to drop than to let resolveProposal reject it (which
    // would surface a confusing "dimension index out of range" error to the
    // user for a model hallucination they can't act on).
    const pass1: RawInferOp[] = [];
    const pass2: RawInferOp[] = [
      { op: 'addTags', dimIdx: 5, tags: ['ghost'] },
    ];
    expect(reconcile(pass1, pass2, 2)).toEqual([]);
  });

  test('drops rename/merge ops against Pass-1-created dims (rare, structurally weird)', () => {
    const pass1: RawInferOp[] = [
      { op: 'createDimension', name: 'Genre', tags: ['Fantasy'] },
    ];
    const pass2: RawInferOp[] = [
      { op: 'renameDimension', dimIdx: 2, newName: 'GenreRenamed' },
      { op: 'mergeDimensions', fromIdx: 2, intoIdx: 0, tagMap: {} },
      { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'Genre', label: 'Fantasy' }] },
    ];
    const out = reconcile(pass1, pass2, 2);
    expect(out).toHaveLength(1);
    expect(out[0]?.op).toBe('assignOptionTags');
  });
});

test('pass2 additions fold into the accepted creation after rejected same-name creation and rename', () => {
  const original: LibrarySnapshot = { dimensions: [{ id: 'original-A', idx: 0, name: 'A', tags: [] }], lists: [] };
  const pass1: RawInferOp[] = [
    { op: 'createDimension', name: 'A', tags: ['ignored'] },
    { op: 'renameDimension', dimIdx: 0, newName: 'X' },
    { op: 'createDimension', name: 'A', tags: ['new'] },
  ];
  const enriched = applyBundlesToSnapshot(original, resolveProposal(pass1, original).rawBundles);
  const newIndex = enriched.dimensions.findIndex((d) => d.id === 'new:A');
  expect(reconcilePass2AddTags(pass1, [{ op: 'addTags', dimIdx: newIndex, tags: ['z'] }], original, enriched)).toEqual([]);
  expect(pass1[0]).toEqual({ op: 'createDimension', name: 'A', tags: ['ignored'] });
  expect(pass1[2]).toEqual({ op: 'createDimension', name: 'A', tags: ['new', 'z'] });
});

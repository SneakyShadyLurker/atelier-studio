import type { DimensionBundle, RejectedOp } from '@atelier/shared';
import type { LibrarySnapshot, RawBundle, RawInferOp } from './inferTypes';
import { mappedTagLabel, orderedOperations, tagIdentity, tagReferenceDependencies } from './bundleOperations';
import { assertNoNewTagOverlaps, inheritTagParent, InvalidTagMutationError } from './tagHierarchy';
import { bundleWorkSize, rebuildSnapshotDerivedFields, snapshotWorkSize } from './librarySnapshot';
import { bundleClosure } from './closureWalk';

type DimensionOpKind = DimensionBundle['kind'];
interface ResolveResult { rawBundles: RawBundle[]; display: DimensionBundle[]; rejected: RejectedOp[] }
interface Acc {
  ops: RawInferOp[];
  opOrder: number[];
  kind: DimensionOpKind;
  dimName: string;
  deps: Set<string>;
  opts: Set<string>;
  lists: Set<number>;
  destructive: boolean;
  impact: string;
}
interface MergeRewrite { intoId: string; tagMap: Record<string, string>; mergeKey: string }
const titleByKind: Record<DimensionOpKind, string> = {
  create: 'New dimension', extend: 'Extend dimension', rename: 'Rename', merge: 'Merge',
};
type SnapDim = LibrarySnapshot['dimensions'][number];
type AssignOptionTagsOp = Extract<RawInferOp, { op: 'assignOptionTags' }>;
function countWidenedOptions(from: SnapDim, into: SnapDim, snap: LibrarySnapshot): number {
  const fromIdxs = new Set(from.tags.map((t) => t.idx));
  const intoIdxs = new Set(into.tags.map((t) => t.idx));
  return snap.lists.flatMap((l) => l.options).filter((o) =>
    o.tagIdxs.some((i) => fromIdxs.has(i)) && o.tagIdxs.some((i) => intoIdxs.has(i))).length;
}

// Only already-consumed names are rewritten. A live name always identifies its
// current owner, including when a later create/rename reuses a freed name.
function resolveAssignHost(
  op: AssignOptionTagsOp,
  _snap: LibrarySnapshot,
  dimByName: Map<string, SnapDim>,
  definedBy: Map<string, string>,
  rewrites: Map<string, MergeRewrite>,
  consumedById = new Map<string, MergeRewrite>(),
): { ok: false; reason: string } | { ok: true; host: string; providerKeys: (string | null)[]; mergeDeps: Set<string> } {
  const mergeDeps = new Set<string>();
  const liveById = new Map([...dimByName.values()].map((dim) => [dim.id, dim]));
  for (const [i, input] of op.tags.entries()) {
    if (dimByName.has(input.dimName)) continue;
    let rewrite = rewrites.get(input.dimName);
    let label = input.label;
    const seen = new Set<string>();
    while (rewrite && !seen.has(rewrite.intoId)) {
      label = mappedTagLabel(rewrite.tagMap, label);
      mergeDeps.add(rewrite.mergeKey);
      seen.add(rewrite.intoId);
      const survivor = liveById.get(rewrite.intoId);
      if (survivor) {
        op.tags[i] = { dimName: survivor.name, label };
        break;
      }
      rewrite = consumedById.get(rewrite.intoId);
    }
  }
  const providerKeys: (string | null)[] = [];
  for (const ref of op.tags) {
    const dim = dimByName.get(ref.dimName);
    if (!dim?.tags.some((tag) => tag.label === ref.label)) {
      return { ok: false, reason: 'option tag references an unknown dimension/tag' };
    }
    providerKeys.push(definedBy.get(tagIdentity(dim.id, ref.label)) ?? null);
  }
  const first = dimByName.get(op.tags[0]?.dimName ?? '');
  if (!first) return { ok: false, reason: 'option tag references an unknown dimension/tag' };
  return { ok: true, host: providerKeys.find((key) => key !== null) ?? `extend:${first.id}`, providerKeys, mergeDeps };
}

export function resolveProposal(ops: readonly RawInferOp[], snap: LibrarySnapshot): ResolveResult {
  const acc = new Map<string, Acc>();
  const rej = new Map<string, number>();
  const reject = (reason: string) => rej.set(reason, (rej.get(reason) ?? 0) + 1);
  const dimById = new Map(snap.dimensions.map((d): [string, SnapDim] => [d.id, { ...d, tags: [...d.tags] }]));
  const dimByName = new Map([...dimById.values()].map((d) => [d.name, d] as const));
  const definedBy = new Map<string, string>();
  const prerequisites = new Map<string, Set<string>>();
  const dimensionDeps = new Map<string, Set<string>>();
  const vacancies = new Map<string, string>();
  const rewrites = new Map<string, MergeRewrite>();
  const consumedById = new Map<string, MergeRewrite>();
  const ensure = (key: string, kind: DimensionOpKind, name: string): Acc => {
    let a = acc.get(key);
    if (!a) {
      a = { ops: [], opOrder: [], kind, dimName: name, deps: new Set(), opts: new Set(), lists: new Set(),
        destructive: kind === 'merge' || kind === 'rename', impact: '' };
      acc.set(key, a);
    }
    return a;
  };
  const depend = (a: Acc, keys: Iterable<string>) => {
    for (const key of keys) if (acc.get(key) !== a) a.deps.add(key);
  };
  const append = (a: Acc, op: RawInferOp, ordinal: number) => { a.ops.push(op); a.opOrder.push(ordinal); };
  for (const [ordinal, input] of ops.entries()) {
    const op = structuredClone(input);
    if (op.op === 'createDimension') {
      if (dimByName.has(op.name)) { reject('dimension name already exists'); continue; }
      const key = `create:${op.name}`;
      const a = ensure(key, 'create', op.name);
      const vacancy = vacancies.get(op.name);
      if (vacancy) depend(a, [vacancy]);
      append(a, op, ordinal);
      const d: SnapDim = { id: `new:${op.name}`, idx: -1, name: op.name,
        tags: [...new Set(op.tags)].map((label) => ({ id: `new:${tagIdentity(op.name, label)}`, idx: -1, label })) };
      dimById.set(d.id, d); dimByName.set(d.name, d);
      dimensionDeps.set(d.id, new Set([key]));
      for (const tag of d.tags) definedBy.set(tagIdentity(d.id, tag.label), key);
    } else if (op.op === 'addTags' || op.op === 'renameDimension') {
      const original = snap.dimensions[op.dimIdx];
      const d = original && dimById.get(original.id);
      if (!d) { reject('dimension index out of range'); continue; }
      if (op.op === 'renameDimension' && op.newName !== d.name && dimByName.has(op.newName)) {
        reject('rename would collide with an existing dimension name'); continue;
      }
      const key = `${op.op === 'addTags' ? 'extend' : 'rename'}:${d.id}`;
      const a = ensure(key, op.op === 'addTags' ? 'extend' : 'rename', d.name);
      depend(a, dimensionDeps.get(d.id) ?? []);
      append(a, op, ordinal);
      if (op.op === 'addTags') {
        for (const label of op.tags) {
          if (!d.tags.some((t) => t.label === label)) d.tags.push({ idx: -1, id: `new:${tagIdentity(d.id, label)}`, label });
          definedBy.set(tagIdentity(d.id, label), key);
        }
      } else {
        const vacancy = vacancies.get(op.newName);
        if (vacancy) depend(a, [vacancy]);
        a.impact = `"${d.name}" -> "${op.newName}"`;
        if (d.name !== op.newName) {
          vacancies.set(d.name, key);
          dimByName.delete(d.name); d.name = op.newName; dimByName.set(d.name, d);
        }
        const deps = dimensionDeps.get(d.id) ?? new Set<string>();
        deps.add(key); dimensionDeps.set(d.id, deps);
      }
    } else if (op.op === 'mergeDimensions') {
      const originalFrom = snap.dimensions[op.fromIdx];
      const originalInto = snap.dimensions[op.intoIdx];
      const from = originalFrom && dimById.get(originalFrom.id);
      const into = originalInto && dimById.get(originalInto.id);
      if (!from || !into || from.id === into.id) { reject('invalid merge indices'); continue; }
      const key = `merge:${from.id}`;
      const a = ensure(key, 'merge', into.name);
      depend(a, dimensionDeps.get(from.id) ?? []); depend(a, dimensionDeps.get(into.id) ?? []);
      for (const tag of from.tags) {
        const identity = tagIdentity(from.id, tag.label);
        const provider = definedBy.get(identity);
        if (provider && acc.has(provider)) depend(a, [provider]);
        depend(a, prerequisites.get(identity) ?? []);
        const label = mappedTagLabel(op.tagMap, tag.label);
        if (!into.tags.some((t) => t.label === label)) {
          into.tags.push({ idx: -1, id: `new:${tagIdentity(into.id, label)}`, label });
          definedBy.set(tagIdentity(into.id, label), key);
          prerequisites.set(tagIdentity(into.id, label), new Set([key]));
        }
      }
      append(a, op, ordinal);
      a.impact = `merge "${from.name}" into "${into.name}"`;
      const widened = countWidenedOptions(from, into, snap);
      if (widened) a.impact += ` -- ${widened} option${widened === 1 ? '' : 's'} become multi-tagged (wildcard risk)`;
      const rewrite = { intoId: into.id, tagMap: op.tagMap, mergeKey: key };
      rewrites.set(from.name, rewrite); consumedById.set(from.id, rewrite);
      vacancies.set(from.name, key);
      dimByName.delete(from.name); dimById.delete(from.id);
      const deps = dimensionDeps.get(into.id) ?? new Set<string>();
      deps.add(key); dimensionDeps.set(into.id, deps);
    } else if (op.op === 'addOption') {
      const list = snap.lists[op.listIdx];
      if (!list) reject('list index out of range');
      else if (list.options.some((o) => o.value === op.value)) reject('addOption value already exists in target list');
      else if (!op.tags.length) reject('addOption with empty tag bag');
      // Rescue owns addOption bundles.
    } else {
      if (!snap.lists[op.listIdx]?.options[op.optionIdx]) { reject('list/option index out of range'); continue; }
      if (!op.tags.length) { reject('empty option assignment'); continue; }
      const result = resolveAssignHost(op, snap, dimByName, definedBy, rewrites, consumedById);
      if (!result.ok) { reject(result.reason); continue; }
      const hostDim = [...dimById.values()].find((d) => `extend:${d.id}` === result.host);
      const a = acc.get(result.host) ?? ensure(result.host, 'extend', hostDim?.name ?? op.tags[0]?.dimName ?? '');
      append(a, op, ordinal);
      a.opts.add(`${op.listIdx}:${op.optionIdx}`); a.lists.add(op.listIdx);
      depend(a, result.mergeDeps);
      depend(a, tagReferenceDependencies(op.tags, { dimensionsByName: dimByName, definedBy, dimensionDeps, prerequisites }));
    }
  }
  return projectDisplayBundles(acc, rej);
}

// Project the accumulators into the public display bundles + raw bundles.
function projectDisplayBundles(acc: Map<string, Acc>, rej: Map<string, number>): ResolveResult {
  const display: DimensionBundle[] = [];
  const rawBundles: RawBundle[] = [];
  for (const [key, a] of acc) {
    rawBundles.push({ key, ops: a.ops, opOrder: a.opOrder, dependsOn: [...a.deps] });
    display.push({
      key,
      kind: a.kind,
      dimensionName: a.dimName,
      title: `${titleByKind[a.kind]}: ${a.dimName}`,
      detail: a.kind === 'create' || a.kind === 'extend'
        ? `tags ${a.opts.size} option(s) across ${a.lists.size} list(s)`
        : a.impact,
      impact: a.destructive ? a.impact : '',
      destructive: a.destructive,
      defaultChecked: true,
      dependsOn: [...a.deps],
      optionCount: a.opts.size,
      listCount: a.lists.size,
    });
  }
  return { rawBundles, display, rejected: [...rej].map(([reason, count]) => ({ reason, count })) };
}

export const INFERENCE_VALIDATION_BUDGET_REASON = 'inference validation budget exceeded';
const DEFAULT_INFERENCE_PREVIEW_WORK_BUDGET = 200_000;

// Inference may emit individually invalid edits alongside useful independent
// bundles. Keep the raw resolver's semantics, but only store strict, applicable
// dependency closures. Always try the entire final state first: a later edit
// can repair an earlier overlap, including one inside a dependency cycle.
export function resolveProposalForInference(
  ops: readonly RawInferOp[],
  snap: LibrarySnapshot,
  opts?: { readonly previewWorkBudget?: number },
): ResolveResult & { preview: LibrarySnapshot } {
  const resolved = resolveProposal(ops, snap);
  try {
    return { ...resolved, preview: applyBundlesToSnapshot(snap, resolved.rawBundles) };
  } catch (error) {
    if (!(error instanceof InvalidTagMutationError)) throw error;
  }

  // Bundle work bounds introduced rows/tags/memberships; merges cannot increase
  // their total count. Charge a conservative source + result + replay cost
  // before each fallback preview, including closure construction and failed
  // previews. The mandatory full-state attempt above is performed only once.
  const previewCost = Math.max(1, 2 * (snapshotWorkSize(snap) + bundleWorkSize(resolved.rawBundles)));
  const budget = opts?.previewWorkBudget ?? DEFAULT_INFERENCE_PREVIEW_WORK_BUDGET;
  let work = 0;
  let exhausted = false;
  let preview = snap;
  const accepted = new Set<string>();
  const failures = new Map<string, string>();
  const tried = new Map<string, { preview?: LibrarySnapshot; reason?: string }>();
  let progress: boolean;
  do {
    progress = false;
    for (const bundle of resolved.rawBundles) {
      if (accepted.has(bundle.key)) continue;
      if (work + previewCost > budget) { exhausted = true; break; }
      work += previewCost;
      const candidate = bundleClosure(resolved.rawBundles, [...accepted, bundle.key]);
      const signature = JSON.stringify(candidate.map((item) => item.key));
      let result = tried.get(signature);
      if (!result) {
        try {
          result = { preview: applyBundlesToSnapshot(snap, candidate) };
        } catch (error) {
          if (!(error instanceof InvalidTagMutationError)) throw error;
          result = { reason: error.message };
        }
        tried.set(signature, result);
      }
      if (result.preview) {
        candidate.forEach((item) => accepted.add(item.key));
        preview = result.preview;
        progress = true;
      } else {
        failures.set(bundle.key, result.reason ?? 'invalid option tag mutation');
      }
    }
  } while (progress && !exhausted);

  const rejected = new Map(resolved.rejected.map((item) => [item.reason, item.count]));
  for (const bundle of resolved.rawBundles) {
    if (accepted.has(bundle.key)) continue;
    // An exhausted search did not establish incompatibility with the final
    // accepted set. Report the bound honestly instead of a semantic conflict.
    const reason = exhausted ? INFERENCE_VALIDATION_BUDGET_REASON
      : (failures.get(bundle.key) ?? 'invalid option tag mutation');
    rejected.set(reason, (rejected.get(reason) ?? 0) + bundle.ops.length);
  }
  return {
    rawBundles: resolved.rawBundles.filter((bundle) => accepted.has(bundle.key)),
    display: resolved.display.filter((bundle) => accepted.has(bundle.key)),
    rejected: [...rejected].map(([reason, count]) => ({ reason, count })),
    preview,
  };
}

// Stable-ID membership replay follows the same operation order as SQL. Indices
// remain original-snapshot addresses until the final derived-field rebuild.
export function applyBundlesToSnapshot(snap: LibrarySnapshot, bundles: readonly RawBundle[]): LibrarySnapshot {
  const next: LibrarySnapshot = structuredClone(snap);
  const dims = new Map(next.dimensions.map((d) => [d.id, d]));
  const names = new Map(next.dimensions.map((d) => [d.name, d]));
  const tagByIdx = new Map(snap.dimensions.flatMap((d) => d.tags.map((t) => [t.idx, t.id] as const)));
  const parents = new Map<string, string>();
  for (const d of snap.dimensions) for (const t of d.tags) {
    const parent = t.parentIdx === undefined ? undefined : tagByIdx.get(t.parentIdx);
    if (parent !== undefined) parents.set(t.id, parent);
  }
  const memberships = new Map<string, { require: Set<string>; exclude: Set<string> }>();
  for (const list of snap.lists) for (const option of list.options) {
    const ids = (idxs: number[]) => idxs.map((idx) => tagByIdx.get(idx)).filter((id): id is string => id !== undefined);
    memberships.set(option.id, { require: new Set(ids(option.tagIdxs)), exclude: new Set(ids(option.excludeTagIdxs ?? [])) });
  }
  const beforeParents = new Map<string, string | null>(parents);
  const beforeMemberships = new Map([...memberships].map(([id, membership]) => [id, {
    require: [...membership.require], exclude: [...membership.exclude],
  }]));
  const createdTags = new Set<string>();
  const ensureTag = (dim: SnapDim, label: string) => {
    let tag = dim.tags.find((t) => t.label === label);
    if (!tag) {
      tag = { idx: -1, id: `new:${tagIdentity(dim.id, label)}`, label };
      dim.tags.push(tag); createdTags.add(tag.id);
    }
    return tag;
  };
  const assign = (optionId: string, refs: { dimName: string; label: string }[], replace: boolean) => {
    const membership = memberships.get(optionId);
    if (!membership) return;
    if (!refs.length) throw new InvalidTagMutationError('empty option tag bag');
    const tags = refs.map((ref) => {
      const dim = names.get(ref.dimName);
      const tag = dim?.tags.find((candidate) => candidate.label === ref.label);
      if (!ref.dimName.trim() || !ref.label.trim() || !dim || !tag) {
        throw new InvalidTagMutationError('option tag references an unknown dimension/tag');
      }
      return { dim, tag };
    });
    if (replace) for (const dim of new Set(tags.map((entry) => entry.dim))) {
      for (const tag of dim.tags) membership.require.delete(tag.id);
    }
    for (const { tag } of tags) { membership.require.add(tag.id); membership.exclude.delete(tag.id); }
  };
  for (const op of orderedOperations(bundles)) {
    if (op.op === 'createDimension') {
      if (names.has(op.name)) continue;
      const dim: SnapDim = { idx: -1, id: `new:${op.name}`, name: op.name, tags: [] };
      next.dimensions.push(dim); dims.set(dim.id, dim); names.set(dim.name, dim);
      for (const label of op.tags) ensureTag(dim, label);
    } else if (op.op === 'addTags' || op.op === 'renameDimension') {
      const original = snap.dimensions[op.dimIdx];
      const dim = original && dims.get(original.id);
      if (!dim) continue;
      if (op.op === 'addTags') for (const label of op.tags) ensureTag(dim, label);
      else { names.delete(dim.name); dim.name = op.newName; names.set(dim.name, dim); }
    } else if (op.op === 'mergeDimensions') {
      const fromId = snap.dimensions[op.fromIdx]?.id;
      const intoId = snap.dimensions[op.intoIdx]?.id;
      const from = fromId === undefined ? undefined : dims.get(fromId);
      const into = intoId === undefined ? undefined : dims.get(intoId);
      if (!from || !into || from.id === into.id) continue;
      const mapped = new Map<string, string>();
      for (const tag of from.tags) mapped.set(tag.id, ensureTag(into, mappedTagLabel(op.tagMap, tag.label)).id);
      const targetParents = new Map(into.tags.map((tag) => [tag.id, parents.get(tag.id) ?? null] as const));
      for (const tag of from.tags) {
        const target = mapped.get(tag.id);
        if (target === undefined) continue;
        for (const membership of memberships.values()) {
          if (membership.require.has(tag.id)) {
            membership.require.add(target); membership.exclude.delete(target);
          } else if (membership.exclude.has(tag.id) && !membership.require.has(target)) {
            membership.exclude.add(target);
          }
          membership.require.delete(tag.id); membership.exclude.delete(tag.id);
        }
        const sourceParent = parents.get(tag.id);
        const targetParent = sourceParent === undefined ? undefined : mapped.get(sourceParent);
        if (targetParent !== undefined && createdTags.has(target) && inheritTagParent(targetParents, target, targetParent)) {
          parents.set(target, targetParent);
        }
      }
      names.delete(from.name); dims.delete(from.id);
    } else if (op.op === 'addOption') {
      const list = next.lists[op.listIdx];
      if (!list) continue;
      const option = { idx: -1, id: `new:option:${JSON.stringify([list.id, op.value])}`, value: op.value, weight: 1, tagIdxs: [] as number[] };
      list.options.push(option); memberships.set(option.id, { require: new Set(), exclude: new Set() });
      assign(option.id, op.tags, false);
    } else {
      const original = snap.lists[op.listIdx]?.options[op.optionIdx];
      if (original) assign(original.id, op.tags, true);
    }
  }
  assertNoNewTagOverlaps(beforeParents, beforeMemberships, new Map(parents),
    new Map([...memberships].map(([id, membership]) => [id, {
      require: [...membership.require], exclude: [...membership.exclude],
    }])));
  next.dimensions = next.dimensions.filter((d) => dims.has(d.id));
  const tagIndices = new Map<string, number>();
  let idx = 0;
  next.dimensions.forEach((dim, di) => {
    dim.idx = di;
    for (const tag of dim.tags) { tag.idx = idx++; tagIndices.set(tag.id, tag.idx); }
  });
  for (const dim of next.dimensions) for (const tag of dim.tags) {
    const parent = parents.get(tag.id);
    const parentIdx = parent === undefined ? undefined : tagIndices.get(parent);
    delete tag.parentIdx;
    if (parentIdx !== undefined) tag.parentIdx = parentIdx;
  }
  const indices = (ids: Set<string>) => [...ids].map((id) => tagIndices.get(id)).filter((i): i is number => i !== undefined);
  next.lists.forEach((list, li) => {
    list.idx = li;
    list.options.forEach((option, oi) => {
      option.idx = oi;
      const membership = memberships.get(option.id);
      if (!membership) return;
      option.tagIdxs = indices(membership.require);
      const excludes = indices(membership.exclude);
      delete option.excludeTagIdxs;
      if (excludes.length) option.excludeTagIdxs = excludes;
    });
  });
  return rebuildSnapshotDerivedFields(next);
}

export const __resolverTest = { countWidenedOptions, resolveAssignHost };

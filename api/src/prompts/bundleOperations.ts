import type { LibrarySnapshot, RawBundle, RawInferOp, TagRef } from './inferTypes';
import { InvalidTagMutationError } from './tagHierarchy';

export const tagIdentity = (dimension: string, label: string): string => JSON.stringify([dimension, label]);

export function mappedTagLabel(mapping: Record<string, string>, label: string): string {
  return Object.hasOwn(mapping, label) ? mapping[label] ?? label : label;
}

// Model operations retain their accepted input order. Appended rescue/manual
// operations without ordinals retain flattened order after those operations.
function orderedBundleOperations(bundles: readonly RawBundle[]): { op: RawInferOp; key: string }[] {
  const entries = bundles.flatMap((bundle) => bundle.ops.map((op, index) => ({
    op, key: bundle.key, order: bundle.opOrder?.[index],
  })));
  entries.sort((a, b) => {
    const left = a.order !== undefined && Number.isFinite(a.order) ? a.order : Infinity;
    const right = b.order !== undefined && Number.isFinite(b.order) ? b.order : Infinity;
    return left === right ? 0 : left - right;
  });
  return entries;
}

export function orderedOperations(bundles: readonly RawBundle[]): RawInferOp[] {
  return orderedBundleOperations(bundles).map(({ op }) => op);
}

export interface TagDependencyState {
  readonly dimensionsByName: ReadonlyMap<string, { readonly id: string; readonly tags: readonly { readonly label: string }[] }>;
  readonly definedBy: ReadonlyMap<string, string>;
  readonly dimensionDeps: ReadonlyMap<string, ReadonlySet<string>>;
  readonly prerequisites: ReadonlyMap<string, ReadonlySet<string>>;
}

// Canonical membership validation and dependency collection for assignments
// and rescue. A bag is accepted whole; no unknown ref becomes a wildcard.
export function tagReferenceDependencies(refs: readonly TagRef[], state: TagDependencyState): Set<string> {
  if (refs.length === 0) throw new InvalidTagMutationError('empty option tag bag');
  const dependencies = new Set<string>();
  for (const ref of refs) {
    const dimension = state.dimensionsByName.get(ref.dimName);
    if (!ref.dimName.trim() || !ref.label.trim() || !dimension?.tags.some((tag) => tag.label === ref.label)) {
      throw new InvalidTagMutationError('option tag references an unknown dimension/tag');
    }
    const identity = tagIdentity(dimension.id, ref.label);
    const provider = state.definedBy.get(identity);
    if (provider) dependencies.add(provider);
    for (const key of state.dimensionDeps.get(dimension.id) ?? []) dependencies.add(key);
    for (const key of state.prerequisites.get(identity) ?? []) dependencies.add(key);
  }
  return dependencies;
}

export function dependenciesForTagReferences(snap: LibrarySnapshot, bundles: readonly RawBundle[], refs: readonly TagRef[]): string[] {
  const dimensions = new Map(snap.dimensions.map((dim) => [dim.id, { ...dim, tags: dim.tags.map((tag) => ({ ...tag })) }]));
  const names = new Map([...dimensions.values()].map((dim) => [dim.name, dim]));
  const definedBy = new Map<string, string>();
  const dimensionDeps = new Map<string, Set<string>>();
  const prerequisites = new Map<string, Set<string>>();
  const vacancies = new Map<string, string>();
  const bundleDeps = new Map(bundles.map((bundle) => [bundle.key, new Set(bundle.dependsOn)]));
  const record = (key: string, dependencies: Iterable<string>) => {
    const known = bundleDeps.get(key) ?? new Set<string>();
    for (const dependency of dependencies) if (dependency !== key) known.add(dependency);
    bundleDeps.set(key, known);
  };
  for (const { op, key } of orderedBundleOperations(bundles)) {
    if (op.op === 'createDimension') {
      if (names.has(op.name)) continue;
      const dim = { idx: -1, id: `new:${op.name}`, name: op.name,
        tags: op.tags.map((label) => ({ id: `new:${tagIdentity(op.name, label)}`, idx: -1, label })) };
      dimensions.set(dim.id, dim); names.set(dim.name, dim);
      const deps = new Set([key]);
      const vacancy = vacancies.get(dim.name);
      if (vacancy) deps.add(vacancy);
      record(key, deps);
      dimensionDeps.set(dim.id, deps);
      for (const tag of dim.tags) definedBy.set(tagIdentity(dim.id, tag.label), key);
    } else if (op.op === 'addTags' || op.op === 'renameDimension') {
      const original = snap.dimensions[op.dimIdx];
      const dim = original && dimensions.get(original.id);
      if (!dim) continue;
      if (op.op === 'addTags') {
        record(key, dimensionDeps.get(dim.id) ?? []);
        for (const label of op.tags) {
          if (!dim.tags.some((tag) => tag.label === label)) {
            dim.tags.push({ id: `new:${tagIdentity(dim.id, label)}`, idx: -1, label });
          }
          definedBy.set(tagIdentity(dim.id, label), key);
        }
      } else {
        const deps = dimensionDeps.get(dim.id) ?? new Set<string>();
        deps.add(key);
        const vacancy = vacancies.get(op.newName);
        if (vacancy) deps.add(vacancy);
        record(key, deps);
        dimensionDeps.set(dim.id, deps);
        if (dim.name !== op.newName) {
          vacancies.set(dim.name, key); names.delete(dim.name);
          dim.name = op.newName; names.set(dim.name, dim);
        }
      }
    } else if (op.op === 'mergeDimensions') {
      const from = dimensions.get(snap.dimensions[op.fromIdx]?.id ?? '');
      const into = dimensions.get(snap.dimensions[op.intoIdx]?.id ?? '');
      if (!from || !into || from.id === into.id) continue;
      const deps = new Set([key, ...(dimensionDeps.get(from.id) ?? []), ...(dimensionDeps.get(into.id) ?? [])]);
      for (const tag of from.tags) {
        const identity = tagIdentity(from.id, tag.label);
        const provider = definedBy.get(identity);
        if (provider) deps.add(provider);
        for (const prerequisite of prerequisites.get(identity) ?? []) deps.add(prerequisite);
      }
      record(key, deps);
      for (const tag of from.tags) {
        const label = mappedTagLabel(op.tagMap, tag.label);
        if (!into.tags.some((existing) => existing.label === label)) {
          into.tags.push({ id: `new:${tagIdentity(into.id, label)}`, idx: -1, label });
          definedBy.set(tagIdentity(into.id, label), key);
        }
        prerequisites.set(tagIdentity(into.id, label), new Set(deps));
      }
      dimensionDeps.set(into.id, deps);
      vacancies.set(from.name, key); names.delete(from.name); dimensions.delete(from.id);
    }
  }
  const dependencies = tagReferenceDependencies(refs, { dimensionsByName: names, definedBy, dimensionDeps, prerequisites });
  for (const key of dependencies) for (const prerequisite of bundleDeps.get(key) ?? []) dependencies.add(prerequisite);
  return [...dependencies];
}

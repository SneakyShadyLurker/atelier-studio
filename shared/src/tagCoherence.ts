// Tag-coherence conflict rule shared by the web resolver (string ids) and the
// api SAT checks (snapshot indexes): expanded exclusions block matching
// requirements, two non-empty requirement sets conflict only when disjoint,
// and untagged on a dimension is a wildcard. Callers expand tag hierarchies
// before grouping; this module only applies the per-dimension predicate.

export interface TagsByDimension<K> {
  readonly require: ReadonlyMap<K, ReadonlySet<K>>;
  readonly exclude: ReadonlyMap<K, ReadonlySet<K>>;
}

/** Groups tag keys by their dimension; tags with no known dimension are dropped. */
export function groupTagsByDimension<K>(tags: Iterable<K>, tagToDimension: ReadonlyMap<K, K>): Map<K, Set<K>> {
  const grouped = new Map<K, Set<K>>();
  for (const tag of tags) {
    const dimension = tagToDimension.get(tag);
    if (dimension === undefined) continue;
    const existing = grouped.get(dimension);
    if (existing === undefined) grouped.set(dimension, new Set([tag]));
    else existing.add(tag);
  }
  return grouped;
}

function intersects<K>(a: ReadonlySet<K> | undefined, b: ReadonlySet<K> | undefined): boolean {
  if (!a || !b) return false;
  for (const key of a) {
    if (b.has(key)) return true;
  }
  return false;
}

/** Yields every dimension on which `a` and `b` conflict, in first-seen order. */
export function* conflictingDimensions<K>(a: TagsByDimension<K>, b: TagsByDimension<K>): Generator<K> {
  const dimensions = new Set([...a.require.keys(), ...a.exclude.keys(), ...b.require.keys(), ...b.exclude.keys()]);
  for (const dimension of dimensions) {
    const ar = a.require.get(dimension);
    const ae = a.exclude.get(dimension);
    const br = b.require.get(dimension);
    const be = b.exclude.get(dimension);
    if (intersects(ae, br) || intersects(be, ar)) yield dimension;
    else if (ar && ar.size > 0 && br && br.size > 0 && !intersects(ar, br)) yield dimension;
  }
}

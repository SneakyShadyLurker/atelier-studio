export function hierarchyError(tags: readonly { id: string; parentId: string | null }[]): 'unknown-parent' | 'cycle' | 'too-deep' | null {
  return hierarchyErrorForParents(new Map(tags.map((tag) => [tag.id, tag.parentId] as const)));
}

function hierarchyErrorForParents(parentById: ReadonlyMap<string, string | null>): 'unknown-parent' | 'cycle' | 'too-deep' | null {
  for (const parentId of parentById.values()) {
    if (parentId !== null && !parentById.has(parentId)) return 'unknown-parent';
  }
  let tooDeep = false;
  for (const id of parentById.keys()) {
    const path = new Set<string>();
    let current: string | null = id;
    let depth = 0;
    while (current !== null) {
      if (path.has(current)) return 'cycle';
      path.add(current);
      depth += 1;
      if (depth > 8) tooDeep = true;
      current = parentById.get(current) ?? null;
    }
  }
  return tooDeep ? 'too-deep' : null;
}

// Existing target/first accepted source parent wins. Validate the whole target
// graph so an inherited edge cannot deepen an existing descendant past 8.
export function inheritTagParent(parents: Map<string, string | null>, child: string, parent: string): boolean {
  if (!parents.has(child) || !parents.has(parent) || parents.get(child) !== null) return false;
  parents.set(child, parent);
  if (hierarchyErrorForParents(parents) !== null) {
    parents.set(child, null);
    return false;
  }
  return true;
}

export class InvalidTagMutationError extends Error {
  constructor(message: string) { super(message); this.name = 'InvalidTagMutationError'; }
}

function ancestorIndex(parentById: ReadonlyMap<string, string | null>): (tagId: string) => ReadonlySet<string> {
  const cache = new Map<string, ReadonlySet<string>>();
  return (tagId) => {
    const known = cache.get(tagId);
    if (known) return known;
    const ancestors = new Set<string>();
    let current: string | null | undefined = tagId;
    while (current && !ancestors.has(current)) {
      ancestors.add(current);
      current = parentById.get(current);
    }
    cache.set(tagId, ancestors);
    return ancestors;
  };
}

function intersects(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  const [smaller, larger] = left.size <= right.size ? [left, right] : [right, left];
  for (const id of smaller) if (larger.has(id)) return true;
  return false;
}

export function tagSetsOverlapThroughAncestors(
  parentById: ReadonlyMap<string, string | null>,
  requiredTagIds: readonly string[],
  excludedTagIds: readonly string[],
): boolean {
  if (requiredTagIds.length === 0 || excludedTagIds.length === 0) return false;
  const ancestorsOf = ancestorIndex(parentById);
  const expand = (tagIds: readonly string[]): Set<string> => {
    const expanded = new Set<string>();
    for (const tagId of tagIds) for (const ancestor of ancestorsOf(tagId)) expanded.add(ancestor);
    return expanded;
  };
  return intersects(expand(requiredTagIds), expand(excludedTagIds));
}

export interface TagMembership { readonly require: readonly string[]; readonly exclude: readonly string[] }

// Pair identities keep an unrelated old contradiction from masking a new one.
// Call only after all operations, so later operations can repair intermediate state.
export function assertNoNewTagOverlaps(
  beforeParents: ReadonlyMap<string, string | null>,
  before: ReadonlyMap<string, TagMembership>,
  afterParents: ReadonlyMap<string, string | null>,
  after: ReadonlyMap<string, TagMembership>,
): void {
  const beforeAncestors = ancestorIndex(beforeParents);
  const afterAncestors = ancestorIndex(afterParents);
  const changedEdges = new Set<string>();
  for (const [id, parent] of beforeParents) if ((afterParents.get(id) ?? null) !== parent) changedEdges.add(id);
  for (const [id, parent] of afterParents) if ((beforeParents.get(id) ?? null) !== parent) changedEdges.add(id);
  const unchangedAncestry = new Map<string, boolean>();
  const ancestryUnchanged = (tagId: string): boolean => {
    if (!changedEdges.size) return true;
    const known = unchangedAncestry.get(tagId);
    if (known !== undefined) return known;
    const unchanged = ![...afterAncestors(tagId)].some((id) => changedEdges.has(id));
    unchangedAncestry.set(tagId, unchanged);
    return unchanged;
  };
  const indexExclusions = (tagIds: Iterable<string>): Map<string, Set<string>> => {
    const byAncestor = new Map<string, Set<string>>();
    for (const tagId of tagIds) for (const ancestor of afterAncestors(tagId)) {
      const tags = byAncestor.get(ancestor) ?? new Set<string>();
      tags.add(tagId); byAncestor.set(ancestor, tags);
    }
    return byAncestor;
  };
  for (const [optionId, membership] of after) {
    if (!membership.require.length || !membership.exclude.length) continue;
    const previous = before.get(optionId);
    const oldRequired = new Set(previous?.require);
    const oldExcluded = new Set(previous?.exclude);
    const changedRequired = new Set(membership.require.filter((id) => !oldRequired.has(id) || !ancestryUnchanged(id)));
    const changedExcluded = membership.exclude.filter((id) => !oldExcluded.has(id) || !ancestryUnchanged(id));
    // Cloned/reordered arrays and cloned maps are still unchanged state.
    // Removing memberships alone cannot introduce a conflicting pair either.
    if (!changedRequired.size && !changedExcluded.length) continue;
    const allExclusions = changedRequired.size ? indexExclusions(membership.exclude) : new Map<string, Set<string>>();
    const changedExclusions = indexExclusions(changedExcluded);
    for (const required of membership.require) {
      const exclusions = changedRequired.has(required) ? allExclusions : changedExclusions;
      if (!exclusions.size) continue;
      const seen = new Set<string>();
      for (const ancestor of afterAncestors(required)) for (const excluded of exclusions.get(ancestor) ?? []) {
        if (seen.has(excluded)) continue;
        seen.add(excluded);
        if (oldRequired.has(required) && oldExcluded.has(excluded)
          && intersects(beforeAncestors(required), beforeAncestors(excluded))) continue;
        throw new InvalidTagMutationError('the same tag cannot be both require and exclude');
      }
    }
  }
}

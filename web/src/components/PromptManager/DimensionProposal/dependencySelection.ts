import type { DimensionChangeBundle } from '@atelier/shared';

// Bundle dependencies can cycle: the server preserves original operation
// order, so "rename A->X, merge B into A, rename A->Y" yields
// rename:A <-> merge:B. Each strongly connected group is one atomic selection
// unit: its members are picked, applied and gated together, and only
// dependencies outside the group gate its checkboxes.

type DependencyNode = Pick<DimensionChangeBundle, 'key' | 'dependsOn'>;

export interface DependencyGroup {
  readonly members: readonly string[];
  /** Dependencies of any member outside the group, including keys absent from the proposal. */
  readonly externalDeps: readonly string[];
}

export interface DependencyGroups {
  /** Every group is listed after the groups it depends on. */
  readonly ordered: readonly DependencyGroup[];
  readonly byKey: ReadonlyMap<string, DependencyGroup>;
}

interface Frame {
  readonly key: string;
  readonly deps: readonly string[];
  next: number;
}

// Iterative Tarjan SCC: linear in bundles + edges, no recursion depth limit.
// Tarjan completes a group only after every group reachable from it, so the
// emission order is already dependency-first.
export function buildDependencyGroups(bundles: readonly DependencyNode[]): DependencyGroups {
  const depsOf = new Map<string, readonly string[]>();
  for (const bundle of bundles) depsOf.set(bundle.key, bundle.dependsOn);

  const visitIndex = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const memberGroups: string[][] = [];
  const lowOf = (key: string) => lowLink.get(key) ?? 0;
  const enter = (key: string): Frame => {
    const index = visitIndex.size;
    visitIndex.set(key, index);
    lowLink.set(key, index);
    stack.push(key);
    onStack.add(key);
    return { key, deps: depsOf.get(key) ?? [], next: 0 };
  };

  for (const root of depsOf.keys()) {
    if (visitIndex.has(root)) continue;
    const frames = [enter(root)];
    for (let frame = frames.at(-1); frame; frame = frames.at(-1)) {
      const dep = frame.deps[frame.next];
      if (dep !== undefined) {
        frame.next += 1;
        if (!depsOf.has(dep)) continue;
        const depIndex = visitIndex.get(dep);
        if (depIndex === undefined) frames.push(enter(dep));
        else if (onStack.has(dep)) lowLink.set(frame.key, Math.min(lowOf(frame.key), depIndex));
        continue;
      }
      frames.pop();
      const parent = frames.at(-1);
      if (parent) lowLink.set(parent.key, Math.min(lowOf(parent.key), lowOf(frame.key)));
      if (lowOf(frame.key) !== visitIndex.get(frame.key)) continue;
      const members: string[] = [];
      for (let member = stack.pop(); member !== undefined; member = stack.pop()) {
        onStack.delete(member);
        members.push(member);
        if (member === frame.key) break;
      }
      memberGroups.push(members);
    }
  }

  const ordered: DependencyGroup[] = [];
  const byKey = new Map<string, DependencyGroup>();
  for (const members of memberGroups) {
    const inGroup = new Set(members);
    const external = new Set<string>();
    for (const member of members) {
      for (const dep of depsOf.get(member) ?? []) {
        if (!inGroup.has(dep)) external.add(dep);
      }
    }
    const group: DependencyGroup = { members, externalDeps: [...external] };
    ordered.push(group);
    for (const member of members) byKey.set(member, group);
  }
  return { ordered, byKey };
}

/**
 * The picked keys that will actually apply, in picked order. A group applies
 * only when all of its members are picked and every external dependency
 * applies; a partially picked group applies nothing, and a dependency key
 * absent from the proposal never applies.
 */
export function effectiveSelection(groups: DependencyGroups, picked: ReadonlySet<string>): Set<string> {
  const applies = new Set<string>();
  for (const group of groups.ordered) {
    if (
      group.members.every((key) => picked.has(key))
      && group.externalDeps.every((key) => applies.has(key))
    ) {
      for (const key of group.members) applies.add(key);
    }
  }
  return new Set([...picked].filter((key) => applies.has(key)));
}

/** Whether the bundle's group can be selected given the effective selection. */
export function dependenciesMet(groups: DependencyGroups, effective: ReadonlySet<string>, key: string): boolean {
  return (groups.byKey.get(key)?.externalDeps ?? []).every((dep) => effective.has(dep));
}

/** The keys plus every member of their groups; unknown keys pass through. */
export function expandToGroups(groups: DependencyGroups, keys: readonly string[]): string[] {
  const out = new Set<string>();
  for (const key of keys) {
    for (const member of groups.byKey.get(key)?.members ?? [key]) out.add(member);
  }
  return [...out];
}

/**
 * Flip the clicked bundle's whole group: a fully picked group is removed,
 * anything else (including a partial pick) is completed.
 */
export function toggleGroup(groups: DependencyGroups, picked: ReadonlySet<string>, key: string): Set<string> {
  const members = groups.byKey.get(key)?.members ?? [key];
  const next = new Set(picked);
  if (members.every((member) => picked.has(member))) {
    for (const member of members) next.delete(member);
  } else {
    for (const member of members) next.add(member);
  }
  return next;
}

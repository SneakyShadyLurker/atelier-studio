import { createHash } from 'node:crypto';
import type { PromptLibraryResponse } from '@atelier/shared';
import type { LibrarySnapshot, RawBundle } from './inferTypes';

// Structural preview work includes the dense membership bags, not just rows.
export function snapshotWorkSize(snapshot: LibrarySnapshot): number {
  return snapshot.dimensions.reduce((size, dim) => size + 1 + dim.tags.length, 0)
    + snapshot.lists.reduce((size, list) => size + 1 + list.options.reduce((count, option) =>
      count + 1 + option.tagIdxs.length + (option.excludeTagIdxs?.length ?? 0), 0), 0);
}

export function bundleWorkSize(bundles: readonly RawBundle[]): number {
  return bundles.reduce((size, bundle) => size + 1 + bundle.ops.reduce((count, op) =>
    count + 1 + ('tags' in op ? op.tags.length : 0), 0), 0);
}

export function rebuildSnapshotDerivedFields(snapshot: LibrarySnapshot): LibrarySnapshot {
  const parentByTagIdx = new Map<number, number>();
  snapshot.dimensions.forEach((dimension) => {
    dimension.tags.forEach((tag) => {
      if (tag.parentIdx !== undefined) parentByTagIdx.set(tag.idx, tag.parentIdx);
    });
  });
  const closureByTagIdx = new Map<number, readonly number[]>();
  for (const dimension of snapshot.dimensions) {
    for (const tag of dimension.tags) {
      const closure: number[] = [];
      const seen = new Set<number>();
      let current: number | undefined = tag.idx;
      while (current !== undefined && !seen.has(current)) {
        seen.add(current);
        closure.push(current);
        current = parentByTagIdx.get(current);
      }
      closureByTagIdx.set(tag.idx, closure);
    }
  }
  const expand = (tagIdxs: readonly number[]): number[] => [
    ...new Set(tagIdxs.flatMap((tagIdx) => closureByTagIdx.get(tagIdx) ?? [tagIdx])),
  ];
  const sameTags = (a: readonly number[], b: readonly number[]): boolean => (
    a.length === b.length && a.every((tagIdx, index) => tagIdx === b[index])
  );
  snapshot.lists.forEach((list) => {
    list.options.forEach((option) => {
      const expandedTagIdxs = expand(option.tagIdxs);
      const excludeTagIdxs = option.excludeTagIdxs ?? [];
      const expandedExcludeTagIdxs = expand(excludeTagIdxs);
      delete option.expandedTagIdxs;
      delete option.expandedExcludeTagIdxs;
      if (!sameTags(option.tagIdxs, expandedTagIdxs)) option.expandedTagIdxs = expandedTagIdxs;
      if (!sameTags(excludeTagIdxs, expandedExcludeTagIdxs)) {
        option.expandedExcludeTagIdxs = expandedExcludeTagIdxs;
      }
    });
  });
  return snapshot;
}

export function toLibrarySnapshot(lib: PromptLibraryResponse): LibrarySnapshot {
  let nextTagIdx = 0;
  const rawDimensions = lib.dimensions.map((d, idx) => ({
    idx,
    id: d.id,
    name: d.name,
    tags: d.tags.map((t) => ({ idx: nextTagIdx++, id: t.id, label: t.label, parentId: t.parentId ?? null })),
  }));
  const tagIdxById = new Map<string, number>();
  const dimensionIdByTagId = new Map<string, string>();
  rawDimensions.forEach((d) => {
    d.tags.forEach((t) => {
      tagIdxById.set(t.id, t.idx);
      dimensionIdByTagId.set(t.id, d.id);
    });
  });
  const dimensions: LibrarySnapshot['dimensions'] = rawDimensions.map((d) => ({
    idx: d.idx,
    id: d.id,
    name: d.name,
    tags: d.tags.map((t) => {
      const parentIdx = t.parentId === null || dimensionIdByTagId.get(t.parentId) !== d.id
        ? undefined
        : tagIdxById.get(t.parentId);
      return {
        idx: t.idx,
        id: t.id,
        label: t.label,
        ...(parentIdx === undefined ? {} : { parentIdx }),
      };
    }),
  }));
  const lists = lib.variableLists.map((l, idx) => ({
    idx,
    id: l.id,
    name: l.name,
    options: l.options.map((o, oIdx) => {
      const tagIdxs = o.tagIds.map((tid) => tagIdxById.get(tid)).filter((n): n is number => n !== undefined);
      const excludeTagIdxs = (o.excludeTagIds ?? [])
        .map((tid) => tagIdxById.get(tid))
        .filter((n): n is number => n !== undefined);
      return {
        idx: oIdx,
        id: o.id,
        value: o.value,
        weight: o.weight,
        tagIdxs,
        ...(excludeTagIdxs.length === 0 ? {} : { excludeTagIdxs }),
      };
    }),
  }));
  return rebuildSnapshotDerivedFields({ dimensions, lists });
}

// Stable structural fingerprint of the live library used for drift detection.
// Excludes the volatile `idx` (positional) -- only ids/names/labels/membership.
export function snapshotHash(s: LibrarySnapshot): string {
  const tagIdByIdx = new Map<number, string>();
  s.dimensions.forEach((d) => { d.tags.forEach((t) => tagIdByIdx.set(t.idx, t.id)); });
  const canon = {
    d: s.dimensions.map((d) => [
      d.id,
      d.name,
      d.tags.map((t) => [t.id, t.label, t.parentIdx === undefined ? null : (tagIdByIdx.get(t.parentIdx) ?? `unknown:${t.parentIdx}`)]),
    ]),
    l: s.lists.map((l) => [
      l.id,
      l.name,
      l.options.map((o) => [
        o.id,
        o.value,
        o.tagIdxs.map((idx) => tagIdByIdx.get(idx) ?? `unknown:${idx}`).sort(),
        (o.excludeTagIdxs ?? []).map((idx) => tagIdByIdx.get(idx) ?? `unknown:${idx}`).sort(),
      ]),
    ]),
  };
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex').slice(0, 16);
}

// Parallel fingerprint of the live library's templates (name + body). Stored
// alongside `baseSnapshotHash` on the proposal so /apply and /rescue can
// detect rename/body edits between infer and apply — `snapshotHash` only
// covers dimensions + lists, so without this a template edit would leave a
// stored conflict (diagnosed against the OLD body) wired to the NEW template
// state. Stable + order-independent: sort by id before hashing.
export function templatesDigest(templates: readonly { id: string; name: string; body: string }[]): string {
  const canon = templates
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((t) => [t.id, t.name, t.body]);
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex').slice(0, 16);
}

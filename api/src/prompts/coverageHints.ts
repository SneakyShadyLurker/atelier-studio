import type { LibrarySnapshot, SnapDim, SnapList } from './inferTypes';

// Lists whose name strongly implies one or more dimensions. The mapping is
// product-owned and matches the heuristic encoded in
// inferDimensionsSystemPrompt.ts § "List-name → dimension heuristic". Keep the
// two in sync — drift here lets the prompt and the server-side gate disagree
// on what "name-implied" means.
//
// Lookup is case-insensitive and tolerant of underscore/space/hyphen variants
// so renames like `fantasy_race` → `Fantasy Race` don't silently disable the
// gate.
export const LIST_NAME_IMPLIES_DIMS: Record<string, readonly string[]> = {
  fantasy_franchise: ['Franchise', 'Genre'],
  fantasy_race: ['Franchise', 'Genre'],
  fantasy_role: ['Genre'],
  fantasy_outfit: ['Genre'],
  fantasy_location: ['Genre'],
  scifi_role: ['Genre'],
  scifi_outfit: ['Genre'],
  scifi_location: ['Genre'],
  job: ['Genre'],
  modern_outfit: ['Genre'],
  modern_location: ['Genre'],
  // Legacy aliases — preserved so a library that hasn't been renamed yet
  // still triggers the gate. Once `outfit`/`location` are gone, these can
  // be deleted.
  outfit: ['Genre'],
  location: ['Genre'],
  camera: ['Era', 'Medium'],
  image_type: ['Medium'],
  medium: ['Medium'],
  era: ['Era'],
};

const normaliseListName = (name: string): string =>
  name.trim().toLowerCase().replace(/[\s-]+/g, '_');

export function impliedDimensionsForList(name: string): readonly string[] {
  const key = normaliseListName(name);
  return Object.hasOwn(LIST_NAME_IMPLIES_DIMS, key) ? LIST_NAME_IMPLIES_DIMS[key] ?? [] : [];
}

export interface CoverageHint {
  listIdx: number;
  listName: string;
  dim: string;
  untaggedOptionIdxs: number[];
}

// For each list whose name implies one or more dimensions, enumerate the
// option indices that are zero-tagged on each implied dimension. The model
// receives this as a "non-negotiable to-do" block alongside the snapshot.
//
// `dimByName` is computed once per call. Options that the snapshot already
// tags on the implied dim are filtered out — we only surface the gap.
export function buildCoverageHints(snap: LibrarySnapshot): CoverageHint[] {
  // Build dimByName once and delegate the per-list scan so the
  // "missing dim ⇒ every option untagged" fallback lives in one place.
  const dimByName = new Map<string, SnapDim>(snap.dimensions.map((d) => [d.name, d] as const));
  const out: CoverageHint[] = [];
  for (const list of snap.lists) {
    out.push(...buildCoverageHintsForList(snap, list, undefined, dimByName));
  }
  return out;
}

// Same as buildCoverageHints, but scoped to a single list (used by the Pass-2
// per-list / per-chunk dispatch so each batch carries only the hints for the
// options it can actually address). For a chunked slice, pass the option
// indices the slice covers; the function filters its idx list accordingly.
// `dimByName` may be supplied to avoid rebuilding it per list when called in a
// loop (buildCoverageHints does this); omitted, it is built from `snap`.
//
// If an implied dimension doesn't exist yet, every option counts as untagged on
// it — the model needs to know so it creates the dim AND wires the options.
export function buildCoverageHintsForList(
  snap: LibrarySnapshot,
  list: SnapList,
  scopedOptionIdxs?: ReadonlySet<number>,
  dimByName = new Map<string, SnapDim>(snap.dimensions.map((d) => [d.name, d] as const)),
): CoverageHint[] {
  const implied = impliedDimensionsForList(list.name);
  if (implied.length === 0) return [];
  const out: CoverageHint[] = [];
  for (const dimName of implied) {
    const dim = dimByName.get(dimName);
    const tagIdxsInDim = dim
      ? new Set<number>(dim.tags.map((t) => t.idx))
      : new Set<number>();
    const untagged: number[] = [];
    for (const opt of list.options) {
      if (opt.weight <= 0) continue;
      if (scopedOptionIdxs && !scopedOptionIdxs.has(opt.idx)) continue;
      const hasAnyOnDim = dim
        ? [
          ...(opt.expandedTagIdxs ?? opt.tagIdxs),
          ...(opt.expandedExcludeTagIdxs ?? opt.excludeTagIdxs ?? []),
        ].some((i) => tagIdxsInDim.has(i))
        : false;
      if (!hasAnyOnDim) untagged.push(opt.idx);
    }
    if (untagged.length > 0) {
      out.push({
        listIdx: list.idx,
        listName: list.name,
        dim: dimName,
        untaggedOptionIdxs: untagged,
      });
    }
  }
  return out;
}

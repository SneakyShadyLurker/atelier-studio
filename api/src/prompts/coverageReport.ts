import type { CoverageOrphanTag, CoverageWarning, LibraryCoverageResponse, PromptLibraryResponse } from '@atelier/shared';
import type { LibrarySnapshot, RawBundle } from './inferTypes';
import { buildCoverageHints, impliedDimensionsForList } from './coverageHints';
import { snapshotHash, templatesDigest, toLibrarySnapshot } from './librarySnapshot';

// Coverage targets that match the prompt's "≥90%" instruction. Tunable in
// one place if we ever discover the threshold needs softening per-list.
const COVERAGE_THRESHOLD = 0.9;

// `${dim}:${label}` -> number of option assignments referencing that tag.
// Shared by coverageWarnings (orphan branch) and orphanTagsAtRest, which built
// this map identically; a change to tag-membership semantics now lives once.
function buildTagAssignmentCounts(snap: LibrarySnapshot): Map<string, number> {
  const counts = new Map<string, number>();
  for (const dim of snap.dimensions) {
    const tagIdxToLabel = new Map(dim.tags.map((t) => [t.idx, t.label] as const));
    for (const list of snap.lists) {
      for (const opt of list.options) {
        const assigned = new Set([
          ...(opt.expandedTagIdxs ?? opt.tagIdxs),
          ...(opt.expandedExcludeTagIdxs ?? opt.excludeTagIdxs ?? []),
        ]);
        for (const tagIdx of assigned) {
          const label = tagIdxToLabel.get(tagIdx);
          if (label === undefined) continue;
          const key = `${dim.name}:${label}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
    }
  }
  return counts;
}

export function coverageWarnings(
  bundles: readonly RawBundle[],
  preview: LibrarySnapshot,
): CoverageWarning[] {
  const out: CoverageWarning[] = [];
  const dimByName = new Map(preview.dimensions.map((d) => [d.name, d] as const));

  // Resolve `extend:<dimId>` bundle keys against the preview snap so we can
  // attribute addTags labels to a dim NAME for the orphan check below. The
  // preview's dim ids match the live ones for non-created dims, so id
  // lookup is reliable.
  const dimById = new Map(preview.dimensions.map((d) => [d.id, d] as const));
  const extendDimName = (b: RawBundle): string | null => {
    if (!b.key.startsWith('extend:')) return null;
    const id = b.key.slice('extend:'.length);
    return dimById.get(id)?.name ?? null;
  };

  // ── Orphan tags: created/added tag with zero option assignments ─────
  const tagAssignments = buildTagAssignmentCounts(preview);

  const seen = new Set<string>();
  for (const b of bundles) {
    for (const op of b.ops) {
      const dim = op.op === 'createDimension'
        ? op.name
        : op.op === 'addTags'
          ? extendDimName(b)
          : null;
      if (dim === null) continue;
      const labels = op.op === 'createDimension' || op.op === 'addTags' ? op.tags : [];
      for (const label of labels) {
        const key = `${dim}:${label}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const count = tagAssignments.get(key) ?? 0;
        if (count === 0) {
          out.push({
            kind: 'orphanTag',
            dim,
            label,
            detail: `tag "${label}" was created on dimension "${dim}" but no option uses it — the option whose name names this tag stays a wildcard`,
          });
        }
      }
    }
  }

  // ── Low coverage on name-implied lists ──────────────────────────────
  for (const list of preview.lists) {
    const implied = impliedDimensionsForList(list.name);
    if (implied.length === 0) continue;
    const automaticOptions = list.options.filter((option) => option.weight > 0);
    if (automaticOptions.length === 0) continue;
    for (const dimName of implied) {
      const dim = dimByName.get(dimName);
      if (!dim) {
        // Dimension that the list-name heuristic says should exist isn't
        // even in the preview. That's a stronger failure than low
        // coverage — surface it explicitly.
        out.push({
          kind: 'missingDimension',
          listName: list.name,
          dim: dimName,
          detail: `list "${list.name}" implies dimension "${dimName}" but it doesn't exist after this proposal — every option will be a wildcard on that axis`,
        });
        continue;
      }
      const tagIdxs = new Set(dim.tags.map((t) => t.idx));
      let tagged = 0;
      for (const opt of automaticOptions) {
        if ([
          ...(opt.expandedTagIdxs ?? opt.tagIdxs),
          ...(opt.expandedExcludeTagIdxs ?? opt.excludeTagIdxs ?? []),
        ].some((i) => tagIdxs.has(i))) tagged += 1;
      }
      const coverage = tagged / automaticOptions.length;
      if (coverage < COVERAGE_THRESHOLD) {
        const untagged = automaticOptions.length - tagged;
        out.push({
          kind: 'lowCoverage',
          listName: list.name,
          dim: dimName,
          coverage,
          taggedCount: tagged,
          totalCount: automaticOptions.length,
          detail: `list "${list.name}" expects ≥${Math.round(COVERAGE_THRESHOLD * 100)}% coverage on "${dimName}" — ${untagged} of ${automaticOptions.length} options remain untagged and will roll as wildcards`,
        });
      }
    }
  }

  return out;
}

// At rest there are no proposal bundles, so coverageWarnings([], snap) never
// runs its orphan branch (which only iterates bundle ops). Compute orphan
// tags directly from the snapshot: a dimension tag is orphaned when ZERO
// options reference its idx. Same assignment map coverageWarnings builds.
export function orphanTagsAtRest(snap: LibrarySnapshot): CoverageOrphanTag[] {
  const tagAssignments = buildTagAssignmentCounts(snap);
  const out: CoverageOrphanTag[] = [];
  for (const dim of snap.dimensions) {
    for (const tag of dim.tags) {
      if ((tagAssignments.get(`${dim.name}:${tag.label}`) ?? 0) === 0) {
        out.push({ dim: dim.name, label: tag.label });
      }
    }
  }
  return out;
}

export function coverageReport(lib: PromptLibraryResponse): LibraryCoverageResponse {
  const snap = toLibrarySnapshot(lib);
  const listIdByName = new Map(snap.lists.map((l) => [l.name, l.id] as const));

  const untaggedByList = buildCoverageHints(snap).map((hint) => ({
    listId: listIdByName.get(hint.listName) ?? '',
    listName: hint.listName,
    dim: hint.dim,
    untaggedCount: hint.untaggedOptionIdxs.length,
  }));

  // orphan tags come from the at-rest helper (NOT coverageWarnings, which
  // yields zero orphans when bundles === []).
  const orphanTags = orphanTagsAtRest(snap);

  const warnings = coverageWarnings([], snap);
  const lowCoverageLists = warnings
    .filter((w): w is Extract<typeof w, { kind: 'lowCoverage' }> => w.kind === 'lowCoverage')
    .map((w) => ({
      listName: w.listName,
      dim: w.dim,
      coverage: w.coverage,
      taggedCount: w.taggedCount,
      totalCount: w.totalCount,
    }));
  const missingDimensions = warnings
    .filter((w): w is Extract<typeof w, { kind: 'missingDimension' }> => w.kind === 'missingDimension')
    .map((w) => ({ listName: w.listName, dim: w.dim }));

  return {
    untaggedByList,
    lowCoverageLists,
    orphanTags,
    missingDimensions,
    librarySnapshotHash: snapshotHash(snap),
    templatesDigest: templatesDigest(lib.templates),
  };
}

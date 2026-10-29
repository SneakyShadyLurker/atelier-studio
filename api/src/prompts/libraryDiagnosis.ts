import type {
  LibraryDiagnosisEntry,
  LibraryDiagnosisResponse,
  PromptLibraryResponse,
} from '@atelier/shared';
import { snapshotHash, templatesDigest, toLibrarySnapshot } from './librarySnapshot';
import { DIAGNOSIS_BUDGET_EXCEEDED_REASON } from './diagnoseTemplateConflicts';
import {
  conflictDimensionIdxs,
  spendCoherenceWork,
  tagDimOf,
  type OptionTagIndex,
  templateSatisfiableByOccurrences,
  templateSatisfiableBranchAware,
} from './dimensionCoherence';
import { extractDistinctListNames } from './templateRefs';
import { extractOccurrences } from './varOccurrences';
import { enumerateRandomBranches } from '@atelier/shared/template-tokens';

const DIAGNOSIS_NODE_BUDGET = 200_000;
let DIAGNOSIS_NODE_BUDGET_OVERRIDE: number | null = null;

export function _setDiagnosisNodeBudgetForTests(n: number | null): void {
  DIAGNOSIS_NODE_BUDGET_OVERRIDE = n;
}

function diagnosisNodeBudget(): number {
  return DIAGNOSIS_NODE_BUDGET_OVERRIDE ?? DIAGNOSIS_NODE_BUDGET;
}

// Pure deterministic library-wide coherence audit.
//
// Runs `templateSatisfiable` against the current library (zero proposed
// bundles). For every template that returns `false`, walks the snapshot
// to surface the offending list-pair × dimension triples in the wire
// shape `ConflictingPair`.
//
// Single source of truth shared by the HTTP endpoint and the CI script.
// Reuses the existing SAT engine — does not re-implement the walk.

export function diagnoseLibrary(lib: PromptLibraryResponse): LibraryDiagnosisResponse {
  const snap = toLibrarySnapshot(lib);
  const templateRefs = lib.templates.map((t) => ({
    name: t.name,
    body: t.body,
    lists: extractDistinctListNames(t.body),
  }));
  const budgetByTemplate = new Map<string, { budgetRef: { nodes: number }; totalBudget: number }>();

  // First-pass: pass/fail per template, with per-template budget.
  const entries: LibraryDiagnosisEntry[] = templateRefs.map((t) => {
    // Dangling-list check FIRST — templates referencing missing or empty
    // lists can never resolve, regardless of slot count. Use the flat list
    // (all var-names across all branches) for the missing-list check so that
    // a template with a branch referencing a deleted list still gets flagged.
    const missingLists = t.lists.filter((listName) => {
      const list = snap.lists.find((l) => l.name === listName);
      return !list || list.options.every((option) => option.weight === 0);
    });
    if (missingLists.length > 0) {
      return {
        templateName: t.name,
        satisfiable: false,
        reason: `missing or empty list(s): ${missingLists.join(', ')}`,
      };
    }
    if (t.lists.length < 2) {
      return { templateName: t.name, satisfiable: true };
    }
    // Per-template budget: one hard template can't pollute later ones.
    // Branch-aware: each {{random::}} alternative is checked independently
    // so templates with branch-disjoint tag schemes are not false-positived.
    const localBudget = diagnosisNodeBudget();
    const localBudgetRef = { nodes: 0 };
    budgetByTemplate.set(t.name, { budgetRef: localBudgetRef, totalBudget: localBudget });
    const ok = templateSatisfiableBranchAware(t.body, snap, { nodeBudgetRef: localBudgetRef, totalBudget: localBudget });
    if (ok) return { templateName: t.name, satisfiable: true };
    if (localBudgetRef.nodes >= localBudget) {
      return {
        templateName: t.name,
        satisfiable: false,
        reason: `${DIAGNOSIS_BUDGET_EXCEEDED_REASON} -- culprit set non-local`,
      };
    }
    return { templateName: t.name, satisfiable: false };
  });

  // Second-pass: for every unsatisfiable template that DOESN'T already have a
  // reason set (i.e. only the SAT failures, not the missing-list or
  // budget-exceeded ones), compute conflicting pairs from only the failing
  // branch shapes.
  const tagDim = tagDimOf(snap);
  for (const entry of entries) {
    if (entry.satisfiable) continue;
    if (entry.reason) continue; // already classified (missing-list or budget-exceeded)
    const t = templateRefs.find((r) => r.name === entry.templateName);
    if (!t) continue;
    const budget = budgetByTemplate.get(t.name) ?? { budgetRef: { nodes: 0 }, totalBudget: diagnosisNodeBudget() };
    const { lists, pairs, budgetExceeded } = branchAwareConflictPairs(t.body, snap, tagDim, budget);
    if (budgetExceeded) {
      Object.assign(entry, {
        reason: `${DIAGNOSIS_BUDGET_EXCEEDED_REASON} -- culprit set non-local`,
      });
      continue;
    }
    if (pairs.length > 0) {
      Object.assign(entry, {
        conflictingPairs: pairs,
        reason: `no satisfying combination across ${lists.join(', ')}`,
      });
    } else {
      Object.assign(entry, {
        reason: `no satisfying combination across ${lists.join(', ')} -- culprit set non-local`,
      });
    }
  }

  return {
    templates: entries,
    librarySnapshotHash: snapshotHash(snap),
    templatesDigest: templatesDigest(lib.templates),
  };
}

// ─── pair-walk helpers (private) ─────────────────────────────────────

type Snap = ReturnType<typeof toLibrarySnapshot>;

function intersectDimensionIdxs(
  a: ReadonlySet<number>,
  b: ReadonlySet<number>,
): Set<number> {
  const intersection = new Set<number>();
  for (const dimensionIdx of a) {
    if (b.has(dimensionIdx)) intersection.add(dimensionIdx);
  }
  return intersection;
}

function branchAwareConflictPairs(
  body: string,
  snap: Snap,
  tagDim: Map<number, number>,
  budget: { budgetRef: { nodes: number }; totalBudget: number },
): {
  lists: string[];
  pairs: { listA: string; listB: string; dimensionName: string }[];
  budgetExceeded: boolean;
} {
  const pairKeys = new Set<string>();
  const optionTags: OptionTagIndex = new Map();
  const listNames = new Set<string>();
  const pairs: { listA: string; listB: string; dimensionName: string }[] = [];

  for (const shape of enumerateRandomBranches(body)) {
    if (budget.budgetRef.nodes >= budget.totalBudget) {
      return { lists: [...listNames], pairs: [], budgetExceeded: true };
    }
    const branchOccs = extractOccurrences(shape);
    if (branchOccs.length < 2) continue;
    if (templateSatisfiableByOccurrences(branchOccs, snap, {
      nodeBudgetRef: budget.budgetRef,
      totalBudget: budget.totalBudget,
    })) continue;
    if (budget.budgetRef.nodes >= budget.totalBudget) {
      return { lists: [...listNames], pairs: [], budgetExceeded: true };
    }
    // The authoritative SAT gate above is occurrence-aware; the display-only
    // pair hint below is derived from the deduped list names. A cross-subject
    // false-positive pair is acceptable in the hint as long as the top-level
    // `satisfiable` flag (occurrence-aware) is correct.
    const branchLists = [...new Set(branchOccs.map((o) => o.listName))];
    for (const listName of branchLists) listNames.add(listName);
    const branchPairs = guaranteedConflictPairs(branchLists, snap, tagDim, optionTags, budget);
    if (branchPairs === null) return { lists: [...listNames], pairs: [], budgetExceeded: true };
    for (const pair of branchPairs) {
      const [a, b] = [pair.listA, pair.listB].sort();
      if (a === undefined || b === undefined) continue;
      const key = `${a}\u0000${b}\u0000${pair.dimensionName}`;
      if (pairKeys.has(key)) continue;
      pairKeys.add(key);
      pairs.push(pair);
    }
  }

  return { lists: [...listNames], pairs, budgetExceeded: false };
}

function guaranteedConflictPairs(
  listNames: readonly string[],
  snap: Snap,
  tagDim: Map<number, number>,
  optionTags: OptionTagIndex,
  budget: { budgetRef: { nodes: number }; totalBudget: number },
): { listA: string; listB: string; dimensionName: string }[] | null {
  const out: { listA: string; listB: string; dimensionName: string }[] = [];
  const workBudget = { nodeBudgetRef: budget.budgetRef, totalBudget: budget.totalBudget };
  const dimensionNameByIdx = new Map(snap.dimensions.map((dimension) => [dimension.idx, dimension.name]));
  for (let i = 0; i < listNames.length; i++) {
    for (let j = i + 1; j < listNames.length; j++) {
      const a = listNames[i];
      const b = listNames[j];
      if (a === undefined || b === undefined) continue;
      const listA = snap.lists.find((list) => list.name === a);
      const listB = snap.lists.find((list) => list.name === b);
      if (!listA || !listB) continue;
      const optionsA = listA.options.filter((option) => option.weight > 0);
      const optionsB = listB.options.filter((option) => option.weight > 0);
      if (optionsA.length === 0 || optionsB.length === 0) continue;
      let guaranteed: Set<number> | null = null;
      optionPairs: for (const optionA of optionsA) {
        for (const optionB of optionsB) {
          if (!spendCoherenceWork(workBudget)) return null;
          const pairConflicts = conflictDimensionIdxs(optionA, optionB, tagDim, optionTags);
          guaranteed = guaranteed === null
            ? new Set(pairConflicts)
            : intersectDimensionIdxs(guaranteed, pairConflicts);
          // An intersection can only shrink; no dimension can become
          // guaranteed again after one compatible option-pair rules it out.
          if (guaranteed.size === 0) break optionPairs;
        }
      }
      for (const dimensionIdx of guaranteed ?? []) {
        const dimensionName = dimensionNameByIdx.get(dimensionIdx);
        if (dimensionName) out.push({ listA: a, listB: b, dimensionName });
      }
    }
  }
  return out;
}

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
  type BudgetOptions,
} from './dimensionCoherence';
import { extractDistinctListNames } from './templateRefs';
import { extractOccurrences } from './varOccurrences';
import { enumerateRandomBranches } from '@atelier/shared/template-tokens';

export const DIAGNOSIS_NODE_BUDGET = 200_000;
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

export function diagnoseLibrary(lib: PromptLibraryResponse, options?: BudgetOptions & { maxTemplateBudget?: number }): LibraryDiagnosisResponse {
  const snap = toLibrarySnapshot(lib);
  const templateRefs = lib.templates.map((t) => ({
    name: t.name,
    body: t.body,
    lists: extractDistinctListNames(t.body),
  }));
  // One request budget covers every template and its pair explanations. A
  // large library must not multiply the solver ceiling by its template count.
  const totalBudget = options?.totalBudget ?? diagnosisNodeBudget();
  const budgetRef = options?.nodeBudgetRef ?? { nodes: 0 };
  const automaticListNames = new Set(snap.lists
    .filter((list) => list.options.some((option) => option.weight > 0))
    .map((list) => list.name));

  const prepared = templateRefs.map((t) => ({ ...t, missingLists: t.lists.filter((name) => !automaticListNames.has(name)) }));
  const solverCount = prepared.filter((t) => t.missingLists.length === 0 && t.lists.length >= 2).length;
  // Fixed equal quotas make both verdicts and explanations independent of order.
  // Cheap proofs need no quota; unused solver work stays with its template.
  const quota = solverCount === 0 ? 0 : Math.min(options?.maxTemplateBudget ?? Number.MAX_SAFE_INTEGER,
    Math.floor(Math.max(0, totalBudget - budgetRef.nodes) / solverCount));
  const tagDim = tagDimOf(snap);
  const entries: LibraryDiagnosisEntry[] = prepared.map((t) => {
    // Dangling-list check FIRST — templates referencing missing or empty
    // lists can never resolve, regardless of slot count. Use the flat list
    // (all var-names across all branches) for the missing-list check so that
    // a template with a branch referencing a deleted list still gets flagged.
    if (t.missingLists.length > 0) {
      return {
        templateName: t.name,
        satisfiable: false,
        reason: `missing or empty list(s): ${t.missingLists.join(', ')}`,
      };
    }
    if (t.lists.length < 2) {
      return { templateName: t.name, satisfiable: true };
    }
    if (quota === 0) return {
      templateName: t.name, satisfiable: null,
      reason: DIAGNOSIS_BUDGET_EXCEEDED_REASON,
    };
    // The solver's final failed spend is an exhaustion sentinel, not actual
    // work. Debit only executed work when aggregating the request counter.
    const localRef = { nodes: 0 };
    const localLimit = quota;
    const budget = { budgetRef: localRef, totalBudget: localLimit };
    try {
      // Branch-aware: each {{random::}} alternative is checked independently
      // so templates with branch-disjoint tag schemes are not false-positived.
      const ok = templateSatisfiableBranchAware(t.body, snap, { nodeBudgetRef: localRef, totalBudget: localLimit });
      if (ok) return { templateName: t.name, satisfiable: true };
      if (localRef.nodes >= localLimit) {
        return {
          templateName: t.name,
          satisfiable: null,
          reason: DIAGNOSIS_BUDGET_EXCEEDED_REASON,
        };
      }
      const { lists, pairs, budgetExceeded } = branchAwareConflictPairs(t.body, snap, tagDim, budget);
      if (budgetExceeded) {
        return { templateName: t.name, satisfiable: false,
          reason: `no satisfying combination; conflict explanation incomplete (${DIAGNOSIS_BUDGET_EXCEEDED_REASON})`,
        };
      }
      if (pairs.length > 0) {
        return { templateName: t.name, satisfiable: false,
          conflictingPairs: pairs,
          reason: `no satisfying combination across ${lists.join(', ')}`,
        };
      }
      return { templateName: t.name, satisfiable: false,
        reason: `no satisfying combination across ${lists.join(', ')} -- culprit set non-local`,
      };
    } finally { budgetRef.nodes += Math.min(localRef.nodes, localLimit); }
  });

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

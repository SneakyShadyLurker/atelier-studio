import type { LibrarySnapshot, RawBundle } from './inferTypes';
import type { TemplateConflict } from '@atelier/shared';
import type { TemplateRefs } from './dimensionCoherence';
import { templateSatisfiableByOccurrences } from './dimensionCoherence';
import { extractOccurrences, type VarOccurrenceRef } from './varOccurrences';
import { applyBundlesToSnapshot } from './dimensionResolver';
import { InvalidTagMutationError } from './tagHierarchy';
import { enumerateRandomBranches } from '@atelier/shared/template-tokens';
import { bundleWorkSize, snapshotWorkSize } from './librarySnapshot';

export interface DiagnoseOptions {
  readonly maxCulpritSubsetSize?: number;
  readonly totalNodeBudget?: number;
  // Internal reuse of a strict final-state preview already validated by inference.
  readonly validatedPreview?: LibrarySnapshot;
}

const DEFAULT_MAX_CULPRIT_SUBSET_SIZE = 4;
const DEFAULT_TOTAL_NODE_BUDGET = 200_000;

// Canonical base wording for the SAT node-budget-exhausted outcome. Single
// source so the per-template factory below and libraryDiagnosis's
// `<reason> -- culprit set non-local` variant stay in lockstep (both are
// asserted verbatim in tests).
export const DIAGNOSIS_BUDGET_EXCEEDED_REASON = 'diagnosis budget exceeded';

function validSubsetPreview(snap: LibrarySnapshot, subset: readonly RawBundle[]): LibrarySnapshot | null {
  try {
    return applyBundlesToSnapshot(snap, subset);
  } catch (error) {
    if (error instanceof InvalidTagMutationError) return null;
    throw error;
  }
}

function budgetExceededConflict(templateName: string): Omit<TemplateConflict, 'inBranch' | 'totalBranches'> {
  return {
    templateName,
    reason: DIAGNOSIS_BUDGET_EXCEEDED_REASON,
    culpritBundleKeys: [],
    rescueAttempted: false,
    culpritKind: 'non-local',
  };
}

// Per-template diagnostic for a single set of var-refs. Returns 0 or 1 conflict.
function diagnoseOneTemplate(
  templateName: string,
  occurrences: readonly VarOccurrenceRef[],
  rawBundles: readonly RawBundle[],
  snap: LibrarySnapshot,
  previewFull: LibrarySnapshot,
  maxSubsetSize: number,
  verdictBudgetRef: { nodes: number },
  budgetRef: { nodes: number },
  totalBudget: number,
  previewCost: number,
): Omit<TemplateConflict, 'inBranch' | 'totalBranches'> | null {
  if (occurrences.length < 2) return null;
  const lists = [...new Set(occurrences.map((o) => o.listName))];
  // Full-proposal verdicts and culprit search have separately capped GLOBAL
  // budgets. Structural search exhaustion must not contaminate later verdicts.
  if (verdictBudgetRef.nodes >= totalBudget) return budgetExceededConflict(templateName);
  const passWithAll = templateSatisfiableByOccurrences(occurrences, previewFull, { nodeBudgetRef: verdictBudgetRef, totalBudget });
  if (passWithAll) return null;
  if (verdictBudgetRef.nodes > totalBudget || budgetRef.nodes >= totalBudget) {
    return budgetExceededConflict(templateName);
  }
  // Phase 1: single-bundle elimination
  let culprit: string[] | null = null;
  for (let i = 0; i < rawBundles.length; i++) {
    const candidate = rawBundles[i];
    if (!candidate) continue;
    // Cloning and applying a large structure must not cost one SAT node.
    budgetRef.nodes += previewCost;
    if (budgetRef.nodes >= totalBudget) break;
    const subset = rawBundles.filter((_, j) => j !== i);
    const preview = validSubsetPreview(snap, subset);
    if (!preview) continue;
    if (templateSatisfiableByOccurrences(occurrences, preview, { nodeBudgetRef: budgetRef, totalBudget })) {
      culprit = [candidate.key];
      break;
    }
  }
  // Phase 2: bounded subset search (size 2 .. maxSubsetSize)
  if (culprit === null && budgetRef.nodes < totalBudget) {
    for (let k = 2; k <= maxSubsetSize && culprit === null && budgetRef.nodes < totalBudget; k++) {
      const found = findRestoringSubsetOfSize(rawBundles, snap, occurrences, k, budgetRef, totalBudget, previewCost);
      if (found) culprit = found;
    }
  }
  if (culprit === null && budgetRef.nodes >= totalBudget) return budgetExceededConflict(templateName);
  return {
    templateName,
    reason: culprit
      ? `removing ${culprit.length} bundle(s) restores satisfiability across ${lists.join(', ')}`
      : `no satisfying combination across ${lists.join(', ')} — culprit set larger than diagnosis bound`,
    culpritBundleKeys: culprit ?? [],
    rescueAttempted: false,
    culpritKind: culprit ? 'local' : 'non-local',
  };
}

export function diagnoseTemplateConflicts(
  rawBundles: readonly RawBundle[],
  snap: LibrarySnapshot,
  templates: readonly TemplateRefs[],
  opts?: DiagnoseOptions,
): TemplateConflict[] {
  const maxSubsetSize = opts?.maxCulpritSubsetSize ?? DEFAULT_MAX_CULPRIT_SUBSET_SIZE;
  const budgetRef = { nodes: 0 };
  const verdictBudgetRef = { nodes: 0 };
  const totalBudget = opts?.totalNodeBudget ?? DEFAULT_TOTAL_NODE_BUDGET;

  const previewFull = opts?.validatedPreview ?? applyBundlesToSnapshot(snap, rawBundles);
  // Computed once, including both the source clone and the resulting taxonomy.
  // This charges membership replay/validation too, not just option rows, so a
  // dense library cannot perform unbudgeted work in every culprit subset.
  const previewCost = Math.max(1, snapshotWorkSize(snap) + snapshotWorkSize(previewFull)
    + bundleWorkSize(rawBundles));
  const conflicts: TemplateConflict[] = [];

  for (const t of templates) {
    if (t.body !== undefined) {
      // Branch-aware: enumerate shapes and diagnose each independently.
      const shapes = enumerateRandomBranches(t.body);
      for (let i = 0; i < shapes.length; i++) {
        const shape = shapes[i];
        if (shape === undefined) continue;
        const branchOccs = extractOccurrences(shape);
        const conflict = diagnoseOneTemplate(
          t.name, branchOccs, rawBundles, snap, previewFull, maxSubsetSize, verdictBudgetRef, budgetRef, totalBudget, previewCost,
        );
        if (conflict) {
          conflicts.push(
            shapes.length > 1
              ? { ...conflict, inBranch: i, totalBranches: shapes.length }
              : conflict,
          );
          break; // one conflict per template (first failing branch)
        }
      }
    } else {
      // Legacy / no-body: use the pre-extracted lists as scene-level occurrences.
      const conflict = diagnoseOneTemplate(
        t.name,
        t.lists.map((listName) => ({ listName, subject: null })),
        rawBundles, snap, previewFull, maxSubsetSize, verdictBudgetRef, budgetRef, totalBudget, previewCost,
      );
      if (conflict) conflicts.push(conflict);
    }
  }

  return conflicts;
}

function findRestoringSubsetOfSize(
  rawBundles: readonly RawBundle[],
  snap: LibrarySnapshot,
  occurrences: readonly VarOccurrenceRef[],
  size: number,
  budgetRef: { nodes: number },
  totalBudget: number,
  previewCost: number,
): string[] | null {
  const indices: readonly number[] = rawBundles.map((_, i) => i);
  return combinationsOfSize(indices, size, (combo): string[] | null => {
    budgetRef.nodes += previewCost;
    if (budgetRef.nodes >= totalBudget) return null;
    const removeSet = new Set(combo);
    const subset = rawBundles.filter((_, i) => !removeSet.has(i));
    const preview = validSubsetPreview(snap, subset);
    if (!preview) return null;
    if (templateSatisfiableByOccurrences(occurrences, preview, { nodeBudgetRef: budgetRef, totalBudget })) {
      const keys: string[] = [];
      for (const i of combo) {
        const b = rawBundles[i];
        if (b) keys.push(b.key);
      }
      return keys;
    }
    return null;
  }, () => budgetRef.nodes >= totalBudget);
}

function combinationsOfSize<T>(
  arr: readonly number[],
  size: number,
  visit: (combo: readonly number[]) => T | null,
  shouldStop: () => boolean,
): T | null {
  const combo: number[] = [];
  const dfs = (start: number, depth: number): T | null => {
    if (shouldStop()) return null;
    if (depth === size) return visit(combo);
    for (let i = start; i < arr.length; i++) {
      if (shouldStop()) return null;
      const v = arr[i];
      if (v === undefined) continue;
      combo.push(v);
      const r = dfs(i + 1, depth + 1);
      combo.pop();
      if (r !== null) return r;
    }
    return null;
  };
  return dfs(0, 0);
}

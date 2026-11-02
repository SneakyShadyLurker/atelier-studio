import type { LibrarySnapshot } from './inferTypes';
import { coherenceBudget, countListConflictEdges, templateSatisfiableByOccurrences, type BudgetOptions } from './dimensionCoherence';
import type { VarOccurrenceRef } from './varOccurrences';

export type RescueTarget =
  | { readonly ok: true; readonly listName: string }
  | { readonly ok: false; readonly reason: 'no-target' };

// Pick WHICH list of a failing template should receive a new rescue option.
// Algorithm (satisfiability-preserving — replaces an earlier unsound
// "smallest domain" heuristic; see the counterexample test):
//   1. For each candidate list Lᵢ in `listNames`, build a hypothetical
//      snapshot where Lᵢ's options are replaced by ONE 0-tag wildcard.
//      Re-check templateSatisfiable on the same listNames.
//      - Passes  → Lᵢ is a VIABLE target (a future bridging option in Lᵢ
//        could in principle resolve the conflict).
//      - Fails   → Lᵢ is NOT viable (two other lists have a pairwise
//        conflict on a dimension Lᵢ can't influence).
//   2. Rank viable targets by (a) descending in-list conflict edges
//      (highest leverage), then (b) ascending domain size (smallest
//      relative impact).
//   3. No viable target → { ok: false, reason: 'no-target' }.
interface Candidate { name: string; conflictEdges: number; domainSize: number }

export function pickRescueTargetList(
  snap: LibrarySnapshot,
  occurrences: readonly VarOccurrenceRef[],
  budgetOpts?: BudgetOptions,
): RescueTarget {
  const budget = coherenceBudget(budgetOpts);
  const viable: Candidate[] = [];
  let verifiedFallback: string | null = null;
  const names = [...new Set(occurrences.map((o) => o.listName))];

  for (const name of names) {
    const list = snap.lists.find((l) => l.name === name);
    if (!list) continue;
    const wildcardSnap: LibrarySnapshot = {
      dimensions: snap.dimensions,
      lists: snap.lists.map((l) =>
        l.name === name
          ? { ...l, options: [{ idx: 0, id: '__rescue_wildcard__', value: '__wildcard__', weight: 1, tagIdxs: [] }] }
          : l,
      ),
    };
    const satisfiable = templateSatisfiableByOccurrences(occurrences, wildcardSnap, budget);
    if (budget.nodeBudgetRef.nodes > budget.totalBudget) break;
    if (!satisfiable) continue;
    verifiedFallback ??= name;
    const conflictEdges = countListConflictEdges(snap, list, budget);
    // Ranking is only a heuristic. Keep a completed viability verdict even
    // when the exact edge count or a later candidate exhausts the budget.
    if (conflictEdges === null) break;
    viable.push({
      name,
      conflictEdges,
      domainSize: list.options.filter((option) => option.weight > 0).length,
    });
  }

  viable.sort((a, b) => b.conflictEdges - a.conflictEdges || a.domainSize - b.domainSize);
  const listName = viable[0]?.name ?? verifiedFallback;
  return listName === null ? { ok: false, reason: 'no-target' } : { ok: true, listName };
}

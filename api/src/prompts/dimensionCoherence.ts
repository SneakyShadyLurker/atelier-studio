import { conflictingDimensions, groupTagsByDimension, type TagsByDimension } from '@atelier/shared/tag-coherence';
import type { LibrarySnapshot, SnapList, SnapOption } from './inferTypes';
import { enumerateRandomBranches } from '@atelier/shared/template-tokens';
import { extractOccurrences, type VarOccurrenceRef } from './varOccurrences';

// Tag hierarchies arrive pre-expanded (expanded*), so the shared predicate
// (@atelier/shared/tag-coherence) applies directly to snapshot indexes.
export function tagDimOf(s: LibrarySnapshot): Map<number, number> {
  const m = new Map<number, number>();
  s.dimensions.forEach((d) => { d.tags.forEach((t) => m.set(t.idx, d.idx)); });
  return m;
}

export type OptionTagIndex = Map<SnapOption, TagsByDimension<number>>;

function snapOptionTags(o: SnapOption, tagDim: ReadonlyMap<number, number>, index?: OptionTagIndex): TagsByDimension<number> {
  const cached = index?.get(o);
  if (cached) return cached;
  const tags = {
    require: groupTagsByDimension(o.expandedTagIdxs ?? o.tagIdxs, tagDim),
    exclude: groupTagsByDimension(o.expandedExcludeTagIdxs ?? o.excludeTagIdxs ?? [], tagDim),
  };
  index?.set(o, tags);
  return tags;
}

export function conflictDimensionIdxs(
  a: SnapOption,
  b: SnapOption,
  tagDim: Map<number, number>,
  index?: OptionTagIndex,
): ReadonlySet<number> {
  return new Set(conflictingDimensions(snapOptionTags(a, tagDim, index), snapOptionTags(b, tagDim, index)));
}

export function conflicts(a: SnapOption, b: SnapOption, tagDim: Map<number, number>, index?: OptionTagIndex): boolean {
  return !conflictingDimensions(snapOptionTags(a, tagDim, index), snapOptionTags(b, tagDim, index)).next().done;
}

// Hard cap on solve nodes AND option-pair comparisons — guards the event loop against
// pathological inputs. When exceeded, return the conservative
// `false` (unsatisfiable) which surfaces as a coherence warning; users can
// still override with the explicit `Apply anyway` action.
const DEFAULT_MAX_COHERENCE_NODES = 100_000;
let MAX_COHERENCE_NODES_OVERRIDE: number | null = null;
export function _setMaxNodesForTests(n: number | null): void {
  MAX_COHERENCE_NODES_OVERRIDE = n;
}

export interface BudgetOptions {
  nodeBudgetRef?: { nodes: number };
  totalBudget?: number;
}

export function coherenceBudget(opts?: BudgetOptions): Required<BudgetOptions> {
  return {
    nodeBudgetRef: opts?.nodeBudgetRef ?? { nodes: 0 },
    totalBudget: opts?.totalBudget ?? MAX_COHERENCE_NODES_OVERRIDE ?? DEFAULT_MAX_COHERENCE_NODES,
  };
}

// Keep the existing counter name for callers, but charge rejected comparisons
// too. Exhaustion is sticky, so unwinding never resumes another domain scan.
export function spendCoherenceWork(budget: Required<BudgetOptions>): boolean {
  if (budget.nodeBudgetRef.nodes > budget.totalBudget) return false;
  return ++budget.nodeBudgetRef.nodes <= budget.totalBudget;
}

// Cross-subject pairs are unconstrained: two occurrences with DIFFERING
// non-null subjects never coerce coherence. A null subject (scene-level)
// bridges to every subject, so it is always checked. Mirror of the web
// resolver's `subjectsCohere`.
function subjectsCohere(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return true;
  return a === b;
}

// Bounded backtracking over occurrence slots: does at least one option-combo
// across the referenced occurrences satisfy all pairwise constraints, where a
// pair is only constrained when its subjects cohere? (web solveUnpinnedAxes
// analogue, subject-aware.)
export function templateSatisfiableByOccurrences(
  occurrences: readonly VarOccurrenceRef[],
  s: LibrarySnapshot,
  budgetOpts?: BudgetOptions,
): boolean {
  const budget = coherenceBudget(budgetOpts);
  // Charge one node for the call itself BEFORE any early returns so a
  // pathological template (empty referenced domain) cannot drive an
  // unmetered outer enumeration with zero budget consumption.
  if (!spendCoherenceWork(budget)) return false;
  const tagDim = tagDimOf(s);
  const optionTags: OptionTagIndex = new Map();
  const slots = occurrences
    .map((o) => {
      const list = s.lists.find((l) => l.name === o.listName);
      return list
        ? { subject: o.subject, options: list.options.filter((option) => option.weight > 0) }
        : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  if (slots.some((d) => d.options.length === 0)) return false;
  const chosen: { subject: number | null; opt: SnapOption }[] = [];
  const solve = (i: number): boolean => {
    if (!spendCoherenceWork(budget)) return false;
    if (i === slots.length) return true;
    const slot = slots[i];
    if (!slot) return false;
    for (const opt of slot.options) {
      let ok = true;
      for (const c of chosen) {
        if (!spendCoherenceWork(budget)) return false;
        if (subjectsCohere(c.subject, slot.subject) && conflicts(c.opt, opt, tagDim, optionTags)) {
          ok = false;
          break;
        }
      }
      if (ok) {
        chosen.push({ subject: slot.subject, opt });
        if (solve(i + 1)) return true;
        chosen.pop();
        if (budget.nodeBudgetRef.nodes > budget.totalBudget) return false;
      }
    }
    return false;
  };
  return solve(0);
}

// Legacy name-based satisfiability: all referenced lists co-slot at scene level
// (null subject → subjectsCohere always true → identical to the old all-pairs
// check). Retained for callers that still pass bare list names.
export function templateSatisfiable(
  listNames: readonly string[],
  s: LibrarySnapshot,
  budgetOpts?: BudgetOptions,
): boolean {
  return templateSatisfiableByOccurrences(
    listNames.map((listName) => ({ listName, subject: null })),
    s,
    budgetOpts,
  );
}

// Count pairwise option-pair conflicts WITHIN a single list (used by the
// rescue-target picker to rank "most-conflicted" lists as leverage points).
// Pairwise conflict semantics match `conflicts()` above, including exclusions.
// null means the exact edge count could not be completed within the budget.
export function countListConflictEdges(snap: LibrarySnapshot, list: SnapList, budgetOpts?: BudgetOptions): number | null {
  const budget = coherenceBudget(budgetOpts);
  const tagDim = tagDimOf(snap);
  const optionTags: OptionTagIndex = new Map();
  const opts = list.options.filter((option) => option.weight > 0);
  let n = 0;
  for (let i = 0; i < opts.length; i++) {
    for (let j = i + 1; j < opts.length; j++) {
      const a = opts[i];
      const b = opts[j];
      if (!a || !b) continue;
      if (!spendCoherenceWork(budget)) return null;
      if (conflicts(a, b, tagDim, optionTags)) n += 1;
    }
  }
  return n;
}

export interface TemplateRefs { name: string; lists: string[]; body?: string }

export function coherenceWarnings(
  templates: readonly TemplateRefs[],
  s: LibrarySnapshot,
): { templateName: string; detail: string }[] {
  const out: { templateName: string; detail: string }[] = [];
  for (const t of templates) {
    if (t.lists.length < 2) continue;
    if (!templateSatisfiable(t.lists, s)) {
      out.push({ templateName: t.name, detail: `no coherent combination across: ${t.lists.join(', ')}` });
    }
  }
  return out;
}

/**
 * Branch-aware satisfiability: a template body is satisfiable iff EVERY
 * shape produced by `enumerateRandomBranches` is satisfiable when its
 * referenced occurrences are SAT-solved together (subject-clustered). Matches
 * the web resolver's lazy semantics — pickable at render time without surprise
 * failures.
 */
export function templateSatisfiableBranchAware(
  body: string,
  s: LibrarySnapshot,
  budgetOpts?: BudgetOptions,
): boolean {
  const shapes = enumerateRandomBranches(body);
  const budget = coherenceBudget(budgetOpts);
  for (const shape of shapes) {
    const occ = extractOccurrences(shape);
    if (occ.length < 2) continue;          // 0 or 1 occurrence = trivially satisfiable
    if (!templateSatisfiableByOccurrences(occ, s, budget)) return false;
  }
  return true;
}

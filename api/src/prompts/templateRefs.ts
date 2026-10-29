import { extractOccurrences } from './varOccurrences';

// Distinct list NAMES referenced anywhere in a template body (subject dropped,
// deduped). Use this only for name-level checks — e.g. "does this list still
// exist?". For SAT/coherence work use extractOccurrences instead: collapsing
// `{{var::face@1}}` and `{{var::face@2}}` to one name silently under-constrains
// the solver. The name-vs-occurrence distinction is load-bearing on those paths.
export function extractDistinctListNames(body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const { listName } of extractOccurrences(body)) {
    if (!seen.has(listName)) {
      seen.add(listName);
      out.push(listName);
    }
  }
  return out;
}

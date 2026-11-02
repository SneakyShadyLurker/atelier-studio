import type { RawBundle } from './inferTypes';

// Resolve the dependency closure of a user's chosen bundle keys.
// Mirrors the apply route's traversal: the user can opt into a bundle key
// without explicitly opting into its dependsOn predecessors — the closure
// walk pulls them in. Same logic used by /apply (chosen set for the SQL
// write) and /diagnose-selection (chosen set for the SAT check).
export function bundleClosure(
  rawBundles: readonly RawBundle[],
  acceptedBundleKeys: readonly string[],
): RawBundle[] {
  const byKey = new Map(rawBundles.map((b) => [b.key, b] as const));
  const closure = new Set<string>();
  const visit = (k: string): void => {
    const bundle = byKey.get(k);
    if (closure.has(k) || !bundle) return;
    closure.add(k);
    bundle.dependsOn.forEach(visit);
  };
  acceptedBundleKeys.forEach(visit);
  // Keep deterministic bundle order. Consumers replay original per-operation
  // ordinals rather than topologically sorting bundles (dependencies can cycle).
  return rawBundles.filter((b) => closure.has(b.key));
}

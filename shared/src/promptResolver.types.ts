// Pure type contract for the prompt-library resolver. Lives in shared/ — but
// deliberately NOT in shared/src/index.ts (the locked wire contract) —
// because the web resolver (web/src/lib/promptResolver.ts) and any future
// cross-boundary tooling depend on this shape. Types only.

/**
 * Inputs to a single prompt resolution: the RNG seed, the pinned axis picks,
 * and the optional `{{user}}` substitution value.
 */
export interface ResolveOpts {
  seed: number;
  pins: Record<string, string>;
  user?: string;
}

/**
 * Output of resolving one template: the final text, the per-axis picks made,
 * the seed used, and any non-fatal warnings.
 *
 * `resolvedBody` is the macro-resolved template body — the exact string the
 * resolver ran `collectVarOccurrences` against to produce `picks`. Sweep/axis
 * tooling MUST derive occurrence keys from this shape (not the raw
 * `template.body`); when an unpicked `{{random::}}` branch carries a
 * `{{var::X}}` token, raw-body occurrence indices diverge from the resolved
 * ones, so a raw-body key never re-resolves against `picks`.
 */
export interface ResolveResult {
  text: string;
  picks: Record<string, string>;
  resolvedBody: string;
  seed: number;
  warnings: string[];
}

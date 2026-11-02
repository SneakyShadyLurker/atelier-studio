// Canonical placement vocabulary for the `[data-tip]` tooltip primitive
// (label rules in styles/global.css, lifecycle in hooks/useTooltipDismiss.ts).
// The default (no `data-tip-place` attribute) renders above-centre; these are
// the explicit overrides, each a preferred side and alignment that CSS flips
// and clamps at the window edges. Undefined values (e.g. "top"/"right")
// silently fall through to the default and read as wired placement that never
// happens, so the set is locked by tooltip-placement-invariant.test.ts in both
// directions.
export const TIP_PLACEMENTS = [
  'below',
  'above-end',
  'above-start',
  'below-end',
  'below-start',
] as const;

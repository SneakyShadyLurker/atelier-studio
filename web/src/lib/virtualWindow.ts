// Shared rules for the four virtualized lists (Canvas feed, Archive grid,
// Sidebar rail, PromptPicker templates) before and after the virtualizer has
// produced items.

/**
 * Virtualization invariant: use the measured total only when virtual items
 * exist; fall back to the estimated total otherwise. `max(measured, estimated)`
 * is wrong: once virtual items exist the measured total IS the truth, and an
 * estimated floor leaves a phantom blank tail when rows are shorter than the
 * estimate.
 */
export function virtualizedHeight(hasVirtualItems: boolean, measuredTotal: number, estimatedTotal: number): number {
  return hasVirtualItems ? measuredTotal : estimatedTotal;
}

export interface FallbackVirtualRow<K extends string | number> {
  readonly key: K;
  readonly index: number;
  readonly start: number;
}

/**
 * Rows to render before the virtualizer has measured its viewport (first
 * paint, happy-dom): the first `fallbackCount` of `count` items, stacked at
 * their estimated offsets.
 */
export function fallbackVirtualRows<K extends string | number>(
  count: number,
  fallbackCount: number,
  estimateAt: (index: number) => number,
  keyAt: (index: number) => K,
): FallbackVirtualRow<K>[] {
  const rows: FallbackVirtualRow<K>[] = [];
  let start = 0;
  for (let index = 0; index < Math.min(count, fallbackCount); index += 1) {
    rows.push({ key: keyAt(index), index, start });
    start += estimateAt(index);
  }
  return rows;
}

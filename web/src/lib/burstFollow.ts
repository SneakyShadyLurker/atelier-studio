import type { Batch } from '@atelier/shared';

// Single source of truth for "which batch is current": the row the sidebar
// rail highlights. While a burst is being followed (followAnchorId set and
// still present in the feed) it resolves to the anchor, the burst's newest
// batch. Otherwise the explicit selection (or, failing that, the newest batch)
// wins. It never moves the viewport: following new work is the feed
// virtualizer's `followOnAppend` (lib/feedAnchor).
//
// This deliberately does NOT walk to the burst's deepest still-generating
// batch: that target moves as rolls arrive and finish, so the highlight would
// oscillate for the whole burst.
export function resolveActiveBatchId(
  batches: readonly Batch[],
  followAnchorId: string | null,
  activeBatchId: string | null,
): string | null {
  // The feed is oldest-first, so the newest batch — the sensible default
  // selection — is the LAST one, not batches[0].
  const explicit = activeBatchId ?? batches.at(-1)?.id ?? null;
  if (!followAnchorId) return explicit;
  if (!batches.some((b) => b.id === followAnchorId)) return explicit;
  return followAnchorId;
}

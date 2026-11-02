import type { LibraryCoverageResponse } from '@atelier/shared';

export interface CoverageBadgeState {
  readonly tone: 'healthy' | 'pending';
  readonly untaggedCount: number;
}

// The badge speaks ONLY to untagged-option work (a to-do, never a defect).
// Orphan tags / missing dimensions live in the card's Cleanup section with
// --danger accents, but they do NOT flip the calm badge tone — by design.
export function coverageBadgeState(report: LibraryCoverageResponse): CoverageBadgeState {
  const untaggedCount = report.untaggedByList.reduce((sum, g) => sum + g.untaggedCount, 0);
  return untaggedCount === 0
    ? { tone: 'healthy', untaggedCount: 0 }
    : { tone: 'pending', untaggedCount };
}

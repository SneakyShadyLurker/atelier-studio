import type { DraftTemplateChanges } from '@atelier/shared';
import {
  applyTemplateChanges,
  type TemplateChange,
  type UnplacedTemplateChange,
} from '@atelier/shared/template-rework';

/** A template rework under review: the placed changes against the body that
 *  was sent, and the user's decisions. Every change starts accepted (spec D4). */
export interface TemplateReview {
  base: string;
  changes: readonly TemplateChange[];
  unplaced: readonly UnplacedTemplateChange[];
  summary: string | null;
  /** The change instructions the rework was asked with; prefill for "Rework again". */
  instructions: string;
  /** Ids of rejected changes, ascending, without duplicates. */
  rejected: readonly number[];
}

export function reviewFromResponse(base: string, instructions: string, payload: DraftTemplateChanges): TemplateReview {
  return {
    base,
    changes: payload.changes,
    unplaced: payload.unplaced,
    summary: payload.summary,
    instructions,
    rejected: [],
  };
}

export function acceptedIds(review: TemplateReview): number[] {
  const rejected = new Set(review.rejected);
  return review.changes.filter((change) => !rejected.has(change.id)).map((change) => change.id);
}

/** The body as it would be with the currently accepted changes applied. */
export function previewBody(review: TemplateReview): string {
  return applyTemplateChanges(review.base, review.changes, acceptedIds(review));
}

function withRejected(review: TemplateReview, rejected: readonly number[]): TemplateReview {
  const same = rejected.length === review.rejected.length
    && rejected.every((id, index) => id === review.rejected[index]);
  return same ? review : { ...review, rejected };
}

export function setDecision(review: TemplateReview, id: number, decision: 'accepted' | 'rejected'): TemplateReview {
  if (!review.changes.some((change) => change.id === id)) return review;
  const others = review.rejected.filter((rejectedId) => rejectedId !== id);
  const rejected = decision === 'rejected' ? [...others, id].toSorted((a, z) => a - z) : others;
  return withRejected(review, rejected);
}

export function setAllDecisions(review: TemplateReview, decision: 'accepted' | 'rejected'): TemplateReview {
  const rejected = decision === 'rejected'
    ? review.changes.map((change) => change.id).toSorted((a, z) => a - z)
    : [];
  return withRejected(review, rejected);
}

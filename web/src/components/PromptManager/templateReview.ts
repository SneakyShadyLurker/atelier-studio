import type { DraftTemplateChanges } from '@atelier/shared';
import {
  applyTemplateChanges,
  type TemplateChange,
  type UnplacedTemplateChange,
} from '@atelier/shared/template-rework';
import { acceptedIds as decidedIds, setAllDecisions as decideAll, setDecision as decide } from './reviewDecisions';

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
  return decidedIds(review);
}

/** The body as it would be with the currently accepted changes applied. */
export function previewBody(review: TemplateReview): string {
  return applyTemplateChanges(review.base, review.changes, acceptedIds(review));
}

export function setDecision(review: TemplateReview, id: number, decision: 'accepted' | 'rejected'): TemplateReview {
  return decide(review, id, decision);
}

export function setAllDecisions(review: TemplateReview, decision: 'accepted' | 'rejected'): TemplateReview {
  return decideAll(review, decision);
}

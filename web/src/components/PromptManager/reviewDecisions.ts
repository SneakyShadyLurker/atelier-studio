/*
 * Accept/reject state shared by the AI reviews: every change starts accepted,
 * and a review records only the ids of rejected ones (ascending, without
 * duplicates). A call that changes nothing returns the same object.
 */

export interface Decidable {
  readonly changes: readonly { readonly id: number }[];
  readonly rejected: readonly number[];
}

export type Decision = 'accepted' | 'rejected';

export function acceptedIds(review: Decidable): number[] {
  const rejected = new Set(review.rejected);
  return review.changes.filter((change) => !rejected.has(change.id)).map((change) => change.id);
}

function withRejected<R extends Decidable>(review: R, rejected: readonly number[]): R {
  const same = rejected.length === review.rejected.length
    && rejected.every((id, index) => id === review.rejected[index]);
  return same ? review : { ...review, rejected };
}

export function setDecision<R extends Decidable>(review: R, id: number, decision: Decision): R {
  if (!review.changes.some((change) => change.id === id)) return review;
  const others = review.rejected.filter((rejectedId) => rejectedId !== id);
  const rejected = decision === 'rejected' ? [...others, id].toSorted((a, z) => a - z) : others;
  return withRejected(review, rejected);
}

export function setAllDecisions<R extends Decidable>(review: R, decision: Decision): R {
  const rejected = decision === 'rejected'
    ? review.changes.map((change) => change.id).toSorted((a, z) => a - z)
    : [];
  return withRejected(review, rejected);
}

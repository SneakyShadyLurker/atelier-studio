import { describe, expect, test } from 'bun:test';
import { acceptedIds, setAllDecisions, setDecision, type Decidable } from './reviewDecisions';

interface Review extends Decidable {
  readonly label: string;
  readonly changes: readonly { readonly id: number; readonly text: string }[];
}

function review(rejected: readonly number[] = []): Review {
  return {
    label: 'colours',
    changes: [{ id: 2, text: 'teal' }, { id: 0, text: 'ochre' }, { id: 1, text: 'umber' }],
    rejected,
  };
}

describe('reviewDecisions', () => {
  test('every change starts accepted, in change order', () => {
    expect(acceptedIds(review())).toEqual([2, 0, 1]);
  });

  test('rejecting keeps the rejected ids ascending and without duplicates', () => {
    const once = setDecision(setDecision(review(), 2, 'rejected'), 0, 'rejected');
    expect(once.rejected).toEqual([0, 2]);
    expect(acceptedIds(once)).toEqual([1]);
    expect(setDecision(once, 2, 'rejected')).toBe(once);
  });

  test('accepting again removes the id and keeps the rest of the review', () => {
    const next = setDecision(review([0, 2]), 2, 'accepted');
    expect(next.rejected).toEqual([0]);
    expect(next.label).toBe('colours');
  });

  test('an unknown id or an unchanged decision returns the same object', () => {
    const current = review([1]);
    expect(setDecision(current, 9, 'rejected')).toBe(current);
    expect(setDecision(current, 0, 'accepted')).toBe(current);
  });

  test('setAllDecisions rejects every id ascending, or accepts all', () => {
    const all = setAllDecisions(review(), 'rejected');
    expect(all.rejected).toEqual([0, 1, 2]);
    expect(acceptedIds(all)).toEqual([]);
    expect(setAllDecisions(all, 'rejected')).toBe(all);
    expect(setAllDecisions(all, 'accepted').rejected).toEqual([]);
    const none = review();
    expect(setAllDecisions(none, 'accepted')).toBe(none);
  });
});

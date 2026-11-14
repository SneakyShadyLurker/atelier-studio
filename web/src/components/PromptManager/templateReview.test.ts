import { describe, expect, test } from 'bun:test';
import type { DraftTemplateChanges } from '@atelier/shared';
import {
  acceptedIds,
  previewBody,
  reviewFromResponse,
  setAllDecisions,
  setDecision,
  type TemplateReview,
} from './templateReview';

const base = 'A red coat in soft light.';
const payload: DraftTemplateChanges = {
  kind: 'changes',
  baseLength: base.length,
  changes: [
    { id: 0, start: 2, end: 5, replace: 'blue', why: 'Bluer, as asked.' },
    { id: 1, start: 14, end: 18, replace: 'hard', why: '' },
  ],
  unplaced: [{ find: 'velvet', replace: 'silk', why: 'Texture.', reason: 'missing' }],
  summary: 'Cooler palette.',
  warnings: ['dropped a token'],
};

function review(): TemplateReview {
  return reviewFromResponse(base, 'bluer and harder', payload);
}

describe('templateReview', () => {
  test('reviewFromResponse keeps the base, changes, unplaced, summary and instructions, all accepted', () => {
    expect(review()).toEqual({
      base,
      changes: payload.changes,
      unplaced: payload.unplaced,
      summary: 'Cooler palette.',
      instructions: 'bluer and harder',
      rejected: [],
    });
  });

  test('acceptedIds lists every change not rejected, in id order', () => {
    expect(acceptedIds(review())).toEqual([0, 1]);
    expect(acceptedIds(setDecision(review(), 0, 'rejected'))).toEqual([1]);
  });

  test('previewBody applies the accepted changes', () => {
    expect(previewBody(review())).toBe('A blue coat in hard light.');
    expect(previewBody(setDecision(review(), 1, 'rejected'))).toBe('A blue coat in soft light.');
    expect(previewBody(setAllDecisions(review(), 'rejected'))).toBe(base);
  });

  test('setDecision keeps rejected ids ascending and unique', () => {
    const both = setDecision(setDecision(review(), 1, 'rejected'), 0, 'rejected');
    expect(both.rejected).toEqual([0, 1]);
    expect(setDecision(both, 1, 'accepted').rejected).toEqual([0]);
  });

  test('setDecision returns the same object when nothing changes', () => {
    const start = review();
    expect(setDecision(start, 0, 'accepted') === start).toBe(true);
    const rejected = setDecision(start, 0, 'rejected');
    expect(setDecision(rejected, 0, 'rejected') === rejected).toBe(true);
  });

  test('setDecision ignores an id that is not a change', () => {
    const start = review();
    expect(setDecision(start, 7, 'rejected') === start).toBe(true);
  });

  test('setAllDecisions rejects or accepts every change', () => {
    const rejected = setAllDecisions(review(), 'rejected');
    expect(rejected.rejected).toEqual([0, 1]);
    expect(setAllDecisions(rejected, 'accepted').rejected).toEqual([]);
  });

  test('setAllDecisions returns the same object when nothing changes', () => {
    const start = review();
    expect(setAllDecisions(start, 'accepted') === start).toBe(true);
    const rejected = setAllDecisions(start, 'rejected');
    expect(setAllDecisions(rejected, 'rejected') === rejected).toBe(true);
  });
});

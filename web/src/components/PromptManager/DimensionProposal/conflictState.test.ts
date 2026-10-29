import { test, expect } from 'bun:test';
import { conflictReducer, intentFor, type ConflictState } from './conflictState';

test('initial state via init action', () => {
  expect(conflictReducer({ kind: 'unresolved' }, { type: 'init' })).toEqual({ kind: 'unresolved' });
});

test('skip from unresolved -> skipped', () => {
  expect(conflictReducer({ kind: 'unresolved' }, { type: 'skip' })).toEqual({ kind: 'skipped' });
});

test('Skip -> Rescue moves to rescuing', () => {
  const after = conflictReducer({ kind: 'skipped' }, { type: 'startRescue' });
  expect(after).toEqual({ kind: 'rescuing' });
});

test('Apply anyway -> Rescue moves to rescuing', () => {
  const after = conflictReducer({ kind: 'acceptedUnsat' }, { type: 'startRescue' });
  expect(after).toEqual({ kind: 'rescuing' });
});

test('rescue success -> rescued with bundle key', () => {
  const after = conflictReducer({ kind: 'rescuing' }, { type: 'rescueSuccess', bundleKey: 'rescue:tmplA' });
  expect(after).toEqual({ kind: 'rescued', rescueBundleKey: 'rescue:tmplA' });
});

test('rescue failure -> rescue-failed (cap spent)', () => {
  const after = conflictReducer({ kind: 'rescuing' }, { type: 'rescueFail', reason: 'upstream-error' });
  expect(after).toEqual({ kind: 'rescue-failed', reason: 'upstream-error' });
});

test('startRescue from rescued is a no-op (cap spent)', () => {
  const prev: ConflictState = { kind: 'rescued', rescueBundleKey: 'rescue:tmplA' };
  expect(conflictReducer(prev, { type: 'startRescue' })).toEqual(prev);
});

test('startRescue from rescue-failed is a no-op (cap spent)', () => {
  const prev: ConflictState = { kind: 'rescue-failed', reason: 'no-target' };
  expect(conflictReducer(prev, { type: 'startRescue' })).toEqual(prev);
});

test('intentFor: Skip -> Rescue requires re-checking culprits', () => {
  expect(intentFor({ kind: 'skipped' }, { kind: 'rescuing' })).toEqual({
    recheckCulpritsInPickedSet: true,
    removeFromAcceptUnsat: false,
    addToAcceptUnsat: false,
    removeCulpritsFromPickedSet: false,
  });
});

test('intentFor: Apply anyway -> Rescue requires removing from acceptUnsat', () => {
  expect(intentFor({ kind: 'acceptedUnsat' }, { kind: 'rescuing' })).toEqual({
    recheckCulpritsInPickedSet: false,
    removeFromAcceptUnsat: true,
    addToAcceptUnsat: false,
    removeCulpritsFromPickedSet: false,
  });
});

test('intentFor: -> skipped sets removeCulpritsFromPickedSet', () => {
  expect(intentFor({ kind: 'unresolved' }, { kind: 'skipped' }).removeCulpritsFromPickedSet).toBe(true);
});

test('intentFor: -> acceptedUnsat sets addToAcceptUnsat', () => {
  expect(intentFor({ kind: 'unresolved' }, { kind: 'acceptedUnsat' }).addToAcceptUnsat).toBe(true);
});

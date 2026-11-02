import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { initialAtelierState, useAtelierStore } from './atelier';

describe('resolving counter (Generate submission feedback)', () => {
  beforeEach(() => { useAtelierStore.setState(initialAtelierState, true); });
  afterEach(() => { useAtelierStore.setState(initialAtelierState, true); });

  test('starts at zero', () => {
    expect(useAtelierStore.getState().resolving).toBe(0);
  });

  test('beginResolving increments, endResolving decrements', () => {
    const { beginResolving, endResolving } = useAtelierStore.getState();
    beginResolving();
    beginResolving();
    expect(useAtelierStore.getState().resolving).toBe(2);
    endResolving();
    expect(useAtelierStore.getState().resolving).toBe(1);
  });

  test('endResolving clamps at zero (never goes negative)', () => {
    const { endResolving } = useAtelierStore.getState();
    endResolving();
    endResolving();
    expect(useAtelierStore.getState().resolving).toBe(0);
  });
});

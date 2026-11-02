import { afterEach, describe, expect, test } from 'bun:test';
import { useAtelierStore } from './atelier';

afterEach(() => {
  useAtelierStore.getState().clearFollowAnchor();
});

describe('followAnchorId slice', () => {
  test('starts null', () => {
    expect(useAtelierStore.getState().followAnchorId).toBeNull();
  });

  test('followBatch sets the durable follow anchor', () => {
    useAtelierStore.getState().followBatch('batch-abc');
    expect(useAtelierStore.getState().followAnchorId).toBe('batch-abc');
  });

  test('a second follow replaces the first (last-write-wins, not a queue)', () => {
    useAtelierStore.getState().followBatch('first');
    useAtelierStore.getState().followBatch('second');
    expect(useAtelierStore.getState().followAnchorId).toBe('second');
  });

  test('clearFollowAnchor stops following (manual selection path)', () => {
    useAtelierStore.getState().followBatch('batch-xyz');
    useAtelierStore.getState().clearFollowAnchor();
    expect(useAtelierStore.getState().followAnchorId).toBeNull();
  });
});

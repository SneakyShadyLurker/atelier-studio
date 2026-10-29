import { afterEach, describe, expect, test } from 'bun:test';
import {
  flushSeenBatches,
  loadSeenBatches,
  markBatchSeen,
  SEEN_BATCHES_STORAGE_KEY,
} from './seenBatches';

afterEach(() => {
  flushSeenBatches();
  sessionStorage.clear();
});

describe('seenBatches', () => {
  test('markBatchSeen mutates the in-memory set synchronously', () => {
    const set = new Set<string>();
    markBatchSeen(set, 'batch-1');
    expect(set.has('batch-1')).toBe(true);
  });

  test('markBatchSeen defers the sessionStorage write until flush', () => {
    const set = new Set<string>();
    markBatchSeen(set, 'batch-1');
    expect(sessionStorage.getItem(SEEN_BATCHES_STORAGE_KEY)).toBeNull();
    flushSeenBatches();
    expect(sessionStorage.getItem(SEEN_BATCHES_STORAGE_KEY)).not.toBeNull();
  });

  test('multiple rapid markBatchSeen calls coalesce into one storage write', () => {
    const set = new Set<string>();
    markBatchSeen(set, 'batch-1');
    markBatchSeen(set, 'batch-2');
    markBatchSeen(set, 'batch-3');
    flushSeenBatches();
    const persisted = loadSeenBatches();
    expect(persisted.has('batch-1')).toBe(true);
    expect(persisted.has('batch-2')).toBe(true);
    expect(persisted.has('batch-3')).toBe(true);
  });

  test('markBatchSeen is a no-op for an already-seen id', () => {
    const set = new Set<string>(['batch-1']);
    markBatchSeen(set, 'batch-1');
    flushSeenBatches();
    expect(sessionStorage.getItem(SEEN_BATCHES_STORAGE_KEY)).toBeNull();
  });

  test('loadSeenBatches round-trips persisted ids', () => {
    const set = new Set<string>();
    markBatchSeen(set, 'batch-1');
    markBatchSeen(set, 'batch-2');
    flushSeenBatches();
    const loaded = loadSeenBatches();
    expect(loaded).toEqual(new Set(['batch-1', 'batch-2']));
  });
});

import { afterEach, describe, expect, test } from 'bun:test';
import {
  flushSeenBatches,
  getSeenBatches,
  loadSeenBatches,
  markBatchesSeen,
  markBatchSeen,
  resetSeenBatches,
  SEEN_BATCHES_MAX_ENTRIES,
  SEEN_BATCHES_STORAGE_KEY,
  subscribeSeenBatches,
} from './seenBatches';

afterEach(() => {
  flushSeenBatches();
  sessionStorage.clear();
  resetSeenBatches();
});

describe('seenBatches', () => {
  test('markBatchSeen updates the snapshot synchronously', () => {
    markBatchSeen('batch-1');
    expect(getSeenBatches().has('batch-1')).toBe(true);
  });

  test('markBatchSeen defers the sessionStorage write until flush', () => {
    markBatchSeen('batch-1');
    expect(sessionStorage.getItem(SEEN_BATCHES_STORAGE_KEY)).toBeNull();
    flushSeenBatches();
    expect(sessionStorage.getItem(SEEN_BATCHES_STORAGE_KEY)).not.toBeNull();
  });

  test('multiple rapid marks coalesce into one storage write', () => {
    markBatchSeen('batch-1');
    markBatchSeen('batch-2');
    markBatchSeen('batch-3');
    flushSeenBatches();
    const persisted = loadSeenBatches();
    expect(persisted.has('batch-1')).toBe(true);
    expect(persisted.has('batch-2')).toBe(true);
    expect(persisted.has('batch-3')).toBe(true);
  });

  test('marking an already-seen id neither writes nor notifies', () => {
    sessionStorage.setItem(SEEN_BATCHES_STORAGE_KEY, JSON.stringify({ ids: ['batch-1'] }));
    resetSeenBatches();
    const before = getSeenBatches();
    let notified = 0;
    const unsubscribe = subscribeSeenBatches(() => { notified += 1; });
    sessionStorage.clear();
    markBatchSeen('batch-1');
    flushSeenBatches();
    unsubscribe();
    expect(notified).toBe(0);
    expect(getSeenBatches()).toBe(before);
    expect(sessionStorage.getItem(SEEN_BATCHES_STORAGE_KEY)).toBeNull();
  });

  test('loadSeenBatches round-trips persisted ids', () => {
    markBatchSeen('batch-1');
    markBatchSeen('batch-2');
    flushSeenBatches();
    expect(loadSeenBatches()).toEqual(new Set(['batch-1', 'batch-2']));
  });

  test('the store hydrates from sessionStorage on first read', () => {
    sessionStorage.setItem(SEEN_BATCHES_STORAGE_KEY, JSON.stringify({ ids: ['batch-old'] }));
    resetSeenBatches();
    expect(getSeenBatches().has('batch-old')).toBe(true);
  });

  test('a mark notifies subscribers once with a new snapshot', () => {
    const before = getSeenBatches();
    const snapshots: ReadonlySet<string>[] = [];
    const unsubscribe = subscribeSeenBatches(() => { snapshots.push(getSeenBatches()); });
    markBatchesSeen(['batch-1', 'batch-2']);
    unsubscribe();
    markBatchSeen('batch-3');
    expect(snapshots.length).toBe(1);
    expect(snapshots[0]).not.toBe(before);
    expect(before.has('batch-1')).toBe(false);
    expect(snapshots[0]?.has('batch-1')).toBe(true);
    expect(snapshots[0]?.has('batch-2')).toBe(true);
  });

  test('the store keeps the FIFO cap, dropping the oldest ids', () => {
    const ids = Array.from({ length: SEEN_BATCHES_MAX_ENTRIES + 3 }, (_, index) => `batch-${String(index)}`);
    markBatchesSeen(ids);
    const seen = getSeenBatches();
    expect(seen.size).toBe(SEEN_BATCHES_MAX_ENTRIES);
    expect(seen.has('batch-0')).toBe(false);
    expect(seen.has('batch-2')).toBe(false);
    expect(seen.has('batch-3')).toBe(true);
    expect(seen.has(`batch-${String(SEEN_BATCHES_MAX_ENTRIES + 2)}`)).toBe(true);
    flushSeenBatches();
    expect(loadSeenBatches().size).toBe(SEEN_BATCHES_MAX_ENTRIES);
  });
});

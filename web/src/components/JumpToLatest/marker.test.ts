import { describe, expect, test } from 'bun:test';
import type { Batch } from '@atelier/shared';
import { feedChangedBelow, snapshotFeedEnd } from './marker';

type Row = Pick<Batch, 'id' | 'createdAt' | 'tiles'>;
const done = (id: string, createdAt: number): Row => ({ id, createdAt, tiles: [{ id: `${id}-t`, seed: 1, status: 'done', url: '/x.png', ext: 'png', mime: 'image/png', completedAt: createdAt }] });
const loading = (id: string, createdAt: number): Row => ({ id, createdAt, tiles: [{ id: `${id}-t`, seed: 1, status: 'loading' }] });

describe('jump-to-latest marker', () => {
  test('a newer batch at the end marks the control', () => {
    const snapshot = snapshotFeedEnd([done('a', 1), done('b', 2)]);
    expect(feedChangedBelow(snapshot, [done('a', 1), done('b', 2)])).toBe(false);
    expect(feedChangedBelow(snapshot, [done('a', 1), done('b', 2), loading('c', 3)])).toBe(true);
  });

  test('a batch that finished since the reader left marks the control', () => {
    const snapshot = snapshotFeedEnd([done('a', 1), loading('b', 2)]);
    expect(feedChangedBelow(snapshot, [done('a', 1), loading('b', 2)])).toBe(false);
    expect(feedChangedBelow(snapshot, [done('a', 1), done('b', 2)])).toBe(true);
  });

  test('older pages and removals do not', () => {
    const snapshot = snapshotFeedEnd([done('b', 2), done('c', 3)]);
    expect(feedChangedBelow(snapshot, [done('a', 1), done('b', 2), done('c', 3)])).toBe(false);
    expect(feedChangedBelow(snapshot, [done('b', 2)])).toBe(false);
    expect(feedChangedBelow(snapshotFeedEnd([]), [])).toBe(false);
  });
});

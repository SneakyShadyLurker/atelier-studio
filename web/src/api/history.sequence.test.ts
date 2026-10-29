import { describe, expect, test } from 'bun:test';
import type { Batch, HistoryPage } from '@atelier/shared';
import { historyOpts } from './history';

function sequenceBatch(masterStatus: 'idle' | 'stitching' | 'ready' | 'failed'): Batch {
  return {
    id: 'batch-1',
    prompt: 'continue walking',
    ratio: '16:9',
    modelId: 'minimax-h3-i2v',
    modelLabel: 'MiniMax H3 I2V',
    createdAt: Date.now(),
    collectionId: null,
    pinned: false,
    status: 'done',
    sequenceId: 'sequence-1',
    sequenceIndex: 1,
    sequence: {
      id: 'sequence-1',
      segmentCount: 2,
      totalDurationFrames: 248,
      masterStatus,
      masterUpdatedAt: Date.now(),
    },
    tiles: [{
      id: 'tile-1',
      seed: 1,
      status: 'done',
      url: '/img/tile-1.mp4',
      ext: 'mp4',
      mime: 'video/mp4',
      completedAt: Date.now(),
    }],
  };
}

function cadence(pages: HistoryPage<Batch>[]): number | false {
  const refetchInterval = historyOpts().refetchInterval;
  if (typeof refetchInterval !== 'function') throw new Error('Expected adaptive polling');
  return refetchInterval({
    state: {
      data: { pages },
      dataUpdatedAt: Date.now(),
      errorUpdateCount: 0,
      fetchFailureCount: 0,
    },
  } as Parameters<typeof refetchInterval>[0]) ?? false;
}

describe('sequence master history polling', () => {
  test('polls a visible stitching master with terminal tiles', () => {
    expect(cadence([{ items: [sequenceBatch('stitching')], nextCursor: null }])).toBe(3000);
  });

  test('keeps polling stitching masters in multi-page caches', () => {
    expect(cadence([
      { items: [sequenceBatch('stitching')], nextCursor: 'older' },
      { items: [sequenceBatch('ready')], nextCursor: null },
    ])).toBe(3000);
  });

  test('stops when the master reaches a terminal state', () => {
    expect(cadence([{ items: [sequenceBatch('ready')], nextCursor: null }])).toBe(false);
  });
});

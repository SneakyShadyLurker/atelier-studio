import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import type { Batch, Tile } from '@atelier/shared';
import { historyKeys } from '../api/history';
import { type HistoryData, upsertNewBatch } from './historyCache';

const tile: Extract<Tile, { status: 'done' }> = {
  id: 'video-1', seed: 1, status: 'done', url: '/api/img/video-1', ext: 'mp4', mime: 'video/mp4', completedAt: 1,
};

function makeBatch(overrides: Partial<Batch> = {}): Batch {
  return {
    id: 'batch-1', prompt: 'continue the shot', ratio: '16:9', modelId: 'minimax-h3-i2v', modelLabel: 'MiniMax H3 I2V',
    createdAt: 1, collectionId: null, pinned: false, status: 'done', tiles: [tile], ...overrides,
  };
}

describe('historyCache sequence upserts', () => {
  test('keeps history-provided sequence fields when a later SSE upsert omits them', () => {
    const queryClient = new QueryClient();
    const existing = makeBatch({
      sequenceId: 'sequence-1',
      sequenceIndex: 1,
      sequence: { id: 'sequence-1', segmentCount: 2, totalDurationFrames: 248, masterStatus: 'stitching' },
    });
    queryClient.setQueryData<HistoryData>(historyKeys.list(), {
      pages: [{ items: [existing], nextCursor: null }],
      pageParams: [null],
    });

    upsertNewBatch(queryClient, historyKeys.list(), makeBatch({ status: 'running' }));

    const updated = queryClient.getQueryData<HistoryData>(historyKeys.list())?.pages[0]?.items[0];
    expect(updated?.sequenceId).toBe('sequence-1');
    expect(updated?.sequenceIndex).toBe(1);
    expect(updated?.sequence).toEqual(existing.sequence);
  });
});

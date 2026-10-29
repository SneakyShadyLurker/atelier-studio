import { describe, expect, test } from 'bun:test';
import type { Batch, Tile, VideoSequenceMasterStatus } from '@atelier/shared';
import {
  canExtendVideoTile,
  formatSequenceDuration,
  sequenceActionAvailability,
  sequenceChipLabel,
  storyChipLabel,
} from './videoSequences';

const videoTile: Extract<Tile, { status: 'done' }> = {
  id: 'video-1', seed: 1, status: 'done', url: '/api/img/video-1', ext: 'mp4', mime: 'video/mp4', completedAt: 1,
};

function batch(kind: 'standalone' | 'tail' | 'non-tail', masterStatus: VideoSequenceMasterStatus = 'ready'): Batch {
  return {
    id: `batch-${kind}`,
    prompt: 'camera tracks the dancer',
    ratio: '16:9',
    modelId: 'minimax-h3-i2v',
    modelLabel: 'MiniMax H3 I2V',
    createdAt: 1,
    collectionId: null,
    pinned: false,
    status: 'done',
    tiles: [videoTile],
    ...(kind === 'standalone' ? {} : {
      sequenceId: 'sequence-1',
      sequenceIndex: kind === 'tail' ? 2 : 0,
      sequence: { id: 'sequence-1', segmentCount: 3, totalDurationFrames: 729, masterStatus },
    }),
  };
}

describe('video sequence formatting', () => {
  test('formats frames at 24 fps as M:SS', () => {
    expect(formatSequenceDuration(0)).toBe('0:00');
    expect(formatSequenceDuration(124)).toBe('0:05');
    expect(formatSequenceDuration(1_464)).toBe('1:01');
  });

  test('formats normal, stitching, and failed sequence chips', () => {
    expect(sequenceChipLabel(batch('tail'))).toBe('Part 3/3 · 0:30');
    expect(sequenceChipLabel(batch('tail', 'stitching'))).toBe('Part 3/3 · stitching…');
    expect(sequenceChipLabel(batch('tail', 'failed'))).toBe('Part 3/3 · master failed');
  });
});

describe('video sequence action gating', () => {
  test('allows Extend only for standalone videos or the sequence tail', () => {
    expect(canExtendVideoTile(batch('standalone'), videoTile, true)).toBe(true);
    expect(canExtendVideoTile(batch('tail'), videoTile, true)).toBe(true);
    expect(canExtendVideoTile(batch('non-tail'), videoTile, true)).toBe(false);
    expect(canExtendVideoTile(batch('tail'), videoTile, false)).toBe(false);
  });

  test('gates sequence rows across tail position and master status', () => {
    expect(sequenceActionAvailability(batch('tail', 'ready'), true)).toEqual({
      playMaster: true, downloadMaster: true, extend: true, discardTail: true,
    });
    expect(sequenceActionAvailability(batch('tail', 'stitching'), true)).toEqual({
      playMaster: false, downloadMaster: false, extend: true, discardTail: true,
    });
    expect(sequenceActionAvailability(batch('non-tail', 'ready'), true)).toEqual({
      playMaster: true, downloadMaster: true, extend: false, discardTail: false,
    });
    expect(sequenceActionAvailability(batch('standalone'), true)).toEqual({
      playMaster: false, downloadMaster: false, extend: false, discardTail: false,
    });
  });
});

describe('story chip formatting', () => {
  const storyBatch = (status: NonNullable<Batch['story']>['status']): Batch => ({
    ...batch('standalone'),
    story: {
      id: 'story-1',
      status,
      segmentIndex: 1,
      segmentCount: 4,
      logline: 'A dancer outruns the storm.',
      etaMs: 121_000,
    },
  });

  test('formats every story status and no-story batches', () => {
    expect(storyChipLabel(storyBatch('rendering'))).toBe('Story 2/4 · ~3m');
    expect(storyChipLabel(storyBatch('failed'))).toBe('Story · failed');
    expect(storyChipLabel(storyBatch('canceled'))).toBe('Story · canceled');
    expect(storyChipLabel(storyBatch('done'))).toBe('Story 2/4');
    expect(storyChipLabel(batch('standalone'))).toBeNull();
  });
});

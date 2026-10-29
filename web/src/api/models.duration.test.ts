import { describe, expect, test } from 'bun:test';
import { isModelList } from './client';

function videoModel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'minimax-h3-i2v',
    name: 'MiniMax H3 I2V',
    backend: 'local',
    tag: 'comfyui',
    latency: 'slow',
    supportedRatios: ['16:9'],
    concurrencyCapPerUser: 1,
    maxCountPerBatch: 1,
    pool: 'local',
    outputsVideo: true,
    supportedDurations: [124, 243, 362],
    defaultDuration: 124,
    ...overrides,
  };
}

describe('isModel — duration fields', () => {
  test('accepts a video model declaring on-grid durations', () => {
    expect(isModelList([videoModel()])).toBe(true);
  });

  test('accepts an image model that declares no durations at all', () => {
    const { supportedDurations: _s, defaultDuration: _d, ...image } = videoModel();
    expect(isModelList([{ ...image, outputsVideo: undefined }])).toBe(true);
  });

  test('rejects an off-grid duration', () => {
    // A length with no client-side definition would otherwise reach
    // DurationChip; the grid is a closed set, so reject at the boundary.
    expect(isModelList([videoModel({ supportedDurations: [124, 481] })])).toBe(false);
    expect(isModelList([videoModel({ supportedDurations: 124 })])).toBe(false);
  });

  test('rejects a default outside the declared set', () => {
    expect(isModelList([videoModel({ supportedDurations: [243, 362], defaultDuration: 124 })])).toBe(false);
    expect(isModelList([videoModel({ supportedDurations: undefined, defaultDuration: 124 })])).toBe(false);
  });
});

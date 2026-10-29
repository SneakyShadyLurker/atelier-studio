import { describe, expect, test } from 'bun:test';
import type { Model } from '@atelier/shared';
import { modelSelectionPatch, promptPickerAvailable } from './modelSelection';

function model(overrides: Partial<Model> = {}): Model {
  return {
    id: 'gpt-image-2.5-sunburst',
    name: 'GPT Image 2.5 Sunburst',
    backend: 'cloud',
    tag: 'cloud',
    latency: 'medium',
    supportedRatios: ['1:1', '4:5'],
    concurrencyCapPerUser: 4,
    maxCountPerBatch: 4,
    pool: 'shared',
    ...overrides,
  };
}

describe('modelSelectionPatch', () => {
  test('resets the explicit ratio when the selected model defines a default', () => {
    expect(modelSelectionPatch('gpt-image-2.5-sunburst', model({ defaultRatio: '4:5' }))).toMatchObject({
      modelId: 'gpt-image-2.5-sunburst',
      ratio: null,
    });
  });

  test('leaves the ratio absent when the selected model defines no default', () => {
    expect('ratio' in modelSelectionPatch('gpt-image-2.5-sunburst', model())).toBe(false);
  });

  test('preserves count snapping and I2V reset behavior', () => {
    expect(modelSelectionPatch('krea-2-gonzalomo', model({ defaultCount: 4 }))).toEqual({
      modelId: 'krea-2-gonzalomo',
      count: 4,
      i2vSourceUploadId: undefined,
      motionPrompt: undefined,
      extendsTileId: undefined,
      extendPrevPrompt: undefined,
      lastImageModelId: 'krea-2-gonzalomo',
    });
    expect(modelSelectionPatch('minimax-h3-i2v', model({ supportsI2V: true }))).toEqual({
      modelId: 'minimax-h3-i2v',
    });
  });

  test('the template picker needs the library gate and a non-I2V model', () => {
    expect(promptPickerAvailable(true, model())).toBe(true);
    expect(promptPickerAvailable(true, model({ outputsVideo: true }))).toBe(true);
    expect(promptPickerAvailable(false, model())).toBe(false);
    expect(promptPickerAvailable(true, model({ supportsI2V: true }))).toBe(false);
  });

  test('T2V clears the animate draft but is never remembered as the image model', () => {
    expect(modelSelectionPatch('minimax-h3-t2v', model({ outputsVideo: true, defaultCount: 1 }))).toEqual({
      modelId: 'minimax-h3-t2v',
      count: 1,
      i2vSourceUploadId: undefined,
      motionPrompt: undefined,
      extendsTileId: undefined,
      extendPrevPrompt: undefined,
    });
  });
});

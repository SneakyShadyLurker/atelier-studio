import type { Batch, Model, Tile } from '@atelier/shared';
import { describe, expect, spyOn, test } from 'bun:test';
import { buildHistoricalRequest, isRetiredHistoricalModel } from './historicalGeneration';

const failedTile: Tile = { id: 'tile-1', seed: 1, status: 'failed', error: 'internal error', completedAt: 1 };

function batch(overrides: Partial<Batch> = {}): Batch {
  return {
    id: 'batch-1',
    prompt: 'a prompt',
    ratio: '16:9',
    modelId: 'model-a',
    modelLabel: 'Model A',
    createdAt: 1,
    collectionId: null,
    pinned: false,
    status: 'done',
    tiles: [failedTile],
    ...overrides,
  };
}

describe('buildHistoricalRequest', () => {
  test('draws exactly one fresh seed per Re-roll click, while Retry keeps its seed', () => {
    let next = 10;
    const random = spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
      if (!(array instanceof Uint32Array)) throw new Error('expected a seed draw');
      array[0] = next++;
      return array;
    });
    try {
      expect(buildHistoricalRequest(batch(), { kind: 'reroll' }).seed).toBe(10);
      expect(buildHistoricalRequest(batch(), { kind: 'reroll' }).seed).toBe(11);
      expect(buildHistoricalRequest(batch(), { kind: 'retry', tile: failedTile, seed: 42 }).seed).toBe(42);
      expect(random).toHaveBeenCalledTimes(2);
    } finally {
      random.mockRestore();
    }
  });
  test('I2V batch replays its source still and non-default duration on both actions', () => {
    const i2v = batch({ modelId: 'minimax-h3-i2v', i2vSourceUploadId: 'upload-src', durationFrames: 362 });
    const reroll = buildHistoricalRequest(i2v, { kind: 'reroll' });
    const retry = buildHistoricalRequest(i2v, { kind: 'retry', tile: failedTile, seed: 9 });
    for (const request of [reroll, retry]) {
      expect(request).toMatchObject({ modelId: 'minimax-h3-i2v', i2vSourceUploadId: 'upload-src', durationFrames: 362, count: 1 });
    }
  });

  test('T2V batch replays its duration without inventing a source', () => {
    const t2v = batch({ modelId: 'minimax-h3-t2v', durationFrames: 243 });
    const reroll = buildHistoricalRequest(t2v, { kind: 'reroll' });
    const retry = buildHistoricalRequest(t2v, { kind: 'retry', tile: failedTile, seed: 9 });
    for (const request of [reroll, retry]) {
      expect(request.durationFrames).toBe(243);
      expect('i2vSourceUploadId' in request).toBe(false);
    }
  });

  test('sequence segments rerun standalone without extension linkage', () => {
    const segment = batch({
      i2vSourceUploadId: 'handoff-upload',
      durationFrames: 124,
      sequenceId: 'seq-1',
      sequenceIndex: 2,
    });
    const request = buildHistoricalRequest(segment, { kind: 'reroll' });
    expect('extendsTileId' in request).toBe(false);
    expect('sequenceId' in request).toBe(false);
    expect(request.i2vSourceUploadId).toBe('handoff-upload');
  });

  test('image batch omits video fields; reroll keeps count, retry sends one seeded tile', () => {
    const tiles: Tile[] = [
      { id: 't1', seed: 1, status: 'failed', error: 'internal error', completedAt: 1 },
      { id: 't2', seed: 2, status: 'failed', error: 'internal error', completedAt: 1, refImageIds: ['ref-batch'] },
      { id: 't3', seed: 3, status: 'failed', error: 'internal error', completedAt: 1, refImageIds: ['ref-own'] },
    ];
    const image = batch({
      tiles,
      provenance: { templateId: 'tpl', templateName: 'Tpl', rollSeed: 5, pins: { a: 'b' } },
    });
    const reroll = buildHistoricalRequest(image, { kind: 'reroll' });
    if (reroll.seed === undefined) throw new Error('missing reroll seed');
    expect(reroll).toEqual({
      prompt: 'a prompt',
      modelId: 'model-a',
      ratio: '16:9',
      count: 3,
      seed: reroll.seed,
      refImageIds: ['ref-batch'],
      provenance: { templateId: 'tpl', rollSeed: 5, pins: { a: 'b' } },
    });
    const ownTile = tiles[2];
    if (!ownTile) throw new Error('missing tile');
    const retry = buildHistoricalRequest(image, { kind: 'retry', tile: ownTile, seed: 42 });
    expect(retry).toEqual({
      prompt: 'a prompt',
      modelId: 'model-a',
      ratio: '16:9',
      count: 1,
      seed: 42,
      refImageIds: ['ref-own'],
      provenance: { templateId: 'tpl', rollSeed: 5, pins: { a: 'b' } },
    });
  });

  test('deleted template provenance is dropped', () => {
    const orphan = batch({ provenance: { templateId: null, templateName: null, rollSeed: 5, pins: {} } });
    expect('provenance' in buildHistoricalRequest(orphan, { kind: 'reroll' })).toBe(false);
  });
});

describe('isRetiredHistoricalModel', () => {
  const model = { id: 'model-a' } as Model;
  const modelById = new Map([[model.id, model]]);

  test('absent from a loaded inventory is retired', () => {
    expect(isRetiredHistoricalModel('retired-id', modelById, true)).toBe(true);
    expect(isRetiredHistoricalModel('model-a', modelById, true)).toBe(false);
  });

  test('pending or failed inventory never claims retirement', () => {
    expect(isRetiredHistoricalModel('retired-id', new Map(), false)).toBe(false);
  });
});

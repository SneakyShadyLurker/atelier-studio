import { describe, expect, test } from 'bun:test';
import { isArchivePage, isCollectionsResponse, isModelList } from './client';

const model = {
  id: 'm1', name: 'Model', backend: 'local', tag: 'comfyui', latency: 'fast',
  supportedRatios: ['1:1', '16:9'], concurrencyCapPerUser: 2, maxCountPerBatch: 4, pool: 'local',
};

describe('isModelList', () => {
  test('accepts every optional model field in its documented shape', () => {
    expect(isModelList([{
      ...model,
      size: 'SDXL', defaultRatio: '16:9', supportsReferenceImages: true, maxRefImages: 4, maxRefBytesPerBatch: 1024,
      supportsI2V: false, batched: true, outputsVideo: false, defaultCount: 4, promptFormat: 'h3-motion',
      requiresKey: { provider: 'google' }, availability: { ok: false, checkedAt: 1, reason: 'timed out' },
    }])).toBe(true);
    expect(isModelList([])).toBe(true);
  });

  test('rejects unknown vocabularies and a default outside the supported set', () => {
    expect(isModelList([{ ...model, backend: 'elsewhere' }])).toBe(false);
    expect(isModelList([{ ...model, pool: 'other' }])).toBe(false);
    expect(isModelList([{ ...model, supportedRatios: ['7:3'] }])).toBe(false);
    expect(isModelList([{ ...model, defaultRatio: '9:16' }])).toBe(false);
    expect(isModelList([{ ...model, promptFormat: 'plain' }])).toBe(false);
    expect(isModelList([{ ...model, requiresKey: { provider: 'other' } }])).toBe(false);
    expect(isModelList([{ ...model, availability: { ok: false, checkedAt: 1, reason: 'host down at port 8188' } }])).toBe(false);
    expect(isModelList([{ ...model, concurrencyCapPerUser: undefined }])).toBe(false);
    expect(isModelList({ 0: model })).toBe(false);
  });
});

describe('isCollectionsResponse', () => {
  const summary = {
    totalCount: 3, pinnedCount: 1, unsortedCount: 2, archivedTotalCount: 0, archivedPinnedCount: 0, archivedUnsortedCount: 0,
  };

  test('accepts collections with the library summary', () => {
    expect(isCollectionsResponse({ items: [{ id: 'c1', name: 'A', count: 1, archivedCount: 0, createdAt: 1 }], summary })).toBe(true);
  });

  test('rejects an incomplete summary or collection', () => {
    expect(isCollectionsResponse({ items: [], summary: { ...summary, archivedUnsortedCount: undefined } })).toBe(false);
    expect(isCollectionsResponse({ items: [{ id: 'c1', name: 'A', count: 1, createdAt: 1 }], summary })).toBe(false);
  });
});

describe('isArchivePage', () => {
  const tile = {
    id: 't1', batchId: 'b1', prompt: 'p', modelLabel: 'Model', seed: 1, status: 'done', url: '/api/img/t1',
    ext: 'png', mime: 'image/png', ratio: '1:1', completedAt: 1, archivedAt: 2,
  };

  test('accepts first and later pages', () => {
    expect(isArchivePage({ items: [tile], nextCursor: 'c', total: 1 })).toBe(true);
    expect(isArchivePage({ items: [{ ...tile, thumbUrl: '/api/img/t1/thumb', refImageIds: ['u1'] }], nextCursor: null, total: null })).toBe(true);
  });

  test('rejects mismatched media, a non-done tile or a missing total', () => {
    expect(isArchivePage({ items: [{ ...tile, ext: 'mp4' }], nextCursor: null, total: 1 })).toBe(false);
    expect(isArchivePage({ items: [{ ...tile, status: 'failed' }], nextCursor: null, total: 1 })).toBe(false);
    expect(isArchivePage({ items: [tile], nextCursor: null })).toBe(false);
  });
});

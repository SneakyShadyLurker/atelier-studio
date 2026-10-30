import { describe, expect, test } from 'bun:test';
import { BatchSchema, PromptLibraryResponseSchema } from '../src/wireSchemas';
import type { HistoryRefreshRequest, HistoryRefreshResponse } from '../src/wireSchemas';
import type { _NoUserIdOn } from '../src/index';

const refreshWireScope: [_NoUserIdOn<HistoryRefreshRequest>, _NoUserIdOn<HistoryRefreshResponse>] = [true, true];

const batch = {
  id: 'batch', prompt: 'beat', ratio: '1:1', modelId: 'm', modelLabel: 'M',
  createdAt: 1, collectionId: null, pinned: false, status: 'done', tiles: [],
};
const library = {
  templates: [],
  variableLists: [{ id: 'list', name: 'List', sortOrder: 0, createdAt: 1, updatedAt: 1,
    options: [{ id: 'option', listId: 'list', value: 'Value', tagIds: [], sortOrder: 0, weight: 1 }] }],
  dimensions: [{ id: 'dimension', name: 'Dimension', tags: [{ id: 'tag', dimensionId: 'dimension', label: 'Tag', sortOrder: 0 }] }],
};

describe('shared response contracts', () => {
  test('refresh request and response contain no public auth scope', () => {
    expect(refreshWireScope).toEqual([true, true]);
  });
  test('keeps optional historic fields compatible while validating newer batch metadata', () => {
    expect(BatchSchema.safeParse(batch).success).toBe(true);
    expect(BatchSchema.safeParse({ ...batch, motionPrompt: 'orbit', durationFrames: 243, startedAt: 2, i2vSourceUploadId: 'source',
      story: { id: 's', status: 'rendering', segmentIndex: 0, segmentCount: 2, logline: 'story', etaMs: 500 } }).success).toBe(true);
    for (const extra of [{ durationFrames: 42 }, { startedAt: 'now' }, { i2vSourceUploadId: 1 }, { motionPrompt: {} }, { story: { id: 's' } }]) {
      expect(BatchSchema.safeParse({ ...batch, ...extra }).success).toBe(false);
    }
  });

  test('validates exclusions and dimension metadata without requiring late-added optional fields', () => {
    expect(PromptLibraryResponseSchema.safeParse(library).success).toBe(true);
    const option = library.variableLists[0]?.options[0];
    const list = library.variableLists[0];
    const dimension = library.dimensions[0];
    expect(PromptLibraryResponseSchema.safeParse({ ...library, variableLists: [{ ...list, options: [{ ...option, excludeTagIds: [3] }] }] }).success).toBe(false);
    expect(PromptLibraryResponseSchema.safeParse({ ...library, dimensions: [{ ...dimension, description: 3 }] }).success).toBe(false);
    expect(PromptLibraryResponseSchema.safeParse({ ...library, dimensions: [{ ...dimension, tags: [{ ...dimension?.tags[0], parentId: 3 }] }] }).success).toBe(false);
  });
});

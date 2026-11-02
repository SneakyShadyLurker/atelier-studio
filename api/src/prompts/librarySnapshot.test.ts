import { describe, expect, test } from 'bun:test';
import { toLibrarySnapshot, snapshotHash } from './librarySnapshot';
import type { PromptLibraryResponse } from '@atelier/shared';

const lib: PromptLibraryResponse = {
  templates: [],
  variableLists: [{
    id: 'l1',
    name: 'Races',
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    options: [{ id: 'o1', listId: 'l1', value: 'Orc', tagIds: ['t1'], sortOrder: 0, weight: 1 }],
  }],
  dimensions: [{ id: 'd1', name: 'Franchise', tags: [{ id: 't1', dimensionId: 'd1', label: 'Warhammer', sortOrder: 0 }] }],
};

describe('toLibrarySnapshot', () => {
  test('index-addresses dims/lists/options, no UUIDs in tagIdxs', () => {
    const s = toLibrarySnapshot(lib);
    expect(s.dimensions[0]).toEqual({ idx: 0, id: 'd1', name: 'Franchise', tags: [{ idx: 0, id: 't1', label: 'Warhammer' }] });
    expect(s.lists[0]?.options[0]).toEqual({ idx: 0, id: 'o1', value: 'Orc', weight: 1, tagIdxs: [0] });
  });

  test('tag idx values are globally unique across dimensions', () => {
    const s = toLibrarySnapshot({
      templates: [],
      variableLists: [{
        id: 'l1',
        name: 'Things',
        sortOrder: 0,
        createdAt: 0,
        updatedAt: 0,
        options: [
          { id: 'o1', listId: 'l1', value: 'A', tagIds: ['t-a'], sortOrder: 0, weight: 1 },
          { id: 'o2', listId: 'l1', value: 'B', tagIds: ['t-b'], sortOrder: 1, weight: 1 },
        ],
      }],
      dimensions: [
        { id: 'd1', name: 'One', tags: [{ id: 't-a', dimensionId: 'd1', label: 'A', sortOrder: 0 }] },
        { id: 'd2', name: 'Two', tags: [{ id: 't-b', dimensionId: 'd2', label: 'B', sortOrder: 0 }] },
      ],
    });
    expect(s.dimensions[0]?.tags[0]?.idx).not.toBe(s.dimensions[1]?.tags[0]?.idx);
    expect(s.lists[0]?.options.map((option) => option.tagIdxs)).toEqual([[0], [1]]);
  });

  test('ignores a parent that belongs to another dimension', () => {
    const snapshot = toLibrarySnapshot({
      templates: [],
      variableLists: [{
        id: 'list',
        name: 'things',
        sortOrder: 0,
        createdAt: 0,
        updatedAt: 0,
        options: [{ id: 'option', listId: 'list', value: 'child', tagIds: ['child'], sortOrder: 0, weight: 1 }],
      }],
      dimensions: [
        { id: 'one', name: 'One', tags: [{ id: 'foreign-parent', dimensionId: 'one', label: 'Parent', sortOrder: 0 }] },
        { id: 'two', name: 'Two', tags: [{ id: 'child', dimensionId: 'two', label: 'Child', sortOrder: 0, parentId: 'foreign-parent' }] },
      ],
    });

    expect(snapshot.dimensions[1]?.tags[0]?.parentIdx).toBeUndefined();
    expect(snapshot.lists[0]?.options[0]?.expandedTagIdxs).toBeUndefined();
  });

  test('snapshotHash is stable and order-independent for identical content', () => {
    expect(snapshotHash(toLibrarySnapshot(lib))).toBe(snapshotHash(toLibrarySnapshot(structuredClone(lib))));
  });

  test('snapshotHash is invariant under option-weight changes', () => {
    const libLight = makeLibFixture({ weight: 1 });
    const libHeavy = makeLibFixture({ weight: 99 });

    expect(snapshotHash(toLibrarySnapshot(libLight))).toBe(snapshotHash(toLibrarySnapshot(libHeavy)));
  });

  test('snapshotHash covers polarity and hierarchy parents', () => {
    const baseList = lib.variableLists[0];
    const baseOption = baseList?.options[0];
    const baseDimension = lib.dimensions[0];
    if (!baseList || !baseOption || !baseDimension) throw new Error('expected fixture');
    const polarity: PromptLibraryResponse = {
      ...lib,
      variableLists: [{ ...baseList, options: [{ ...baseOption, tagIds: [], excludeTagIds: ['t1'] }] }],
    };
    const hierarchy: PromptLibraryResponse = {
      ...lib,
      dimensions: [{
        ...baseDimension,
        tags: [
          ...baseDimension.tags,
          { id: 't2', dimensionId: 'd1', label: 'Warhammer 40k', sortOrder: 1, parentId: 't1' },
        ],
      }],
    };
    const baseSnapshotHash = snapshotHash(toLibrarySnapshot(lib));
    for (const changed of [polarity, hierarchy]) {
      expect(snapshotHash(toLibrarySnapshot(changed))).not.toBe(baseSnapshotHash);
    }
  });
});

function makeLibFixture({ weight }: { weight: number }): PromptLibraryResponse {
  return {
    templates: [],
    variableLists: [{
      id: 'l1',
      name: 'list',
      sortOrder: 0,
      createdAt: 0,
      updatedAt: 0,
      options: [{ id: 'o1', listId: 'l1', value: 'opt', tagIds: [], sortOrder: 0, weight }],
    }],
    dimensions: [],
  };
}

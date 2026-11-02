import { describe, expect, test } from 'bun:test';
import type { Collection } from '@atelier/shared';
import { buildLibraryRows } from './rows';

const summary = {
  unsortedCount: 4,
  pinnedCount: 2,
  archivedUnsortedCount: 0,
  archivedPinnedCount: 2,
};

const collections: readonly Collection[] = [
  { id: 'c1', name: 'Alpha', count: 3, archivedCount: 2, createdAt: 1 },
  { id: 'c2', name: 'Beta', count: 0, archivedCount: 0, createdAt: 1 },
];

describe('buildLibraryRows', () => {
  test('main view: all collections (incl. 0-count) plus "+ New collection"', () => {
    const rows = buildLibraryRows(collections, summary, false);
    expect(rows.map((r) => r.kind)).toEqual(['unsorted', 'pinned', 'collection', 'collection', 'new']);
  });

  test('archive view: 0-archived collections and "+ New collection" are hidden', () => {
    const rows = buildLibraryRows(collections, summary, true);
    expect(rows.map((r) => r.kind)).toEqual(['unsorted', 'pinned', 'collection']);
    const collectionRow = rows.find((r) => r.kind === 'collection');
    expect(collectionRow?.kind === 'collection' && collectionRow.collection.name).toBe('Alpha');
  });

  test('main view keeps "+ New collection"; archive omits it', () => {
    expect(buildLibraryRows(collections, summary, false).some((r) => r.kind === 'new')).toBe(true);
    expect(buildLibraryRows(collections, summary, true).some((r) => r.kind === 'new')).toBe(false);
  });

  test('archive uses archived counts and archive-scoped views', () => {
    const rows = buildLibraryRows(collections, summary, true);
    const unsorted = rows[0];
    expect(unsorted?.kind === 'unsorted' && unsorted.count).toBe(0);
    const collectionRow = rows.find((r) => r.kind === 'collection');
    expect(collectionRow?.kind === 'collection' && collectionRow.view.kind).toBe('archive');
    expect(collectionRow?.kind === 'collection' && collectionRow.count).toBe(2);
  });

  test('archive with no archived collection content collapses to flat scopes', () => {
    const allUnarchived: readonly Collection[] = [
      { id: 'c1', name: 'Alpha', count: 3, archivedCount: 0, createdAt: 1 },
      { id: 'c2', name: 'Beta', count: 5, archivedCount: 0, createdAt: 2 },
    ];
    const rows = buildLibraryRows(allUnarchived, { ...summary, archivedPinnedCount: 0 }, true);
    expect(rows.map((r) => r.kind)).toEqual(['unsorted']);
  });

  test('live view: pinned row is omitted when live pinned count is zero', () => {
    const rows = buildLibraryRows(collections, { ...summary, pinnedCount: 0 }, false);
    expect(rows.some((r) => r.kind === 'pinned')).toBe(false);
  });

  test('archive view: pinned row is omitted when archived pinned count is zero', () => {
    const rows = buildLibraryRows(collections, { ...summary, archivedPinnedCount: 0 }, true);
    expect(rows.some((r) => r.kind === 'pinned')).toBe(false);
  });
});

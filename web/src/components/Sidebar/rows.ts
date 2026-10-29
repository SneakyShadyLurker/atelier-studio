import type { Collection } from '@atelier/shared';
import {
  APP_VIEW_PINNED,
  APP_VIEW_UNSORTED,
  archiveCollectionView,
  archivePinnedView,
  archiveUnsortedView,
  collectionView,
} from '../../store/atelier';
import type { AppView } from '../../store/atelier';

export type LibraryRow =
  | { kind: 'pinned'; label: 'Pinned'; count: number; view: AppView }
  | { kind: 'unsorted'; label: 'Unsorted'; count: number; view: AppView }
  | { kind: 'collection'; collection: Collection; count: number; view: AppView }
  | { kind: 'new'; label: '+ New collection' };

interface RowSummary {
  unsortedCount: number;
  pinnedCount: number;
  archivedUnsortedCount: number;
  archivedPinnedCount: number;
}

export function buildLibraryRows(
  collections: readonly Collection[],
  summary: RowSummary,
  isArchive: boolean,
): readonly LibraryRow[] {
  const next: LibraryRow[] = [
    {
      kind: 'unsorted',
      label: 'Unsorted',
      count: isArchive ? summary.archivedUnsortedCount : summary.unsortedCount,
      view: isArchive ? archiveUnsortedView : APP_VIEW_UNSORTED,
    },
  ];
  const pinnedCount = isArchive ? summary.archivedPinnedCount : summary.pinnedCount;
  if (pinnedCount > 0) {
    next.push({
      kind: 'pinned',
      label: 'Pinned',
      count: pinnedCount,
      view: isArchive ? archivePinnedView : APP_VIEW_PINNED,
    });
  }
  for (const collection of collections) {
    const count = isArchive ? collection.archivedCount : collection.count;
    // Archive is a terminal deletion bin: a collection with nothing archived
    // is not a destination there. Gated like Pinned above; the collection is
    // still fully present on the Main rail.
    if (isArchive && count === 0) continue;
    next.push({
      kind: 'collection',
      collection,
      count,
      view: isArchive ? archiveCollectionView(collection.id) : collectionView(collection.id),
    });
  }
  // No "create an organizing bucket" affordance inside a deletion queue.
  if (!isArchive) next.push({ kind: 'new', label: '+ New collection' });
  return next;
}

import { isVideoMime, type ArchivedTile } from '@atelier/shared';
import { useVirtualizer } from '@tanstack/react-virtual';
import { memo, useDeferredValue, useEffect, useMemo, useRef, useState, ViewTransition } from 'react';
import { getRatioDefinition } from '../../lib/ratios';
import { fallbackVirtualRows, virtualizedHeight } from '../../lib/virtualWindow';
import { InfiniteStatus } from '../InfiniteStatus';
import { I } from '../icons/I';
import { ManagedViewHeader } from '../ManagedViewHeader';
import { StateView, LoadingState, ErrorState } from '../StateView';
import ConfirmDialog from '../ConfirmDialog';
import BatchPrompt from '../Batch/BatchPrompt';
import ClipFrame from '../tile/ClipFrame';
import { Meta } from '../Meta';
import buttons from '../../styles/buttons.module.css';
import styles from './index.module.css';

interface ArchiveProps {
  items: readonly ArchivedTile[];
  total: number;
  isLoading: boolean;
  isError: boolean;
  error?: string | null;
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  isFetchNextPageError?: boolean;
  onLoadMore?: () => void;
  onRetry: () => void;
  // A returned promise lets a rejected action bring the tile back; a void
  // return is treated as fire-and-forget success.
  onRestore: (tileId: string) => unknown;
  onPermanentDelete: (tileId: string) => unknown;
  onPurgeAll: () => void;
  onBack: () => void;
  onOpenTile: (tile: ArchivedTile) => void;
}

function EmptyArchive() {
  return (
    <StateView
      art="empty-archive"
      title="Nothing archived"
      body="Archived images stay here for 30 days before they are deleted permanently."
    />
  );
}

function tileAspectRatio(tile: ArchivedTile): string {
  const ratio = getRatioDefinition(tile.ratio);
  return `${ratio.w} / ${ratio.h}`;
}

const ARCHIVE_MIN_TILE_WIDTH = 260;
const ARCHIVE_ROW_ESTIMATE = 390;
const ARCHIVE_FALLBACK_ROWS = 6;
const archiveDateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

function ArchiveImage({ tile }: { tile: ArchivedTile }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <>
      <span className={`${styles.skeleton} ${loaded ? styles.skeletonHidden : ''}`} aria-hidden="true" />
      <img
        ref={(image) => {
          if (image?.complete && image.naturalWidth > 0) setLoaded(true);
        }}
        className={loaded ? styles.imageLoaded : undefined}
        src={tile.thumbUrl ?? tile.url}
        alt={`${tile.prompt} — generated with ${tile.modelLabel}`}
        width={ARCHIVE_MIN_TILE_WIDTH}
        height={ARCHIVE_MIN_TILE_WIDTH}
        loading="lazy"
        decoding="async"
        draggable={false}
        onLoad={() => { setLoaded(true); }}
        onError={(event) => {
          if (event.currentTarget.getAttribute('src') !== tile.url) {
            setLoaded(false);
            event.currentTarget.src = tile.url;
          }
        }}
      />
    </>
  );
}

function chunkRows<T>(items: readonly T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    rows.push(items.slice(index, index + size));
  }
  return rows;
}

function Archive({
  items,
  total,
  isLoading,
  isError,
  error = null,
  hasNextPage = false,
  isFetchingNextPage = false,
  isFetchNextPageError = false,
  onLoadMore,
  onRetry,
  onRestore,
  onPermanentDelete,
  onPurgeAll,
  onBack,
  onOpenTile,
}: ArchiveProps) {
  // Tiles whose Restore or Delete is in flight: filtered out at once (their
  // exit is the tile boundary's, below) and brought back if the action fails.
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(() => new Set());
  // Tiles a failed action brought back: they re-enter with `tile-enter`. Every
  // other insertion (first load, pagination, a tile scrolling into the
  // rendered window) is historical and has no entrance.
  const [revealedIds, setRevealedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const archiveRef = useRef<HTMLDivElement | null>(null);
  const [gridCols, setGridCols] = useState(1);
  // Derive (don't store-via-effect): the confirm only renders while its tile
  // is still in `items`. If the list changes underneath (pagination refetch,
  // cross-tab mutation, eviction) the dialog auto-unmounts instead of letting
  // the user confirm a permanent disk-delete for a tile they can't see.
  const pendingDeleteTile = pendingDelete !== null
    ? items.find((tile) => tile.id === pendingDelete) ?? null
    : null;
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    const element = archiveRef.current;
    if (!element) return;
    const update = () => {
      const width = element.clientWidth;
      // The rows' gap is the --grid-gap token (narrower on phones); read it
      // here so the column count matches the rendered gap.
      const gap = parseFloat(getComputedStyle(element).getPropertyValue('--grid-gap')) || 0;
      const next = Math.max(1, Math.floor((width + gap) / (ARCHIVE_MIN_TILE_WIDTH + gap)));
      setGridCols(next);
    };
    update();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update);
      return () => { window.removeEventListener('resize', update); };
    }
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => { observer.disconnect(); };
  }, []);

  // A failed action must not hide the tile forever: drop it from the pending
  // set so it returns (through the same deferred snapshot, so it enters) and
  // the user can retry. The action's own error toast speaks.
  const revealTile = (tileId: string) => {
    if (!mountedRef.current) return;
    setPendingIds((current) => {
      if (!current.has(tileId)) return current;
      const next = new Set(current);
      next.delete(tileId);
      return next;
    });
    setRevealedIds((current) => new Set(current).add(tileId));
  };

  const runAction = (tileId: string, action: (id: string) => unknown) => {
    let outcome: unknown;
    try {
      outcome = action(tileId);
    } catch {
      revealTile(tileId);
      return;
    }
    if (outcome instanceof Promise) {
      void outcome.catch(() => { revealTile(tileId); });
    }
  };

  const removeTile = (tileId: string, action: (id: string) => unknown) => {
    if (pendingIds.has(tileId)) return;
    setPendingIds((current) => new Set(current).add(tileId));
    setRevealedIds((current) => {
      if (!current.has(tileId)) return current;
      const next = new Set(current);
      next.delete(tileId);
      return next;
    });
    runAction(tileId, action);
  };

  const visibleItems = useMemo(() => items.filter((tile) => !pendingIds.has(tile.id)), [items, pendingIds]);
  // One render snapshot of the rows: a removal or a failure's return commits
  // in a Transition, which is what the tile boundaries animate. Rows keep
  // their index keys, so the removed tile's <ViewTransition> is the top of
  // what React deletes (React runs exit/enter only for a boundary above every
  // DOM node of the change), the tiles left in its row move as an update, and
  // a tile that re-chunks into the row above pairs with itself through its
  // shared name.
  const liveRows = useMemo(() => chunkRows(visibleItems, gridCols), [gridCols, visibleItems]);
  const virtualRowsData = useDeferredValue(liveRows);
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual's useVirtualizer is the canonical virtualization primitive; React Compiler escape hatch.
  const rowVirtualizer = useVirtualizer({
    count: virtualRowsData.length,
    getScrollElement: () => archiveRef.current,
    estimateSize: () => ARCHIVE_ROW_ESTIMATE,
    initialRect: { width: 0, height: 720 },
    overscan: 3,
  });
  const measureRows = rowVirtualizer.measure;
  useEffect(() => {
    measureRows();
  }, [gridCols, measureRows]);
  const virtualRows = rowVirtualizer.getVirtualItems();
  const renderRows = virtualRows.length > 0
    ? virtualRows
    : fallbackVirtualRows(virtualRowsData.length, ARCHIVE_FALLBACK_ROWS, () => ARCHIVE_ROW_ESTIMATE, (index) => index);
  const virtualGridHeight = virtualizedHeight(virtualRows.length > 0, rowVirtualizer.getTotalSize(), virtualRowsData.length * ARCHIVE_ROW_ESTIMATE);

  const renderTile = (tile: ArchivedTile) => {
    const archivedDate = archiveDateFormatter.format(tile.archivedAt);
    return (
      // Same capture as a feed tile (motion.css .tile-*), named so a survivor
      // that re-chunks into another virtual row moves as one group (share).
      <ViewTransition
        key={tile.id}
        name={`tile-${tile.id}`}
        share="tile-move"
        default="tile-move"
        exit="tile-exit"
        enter={revealedIds.has(tile.id) ? 'tile-enter' : 'none'}
      >
      <div className={styles.tile}>
        <div className={styles.media}>
          <button
            className={styles.frame}
            type="button"
            aria-label={`Open archived image: ${tile.prompt}`}
            // Archived media was seen in the feed: a virtual remount (scroll,
            // re-chunked rows) must not replay the video develop.
            data-seen="true"
            style={{ aspectRatio: tileAspectRatio(tile) }}
            onClick={() => { onOpenTile(tile); }}
          >
            {isVideoMime(tile.mime) ? (
              <ClipFrame src={tile.url} poster={tile.thumbUrl} />
            ) : (
              <ArchiveImage tile={tile} />
            )}
          </button>
          <div className={styles.overlay}>
            <div className={styles.actions}>
              <button
                type="button"
                className={buttons.tileAction}
                aria-label="Restore"
                data-tip="Restore"
                onClick={(event) => {
                  event.stopPropagation();
                  removeTile(tile.id, onRestore);
                }}
              >
                <I.reroll />
              </button>
              <button
                type="button"
                className={buttons.tileAction}
                aria-label="Delete permanently"
                data-tip="Delete permanently"
                data-tip-place="above-end"
                onClick={(event) => {
                  event.stopPropagation();
                  setPendingDelete(tile.id);
                }}
              >
                <I.trash />
              </button>
            </div>
          </div>
        </div>
        <div className={styles.identity}>
          <BatchPrompt prompt={tile.prompt} {...(styles.prompt ? { className: styles.prompt } : {})} />
          <Meta
            lead
            className={styles.meta}
            items={[tile.modelLabel, <time key="archived" dateTime={new Date(tile.archivedAt).toISOString()}>Archived {archivedDate}</time>]}
          />
        </div>
      </div>
      </ViewTransition>
    );
  };

  return (
    <div className={styles.archive} aria-labelledby="atelier-archive-heading">
      <ManagedViewHeader
        heading="Archive"
        headingId="atelier-archive-heading"
        backLabel="Back to Unsorted"
        onBack={onBack}
      >
        <button className={`${buttons.danger} ${styles.emptyButton}`} type="button" disabled={total === 0} onClick={onPurgeAll}>
          Empty archive
        </button>
      </ManagedViewHeader>

      <div ref={archiveRef} className={styles.contents}>
        {isLoading ? (
          <LoadingState label="Loading archive…" />
        ) : isError ? (
          <ErrorState message={error ?? 'Archive unavailable'} onRetry={onRetry} />
        ) : items.length === 0 ? (
          <EmptyArchive />
        ) : (
          <div
            className={styles.virtualGrid}
            data-virtualized="archive"
            style={{ height: `${virtualGridHeight}px` }}
          >
            {renderRows.map((virtualRow) => {
              const row = virtualRowsData[virtualRow.index] ?? [];
              return (
                // Exit only: a row React deletes (its sole tile removed, the
                // last tile of all included) would take that tile's boundary
                // with it, and React runs exit only for the top boundary of
                // a deleted subtree. Tiles that stay or re-chunk carry their
                // own captures, so the row never animates an update.
                <ViewTransition key={virtualRow.key} default="none" exit="tile-exit">
                <div
                  data-index={virtualRow.index}
                  ref={rowVirtualizer.measureElement}
                  className={styles.virtualRow}
                  style={{
                    gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))`,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  {row.map(renderTile)}
                </div>
                </ViewTransition>
              );
            })}
          </div>
        )}
        <InfiniteStatus
          hasNextPage={hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          isFetchNextPageError={isFetchNextPageError}
          fetchNextPage={() => { onLoadMore?.(); }}
          scrollRoot={archiveRef}
          itemCount={items.length}
          endLabel={`End, ${String(total)} archived`}
          enabled={!isLoading && !isError}
        />
      </div>
      {pendingDeleteTile !== null && (
        <ConfirmDialog
          open
          title="Delete permanently?"
          body="This removes the image from disk. This cannot be undone."
          confirmLabel="Delete"
          cancelLabel="Cancel"
          danger
          closeOnBackdrop={false}
          onConfirm={() => {
            const id = pendingDeleteTile.id;
            setPendingDelete(null);
            removeTile(id, onPermanentDelete);
          }}
          onCancel={() => { setPendingDelete(null); }}
        />
      )}
    </div>
  );
}

// memo for parity with Sidebar — same Library rail shape; marginal impact
// (archive view has no live SSE stream) but keeps the surface consistent.
export default memo(Archive);

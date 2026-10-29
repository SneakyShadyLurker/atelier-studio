import { isVideoMime, type ArchivedTile } from '@atelier/shared';
import { useVirtualizer } from '@tanstack/react-virtual';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { getRatioDefinition } from '../../lib/ratios';
import { fallbackVirtualRows, virtualizedHeight } from '../../lib/virtualWindow';
import { InfiniteStatus } from '../InfiniteStatus';
import { I } from '../icons/I';
import { ManagedViewHeader } from '../ManagedViewHeader';
import { StateView, LoadingState, ErrorState } from '../StateView';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import ConfirmDialog from '../ConfirmDialog';
import BatchPrompt from '../Batch/BatchPrompt';
import ClipFrame from '../tile/ClipFrame';
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
      glyph={<I.archive width={22} height={22} />}
      title="Nothing archived"
      body="Deleted images live here for 30 days before they are removed permanently."
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

export function archiveRowKey(row: readonly ArchivedTile[] | undefined, index: number): string | number {
  return row?.map((tile) => tile.id).join(':') ?? index;
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
  const [leavingIds, setLeavingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(() => new Set());
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const archiveRef = useRef<HTMLDivElement | null>(null);
  const [gridCols, setGridCols] = useState(1);
  const reducedMotion = useReducedMotion();
  // Derive (don't store-via-effect): the confirm only renders while its tile
  // is still in `items`. If the list changes underneath (pagination refetch,
  // cross-tab mutation, eviction) the dialog auto-unmounts instead of letting
  // the user confirm a permanent disk-delete for a tile they can't see.
  const pendingDeleteTile = pendingDelete !== null
    ? items.find((tile) => tile.id === pendingDelete) ?? null
    : null;
  const timers = useRef(new Map<string, number>());
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    const pendingTimers = timers.current;
    return () => {
      mountedRef.current = false;
      for (const timer of pendingTimers.values()) window.clearTimeout(timer);
      pendingTimers.clear();
    };
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

  // A failed action must not hide the tile forever: cancel any pending exit
  // timer and drop the tile from both leaving and hidden so the user can retry.
  const revealTile = (tileId: string) => {
    if (!mountedRef.current) return;
    const timer = timers.current.get(tileId);
    if (timer !== undefined) window.clearTimeout(timer);
    timers.current.delete(tileId);
    const without = (current: ReadonlySet<string>) => {
      if (!current.has(tileId)) return current;
      const next = new Set(current);
      next.delete(tileId);
      return next;
    };
    setLeavingIds(without);
    setHiddenIds(without);
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

  const startLeaving = (tileId: string, action: (id: string) => unknown) => {
    if (leavingIds.has(tileId) || hiddenIds.has(tileId)) return;
    if (reducedMotion) {
      setHiddenIds((current) => new Set(current).add(tileId));
      runAction(tileId, action);
      return;
    }
    setLeavingIds((current) => new Set(current).add(tileId));
    // Track the CSS exit duration (.tileLeaving animates for var(--dur-sheet))
    // so the unmount can't clip the animation; fall back to 240 when the token
    // isn't resolvable (e.g. happy-dom).
    const exitMs = Number.parseInt(
      getComputedStyle(document.documentElement).getPropertyValue('--dur-sheet'),
      10,
    ) || 240;
    const timer = window.setTimeout(() => {
      setHiddenIds((current) => new Set(current).add(tileId));
      setLeavingIds((current) => {
        const next = new Set(current);
        next.delete(tileId);
        return next;
      });
      timers.current.delete(tileId);
    }, exitMs);
    timers.current.set(tileId, timer);
    runAction(tileId, action);
  };

  const visibleItems = useMemo(() => items.filter((tile) => !hiddenIds.has(tile.id)), [items, hiddenIds]);
  const virtualRowsData = useMemo(() => chunkRows(visibleItems, gridCols), [gridCols, visibleItems]);
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual's useVirtualizer is the canonical virtualization primitive; React Compiler escape hatch.
  const rowVirtualizer = useVirtualizer({
    count: virtualRowsData.length,
    getScrollElement: () => archiveRef.current,
    getItemKey: (index) => archiveRowKey(virtualRowsData[index], index),
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
    const isLeaving = leavingIds.has(tile.id);
    const archivedDate = archiveDateFormatter.format(tile.archivedAt);
    return (
      <div key={tile.id} className={`${styles.tile} ${isLeaving ? styles.tileLeaving : ''}`}>
        <div className={styles.media}>
          <button
            className={styles.frame}
            type="button"
            aria-label={`Open archived image: ${tile.prompt}`}
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
                  startLeaving(tile.id, onRestore);
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
          <div className={styles.meta}>
            <span>{tile.modelLabel}</span>
            <time dateTime={new Date(tile.archivedAt).toISOString()}>Archived {archivedDate}</time>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className={styles.archive} aria-labelledby="atelier-archive-heading">
      <ManagedViewHeader
        heading="Archive"
        headingId="atelier-archive-heading"
        label={`ARCHIVE · ${total} ITEM${total === 1 ? '' : 'S'}`}
        onBack={onBack}
      >
        <button className={`${buttons.danger} ${styles.emptyButton}`} type="button" disabled={total === 0} onClick={onPurgeAll}>
          Empty Archive
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
                <div
                  key={virtualRow.key}
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
              );
            })}
          </div>
        )}
        <InfiniteStatus
          hasNextPage={hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          isFetchNextPageError={isFetchNextPageError}
          fetchNextPage={() => { onLoadMore?.(); }}
          itemCount={items.length}
          endLabel={`END · ${total} ARCHIVED`}
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
            startLeaving(id, onPermanentDelete);
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

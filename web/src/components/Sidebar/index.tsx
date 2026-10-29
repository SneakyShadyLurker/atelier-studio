import type { Batch, Collection, HistoryPage, Model } from '@atelier/shared';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Ref } from 'react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  APP_VIEW_ARCHIVE,
  APP_VIEW_PROMPTS,
  type AppView,
  appViewEquals,
  useAtelierStore,
} from '../../store/atelier';
import { FEED_VIRTUALIZER_ANCHORING } from '../../lib/feedAnchor';
import { fallbackVirtualRows, virtualizedHeight } from '../../lib/virtualWindow';
import { describeError } from '../../lib/errorCopy';
import type { Theme } from '../../hooks/useTheme';
import { useCollections } from '../../hooks/useCollections';
import { useCreateCollection } from '../../hooks/useCreateCollection';
import { useDeleteCollection } from '../../hooks/useDeleteCollection';
import { useInlineEdit } from '../../hooks/useInlineEdit';
import { useIsPhone } from '../../hooks/useIsPhone';
import { useRenameCollection } from '../../hooks/useRenameCollection';
import { useReorderCollections } from '../../hooks/useReorderCollections';
import { useRovingTabIndex } from '../../hooks/useRovingTabIndex';
import { useTogglePin } from '../../hooks/useTogglePin';
import { useVerticalDragReorder } from '../../hooks/useVerticalDragReorder';
import { runWhenReachable } from '../../lib/focus';
import ConfirmDialog from '../ConfirmDialog';
import { InfiniteStatus } from '../InfiniteStatus';
import { I } from '../icons/I';
import buttons from '../../styles/buttons.module.css';
import atelierMark from '../../assets/atelier-mark.png';
import styles from './index.module.css';
import { buildLibraryRows, type LibraryRow } from './rows';

const SIDEBAR_ROW_HEIGHT = 62;
const SIDEBAR_FALLBACK_ROWS = 10;

interface SidebarProps {
  id?: string;
  dataOpen?: boolean;
  inertClosed?: boolean;
  collapsed?: boolean;
  onCollapse?: () => void;
  history: HistoryPage<Batch>;
  models: readonly Model[];
  activeBatchId: string | null;
  // Debounced search term matching the history query key. Live q below still
  // drives the visible search field; mutation hooks use this prop for cache
  // scoping so keystrokes don't retarget optimistic writes mid-debounce.
  historyQ: string;
  archivedCount: number;
  promptsEnabled?: boolean;
  theme?: Theme;
  error?: string | null;
  historyReadOnly?: boolean;
  isFetchingNextPage?: boolean;
  isFetchNextPageError?: boolean;
  hasNextPage?: boolean;
  onSelect: (batchId: string) => void;
  // App-owned view-navigation transaction (transition wrap + phone drawer
  // close) — single source of truth, never re-rolled locally.
  onSelectView: (view: AppView) => void;
  onClear: () => void;
  onToggleTheme?: () => void;
  onRetry?: () => void;
  onLoadMore?: () => void;
  ref?: Ref<HTMLElement>;
}

type InlineState =
  | { kind: 'idle' }
  | { kind: 'searching' };

type InlineKind = 'creating' | 'renaming';
type InlineContext = { kind: 'creating' } | { kind: 'renaming'; id: string; name: string };

const IDLE: InlineState = { kind: 'idle' };

function collectionLabel(collections: readonly Collection[], view: AppView): string | null {
  if (view.kind === 'collection') return collections.find((collection) => collection.id === view.id)?.name ?? null;
  if (view.kind === 'archive' && view.scope.kind === 'collection') {
    const id = view.scope.id;
    return collections.find((collection) => collection.id === id)?.name ?? null;
  }
  return null;
}

function historySectionLabel(view: AppView, collections: readonly Collection[]): string {
  if (view.kind === 'archive') {
    if (view.scope.kind === 'all') return 'ARCHIVE';
    if (view.scope.kind === 'pinned') return 'ARCHIVE · PINNED';
    if (view.scope.kind === 'unsorted') return 'ARCHIVE · UNSORTED';
    const name = collectionLabel(collections, view);
    return name ? `ARCHIVE · ${name.toUpperCase()}` : 'ARCHIVE';
  }
  if (view.kind === 'pinned') return 'PINNED';
  if (view.kind === 'unsorted') return 'UNSORTED';
  const name = collectionLabel(collections, view);
  if (name) return `IN ${name.toUpperCase()}`;
  return 'RECENT';
}

function emptyCopy(view: AppView, collections: readonly Collection[], q: string, totalCount: number): string {
  if (q.trim()) return `No prompts match "${q.trim()}".`;
  if (view.kind === 'archive') {
    if (view.scope.kind === 'all') return 'Nothing archived yet.';
    if (view.scope.kind === 'pinned') return 'No archived batches were pinned.';
    if (view.scope.kind === 'unsorted') return 'No archived batches outside a collection.';
    const name = collectionLabel(collections, view);
    return name ? `No archived batches in ${name}.` : 'No archived batches in this collection.';
  }
  if (view.kind === 'pinned') return 'No pinned batches yet. Click the star on any generation to pin it.';
  if (view.kind === 'unsorted') {
    if (totalCount === 0) return 'Nothing here yet. Your generations will appear here.';
    return 'Everything is in a collection. Nice!';
  }
  const name = collectionLabel(collections, view);
  if (name) return `No generations in ${name} yet. Move batches here from the Move menu.`;
  return 'Nothing here yet. Your generations will appear here.';
}





function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || target.isContentEditable;
}

function isInlineCancelTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.dataset.cancelInline === 'true';
}

interface SidebarFeedRowProps {
  batch: Batch;
  isActive: boolean;
  readOnly: boolean;
  onSelect: (batchId: string) => void;
  onTogglePin: (batchId: string, pinned: boolean) => void;
}

// Memoized so an activeBatchId change (every selection / scroll-follow tick)
// re-renders only the two rows whose isActive flips — not the whole feed. The
// `onSelect`/`onTogglePin` callbacks are stabilized by the parent so the shallow
// prop compare holds.
const SidebarFeedRow = memo(function SidebarFeedRow({ batch, isActive, readOnly, onSelect, onTogglePin }: SidebarFeedRowProps) {
  const firstReady = batch.tiles.find((tile) => tile.status === 'done');
  const pinLabel = batch.pinned ? 'Unpin batch' : 'Pin batch';
  return (
    <div className={styles.itemShell}>
      {/* The open button comes first in the DOM so keyboard/AT reach the
          primary "Open batch" action before the secondary pin star. The star
          is absolutely positioned (.itemStar), so visual placement (top-right)
          is unchanged by the source order. */}
      <button
        type="button"
        className={`${styles.item} ${isActive ? styles.itemActive : ''}`}
        aria-label={`Open batch: ${batch.prompt.slice(0, 80)}`}
        disabled={readOnly}
        onClick={() => { onSelect(batch.id); }}
        onKeyDown={(event) => {
          if (isInteractiveTarget(event.target)) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onSelect(batch.id);
          }
        }}
      >
        <div className={`${styles.thumb} ${firstReady ? '' : styles.thumbEmpty}`}>
          {firstReady?.status === 'done' && (
            <img
              src={firstReady.thumbUrl ?? firstReady.url}
              alt=""
              width={32}
              height={32}
              loading="lazy"
              decoding="async"
              onError={(event) => {
                if (event.currentTarget.getAttribute('src') !== firstReady.url) event.currentTarget.src = firstReady.url;
              }}
            />
          )}
        </div>
        <div className={styles.text}>
          <div className={styles.prompt}>{batch.prompt}</div>
          <div className={styles.meta}>
            {batch.tiles.length}× · {batch.ratio} · {batch.modelLabel}
          </div>
        </div>
      </button>
      <button
        className={`${buttons.starBtn} ${styles.itemStar}`}
        type="button"
        aria-label={pinLabel}
        aria-pressed={batch.pinned}
        data-pinned={batch.pinned ? 'true' : 'false'}
        data-size="22"
        data-tip={pinLabel}
        data-tip-place="above-end"
        disabled={readOnly}
        onClick={(event) => {
          event.stopPropagation();
          onTogglePin(batch.id, !batch.pinned);
        }}
      >
        <I.star />
      </button>
    </div>
  );
});

function Sidebar({
  id,
  dataOpen = false,
  inertClosed = false,
  collapsed = false,
  onCollapse,
  history,
  models,
  activeBatchId,
  historyQ,
  archivedCount,
  promptsEnabled = false,
  theme = 'light',
  error = null,
  historyReadOnly = false,
  isFetchingNextPage = false,
  isFetchNextPageError = false,
  hasNextPage = false,
  onSelect,
  onSelectView,
  onClear,
  onToggleTheme,
  onRetry,
  onLoadMore,
  ref,
}: SidebarProps) {
  const batches = history.items;
  const feedRef = useRef<HTMLDivElement | null>(null);
  const virtualListRef = useRef<HTMLDivElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const getBatchKey = useCallback((index: number) => batches[index]?.id ?? index, [batches]);
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual is the shared virtualization primitive used by Canvas.
  const feedVirtualizer = useVirtualizer({
    count: batches.length,
    getScrollElement: () => feedRef.current,
    getItemKey: getBatchKey,
    estimateSize: () => SIDEBAR_ROW_HEIGHT,
    initialRect: { width: 248, height: 620 },
    overscan: 4,
    scrollMargin,
    // Same anchoring as the Canvas feed — the rail lists the same batches in
    // the same order, so the two must not disagree about whether the reader
    // moves. See lib/feedAnchor.
    ...FEED_VIRTUALIZER_ANCHORING,
  });
  const virtualRows = feedVirtualizer.getVirtualItems();
  const renderRows = virtualRows.length > 0
    ? virtualRows
    : fallbackVirtualRows(batches.length, SIDEBAR_FALLBACK_ROWS, () => SIDEBAR_ROW_HEIGHT, (index) => batches[index]?.id ?? index);
  const virtualHeight = virtualizedHeight(virtualRows.length > 0, feedVirtualizer.getTotalSize(), batches.length * SIDEBAR_ROW_HEIGHT);
  const backends = new Set(models.map((model) => model.backend)).size;
  const nextTheme: Theme = theme === 'dark' ? 'light' : 'dark';
  const themeTip = `Switch to ${nextTheme} theme`;
  const isPhone = useIsPhone();
  const q = useAtelierStore((state) => state.q);
  const setQ = useAtelierStore((state) => state.setQ);
  const view = useAtelierStore((state) => state.view);
  const setSidebarOpen = useAtelierStore((state) => state.setSidebarOpen);
  const addToast = useAtelierStore((state) => state.addToast);
  const collectionsQuery = useCollections();
  const createCollection = useCreateCollection();
  const renameCollection = useRenameCollection();
  const deleteCollection = useDeleteCollection();
  const togglePin = useTogglePin({ activeView: view, q: historyQ });
  // Stable callbacks so the memoized SidebarFeedRow's shallow compare holds.
  // mutate is referentially stable in TanStack v5; onSelect is a stable prop.
  const togglePinMutate = togglePin.mutate;
  const handleTogglePin = useCallback(
    (batchId: string, pinned: boolean) => { togglePinMutate({ batchId, pinned }); },
    [togglePinMutate],
  );
  const handleSelectBatch = useCallback((batchId: string) => { onSelect(batchId); }, [onSelect]);
  const collectionsData = collectionsQuery.data;
  const collections = useMemo(() => collectionsData?.items ?? [], [collectionsData?.items]);
  const summary = useMemo(() => collectionsData?.summary ?? {
    totalCount: 0,
    pinnedCount: 0,
    unsortedCount: 0,
    archivedTotalCount: 0,
    archivedPinnedCount: 0,
    archivedUnsortedCount: 0,
  }, [collectionsData?.summary]);
  const isArchive = view.kind === 'archive';
  // The recent-generations feed is a Canvas concept. Full-screen management
  // views (Archive, Prompt Library) suppress it but keep the Library rail
  // byte-identical to the normal view — only the contextually-irrelevant
  // feed list is dropped.
  const hideFeed = isArchive || view.kind === 'prompts';
  useLayoutEffect(() => {
    const scroller = feedRef.current;
    const list = virtualListRef.current;
    if (!scroller || !list) return;
    const measure = () => {
      setScrollMargin(list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    const leading = list.previousElementSibling;
    if (leading) observer.observe(leading);
    return () => { observer.disconnect(); };
  }, [batches.length, hasNextPage, isFetchingNextPage, isFetchNextPageError, historyReadOnly, hideFeed, error]);
  const [inlineState, setInlineState] = useState<InlineState>(IDLE);
  const [inlineContext, setInlineContext] = useState<InlineContext | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Collection | null>(null);
  const [liveAnnouncement, setLiveAnnouncement] = useState('');
  const reorderCollections = useReorderCollections({
    onAnnounce: setLiveAnnouncement,
    onErrorToast: (message) => { addToast(message, 'error'); },
  });
  const inputRef = useRef<HTMLInputElement | null>(null);
  const searchToggleRef = useRef<HTMLButtonElement | null>(null);
  const restoreFocusIndex = useRef(0);
  const lastCountMap = useRef<Map<string, number>>(new Map());
  const suppressBlurCommit = useRef(false);
  const collectionLiRefs = useRef<Map<string, HTMLLIElement | null>>(new Map());
  const inlineEdit = useInlineEdit<InlineKind>({
    commitOnBlur: true,
    onCommit: (kind, draft) => {
      const name = draft.trim();
      const context = inlineContext;
      setInlineContext(null);
      if (!name || context?.kind !== kind) {
        focusRow(restoreFocusIndex.current);
        return;
      }
      if (kind === 'creating') {
        createCollection.mutateAsync({ name })
          .then(() => {
            addToast('Collection created');
            focusRow(restoreFocusIndex.current);
          })
          .catch((mutationError: unknown) => {
            addToast(describeError(mutationError, "Couldn't save the collection."), 'error');
          });
        return;
      }
      if (context.kind === 'renaming') {
        if (name === context.name) {
          focusRow(restoreFocusIndex.current);
          return;
        }
        renameCollection.mutateAsync({ id: context.id, name })
          .then(() => {
            addToast('Collection renamed');
            focusRow(restoreFocusIndex.current);
          })
          .catch((mutationError: unknown) => {
            addToast(describeError(mutationError, "Couldn't save the collection."), 'error');
          });
      }
    },
    onCancel: () => {
      setInlineContext(null);
      focusRow(restoreFocusIndex.current);
    },
  });

  const rows = useMemo<readonly LibraryRow[]>(
    () => buildLibraryRows(collections, summary, isArchive),
    [collections, summary, isArchive],
  );

  const activeLibraryIndex = Math.max(0, rows.findIndex((row) => row.kind !== 'new' && appViewEquals(row.view, view)));
  const { rowRefs, onKeyDown: onLibraryKeyDown } = useRovingTabIndex<HTMLButtonElement>(rows.length, activeLibraryIndex);

  useEffect(() => {
    if (inlineEdit.isActive) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [inlineEdit.isActive]);

  // Build the announcement-entry list outside the effect so identity-change
  // of `rows` alone doesn't fire the diff scan. The effect's diff is keyed
  // off `countSignature` (a string of `id|count` pairs) so it only runs when
  // a count actually changes. Each entry stores label/id/count for the live
  // announcement; the prior-render Map is held in `lastCountMap` ref and
  // queried with O(1) `.get` instead of repeated `.find` scans.
  const announceEntries = useMemo(
    () => rows
      .filter((row): row is Exclude<LibraryRow, { kind: 'new' }> => row.kind !== 'new')
      .map((row) => ({
        id: row.kind === 'collection' ? `collection:${row.collection.id}` : row.kind,
        label: row.kind === 'collection' ? row.collection.name : row.label,
        count: row.count,
      })),
    [rows],
  );
  const countSignature = useMemo(
    () => announceEntries.map((entry) => `${entry.id}|${entry.count}`).join(','),
    [announceEntries],
  );

  useEffect(() => {
    const prior = lastCountMap.current;
    let changed: typeof announceEntries[number] | undefined;
    for (const entry of announceEntries) {
      const previous = prior.get(entry.id);
      if (previous !== undefined && previous !== entry.count) { changed = entry; break; }
    }
    if (!changed) {
      for (const entry of announceEntries) {
        if (!prior.has(entry.id) && entry.count > 0) { changed = entry; break; }
      }
    }
    const nextMap = new Map<string, number>();
    for (const entry of announceEntries) nextMap.set(entry.id, entry.count);
    lastCountMap.current = nextMap;
    if (!changed) return;
    const announced = changed;
    const handle = window.setTimeout(() => {
      setLiveAnnouncement(`${announced.label}, ${announced.count} ${announced.count === 1 ? 'batch' : 'batches'}`);
    }, 300);
    return () => { window.clearTimeout(handle); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countSignature]);

  function focusRow(index: number) {
    const target = rowRefs.current[index] ?? null;
    runWhenReachable(() => { target?.focus(); }, target);
  }

  const cancelSearch = () => {
    setInlineState(IDLE);
    if (isPhone && inlineState.kind === 'searching') {
      setQ('');
      setSearchOpen(false);
    }
  };

  const beginCreate = (index: number) => {
    restoreFocusIndex.current = index;
    setInlineContext({ kind: 'creating' });
    inlineEdit.begin('creating');
  };

  const beginRename = (collection: Collection, index: number) => {
    restoreFocusIndex.current = index;
    setInlineContext({ kind: 'renaming', id: collection.id, name: collection.name });
    inlineEdit.begin('renaming', collection.name);
  };

  const collectionIds = useMemo(() => collections.map((collection) => collection.id), [collections]);

  const onCollectionReorder = (next: string[], movedId: string) => {
    const moved = collections.find((collection) => collection.id === movedId);
    const position = next.indexOf(movedId) + 1;
    const total = next.length;
    // Per-mutation strings travel through vars so the hook-level onSuccess /
    // onError see them even on non-last mutations of a burst (mutate(vars,
    // perCallCallbacks) drops perCallCallbacks on every call except the latest).
    const announce = moved
      ? {
          success: `Moved ${moved.name} to position ${position} of ${total}`,
          revert: `Move of ${moved.name} reverted`,
        }
      : undefined;
    reorderCollections.mutate({ orderedIds: next, ...(announce ? { announce } : {}) });
  };

  const collectionReorder = useVerticalDragReorder({
    ids: collectionIds,
    onReorder: onCollectionReorder,
    getRowElement: (id) => collectionLiRefs.current.get(id) ?? null,
    thresholdPx: 4,
    dropIndicator: true,
    allowKeyboard: true,
    disabled: isArchive || inlineState.kind !== 'idle' || inlineEdit.isActive,
    onAnnounce: setLiveAnnouncement,
  });

  const dropIndicatorTop = collectionReorder.dropIndicatorTop;

  const renderNameInput = (labelId: string) => (
    <div className={styles.libInputWrap}>
      <label className="srOnly" htmlFor={labelId}>Collection name</label>
      <input
        ref={inputRef}
        id={labelId}
        className={styles.libNameInput}
        value={inlineEdit.inputProps.value}
        onChange={inlineEdit.inputProps.onChange}
        onFocus={(event) => { event.target.select(); }}
        onBlur={(event) => {
          if (suppressBlurCommit.current || isInlineCancelTarget(event.relatedTarget)) {
            suppressBlurCommit.current = false;
            inlineEdit.cancel();
            return;
          }
          inlineEdit.inputProps.onBlur(event);
        }}
        onKeyDown={inlineEdit.inputProps.onKeyDown}
      />
    </div>
  );

  const renderLibraryRow = (row: LibraryRow, index: number) => {
    const isActive = row.kind !== 'new' && appViewEquals(row.view, view);
    const rowClass = `${styles.libRow} ${isActive ? 'railActiveBar' : ''}`;
    const refForRow = (node: HTMLButtonElement | null) => {
      rowRefs.current[index] = node;
    };
    if (row.kind === 'new') {
      return (
        <li key="new" className={styles.libNewRow}>
          {inlineContext?.kind === 'creating'
            ? renderNameInput('collection-create-name')
            : (
              <button
                ref={refForRow}
                className={`${styles.libRow} ${styles.libNewButton}`}
                type="button"
                onClick={() => { beginCreate(index); }}
              >
                <span>{row.label}</span>
              </button>
              )}
        </li>
      );
    }
    if (row.kind === 'collection' && inlineContext?.kind === 'renaming' && inlineContext.id === row.collection.id) {
      return (
        <li key={row.collection.id} className={styles.libCollectionRow}>
          {renderNameInput(`collection-rename-${row.collection.id}`)}
        </li>
      );
    }
    const label = row.kind === 'collection' ? row.collection.name : row.label;
    const count = row.count;
    const isCollection = row.kind === 'collection';
    const isDraggingThis = isCollection && collectionReorder.isDragging && collectionReorder.suppressClick(row.collection.id);
    const button = (
      <button
        ref={refForRow}
        className={rowClass}
        type="button"
        data-active={isActive ? 'true' : 'false'}
        aria-current={isActive ? 'page' : undefined}
        aria-pressed={isActive}
        onClick={() => {
          if (isCollection && collectionReorder.suppressClick(row.collection.id)) return;
          onSelectView(row.view);
          if (isPhone) setInlineState(IDLE);
        }}
        onDoubleClick={() => {
          if (row.kind === 'collection') beginRename(row.collection, index);
        }}
        {...(isCollection ? {
          ...collectionReorder.pointerHandlers(row.collection.id),
          ...(collectionReorder.keyboardHandlers(row.collection.id) ?? {}),
        } : {})}
      >
        <span className={styles.libIcon} aria-hidden="true">
          {isCollection ? (
            <>
              <span className={styles.libGrip} aria-hidden="true"><I.grip /></span>
              <span className={styles.libFolder} aria-hidden="true"><I.folder /></span>
            </>
          ) : (
            <I.folder />
          )}
        </span>
        <span className={styles.libLabel}>{label}</span>
        <span className={styles.libCount}>{count}</span>
      </button>
    );
    if (!isCollection) return <li key={row.kind}>{button}</li>;
    return (
      <li
        key={row.collection.id}
        className={styles.libCollectionRow}
        data-dragging={isDraggingThis ? 'true' : 'false'}
        ref={(node) => {
          if (node) collectionLiRefs.current.set(row.collection.id, node);
          else collectionLiRefs.current.delete(row.collection.id);
        }}
      >
        {button}
        <button
          className={styles.libDelete}
          type="button"
          aria-label={`Delete collection ${row.collection.name}`}
          data-tip="Delete collection"
          data-tip-place="above-end"
          onPointerDown={(event) => { event.stopPropagation(); }}
          onClick={() => { setDeleteTarget(row.collection); }}
        >
          <I.close />
        </button>
      </li>
    );
  };

  const searchVisible = view.kind !== 'archive' && (isPhone || searchOpen || q.trim() !== '');
  const historyLabel = historySectionLabel(view, collections);

  return (
    <aside
      ref={ref}
      id={id}
      className={styles.sidebar}
      data-open={dataOpen ? 'true' : 'false'}
      data-collapsed={collapsed ? 'true' : undefined}
      aria-label="Sidebar"
      aria-hidden={inertClosed ? true : undefined}
      inert={inertClosed || undefined}
    >
      <header className={styles.header}>
        <img className={styles.mark} src={atelierMark} width={22} height={22} alt="" />
        <div className={styles.title}>Atelier</div>
        <div className={styles.version}>v1.0</div>
        {onCollapse && !isPhone && (
          <button
            className={styles.collapseBtn}
            type="button"
            aria-label="Collapse sidebar"
            onClick={onCollapse}
          >
            <I.chevronLeft />
          </button>
        )}
        {isPhone && (
          <button className={styles.closeBtn} type="button" aria-label="Close menu" onClick={() => { setSidebarOpen(false); }}>
            <I.close />
          </button>
        )}
      </header>

      <nav className={styles.library} aria-label="Library" onKeyDown={onLibraryKeyDown}>
          <div className={styles.section} data-zone="head">
            <span role="heading" aria-level={2}>LIBRARY</span>
            {isPhone && (inlineState.kind !== 'idle' || inlineEdit.isActive) ? (
              <button
                className={styles.cancelText}
                type="button"
                aria-label="Cancel"
                data-cancel-inline="true"
                onPointerDown={() => { suppressBlurCommit.current = true; }}
                onMouseDown={() => { suppressBlurCommit.current = true; }}
                onClick={() => {
                  suppressBlurCommit.current = true;
                  if (inlineEdit.isActive) inlineEdit.cancel();
                  else cancelSearch();
                }}
              >
                Cancel
              </button>
            ) : (
              !isPhone && (
                <button
                  ref={searchToggleRef}
                  className={buttons.iconAction}
                  type="button"
                  aria-label="Search prompts"
                  aria-pressed={searchOpen}
                  data-size="22"
                  data-tip="Search prompts"
                  data-tip-place="below"
                  onClick={() => {
                    setSearchOpen((open) => !open);
                    setInlineState({ kind: 'searching' });
                  }}
                >
                  <I.search />
                </button>
              )
            )}
          </div>
          {searchVisible && (
            <div className={styles.searchRow} data-zone="entry">
              <input
                type="search"
                autoComplete="off"
                enterKeyHint="search"
                spellCheck={false}
                className={styles.searchInput}
                aria-label="Search prompts"
                data-mobile={isPhone ? 'true' : 'false'}
                placeholder="Search prompts…"
                value={q}
                onFocus={() => { setInlineState({ kind: 'searching' }); }}
                onChange={(event) => { setQ(event.target.value); }}
                onBlur={() => {
                  if (!isPhone && q.trim() === '') {
                    setSearchOpen(false);
                    setInlineState(IDLE);
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    setQ('');
                    setSearchOpen(false);
                    setInlineState(IDLE);
                    // Restore focus to the toggle that opened search so the
                    // rail keyboard loop isn't dropped to <body>. Deferred so
                    // the toggle (re)mounts after this state flush first.
                    runWhenReachable(() => { searchToggleRef.current?.focus(); });
                  }
                }}
              />
            </div>
          )}
          <ul
            className={styles.libList}
            role="list"
            data-zone="body"
            data-drag-active={collectionReorder.isDragging ? 'true' : 'false'}
            data-reorderable={isArchive ? 'false' : 'true'}
          >
            {rows.map(renderLibraryRow)}
            {dropIndicatorTop !== null && (
              <li
                aria-hidden="true"
                className={styles.libDropIndicator}
                style={{ transform: `translateY(${dropIndicatorTop}px)` }}
              />
            )}
          </ul>
          {collections.length === 0 && (
            <div className={styles.libMicrocopy}>Group related batches into collections.</div>
          )}
          <div className="srOnly" aria-live="polite" aria-atomic="true">{liveAnnouncement}</div>
      </nav>

      {!hideFeed && (
        <div className={styles.section} data-zone="head">
          <span role="heading" aria-level={2}>{historyLabel}</span>
          {(view.kind === 'unsorted' || view.kind === 'collection') && batches.length > 0 && q.trim() === '' && (
            <button className={buttons.iconAction} data-size="22" type="button" aria-label="Archive all" data-tip="Archive all" data-tip-place="below" disabled={historyReadOnly} onClick={onClear}>
              <I.archive />
            </button>
          )}
        </div>
      )}

      {!hideFeed && (
      <div
        ref={feedRef}
        className={styles.list}
        data-testid="sidebar-feed"
        data-zone="body"
      >
        {error && batches.length === 0 ? (
          <div className={styles.empty}>
            <div>{error}</div>
            <button className={styles.retry} type="button" onClick={onRetry}>Retry</button>
          </div>
        ) : batches.length === 0 ? (
          <div className={styles.empty}>{emptyCopy(view, collections, q, summary.totalCount)}</div>
        ) : (
          <>
          <InfiniteStatus
            hasNextPage={hasNextPage}
            isFetchingNextPage={isFetchingNextPage}
            isFetchNextPageError={isFetchNextPageError}
            fetchNextPage={() => { onLoadMore?.(); }}
            itemCount={history.items.length}
            endLabel={`START · ${history.items.length} ${history.items.length === 1 ? 'BATCH' : 'BATCHES'}`}
            enabled={!historyReadOnly}
          />
          <div ref={virtualListRef} className={styles.virtualList} data-testid="sidebar-virtual-list" style={{ height: `${virtualHeight}px` }}>
            {renderRows.map((virtualRow) => {
              const batch = batches[virtualRow.index];
              if (!batch) return null;
              return (
                <div
                  key={virtualRow.key}
                  className={styles.virtualRow}
                  data-index={virtualRow.index}
                  ref={feedVirtualizer.measureElement}
                  style={{ transform: `translateY(${virtualRow.start - (virtualRows.length > 0 ? scrollMargin : 0)}px)` }}
                >
                  <SidebarFeedRow
                    batch={batch}
                    isActive={batch.id === activeBatchId}
                    readOnly={historyReadOnly}
                    onSelect={handleSelectBatch}
                    onTogglePin={handleTogglePin}
                  />
                </div>
              );
            })}
          </div>
          </>
        )}
      </div>
      )}

      {hideFeed && <div className={styles.spacer} data-testid="sidebar-spacer" aria-hidden="true" />}

      {promptsEnabled && (
        <button
          className={`${styles.archiveBtn} ${view.kind === 'prompts' ? styles.archiveActive : ''}`}
          type="button"
          aria-label="Prompt Library"
          aria-pressed={view.kind === 'prompts'}
          aria-current={view.kind === 'prompts' ? 'page' : undefined}
          onClick={() => { onSelectView(APP_VIEW_PROMPTS); }}
        >
          <span className={styles.archiveChip} aria-hidden="true"><I.library /></span>
          <span className={styles.archiveLabel}>Prompt Library</span>
        </button>
      )}

      <button
        className={`${styles.archiveBtn} ${view.kind === 'archive' ? styles.archiveActive : ''}`}
        type="button"
        aria-label="Archive"
        aria-pressed={view.kind === 'archive'}
        aria-current={view.kind === 'archive' ? 'page' : undefined}
        onClick={() => { onSelectView(APP_VIEW_ARCHIVE); }}
      >
        <span className={styles.archiveChip} aria-hidden="true"><I.archive /></span>
        <span className={styles.archiveLabel}>Archive</span>
        {archivedCount > 0 && <span className={styles.archiveCount}>{archivedCount}</span>}
      </button>

      <footer className={styles.footer} data-zone="foot">
        <span className={styles.dot} />
        <span className={styles.footerLabel}>
          {models.length} models · {backends} backends
        </span>
        <button
          className={styles.settingsBtn}
          type="button"
          aria-label="API keys"
          data-tip="API keys"
          data-tip-place="above-end"
          onClick={() => { useAtelierStore.getState().openByok(); }}
        >
          <I.settings />
        </button>
        {onToggleTheme && (
          <button
            className={styles.themeBtn}
            type="button"
            aria-label={themeTip}
            aria-pressed={theme === 'dark'}
            data-tip={`${nextTheme === 'light' ? 'Light' : 'Dark'} theme`}
            data-tip-place="above-end"
            onClick={onToggleTheme}
          >
            {theme === 'dark' ? <I.sun /> : <I.moon />}
          </button>
        )}
      </footer>

      {deleteTarget && (
        <ConfirmDialog
          open
          title="Delete collection?"
          body="Batches will return to Unsorted."
          confirmLabel="Delete collection"
          cancelLabel="Cancel"
          danger
          closeOnBackdrop={false}
          onConfirm={() => {
            const target = deleteTarget;
            setDeleteTarget(null);
            deleteCollection.mutate({ id: target.id });
          }}
          onCancel={() => { setDeleteTarget(null); }}
        />
      )}
    </aside>
  );
}

// memo: App re-renders on every SSE partial/terminal frame (history cache
// writes). App-passed props are referentially stable
// (history/models useMemo'd, handlers useCallback'd) so memo prevents the
// full history rail from reconciling on each streaming preview frame.
export default memo(Sidebar);

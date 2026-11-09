import type { Batch, Collection, DoneTile, Model, Tile } from '@atelier/shared';
import { isVideoMime } from '@atelier/shared';
import { memo, useCallback, useDeferredValue, useEffect, useRef, useState, ViewTransition } from 'react';
import { refImageUrl } from '../../api/uploads';
import { sequenceMasterUrl } from '../../api/sequences';
import { findI2VModel } from '../../lib/i2v';
import { queueLabel } from '../../lib/queueLabel';
import { runWhenReachable } from '../../lib/focus';
import { announceBatchSettled } from '../../lib/queueLiveAnnouncer';
import { getRatioDefinition } from '../../lib/ratios';
import { useTogglePin } from '../../hooks/useTogglePin';
import { useIsPhone } from '../../hooks/useIsPhone';
import type { AppView } from '../../store/atelier';
import { I } from '../icons/I';
import { Meta } from '../Meta';
import BatchOverflowMenu, { buildBatchOverflowGroups, type BatchOverflowAction } from '../BatchOverflowMenu';
import BatchPrompt from './BatchPrompt';
import MovePopover from '../MovePopover';
import FailedTile from '../tile/FailedTile';
import ImageTile from '../tile/ImageTile';
import TilePlaceholder from '../tile/TilePlaceholder';
import { RelativeTime } from './RelativeTime';
import { canExtendVideoTile, isSequenceTail, sequenceChipLabel, storyChipLabel } from '../../lib/videoSequences';
import { useExtendFromTile } from '../../hooks/useExtendFromTile';
import buttons from '../../styles/buttons.module.css';
import { batchSuccessor, focusSuccessor } from '../../lib/focusSuccessor';
import { createPortal } from 'react-dom';
import styles from './index.module.css';

export type BatchAction =
  | 'copy' | 'reroll' | 'delete' | 'saveTemplate' | 'reopen'
  | 'playMaster' | 'downloadMaster' | 'discardSequenceTail' | 'cancelStory';
export type TileAction = 'download' | 'delete' | 'retry' | 'dismiss';
/** Hands a finished tile to another surface (composer, story, card). Resolves false when nothing happened. */
export type TileHandoff = (batch: Batch, tile: DoneTile) => Promise<boolean>;

interface BatchViewProps {
  batch: Batch;
  modelById: ReadonlyMap<string, Model>;
  // Threaded from App via Canvas. Previously read directly from the Zustand
  // store inside BatchView, which re-rendered every visible batch on any view
  // change (e.g. sidebar nav). Pass-down keeps BatchView's memoized row effective for
  // unrelated store churn.
  activeView: AppView;
  // Resolved by Canvas from App's single collections query and threaded down.
  // Previously BatchView called useCollections() itself, so every visible batch
  // held its own subscriber and re-rendered on any collection mutation. As a
  // resolved value it is undefined for unsorted batches (the common case), so
  // BatchView's memoized row holds across collection mutations that don't touch it.
  currentCollection?: Collection | undefined;
  isAboveFold?: boolean;
  isFirstBatch?: boolean;
  seen?: boolean;
  onBatchAction: (action: BatchAction, batch: Batch) => void;
  promptsEnabled: boolean;
  readOnlyActions?: boolean;
  onTileAction: (action: TileAction, batch: Batch, tile: Tile) => void;
  onOpenTile: (batch: Batch, tile: DoneTile) => void;
  // Adds a generated image to the composer as a reference for its source model.
  onEditTile?: TileHandoff | undefined;
  // Hands a still tile off to the composer as an I2V source. Optional: undefined
  // when no image-to-video model is available, which also hides the action.
  onAnimateTile?: TileHandoff | undefined;
  onTellStoryTile?: TileHandoff | undefined;
  // Creates an Ephemera character card from a done image. Undefined when the
  // integration is off for this user, which also hides the action.
  onCreateCardTile?: TileHandoff | undefined;
  // Tiles with a card in flight (store-owned, passed down from App).
  cardPendingTileIds?: ReadonlySet<string> | undefined;
  // Debounced search term, passed down from App (NOT read from store here).
  // Subscribing to live store.q would re-render every BatchView on every
  // keystroke (defeating the memo) and would scope useTogglePin's optimistic
  // write to a key the visible list isn't reading during the debounce window.
  q: string;
}

interface TileRowProps {
  tile: Tile;
  batch: Batch;
  index: number;
  isAboveFold: boolean;
  ratio: string;
  aspectRatio: string;
  modelName: string;
  seen: boolean;
  readOnlyActions: boolean;
  i2vAvailable: boolean;
  batchSupportsReferenceImages: boolean;
  // The batch's OWN model is image→video — drives the video-aware loading
  // state (m:ss + ETA). Distinct from i2vAvailable (whether ANY i2v model
  // exists, which gates the Animate action on image tiles).
  batchIsVideo: boolean;
  extendingTileId: string | null;
  inlineVideoSrc?: string | undefined;
  onExtendTile: TileHandoff;
  onTileAction: (action: TileAction, batch: Batch, tile: Tile) => void;
  onOpenTile: (batch: Batch, tile: DoneTile) => void;
  onEditTile?: TileHandoff | undefined;
  onAnimateTile?: TileHandoff | undefined;
  onTellStoryTile?: TileHandoff | undefined;
  onCreateCardTile?: TileHandoff | undefined;
  creatingCard: boolean;
}

// Per-tile wrapper that produces the per-tile click closures internally.
// `batch` ref churns on every SSE event for the owning batch and we MUST
// forward it so every action targets the current batch; the memo win is that
// unchanged batches keep their ref (structural sharing) and the parent
// handlers (`onTileAction`/`onOpenTile`) are useCallback-stable in App.
function TileRowImpl({
  tile,
  batch,
  index,
  isAboveFold,
  ratio,
  aspectRatio,
  modelName,
  seen,
  readOnlyActions,
  i2vAvailable,
  batchSupportsReferenceImages,
  batchIsVideo,
  extendingTileId,
  inlineVideoSrc,
  onExtendTile,
  onTileAction,
  onOpenTile,
  onEditTile,
  onAnimateTile,
  onTellStoryTile,
  onCreateCardTile,
  creatingCard,
}: TileRowProps) {
  // A tile whose terminal body replaces its loading plate in place has
  // already entered: the ImageTile or FailedTile shell mounts without the
  // entrance that would otherwise make it flash and rise a second time.
  const [enteredLoading] = useState(tile.status === 'loading');
  const entered = enteredLoading && tile.status !== 'loading';
  if (tile.status === 'loading') {
    return (
      <TilePlaceholder
        tileId={tile.id}
        batchId={batch.id}
        batchStatus={batch.status}
        aspectRatio={aspectRatio}
        modelName={modelName}
        startedAt={batch.startedAt ?? batch.createdAt}
        queueLengthAhead={batch.queueLengthAhead}
        seen={seen}
        isVideo={batchIsVideo}
        sourceStillUrl={batchIsVideo && batch.i2vSourceUploadId ? refImageUrl(batch.i2vSourceUploadId) : undefined}
      />
    );
  }
  if (tile.status === 'failed') {
    return (
      <FailedTile
        tile={tile}
        aspectRatio={aspectRatio}
        seen={seen}
        entered={entered}
        disabled={readOnlyActions}
        onRetry={() => { onTileAction('retry', batch, tile); }}
        onDismiss={() => { onTileAction('dismiss', batch, tile); }}
      />
    );
  }
  return (
    // The pure gate is shared with Lightbox/menu so standalone/tail semantics
    // cannot drift between the three action surfaces.
    <ImageTile
      tile={tile}
      index={index}
      isAboveFold={isAboveFold}
      ratio={ratio}
      aspectRatio={aspectRatio}
      seen={seen}
      entered={entered}
      disabled={readOnlyActions}
      promptPreview={batch.prompt}
      videoSrc={inlineVideoSrc}
      canEdit={batchSupportsReferenceImages && onEditTile !== undefined && !isVideoMime(tile.mime)}
      canAnimate={i2vAvailable && onAnimateTile !== undefined && !isVideoMime(tile.mime)}
      canTellStory={onTellStoryTile !== undefined && (
        (!isVideoMime(tile.mime) && i2vAvailable)
        || canExtendVideoTile(batch, tile, i2vAvailable)
      )}
      canExtend={canExtendVideoTile(batch, tile, i2vAvailable)}
      extending={extendingTileId === tile.id}
      canCreateCard={onCreateCardTile !== undefined && !isVideoMime(tile.mime)}
      creatingCard={creatingCard}
      onOpen={() => { onOpenTile(batch, tile); }}
      onDownload={() => { onTileAction('download', batch, tile); }}
      onDelete={() => { onTileAction('delete', batch, tile); }}
      onEdit={onEditTile ? () => onEditTile(batch, tile) : undefined}
      onAnimate={onAnimateTile ? () => onAnimateTile(batch, tile) : undefined}
      onTellStory={onTellStoryTile ? () => onTellStoryTile(batch, tile) : undefined}
      onExtend={() => onExtendTile(batch, tile)}
      onCreateCard={onCreateCardTile ? () => onCreateCardTile(batch, tile) : undefined}
    />
  );
}

// Default (shallow) memo on purpose. A row renders from, and hands its action
// callbacks, the WHOLE batch — prompt, sequence/sequenceIndex, source upload,
// status, tiles — and App's handlers read any of it, so a field-picking
// comparator silently serves stale gates (Extend on a no-longer-tail clip) and
// stale handoffs (an old prompt) whenever a field it forgot changes while
// `tiles` keeps its ref. TanStack's structural sharing keeps every unchanged
// batch's ref, so unrelated-batch SSE events still skip every row here.
const TileRow = memo(TileRowImpl);

function BatchView({ batch: liveBatch, modelById, activeView, currentCollection, isAboveFold = false, isFirstBatch = false, seen = false, onBatchAction, promptsEnabled, readOnlyActions = false, onTileAction, onOpenTile, onEditTile, onAnimateTile, onTellStoryTile, onCreateCardTile, cardPendingTileIds, q }: BatchViewProps) {
  // One render snapshot for the whole batch: header, tiles and every handler
  // read it, so they never disagree, and a tile removal or insertion commits
  // in a Transition, which is what lets the tile boundaries below animate.
  const batch = useDeferredValue(liveBatch);
  const [moveOpen, setMoveOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreBtnRef = useRef<HTMLButtonElement | null>(null);
  const moveBtnRef = useRef<HTMLButtonElement | null>(null);
  const moreFocusRef = useRef<HTMLElement | null>(null);
  const pinFocusHandoffRef = useRef(false);
  const bindMoreButton = useCallback((element: HTMLButtonElement | null) => {
    moreBtnRef.current = element;
    if (!element) return;
    return () => {
      moreBtnRef.current = null;
      const owner = moreFocusRef.current;
      const active = document.activeElement;
      if (!owner || (active !== owner && active !== document.body && active !== null)) return;
      // Selection closes the menu before its optimistic patch removes More.
      // Ref cleanup sees that later removal as well as availability changes.
      const target = moveBtnRef.current;
      runWhenReachable(() => {
        const current = document.activeElement;
        if (owner.isConnected || (current !== document.body && current?.isConnected)) return;
        if (target && !target.disabled) target.focus({ preventScroll: true });
      }, target);
    };
  }, []);
  // MovePopover anchors (and returns focus) to whichever trigger opened it —
  // the collection token in the meta row or the persistent Move icon.
  const moveAnchorRef = useRef<HTMLButtonElement | null>(null);
  const isPhone = useIsPhone();
  const togglePin = useTogglePin({ activeView, q });
  const { pendingTileId: extendingTileId, extendFromTile } = useExtendFromTile();
  const ratio = getRatioDefinition(batch.ratio);
  const aspectRatio = `${ratio.w} / ${ratio.h}`;
  const batchModel = modelById.get(batch.modelId);
  const modelName = batchModel?.name ?? batch.modelLabel;
  const headingPrompt = batch.prompt.length > 80 ? `${batch.prompt.slice(0, 77)}…` : batch.prompt;
  // Any registered image→video model makes the Animate action eligible (it is
  // hidden on tiles that are already video). Derived from the same model map
  // the header reads, so it costs nothing extra and stays memo-stable.
  const i2vModel = findI2VModel(modelById.values());
  const i2vAvailable = i2vModel !== undefined;
  const hasMoreItems = buildBatchOverflowGroups({ batch, promptsEnabled, readOnlyActions, i2vAvailable, isPhone }).length > 0;
  // Losing the last canonical item dismisses the existing menu through its
  // ordinary exit lifecycle, and cannot leave a latent open state behind.
  if (moreOpen && !hasMoreItems) setMoreOpen(false);
  const batchIsVideo = modelById.get(batch.modelId)?.outputsVideo === true;
  const sequenceLabel = sequenceChipLabel(batch);
  const storyLabel = storyChipLabel(batch);
  const masterReadyOnTail = isSequenceTail(batch) && batch.sequence?.masterStatus === 'ready';
  const inlineVideoSrc = masterReadyOnTail && batch.sequence
    ? sequenceMasterUrl(batch.sequence.id)
    : undefined;
  const handleExtendTile = (sourceBatch: Batch, tile: DoneTile) => (
    i2vModel
      ? extendFromTile(sourceBatch, tile, i2vModel, { focusMotion: true })
      : Promise.resolve(false)
  );
  // One aggregated batch-level status for screen readers — the tile layers are
  // decorative (aria-hidden), so without this a non-sighted user gets no signal
  // that generation started, progressed, or finished. aria-live only announces
  // CHANGES after mount, so already-settled historical / virtualized batches
  // stay silent; only an actively-resolving batch is announced.
  const total = batch.tiles.length;
  let done = 0;
  let failed = 0;
  let loading = 0;
  for (const tile of batch.tiles) {
    if (tile.status === 'done') done += 1;
    else if (tile.status === 'failed') failed += 1;
    else loading += 1;
  }
  const noun = total === 1 ? 'image' : 'images';
  // This row's region speaks progress only; completion goes to the page-level
  // announcer (lib/queueLiveAnnouncer), which de-duplicates it per batch with
  // the generation stream and still speaks when this row is not mounted.
  const liveStatus = loading > 0
    ? `Generating ${total} ${noun}: ${done} of ${total} ready${failed > 0 ? `, ${failed} failed` : ''}`
    : '';
  const hasLoading = loading > 0;
  // Only batches that are (or were) generating during THIS mount get a live
  // region. A settled historical/virtualized batch mounting with no loading
  // tiles stays silent; an active batch flips this sticky flag on (so the
  // completion announcement survives loading→0). Guarded setState-in-render is
  // React's sanctioned "store info from prior renders" pattern — progress and
  // completion changes still announce as the live region's content updates.
  const [everActive, setEverActive] = useState(false);
  if (hasLoading && !everActive) setEverActive(true);
  const settledHere = everActive && !hasLoading;
  useEffect(() => {
    if (settledHere) announceBatchSettled(batch.id, done, failed);
  }, [settledHere, batch.id, done, failed]);
  const moveLabel = `${currentCollection?.name ?? 'collection'}, move to collection`;
  const openMove = (anchor: HTMLButtonElement | null) => {
    moveAnchorRef.current = anchor ?? moveBtnRef.current;
    // Touch activation can leave focus on the page. Give both canonical
    // overlay owners the actual invoker before they capture restore focus.
    moveAnchorRef.current?.focus();
    setMoreOpen(false);
    setMoveOpen(true);
  };
  const onOverflowSelect = (action: BatchOverflowAction) => {
    if (action === 'move') { openMove(moveBtnRef.current); return; }
    if (action === 'pin') {
      // The canonical chrome's deferred restore was queued when the menu
      // closed. A focus move made before it runs must keep its destination.
      pinFocusHandoffRef.current = true;
      runWhenReachable(() => { pinFocusHandoffRef.current = false; });
      togglePin.mutate({ batchId: batch.id, pinned: true });
      setMoreOpen(false);
      return;
    }
    if (action === 'extendSequence') {
      const tailVideo = batch.tiles.find((tile): tile is DoneTile =>
        canExtendVideoTile(batch, tile, i2vModel !== undefined));
      setMoreOpen(false);
      if (tailVideo) void handleExtendTile(batch, tailVideo);
      return;
    }
    onBatchAction(action, batch);
    setMoreOpen(false);
  };

  return (
    <section className={styles.batch} data-batch-id={batch.id} data-first={isFirstBatch ? 'true' : undefined} data-seen={seen ? 'true' : undefined} data-entering={seen ? undefined : 'true'}>
      <h2 className="srOnly">{headingPrompt}, {modelName}</h2>
      <header className={styles.header} onFocusCapture={(event) => {
        const target = event.target;
        // Portalled menu focus bubbles through its owning header in React.
        moreFocusRef.current = target === moreBtnRef.current
          || target.closest('[role="menu"][aria-label="Batch actions"]') ? target : null;
      }} onBlurCapture={(event) => {
        const next = event.relatedTarget;
        if (next instanceof HTMLElement && (next === moreBtnRef.current
          || next.closest('[role="menu"][aria-label="Batch actions"]'))) return;
        moreFocusRef.current = null;
      }}>
        <BatchPrompt prompt={batch.prompt} />
        <div className={styles.headerControls}>
        <Meta lead className={styles.meta} items={[
          <span key="model" className={styles.modelName}>{modelName}</span>,
          batch.ratio,
          sequenceLabel ? <span key="sequence" className={styles.sequenceChip}>{sequenceLabel}</span> : null,
          storyLabel ? <span key="story" className={styles.sequenceChip}>{storyLabel}</span> : null,
          // Header slots that come and go are part boundaries fed by the
          // batch snapshot above, so they drop in and lift out.
          batch.status === 'queued' ? (
            <ViewTransition key="queue" default="none" enter="part-enter" exit="part-exit">
              <span className={styles.queueBadge}>{queueLabel(batch.queueLengthAhead)}</span>
            </ViewTransition>
          ) : null,
          <span key="time" className={styles.metaTime}><RelativeTime timestamp={batch.createdAt} /></span>,
          batch.collectionId !== null && currentCollection ? (
            <button
              key="collection"
              className={styles.metaCol}
              type="button"
              aria-label={moveLabel}
              aria-haspopup="dialog"
              aria-expanded={moveOpen}
              disabled={readOnlyActions}
              onClick={(event) => { openMove(event.currentTarget); }}
            >
              <I.folder /> <span className={styles.metaColName}>{currentCollection.name}</span>
            </button>
          ) : null,
          batch.provenance ? (
            // tabIndex makes the seed keyboard-reachable: the data-tip
            // primitive reveals on :focus-visible and the aria-label carries
            // the same detail for screen readers (it surfaces nowhere else).
            <span
              key="provenance"
              className={styles.metaProvenance}
              tabIndex={0}
              aria-label={`Rolled from ${batch.provenance.templateName ?? 'template'}, seed ${String(batch.provenance.rollSeed)}`}
              data-tip={`Seed ${String(batch.provenance.rollSeed)}`}
            >
              <I.sparkle /> <span className={styles.metaColName}>{batch.provenance.templateName ?? 'Template'}</span>
            </span>
          ) : null,
        ]} />
        <div className={styles.actions}>
          {batch.pinned ? (
            <ViewTransition default="none" enter="part-enter" exit="part-exit">
            <button
              className={buttons.starBtn}
              type="button"
              aria-label="Unpin batch"
              aria-pressed={true}
              disabled={readOnlyActions}
              data-pinned="true"
              data-size="28"
              data-tip="Unpin batch"
              onClick={(event) => {
                event.stopPropagation();
                // The star leaves with the pin; Move keeps the keyboard in the header.
                // In the Pinned view the whole row leaves, so the next row takes it.
                focusSuccessor(activeView.kind === 'pinned' ? batchSuccessor(event.currentTarget) : moveBtnRef.current);
                togglePin.mutate({ batchId: batch.id, pinned: false });
              }}
            >
              <I.star />
            </button>
            </ViewTransition>
          ) : null}
          {masterReadyOnTail ? (
            <ViewTransition default="none" enter="part-enter" exit="part-exit">
            <button
              className={buttons.iconAction}
              data-size="28"
              type="button"
              aria-label="Play master"
              data-tip="Play master"
              onClick={() => { onBatchAction('playMaster', batch); }}
            >
              <I.play />
            </button>
            </ViewTransition>
          ) : null}
          {!isPhone && (
            <button className={buttons.iconAction} data-size="28" type="button" aria-label="Copy prompt" data-tip="Copy prompt" onClick={() => { onBatchAction('copy', batch); }}>
              <I.copy />
            </button>
          )}
          <button className={buttons.iconAction} data-size="28" type="button" aria-label="Re-roll" data-tip="Re-roll" disabled={readOnlyActions} onClick={() => { onBatchAction('reroll', batch); }}>
            <I.reroll />
          </button>
          <button
            ref={moveBtnRef}
            className={buttons.iconAction}
            data-size="28"
            data-in-collection={batch.collectionId !== null ? 'true' : undefined}
            type="button"
            aria-label="Move to collection"
            data-tip="Move to collection"
            aria-haspopup="dialog"
            aria-expanded={moveOpen}
            disabled={readOnlyActions}
            onClick={(event) => { openMove(event.currentTarget); }}
          >
            <I.folderPlus />
          </button>
          <button className={buttons.iconAction} data-size="28" type="button" aria-label="Archive batch" data-tip="Archive batch" disabled={readOnlyActions} onClick={(event) => { focusSuccessor(batchSuccessor(event.currentTarget)); onBatchAction('delete', batch); }}>
            <I.archive />
          </button>
          {hasMoreItems && <button
            ref={bindMoreButton}
            className={buttons.iconAction}
            data-size="28"
            type="button"
            aria-label="More actions"
            data-tip="More"
            data-tip-place="above-end"
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            onBlur={(event) => {
              const next = event.relatedTarget;
              if (!pinFocusHandoffRef.current || !(next instanceof HTMLElement) || !next.isConnected) return;
              runWhenReachable(() => {
                if (document.activeElement === moreBtnRef.current) next.focus();
              }, next);
            }}
            onClick={(event) => {
              event.currentTarget.focus({ preventScroll: true });
              setMoreOpen((value) => !value);
            }}
          >
            <I.more />
          </button>}
        </div>
        </div>
        {moreOpen && (
          <BatchOverflowMenu
            batch={batch}
            anchorRef={moreBtnRef}
            open={hasMoreItems}
            promptsEnabled={promptsEnabled}
            readOnlyActions={readOnlyActions}
            i2vAvailable={i2vAvailable}
            onSelect={onOverflowSelect}
            onClose={() => { setMoreOpen(false); }}
          />
        )}
        {moveOpen && !readOnlyActions && (
          <MovePopover
            batch={batch}
            anchorRef={moveAnchorRef}
            returnFocusFallbackRef={moveBtnRef}
            open
            view={activeView}
            q={q}
            onClose={() => { setMoveOpen(false); }}
          />
        )}
      </header>
      <div
        className={styles.grid}
        data-testid="batch-grid"
        data-tile-count={batch.tiles.length}
        style={{
          '--tile-ratio-num': ratio.w / ratio.h,
        } as React.CSSProperties}
      >
        {batch.tiles.map((tile, index) => (
          // One capture per tile (motion.css .tile-*): survivors interpolate
          // to their reflowed slot, a removed tile shrinks out, and in a batch
          // already seen an Undo-restored tile fades in (an unseen batch plays
          // its CSS entrance instead). Unnamed on purpose: a feed tile never
          // changes parent, and Unsorted and Pinned can both show it, so a
          // name would pair it across a view swap instead of letting it travel
          // with the stage.
          <ViewTransition
            key={tile.id}
            default="tile-move"
            exit="tile-exit"
            enter={seen ? 'tile-enter' : 'none'}
          >
          <TileRow
            tile={tile}
            batch={batch}
            index={index}
            isAboveFold={isAboveFold && index === 0}
            ratio={batch.ratio}
            aspectRatio={aspectRatio}
            modelName={modelName}
            seen={seen}
            readOnlyActions={readOnlyActions}
            i2vAvailable={i2vAvailable}
            batchSupportsReferenceImages={batchModel?.supportsReferenceImages === true}
            batchIsVideo={batchIsVideo}
            extendingTileId={extendingTileId}
            inlineVideoSrc={inlineVideoSrc}
            onExtendTile={handleExtendTile}
            onTileAction={onTileAction}
            onOpenTile={onOpenTile}
            onEditTile={onEditTile}
            onAnimateTile={onAnimateTile}
            onTellStoryTile={onTellStoryTile}
            onCreateCardTile={onCreateCardTile}
            creatingCard={cardPendingTileIds?.has(tile.id) === true}
          />
          </ViewTransition>
        ))}
      </div>
      {/* The row's progress announcement lives outside the row's view-transition
          boundary: a text change inside it would activate the row's update on
          every tile completion and hold the whole row non-hit-testable. */}
      {createPortal(<div className="srOnly" role="status" aria-live="polite">{everActive ? liveStatus : ''}</div>, document.body)}
    </section>
  );
}

// The keystone of the SSE render-path fix. `updateBatchTile` rebuilds only
// the one batch object whose tile changed, so every OTHER batch keeps a
// stable `batch` ref. With `models`/handler props stabilized in App, Canvas's
// memoized row (whose compiled body caches this element) means a tile event
// re-renders just the owning batch, not the whole infinite-scrolled history
// grid. Inside the owning batch every `TileRow` re-renders against
// the new batch; keyed rows keep their DOM.
export default BatchView;

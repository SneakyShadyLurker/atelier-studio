import type { Batch, Collection, DoneTile, Model, Tile } from '@atelier/shared';
import { isVideoMime } from '@atelier/shared';
import { memo, useEffect, useRef, useState } from 'react';
import { refImageUrl } from '../../api/uploads';
import { sequenceMasterUrl } from '../../api/sequences';
import { findI2VModel } from '../../lib/i2v';
import { queueLabel } from '../../lib/queueLabel';
import { announceBatchSettled } from '../../lib/queueLiveAnnouncer';
import { getRatioDefinition } from '../../lib/ratios';
import { useTogglePin } from '../../hooks/useTogglePin';
import type { AppView } from '../../store/atelier';
import { I } from '../icons/I';
import BatchOverflowMenu, { type BatchOverflowAction } from '../BatchOverflowMenu';
import BatchPrompt from './BatchPrompt';
import MovePopover from '../MovePopover';
import FailedTile from '../tile/FailedTile';
import ImageTile from '../tile/ImageTile';
import TilePlaceholder from '../tile/TilePlaceholder';
import { RelativeTime } from './RelativeTime';
import { canExtendVideoTile, isSequenceTail, sequenceChipLabel, storyChipLabel } from '../../lib/videoSequences';
import { useExtendFromTile } from '../../hooks/useExtendFromTile';
import buttons from '../../styles/buttons.module.css';
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

function BatchView({ batch, modelById, activeView, currentCollection, isAboveFold = false, isFirstBatch = false, seen = false, onBatchAction, promptsEnabled, readOnlyActions = false, onTileAction, onOpenTile, onEditTile, onAnimateTile, onTellStoryTile, onCreateCardTile, cardPendingTileIds, q }: BatchViewProps) {
  const [moveOpen, setMoveOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreBtnRef = useRef<HTMLButtonElement | null>(null);
  // MovePopover anchors (and returns focus) to whichever trigger opened it —
  // the collection chip in the meta row or the More button's overflow action.
  const moveAnchorRef = useRef<HTMLButtonElement | null>(null);
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
  const moveLabel = `Move to ${currentCollection?.name ?? 'collection'}`;
  const openMove = (anchor: HTMLButtonElement | null) => {
    moveAnchorRef.current = anchor ?? moreBtnRef.current;
    setMoreOpen(false);
    setMoveOpen(true);
  };
  const onOverflowSelect = (action: BatchOverflowAction) => {
    if (action === 'move') { openMove(moreBtnRef.current); return; }
    if (action === 'pin') {
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
    <section className={styles.batch} data-batch-id={batch.id} data-first={isFirstBatch ? 'true' : undefined} data-seen={seen ? 'true' : undefined}>
      <h2 className="srOnly">{headingPrompt} · {modelName}</h2>
      <header className={styles.header}>
        <BatchPrompt prompt={batch.prompt} />
        <div className={styles.meta}>
          <span className={styles.modelName}>{modelName}</span>
          <span>{batch.ratio}</span>
          {sequenceLabel ? <span className={styles.sequenceChip}>{sequenceLabel}</span> : null}
          {storyLabel ? <span className={styles.sequenceChip}>{storyLabel}</span> : null}
          {batch.status === 'queued' ? (
            <span className={styles.queueBadge}>{queueLabel(batch.queueLengthAhead)}</span>
          ) : null}
          <span className={styles.metaTime}><RelativeTime timestamp={batch.createdAt} /></span>
          {batch.collectionId !== null && currentCollection ? (
            <button
              className={styles.metaCol}
              type="button"
              aria-label={moveLabel}
              aria-haspopup="dialog"
              aria-expanded={moveOpen}
              disabled={readOnlyActions}
              onClick={(event) => { openMove(event.currentTarget); }}
            >
              <I.folder /> <span className={styles.metaColName}>{currentCollection.name.toUpperCase()}</span>
            </button>
          ) : null}
          {batch.provenance ? (
            // tabIndex makes the seed keyboard-reachable: the data-tip
            // primitive reveals on :focus-visible and the aria-label carries
            // the same detail for screen readers (it surfaces nowhere else).
            <span
              className={styles.metaProvenance}
              tabIndex={0}
              aria-label={`Rolled from ${batch.provenance.templateName ?? 'template'}, seed ${String(batch.provenance.rollSeed)}`}
              data-tip={`Seed ${String(batch.provenance.rollSeed)}`}
            >
              <I.sparkle /> {batch.provenance.templateName ?? 'Template'}
            </span>
          ) : null}
        </div>
        <div className={styles.actions}>
          {batch.pinned ? (
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
                togglePin.mutate({ batchId: batch.id, pinned: false });
              }}
            >
              <I.star />
            </button>
          ) : null}
          {masterReadyOnTail ? (
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
          ) : null}
          <button className={buttons.iconAction} data-size="28" type="button" aria-label="Archive batch" data-tip="Archive batch" disabled={readOnlyActions} onClick={() => { onBatchAction('delete', batch); }}>
            <I.archive />
          </button>
          <button
            ref={moreBtnRef}
            className={buttons.iconAction}
            data-size="28"
            type="button"
            aria-label="More actions"
            data-tip="More"
            data-tip-place="above-end"
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            onClick={() => { setMoreOpen((value) => !value); }}
          >
            <I.more />
          </button>
        </div>
        {moreOpen && (
          <BatchOverflowMenu
            batch={batch}
            anchorRef={moreBtnRef}
            open
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
            returnFocusFallbackRef={moreBtnRef}
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
          <TileRow
            key={tile.id}
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
        ))}
      </div>
      <div className="srOnly" role="status" aria-live="polite">{everActive ? liveStatus : ''}</div>
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

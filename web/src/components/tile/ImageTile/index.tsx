import { isVideoMime, type DoneTile } from '@atelier/shared';
import { useRef, useState, type ReactNode, type Ref } from 'react';
import { useTextModelGate } from '../../../hooks/useTextModelGate';
import { goToTextModels } from '../../../lib/textModelsNav';
import TextModelNote from '../../TextModelNote';
import { I } from '../../icons/I';
import ClipFrame from '../ClipFrame';
import { Meta } from '../../Meta';
import { focusSuccessor, tileSuccessor } from '../../../lib/focusSuccessor';
import buttons from '../../../styles/buttons.module.css';
import styles from './index.module.css';

// Reveal is the loading→done handoff polish — only meaningful on the SSE-driven
// transition. History remounts (initial page load, fetchNextPage) re-mount
// ImageTile with completedAt many seconds in the past; suppressing the reveal
// there avoids a 500ms mat flash over every historical image.
const REVEAL_FRESHNESS_MS = 2000;
const HIGH_PRIORITY_IMAGE_PROPS = { fetchPriority: 'high' } as const;

interface ImageTileProps {
  tile: DoneTile;
  index: number;
  isAboveFold?: boolean;
  ratio: string;
  aspectRatio: string;
  seen?: boolean;
  /** The tile already stood here as a loading plate: no shell entrance, the develop alone marks completion. */
  entered?: boolean;
  disabled?: boolean;
  promptPreview?: string;
  /** Inline playback-only override; download and lightbox keep tile.url. */
  videoSrc?: string | undefined;
  /** Show the Animate (image→video) action. Gated upstream by I2V availability. */
  canAnimate?: boolean;
  /** Show AI Storytelling for an eligible done still or video tail. */
  canTellStory?: boolean;
  /** Show Extend on a done standalone video or sequence tail. */
  canExtend?: boolean;
  extending?: boolean;
  /** Show the edit handoff for image models that accept reference images. */
  canEdit?: boolean;
  /** Show the Ephemera character-card action on a done image. */
  canCreateCard?: boolean;
  /** A card for this tile is in flight (store-owned, survives remounts). */
  creatingCard?: boolean;
  onOpen: () => void;
  onDownload: () => void;
  onDelete: () => void;
  /** Add this image to the composer as a reference for its source model. */
  onEdit?: (() => Promise<boolean>) | undefined;
  /** Hand this still off to the composer as an I2V source. Resolves when the
   *  source upload settles, so the button can show a local pending spinner. */
  onAnimate?: (() => Promise<boolean>) | undefined;
  onTellStory?: (() => Promise<boolean>) | undefined;
  onExtend?: (() => Promise<boolean>) | undefined;
  onCreateCard?: (() => Promise<boolean>) | undefined;
}

interface TileActionButtonProps {
  label: string;
  tip: string;
  busyTip?: string;
  icon: ReactNode;
  disabled: boolean;
  /** Store-owned busy state. When omitted, the button tracks its own pending
   *  state across the returned promise and ignores re-entrant clicks. */
  busy?: boolean;
  onAction: () => Promise<boolean>;
  buttonRef?: Ref<HTMLButtonElement> | undefined;
}

function TileActionButton({ label, tip, busyTip = 'Preparing…', icon, disabled, busy: externalBusy, onAction, buttonRef }: TileActionButtonProps) {
  const [pending, setPending] = useState(false);
  const busy = externalBusy ?? pending;
  return (
    <button
      ref={buttonRef}
      type="button"
      className={buttons.tileAction}
      aria-label={label}
      data-tip={busy ? busyTip : tip}
      aria-busy={busy || undefined}
      // Busy is aria-disabled, never `disabled`: a focused control that becomes
      // disabled drops keyboard focus to <body>.
      aria-disabled={busy || undefined}
      disabled={disabled}
      onClick={(event) => {
        // The tile frame is a button underneath; keep the click off it.
        event.stopPropagation();
        if (busy) return;
        if (externalBusy !== undefined) {
          void onAction();
          return;
        }
        setPending(true);
        void onAction().finally(() => { setPending(false); });
      }}
    >
      {busy ? <span className={styles.actionSpinner} aria-hidden="true" /> : icon}
    </button>
  );
}

/** Tile-level Tell Story runs the storytelling text task, so with no text model
 *  configured it opens the text-model note under itself (decision 3). Its own
 *  component so only tiles that offer the action subscribe to the gate. */
function TellStoryAction({ label, disabled, onTellStory }: { label: string; disabled: boolean; onTellStory: () => Promise<boolean> }) {
  const gate = useTextModelGate();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  return (
    <>
      <TileActionButton
        label={label}
        tip="Tell Story"
        icon={<I.sparkle />}
        disabled={disabled}
        buttonRef={buttonRef}
        onAction={() => {
          if (gate.availability !== 'none') return onTellStory();
          setNoteOpen(true);
          return Promise.resolve(false);
        }}
      />
      {noteOpen ? (
        <TextModelNote
          open
          action="Tell Story"
          anchorRef={buttonRef}
          escape="top-level"
          navigateToTextModels={goToTextModels}
          onClose={() => { setNoteOpen(false); }}
        />
      ) : null}
    </>
  );
}

function ImageTile({ tile, index, isAboveFold = false, ratio, aspectRatio, seen = false, entered = false, disabled = false, promptPreview, videoSrc, canAnimate = false, canTellStory = false, canExtend = false, extending = false, canEdit = false, canCreateCard = false, creatingCard = false, onOpen, onDownload, onDelete, onEdit, onAnimate, onTellStory, onExtend, onCreateCard }: ImageTileProps) {
  // Lazy initializer freezes the decision at mount — no re-evaluation per render.
  const [showReveal] = useState(() => Date.now() - tile.completedAt < REVEAL_FRESHNESS_MS);
  // Give SR users the prompt context the Lightbox already provides instead of
  // an index-only "Generated image 3".
  const promptContext = promptPreview ? `: ${promptPreview.slice(0, 80)}` : '';
  const isVideo = isVideoMime(tile.mime);
  // Thumbnail first, then the full image, then a designed failure state the
  // user can retry (remounting the <img> re-requests from the thumbnail).
  const [media, setMedia] = useState<'thumb' | 'full' | 'failed'>(tile.thumbUrl ? 'thumb' : 'full');
  const [mediaAttempt, setMediaAttempt] = useState(0);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [readyImage, setReadyImage] = useState<{ source: string; attempt: number; cached: boolean } | null>(null);
  const source = media === 'thumb' && tile.thumbUrl ? tile.thumbUrl : tile.url;
  const ready = readyImage?.source === source && readyImage.attempt === mediaAttempt;
  const reveal = async (image: HTMLImageElement, cached = false) => {
    // A completed cache hit needs no second develop on a virtualized remount.
    // Decode a newly arrived resource before handing the mat to the pixels.
    if (!cached) await image.decode().catch(() => undefined);
    if (imageRef.current !== image || image.getAttribute('src') !== source || image.naturalWidth === 0) return;
    setReadyImage((current) => current?.source === source && current.attempt === mediaAttempt
      ? current
      : { source, attempt: mediaAttempt, cached });
  };
  const mediaFailed = !isVideo && media === 'failed';
  const retryMedia = () => {
    setMedia(tile.thumbUrl ? 'thumb' : 'full');
    setMediaAttempt((attempt) => attempt + 1);
  };

  return (
    <div className={styles.tile} data-feed-tile={tile.id} data-seen={seen || entered ? 'true' : undefined}>
      <button
        type="button"
        aria-label={mediaFailed ? `Image ${index + 1} failed to load. Retry` : `Open image ${index + 1}${promptContext}`}
        disabled={disabled}
        onClick={mediaFailed ? retryMedia : (event) => {
          event.currentTarget.focus({ preventScroll: true });
          onOpen();
        }}
        className={styles.frame}
        data-media-failed={mediaFailed ? 'true' : undefined}
        data-media-ready={isVideo || ready ? 'true' : undefined}
        data-cached={ready && readyImage.cached ? 'true' : undefined}
        data-develop={showReveal && !seen ? 'true' : undefined}
        style={{ aspectRatio }}
      >
        {isVideo ? (
          <ClipFrame src={videoSrc ?? tile.url} poster={tile.thumbUrl} />
        ) : mediaFailed ? (
          <span className={styles.mediaFailed} aria-hidden="true">
            <I.alert />
            <span>Couldn’t load. Retry</span>
          </span>
        ) : (
          <img
            key={`${source}:${mediaAttempt}`}
            ref={(image) => {
              imageRef.current = image;
              if (image?.complete && image.naturalWidth > 0) void reveal(image, true);
            }}
            {...(isAboveFold ? HIGH_PRIORITY_IMAGE_PROPS : {})}
            src={source}
            alt={`Generated image ${index + 1}${promptContext}`}
            loading={isAboveFold ? 'eager' : 'lazy'}
            decoding="async"
            draggable={false}
            onLoad={(event) => { void reveal(event.currentTarget); }}
            onError={(event) => {
              if (imageRef.current !== event.currentTarget) return;
              setMedia((current) => (current === 'thumb' ? 'full' : 'failed'));
            }}
          />
        )}
        {!isVideo && !mediaFailed && <div className={styles.reveal} aria-hidden="true" />}
      </button>
      <div className={styles.overlay}>
        <div className={styles.actions}>
          <span className={styles.num}>
            <Meta className={styles.numMeta} items={[String(index + 1), ratio]} />
            {isVideo && <I.film className={styles.numGlyph} aria-hidden="true" />}
          </span>
          <div className={styles.buttons}>
            {canEdit && onEdit && !isVideo && (
              <TileActionButton label={`Edit image ${index + 1}`} tip="Edit" icon={<I.penLine />} disabled={disabled} onAction={onEdit} />
            )}
            {canAnimate && onAnimate && (
              <TileActionButton label={`Animate image ${index + 1}`} tip="Animate" icon={<I.film />} disabled={disabled} onAction={onAnimate} />
            )}
            {canExtend && onExtend && isVideo && (
              <TileActionButton label={`Extend video ${index + 1}`} tip="Extend" icon={<I.extend />} disabled={disabled} busy={extending} onAction={onExtend} />
            )}
            {canTellStory && onTellStory && (
              <TellStoryAction label={`Tell story from ${isVideo ? 'video' : 'image'} ${index + 1}`} disabled={disabled} onTellStory={onTellStory} />
            )}
            {canCreateCard && onCreateCard && !isVideo && (
              <TileActionButton label={`Create character card from image ${index + 1}`} tip="Character card" busyTip="Writing card…" icon={<I.card />} disabled={disabled} busy={creatingCard} onAction={onCreateCard} />
            )}
            <button type="button" className={buttons.tileAction} aria-label="Download tile" data-tip="Download" disabled={disabled} onClick={(event) => { event.stopPropagation(); onDownload(); }}>
              <I.download />
            </button>
            <button type="button" className={buttons.tileAction} aria-label="Archive tile" data-tip="Archive" disabled={disabled} onClick={(event) => { event.stopPropagation(); focusSuccessor(tileSuccessor(event.currentTarget)); onDelete(); }}>
              <I.archive />
            </button>
            <button type="button" className={buttons.tileAction} aria-label={`Expand tile ${index + 1}`} data-tip="Expand" data-tip-place="above-end" disabled={disabled} onClick={(event) => { event.stopPropagation(); event.currentTarget.focus({ preventScroll: true }); onOpen(); }}>
              <I.expand />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default ImageTile;

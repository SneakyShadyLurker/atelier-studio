import { isVideoMime, type DoneTile } from '@atelier/shared';
import { useState, type ReactNode } from 'react';
import { I } from '../../icons/I';
import ClipFrame from '../ClipFrame';
import buttons from '../../../styles/buttons.module.css';
import styles from './index.module.css';

// Reveal is the loading→done handoff polish — only meaningful on the SSE-driven
// transition. History remounts (initial page load, fetchNextPage) re-mount
// ImageTile with completedAt many seconds in the past; suppressing the reveal
// there avoids a 520ms cream flash over every historical image.
const REVEAL_FRESHNESS_MS = 2000;
const HIGH_PRIORITY_IMAGE_PROPS = { fetchPriority: 'high' } as const;

interface ImageTileProps {
  tile: DoneTile;
  index: number;
  isAboveFold?: boolean;
  ratio: string;
  aspectRatio: string;
  seen?: boolean;
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
}

function TileActionButton({ label, tip, busyTip = 'Preparing…', icon, disabled, busy: externalBusy, onAction }: TileActionButtonProps) {
  const [pending, setPending] = useState(false);
  const busy = externalBusy ?? pending;
  return (
    <button
      type="button"
      className={buttons.tileAction}
      aria-label={label}
      data-tip={busy ? busyTip : tip}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
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

function ImageTile({ tile, index, isAboveFold = false, ratio, aspectRatio, seen = false, disabled = false, promptPreview, videoSrc, canAnimate = false, canTellStory = false, canExtend = false, extending = false, canEdit = false, canCreateCard = false, creatingCard = false, onOpen, onDownload, onDelete, onEdit, onAnimate, onTellStory, onExtend, onCreateCard }: ImageTileProps) {
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
  const mediaFailed = !isVideo && media === 'failed';
  const retryMedia = () => {
    setMedia(tile.thumbUrl ? 'thumb' : 'full');
    setMediaAttempt((attempt) => attempt + 1);
  };

  return (
    <div className={styles.tile} data-seen={seen ? 'true' : undefined}>
      <button
        type="button"
        aria-label={mediaFailed ? `Image ${index + 1} failed to load. Retry` : `Open image ${index + 1}${promptContext}`}
        disabled={disabled}
        onClick={mediaFailed ? retryMedia : onOpen}
        className={styles.frame}
        data-media-failed={mediaFailed ? 'true' : undefined}
        style={{ aspectRatio }}
      >
        {isVideo ? (
          <ClipFrame src={videoSrc ?? tile.url} poster={tile.thumbUrl} />
        ) : mediaFailed ? (
          <span className={styles.mediaFailed} aria-hidden="true">
            <I.alert />
            <span>Couldn’t load · Retry</span>
          </span>
        ) : (
          <img
            key={mediaAttempt}
            {...(isAboveFold ? HIGH_PRIORITY_IMAGE_PROPS : {})}
            src={media === 'thumb' && tile.thumbUrl ? tile.thumbUrl : tile.url}
            alt={`Generated image ${index + 1}${promptContext}`}
            loading={isAboveFold ? 'eager' : 'lazy'}
            decoding="async"
            draggable={false}
            onError={() => { setMedia((current) => (current === 'thumb' ? 'full' : 'failed')); }}
          />
        )}
        {showReveal && <div className={styles.reveal} aria-hidden="true" />}
      </button>
      <div className={styles.overlay}>
        <div className={styles.actions}>
          <span className={styles.num}>
            {String(index + 1).padStart(2, '0')} · {ratio}
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
              <TileActionButton label={`Tell story from ${isVideo ? 'video' : 'image'} ${index + 1}`} tip="Tell Story" icon={<I.sparkle />} disabled={disabled} onAction={onTellStory} />
            )}
            {canCreateCard && onCreateCard && !isVideo && (
              <TileActionButton label={`Create character card from image ${index + 1}`} tip="Character card" busyTip="Writing card…" icon={<I.card />} disabled={disabled} busy={creatingCard} onAction={onCreateCard} />
            )}
            <button type="button" className={buttons.tileAction} aria-label="Download tile" data-tip="Download" disabled={disabled} onClick={(event) => { event.stopPropagation(); onDownload(); }}>
              <I.download />
            </button>
            <button type="button" className={buttons.tileAction} aria-label="Archive tile" data-tip="Archive" disabled={disabled} onClick={(event) => { event.stopPropagation(); onDelete(); }}>
              <I.archive />
            </button>
            <button type="button" className={buttons.tileAction} aria-label={`Expand tile ${index + 1}`} data-tip="Expand" data-tip-place="above-end" disabled={disabled} onClick={(event) => { event.stopPropagation(); onOpen(); }}>
              <I.expand />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default ImageTile;

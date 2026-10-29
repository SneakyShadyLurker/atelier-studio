import type { Batch, DoneTile, Model } from '@atelier/shared';
import { isVideoMime } from '@atelier/shared';
import type { CSSProperties } from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import { refImageUrl } from '../../api/uploads';
import { MOTION_PROMPT_SELECTOR, useAnimateFromTile } from '../../hooks/useAnimateFromTile';
import { useExtendFromTile } from '../../hooks/useExtendFromTile';
import { useEditFromTile } from '../../hooks/useEditFromTile';
import { useImageZoom } from '../../hooks/useImageZoom';
import { useKeyboardScoped } from '../../hooks/useKeyboard';
import { getAdjacentTile, getDoneTiles } from '../../hooks/lightboxNav';
import { useAtelierStore } from '../../store/atelier';
import { runWhenReachable } from '../../lib/focus';
import { findI2VModel } from '../../lib/i2v';
import { canExtendVideoTile } from '../../lib/videoSequences';
import { COMPOSER_PROMPT_ID } from '../Composer';
import { DialogShell } from '../DialogShell';
import { useExitTransition } from '../../hooks/useExitTransition';
import { I } from '../icons/I';
import buttons from '../../styles/buttons.module.css';
import styles from './index.module.css';

// 'archive' = soft delete (history view, 30-day retention).
// 'permanent' = hard delete (archive view; the tile is already archived).
export type LightboxDeleteVariant = 'archive' | 'permanent';

interface LightboxProps {
  batch: Batch;
  modelById: ReadonlyMap<string, Model>;
  triggerKey: string;
  deleteVariant: LightboxDeleteVariant;
  onClose: () => void;
  onDownload: (tile: DoneTile) => void;
  onDelete: (tile: DoneTile) => void;
  master?: {
    readonly url: string;
    readonly durationLabel: string;
    readonly onDownload: () => void;
  };
}

interface SwipeGesture {
  startX: number;
  startY: number;
  startTime: number;
  pointerId: number;
}

const HIGH_PRIORITY_IMAGE_PROPS = { fetchPriority: 'high' } as const;

/** Arrow-key nudge while zoomed — about a thumb-swipe of travel per press. */
const KEY_PAN_STEP_PX = 96;

export default function Lightbox({ batch, modelById, triggerKey, deleteVariant, onClose, onDownload, onDelete, master }: LightboxProps) {
  // The store's lightbox.tileId is the single source of truth for the tile on
  // screen — keyboard nav (useKeyboard ArrowLeft/Right) and the on-screen
  // prev/next/swipe paths below all write the same field.
  const storeTileId = useAtelierStore((state) => state.lightbox?.tileId);
  const setLightboxTile = useAtelierStore((state) => state.setLightboxTile);
  const activeTileId = storeTileId ?? triggerKey;
  const [activeRefImageId, setActiveRefImageId] = useState<string | null>(null);
  // Adjust-state-during-render: leaving a tile always exits its ref-image view.
  const [prevTileId, setPrevTileId] = useState(activeTileId);
  if (prevTileId !== activeTileId) {
    setPrevTileId(activeTileId);
    setActiveRefImageId(null);
  }
  const [loadedImage, setLoadedImage] = useState<{ src: string; loaded: boolean; width: number; height: number } | null>(null);
  const [failedImageSrc, setFailedImageSrc] = useState<string | null>(null);
  const [imageRetry, setImageRetry] = useState(0);
  const [imageEl, setImageEl] = useState<HTMLImageElement | null>(null);
  const [gesture, setGesture] = useState<SwipeGesture | null>(null);
  const [displacement, setDisplacement] = useState({ dx: 0, dy: 0 });
  const gestureRef = useRef<SwipeGesture | null>(null);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const handoffFocusRef = useRef<'prompt' | 'motion' | null>(null);
  const edit = useEditFromTile();
  const animate = useAnimateFromTile();
  const { pendingTileId: extendingTileId, extendFromTile: extend } = useExtendFromTile();
  const [editing, setEditing] = useState(false);
  const [animating, setAnimating] = useState(false);
  // Every dismissal (Esc, backdrop, close button, swipe-down, edit/animate
  // handoffs) plays the shared exit before the parent unmounts the viewer.
  const { closing, requestClose } = useExitTransition(onClose);
  const readyTiles = getDoneTiles(batch);
  const activeIndex = Math.max(0, readyTiles.findIndex((tile) => tile.id === activeTileId));
  const tile = readyTiles[activeIndex] ?? readyTiles[0];
  const showingMaster = master !== undefined;
  const fullSrc = master?.url ?? (activeRefImageId ? refImageUrl(activeRefImageId) : tile?.url);
  const [previousImageSrc, setPreviousImageSrc] = useState(fullSrc);
  if (previousImageSrc !== fullSrc) {
    setPreviousImageSrc(fullSrc);
    setFailedImageSrc(null);
    setImageRetry(0);
  }
  const showingReference = activeRefImageId !== null && !showingMaster;
  const imageFailed = failedImageSrc === fullSrc;
  const thumbSrc = showingMaster || activeRefImageId ? undefined : tile?.thumbUrl;
  const showingVideo = showingMaster || (tile !== undefined && activeRefImageId === null && isVideoMime(tile.mime));
  const fullImageLoaded = !showingVideo && fullSrc !== undefined && loadedImage?.src === fullSrc && loadedImage.loaded;
  // Real decoded pixels of the image actually on screen — the single source of
  // truth for resolution, since the wire Tile carries no width/height and they
  // vary per provider/ratio. Shown as a placeholder until the full image loads.
  const naturalDims = fullImageLoaded
    ? `${String(loadedImage.width)}x${String(loadedImage.height)}`
    : showingMaster ? 'master' : showingVideo ? 'video' : '…';
  const model = modelById.get(batch.modelId);
  const canEdit = model?.supportsReferenceImages === true && !showingVideo && activeRefImageId === null;
  const promptPreview = `${batch.prompt.slice(0, 120)}${batch.prompt.length > 120 ? '…' : ''}`;
  const imageContext = `prompt: ${promptPreview}`;
  const dialogLabel = showingMaster
    ? `Sequence master preview, ${master.durationLabel}`
    : showingReference
      ? `Reference image preview, ${imageContext}`
      : `${showingVideo ? 'Video' : 'Image'} preview, ${activeIndex + 1} of ${readyTiles.length}, ${imageContext}`;
  const titleId = useId();
  const i2vModel = findI2VModel(modelById.values());

  // Fitting the image to the viewport downsamples most renders, so the viewer
  // offers a second step at 1:1 with panning. Video keeps its native controls.
  const zoom = useImageZoom({
    element: imageEl,
    naturalWidth: fullImageLoaded ? loadedImage.width : 0,
    enabled: !showingVideo && !showingMaster,
    resetKey: fullSrc ?? '',
  });

  // Tab containment is the native showModal() modal's (DialogShell); only the
  // initial focus target is ours: the close control.
  useEffect(() => {
    const target = closeRef.current;
    runWhenReachable(() => { target?.focus(); }, target);
  }, []);

  // While zoomed the arrows drive the viewport instead of the filmstrip. These
  // register after App's tile-nav handlers, and the scope dispatches the most
  // recent binding, so they take over for exactly as long as the zoom lasts.
  useKeyboardScoped('lightbox-open', 'ArrowLeft', (event) => {
    event.preventDefault();
    zoom.panBy(KEY_PAN_STEP_PX, 0);
  }, zoom.isZoomed);
  useKeyboardScoped('lightbox-open', 'ArrowRight', (event) => {
    event.preventDefault();
    zoom.panBy(-KEY_PAN_STEP_PX, 0);
  }, zoom.isZoomed);
  useKeyboardScoped('lightbox-open', 'ArrowUp', (event) => {
    event.preventDefault();
    zoom.panBy(0, KEY_PAN_STEP_PX);
  }, zoom.isZoomed);
  useKeyboardScoped('lightbox-open', 'ArrowDown', (event) => {
    event.preventDefault();
    zoom.panBy(0, -KEY_PAN_STEP_PX);
  }, zoom.isZoomed);

  useEffect(() => {
    return () => {
      const handoffFocus = handoffFocusRef.current;
      if (handoffFocus === null) return;
      const selector = handoffFocus === 'motion' ? MOTION_PROMPT_SELECTOR : `#${COMPOSER_PROMPT_ID}`;
      const target = document.querySelector<HTMLElement>(selector);
      runWhenReachable(() => {
        document.querySelector<HTMLElement>(selector)?.focus();
      }, target);
    };
  }, []);

  if (!tile || !fullSrc) return null;

  const isFirst = activeIndex === 0;
  const isLast = activeIndex === readyTiles.length - 1;

  // Escape and backdrop clicks unwind one level at a time: 1:1 view first,
  // dismissal second. The close button always dismisses outright.
  const cancel = () => {
    if (zoom.isZoomed) {
      zoom.reset();
      return;
    }
    requestClose();
  };

  const showTileAt = (index: number) => {
    const next = readyTiles[index];
    if (!next) return;
    setLightboxTile(next.id);
  };

  const resetSwipe = () => {
    gestureRef.current = null;
    setGesture(null);
    setDisplacement({ dx: 0, dy: 0 });
  };

  const navigateToAdjacent = (direction: 'prev' | 'next') => {
    const next = getAdjacentTile(batch, tile.id, direction);
    if (!next) {
      resetSwipe();
      return;
    }
    setLightboxTile(next.id);
    resetSwipe();
  };

  const swipeStyle: CSSProperties | undefined = displacement.dx !== 0 || displacement.dy !== 0
    ? {
        transform: `translate3d(${String(displacement.dx)}px, ${String(displacement.dy)}px, 0)`,
        opacity: Math.max(0.3, 1 - Math.max(0, displacement.dy) / 300),
      }
    : undefined;
  // Zoom owns the transform whenever it is engaged; swipe only runs at fit.
  const imageStyle: CSSProperties | undefined = zoom.transform !== undefined
    ? { transform: zoom.transform }
    : swipeStyle;
  const frameStyle: CSSProperties | undefined = thumbSrc
    ? { backgroundImage: `url(${JSON.stringify(thumbSrc)})` }
    : undefined;
  const imageClassName = [
    styles.image,
    gesture || zoom.isInteracting ? styles.dragging : styles.settling,
    fullImageLoaded || !thumbSrc ? styles.imageLoaded : '',
    zoom.canZoom ? styles.zoomable : '',
    zoom.isZoomed ? styles.zoomed : '',
    zoom.isPanning ? styles.grabbing : '',
  ].filter(Boolean).join(' ');

  const editFromTile = () => {
    if (!model || editing) return;
    setEditing(true);
    void edit(tile, model, { ratio: batch.ratio }).then((ok) => {
      if (ok) {
        handoffFocusRef.current = 'prompt';
        requestClose();
        return;
      }
      setEditing(false);
    });
  };
  const animateFromTile = () => {
    if (!i2vModel || animating) return;
    setAnimating(true);
    // The Lightbox owns motion-prompt focus via its unmount-cleanup handoff
    // (its focus trap is still active here), so the hook does NOT focus.
    handoffFocusRef.current = 'motion';
    void animate(tile, i2vModel, { sourcePrompt: batch.prompt, ratio: batch.ratio }).then((ok) => {
      if (ok) {
        requestClose();
        return;
      }
      handoffFocusRef.current = null;
      setAnimating(false);
    });
  };
  const extendFromTile = () => {
    if (!i2vModel || extendingTileId !== null || showingMaster) return;
    handoffFocusRef.current = 'motion';
    void extend(batch, tile, i2vModel).then((ok) => {
      if (ok) {
        requestClose();
        return;
      }
      handoffFocusRef.current = null;
    });
  };
  const canAnimate = i2vModel !== undefined && !isVideoMime(tile.mime);
  const canExtend = !showingMaster && canExtendVideoTile(batch, tile, i2vModel !== undefined);

  return (
    <DialogShell
      open
      onCancel={cancel}
      closing={closing}
      labelledBy={titleId}
      backdropClassName={styles.backdrop}
      portalRef={dialogRef}
    >
      <h2 id={titleId} className="srOnly">{dialogLabel}</h2>
      <button ref={closeRef} className={styles.close} type="button" aria-label="Close lightbox" data-tip="Close" data-tip-place="below" onClick={requestClose}>
        <I.close />
      </button>
      {!showingMaster && <button className={`${styles.nav} ${styles.prev}`} type="button" aria-label="Previous image" data-tip="Previous" disabled={isFirst} onClick={() => {
        showTileAt(activeIndex - 1);
      }}>
        <I.chevronLeft width="18" height="18" />
      </button>}
      {!showingMaster && <button className={`${styles.nav} ${styles.next}`} type="button" aria-label="Next image" data-tip="Next" disabled={isLast} onClick={() => {
        showTileAt(activeIndex + 1);
      }}>
        <I.chevronRight width="18" height="18" />
      </button>}
      <div className={styles.frame} data-media={showingVideo ? 'video' : 'image'} style={frameStyle} onMouseDown={(event) => { event.stopPropagation(); }}>
        {showingVideo ? (
          <video
            className={styles.video}
            src={fullSrc}
            poster={thumbSrc}
            controls
            playsInline
          />
        ) : imageFailed ? (
          <div className={styles.imageError} role="status">
            <span>{showingReference ? 'Reference image unavailable' : 'Full image unavailable'}</span>
            <button className={styles.btn} type="button" onClick={() => { setFailedImageSrc(null); setImageRetry((value) => value + 1); }}>Retry image</button>
          </div>
        ) : (
          <img
            key={`${fullSrc}:${imageRetry}`}
            {...HIGH_PRIORITY_IMAGE_PROPS}
            ref={setImageEl}
            className={imageClassName}
            src={fullSrc}
            alt={`${activeRefImageId ? 'Expanded reference image' : 'Expanded generated image'}, ${imageContext}`}
            decoding="async"
            draggable={false}
            style={imageStyle}
            onLoad={(event) => {
              const img = event.currentTarget;
              setLoadedImage({ src: fullSrc, loaded: true, width: img.naturalWidth, height: img.naturalHeight });
            }}
            onError={() => { setFailedImageSrc(fullSrc); }}
            onClick={zoom.onClick}
            onPointerDown={(event) => {
              // A claimed gesture is a pan or a pinch; swipe-to-dismiss and
              // swipe-to-navigate only exist at fit.
              if (zoom.onPointerDown(event)) {
                resetSwipe();
                return;
              }
              if (event.pointerType !== 'touch') return;
              const nextGesture = { startX: event.clientX, startY: event.clientY, startTime: Date.now(), pointerId: event.pointerId };
              gestureRef.current = nextGesture;
              setGesture(nextGesture);
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (zoom.onPointerMove(event)) return;
              const currentGesture = gestureRef.current;
              if (event.pointerId !== currentGesture?.pointerId) return;
              const dx = event.clientX - currentGesture.startX;
              const dy = event.clientY - currentGesture.startY;
              if (Math.abs(dy) > Math.abs(dx) && dy > 0) {
                setDisplacement({ dx: 0, dy });
              } else if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 12) {
                setDisplacement({ dx: Math.max(-60, Math.min(60, dx)), dy: 0 });
              }
            }}
            onPointerUp={(event) => {
              if (zoom.onPointerUp(event)) return;
              const currentGesture = gestureRef.current;
              if (event.pointerId !== currentGesture?.pointerId) return;
              const dx = event.clientX - currentGesture.startX;
              const dy = event.clientY - currentGesture.startY;
              const duration = Math.max(1, Date.now() - currentGesture.startTime);
              if (Math.abs(dy) > Math.abs(dx) && dy > 0 && (dy > 80 || dy / duration > 0.5)) {
                resetSwipe();
                requestClose();
              } else if (Math.abs(dx) > Math.abs(dy) && dx > 80) {
                navigateToAdjacent('prev');
              } else if (Math.abs(dx) > Math.abs(dy) && dx < -80) {
                navigateToAdjacent('next');
              } else {
                resetSwipe();
              }
            }}
            onPointerCancel={(event) => {
              zoom.onPointerCancel(event);
              resetSwipe();
            }}
          />
        )}
      </div>
      {!showingMaster && tile.refImageIds && tile.refImageIds.length > 0 && (
        <div className={styles.refs} onMouseDown={(event) => { event.stopPropagation(); }}>
          <button
            className={`${styles.refThumb} ${!showingReference ? styles.refThumbActive : ''}`}
            type="button"
            aria-label={isVideoMime(tile.mime) ? 'View generated video' : 'View generated image'}
            aria-pressed={!showingReference}
            onClick={() => { setActiveRefImageId(null); }}
          >
            {isVideoMime(tile.mime)
              ? tile.thumbUrl ? <img src={tile.thumbUrl} alt="" loading="lazy" decoding="async" /> : <I.film aria-hidden="true" />
              : <img src={tile.thumbUrl ?? tile.url} alt="" loading="lazy" decoding="async" />}
          </button>
          {tile.refImageIds.map((uploadId, index) => (
            <button
              key={uploadId}
              className={`${styles.refThumb} ${activeRefImageId === uploadId ? styles.refThumbActive : ''}`}
              type="button"
              aria-label={`View reference image ${index + 1} of ${tile.refImageIds?.length ?? 0}`}
              aria-pressed={activeRefImageId === uploadId}
              onClick={() => { setActiveRefImageId(uploadId); }}
            >
              <img src={refImageUrl(uploadId)} alt="" loading="lazy" decoding="async" />
            </button>
          ))}
        </div>
      )}
      <div className={styles.bar} data-media={showingVideo ? 'video' : 'image'} onMouseDown={(event) => { event.stopPropagation(); }}>
        <div className={styles.info}>
          <span>
            {showingMaster ? (
              <><b>Sequence master</b> · {batch.ratio} · {master.durationLabel}</>
            ) : showingReference ? (
              <><b>Reference image</b> · {naturalDims}{zoom.isZoomed ? ` · ${String(zoom.percent)}%` : ''}</>
            ) : (
              <><b>{model?.name ?? batch.modelLabel}</b> · {batch.ratio} · {naturalDims} · {String(activeIndex + 1).padStart(2, '0')}/
              {String(readyTiles.length).padStart(2, '0')}{zoom.isZoomed ? ` · ${String(zoom.percent)}%` : ''}</>
            )}
          </span>
        </div>
        {zoom.canZoom && (
          <button
            className={`${buttons.iconAction} ${styles.zoomAction}`}
            type="button"
            aria-label={zoom.isZoomed ? 'Fit image to the screen' : 'Zoom to full resolution'}
            aria-pressed={zoom.isZoomed}
            data-tip={zoom.isZoomed ? 'Fit' : 'Zoom 1:1'}
            onClick={() => { zoom.toggle(); }}
          >
            {zoom.isZoomed ? <I.zoomOut /> : <I.zoomIn />}
          </button>
        )}
        {!showingReference && <button className={styles.btn} type="button" aria-label={showingMaster ? 'Download sequence master' : 'Download expanded image'} onClick={() => { if (master) master.onDownload(); else onDownload(tile); }}>
          <I.download />
          Download
        </button>}
        {!showingReference && canAnimate && (
          <button className={`${buttons.iconAction} ${styles.animateAction}`} type="button" aria-label="Animate this image" data-tip={animating ? 'Preparing…' : 'Animate'} aria-busy={animating} disabled={animating} onClick={animateFromTile}>
            {animating ? <span className={styles.animateSpinner} aria-hidden="true" /> : <I.film />}
          </button>
        )}
        {!showingReference && canExtend && (
          <button className={`${buttons.iconAction} ${styles.animateAction}`} type="button" aria-label="Extend this video" data-tip={extendingTileId === tile.id ? 'Preparing…' : 'Extend'} aria-busy={extendingTileId === tile.id} disabled={extendingTileId !== null} onClick={extendFromTile}>
            {extendingTileId === tile.id ? <span className={styles.animateSpinner} aria-hidden="true" /> : <I.extend />}
          </button>
        )}
        {!showingMaster && !showingReference && canEdit && (
          <button className={styles.btn} type="button" aria-label="Edit from this image" aria-busy={editing || undefined} disabled={editing} onClick={editFromTile}>
            {editing ? <span className={styles.animateSpinner} aria-hidden="true" /> : <I.penLine />}
            Edit
          </button>
        )}
        {!showingMaster && !showingReference && <button className={`${styles.btn} ${styles.danger}`} type="button" aria-label={deleteVariant === 'archive' ? 'Archive expanded image' : 'Delete expanded image permanently'} onClick={() => { onDelete(tile); }}>
          {deleteVariant === 'archive' ? <I.archive /> : <I.trash />}
          {deleteVariant === 'archive' ? 'Archive' : 'Delete'}
        </button>}
      </div>
    </DialogShell>
  );
}

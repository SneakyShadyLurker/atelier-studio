import { isVideoMime } from '@atelier/shared';
import type { CSSProperties } from 'react';
import { useDeferredValue, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, ViewTransition } from 'react';
import { createPortal } from 'react-dom';
import type { LightboxContentProps } from './types';
import { refImageUrl } from '../../api/uploads';
import { MOTION_PROMPT_SELECTOR, useAnimateFromTile } from '../../hooks/useAnimateFromTile';
import { useExtendFromTile } from '../../hooks/useExtendFromTile';
import { useEditFromTile } from '../../hooks/useEditFromTile';
import { useImageZoom } from '../../hooks/useImageZoom';
import { useKeyboardScoped } from '../../hooks/useKeyboard';
import { getAdjacentTile } from '../../hooks/lightboxNav';
import { useAtelierStore } from '../../store/atelier';
import { runWhenReachable } from '../../lib/focus';
import { findI2VModel } from '../../lib/i2v';
import { canExtendVideoTile } from '../../lib/videoSequences';
import { COMPOSER_PROMPT_ID } from '../Composer';
import { I } from '../icons/I';
import { Meta } from '../Meta';
import buttons from '../../styles/buttons.module.css';
import styles from './index.module.css';

interface SwipeGesture {
  startX: number;
  startY: number;
  startTime: number;
  pointerId: number;
}

const HIGH_PRIORITY_IMAGE_PROPS = { fetchPriority: 'high' } as const;

/** Arrow-key nudge while zoomed — about a thumb-swipe of travel per press. */
const KEY_PAN_STEP_PX = 96;

export default function Content({ batch, modelById, deleteVariant, onDownload, onDelete, master, descriptor, frameHost, requestClose, setActiveRefImageId, cancelRef, onReady }: LightboxContentProps) {
  const { tile, activeIndex, tileCount, activeRefImageId, fullSrc, thumbSrc, showingMaster, showingReference, showingVideo, fittedRatio, imageContext } = descriptor;
  const setLightboxTile = useAtelierStore((state) => state.setLightboxTile);
  const [loadedImage, setLoadedImage] = useState<{ src: string; loaded: boolean; width: number; height: number } | null>(null);
  const [failedImageSrc, setFailedImageSrc] = useState<string | null>(null);
  const [imageRetry, setImageRetry] = useState(0);
  const [imageEl, setImageEl] = useState<HTMLImageElement | null>(null);
  const [gesture, setGesture] = useState<SwipeGesture | null>(null);
  const [displacement, setDisplacement] = useState({ dx: 0, dy: 0 });
  const gestureRef = useRef<SwipeGesture | null>(null);
  const handoffFocusRef = useRef<'prompt' | 'motion' | null>(null);
  const edit = useEditFromTile();
  const animate = useAnimateFromTile();
  const { pendingTileId: extendingTileId, extendFromTile: extend } = useExtendFromTile();
  const [editing, setEditing] = useState(false);
  const [animating, setAnimating] = useState(false);
  const [previousImageSrc, setPreviousImageSrc] = useState(fullSrc);
  if (previousImageSrc !== fullSrc) {
    setPreviousImageSrc(fullSrc);
    setFailedImageSrc(null);
    setImageRetry(0);
  }
  const imageFailed = failedImageSrc === fullSrc;
  // One render snapshot for the conditional chrome (the reference strip and
  // the error fallback): they and their handlers read it, so each mounts and
  // unmounts in a Transition through its part boundary.
  const stripTile = !showingMaster && tile?.refImageIds && tile.refImageIds.length > 0 ? tile : null;
  const liveChrome = useMemo(
    () => ({ stripTile, activeRefImageId, imageFailed, showingReference }),
    [stripTile, activeRefImageId, imageFailed, showingReference],
  );
  const chrome = useDeferredValue(liveChrome);
  const fullImageLoaded = !showingVideo && fullSrc !== undefined && loadedImage?.src === fullSrc && loadedImage.loaded;
  // Real decoded pixels of the image actually on screen — the single source of
  // truth for resolution, since the wire Tile carries no width/height and they
  // vary per provider/ratio. The readout sits in a reserved tabular slot that
  // stays empty until the full image loads, so the fields after it (the
  // "1 of 3" position) never move when it decodes.
  const naturalDims = (
    <span className={styles.dims} data-slot="dims">
      {fullImageLoaded
        ? `${String(loadedImage.width)}×${String(loadedImage.height)}`
        : showingMaster ? 'master' : showingVideo ? 'video' : ''}
    </span>
  );
  const model = modelById.get(batch.modelId);
  const canEdit = model?.supportsReferenceImages === true && !showingVideo && activeRefImageId === null;
  const i2vModel = findI2VModel(modelById.values());

  // Fitting the image to the viewport downsamples most renders, so the viewer
  // offers a second step at 1:1 with panning. Video keeps its native controls.
  const zoom = useImageZoom({
    element: imageEl,
    naturalWidth: fullImageLoaded ? loadedImage.width : 0,
    enabled: !showingVideo && !showingMaster,
    resetKey: fullSrc ?? '',
  });

  // Readiness is a lifetime notification, independent of the live selection.
  useLayoutEffect(() => { onReady(); }, [onReady]);
  useImperativeHandle(cancelRef, () => ({
    cancel: () => {
      if (zoom.isZoomed) zoom.reset();
      else requestClose();
    },
  }));

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
  const imageClassName = [
    styles.image,
    gesture || zoom.isInteracting ? styles.dragging : styles.settling,
    fullImageLoaded ? styles.imageLoaded : '',
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
    <>
      {frameHost ? createPortal(
        showingVideo ? (
          <video
            className={styles.video}
            src={fullSrc}
            poster={thumbSrc}
            controls
            playsInline
          />
        ) : chrome.imageFailed ? (
          <ViewTransition key="error" default="none" enter="part-enter" exit="part-exit">
            <div className={styles.imageError} role="status">
              <span>{chrome.showingReference ? 'Reference image unavailable' : 'Full image unavailable'}</span>
              <button className={styles.btn} type="button" onClick={() => { setFailedImageSrc(null); setImageRetry((value) => value + 1); }}>Retry image</button>
            </div>
          </ViewTransition>
        ) : (
          <img
            key={`${fullSrc}:${imageRetry}`}
            {...HIGH_PRIORITY_IMAGE_PROPS}
            ref={setImageEl}
            className={imageClassName}
            src={fullSrc}
            width={fullImageLoaded ? loadedImage.width : fittedRatio.w}
            height={fullImageLoaded ? loadedImage.height : fittedRatio.h}
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
                // Keep the terminal pose while the viewer fades away. Only
                // a cancelled swipe returns to fit; dismissal releases ownership.
                gestureRef.current = null;
                setGesture(null);
                setDisplacement({ dx: 0, dy });
                event.currentTarget.releasePointerCapture(event.pointerId);
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
        ), frameHost) : null}
      {/* One bottom column: the reference strip sits on top of the toolbar,
          so a toolbar that wraps (phones) pushes the strip up instead of
          running under it. */}
      <div className={styles.dock} data-media={showingVideo ? 'video' : 'image'}>
      {chrome.stripTile?.refImageIds ? (
        <ViewTransition default="none" enter="part-enter" exit="part-exit">
        <div className={styles.refs} onMouseDown={(event) => { event.stopPropagation(); }}>
          <button
            className={`${styles.refThumb} ${!chrome.showingReference ? styles.refThumbActive : ''}`}
            type="button"
            aria-label={isVideoMime(chrome.stripTile.mime) ? 'View generated video' : 'View generated image'}
            aria-pressed={!chrome.showingReference}
            onClick={() => { setActiveRefImageId(null); }}
          >
            {isVideoMime(chrome.stripTile.mime)
              ? chrome.stripTile.thumbUrl ? <img src={chrome.stripTile.thumbUrl} alt="" loading="lazy" decoding="async" /> : <I.film aria-hidden="true" />
              : <img src={chrome.stripTile.thumbUrl ?? chrome.stripTile.url} alt="" loading="lazy" decoding="async" />}
          </button>
          {chrome.stripTile.refImageIds.map((uploadId, index, ids) => (
            <button
              key={uploadId}
              className={`${styles.refThumb} ${chrome.activeRefImageId === uploadId ? styles.refThumbActive : ''}`}
              type="button"
              aria-label={`View reference image ${index + 1} of ${ids.length}`}
              aria-pressed={chrome.activeRefImageId === uploadId}
              onClick={() => {
                // The strip renders from the deferred chrome: a previous
                // tile's strip is still clickable until its exit commits, and
                // must not select an upload the live tile does not own.
                if (tile.refImageIds?.includes(uploadId)) setActiveRefImageId(uploadId);
              }}
            >
              <img src={refImageUrl(uploadId)} alt="" loading="lazy" decoding="async" />
            </button>
          ))}
        </div>
        </ViewTransition>
      ) : null}
      <div className={styles.bar} onMouseDown={(event) => { event.stopPropagation(); }}>
        <div className={styles.info}>
          <Meta
            lead
            className={styles.caption}
            items={showingMaster
              ? ['Sequence master', batch.ratio, master?.durationLabel]
              : showingReference
                ? ['Reference image', naturalDims, zoom.isZoomed ? `${String(zoom.percent)}%` : null]
                : [
                  model?.name ?? batch.modelLabel,
                  batch.ratio,
                  naturalDims,
                  `${String(activeIndex + 1)} of ${String(tileCount)}`,
                  zoom.isZoomed ? `${String(zoom.percent)}%` : null,
                ]}
          />
        </div>
        {/* The Zoom slot is laid out for every image, so the toolbar keeps
            one width before and after decode; it is hidden and inert until
            zoom is worthwhile. */}
        {!showingVideo && (
          <button
            className={`${buttons.iconAction} ${styles.zoomAction}`}
            type="button"
            data-slot="zoom"
            aria-label={zoom.isZoomed ? 'Fit image to the screen' : 'Zoom to full resolution'}
            aria-pressed={zoom.isZoomed}
            aria-hidden={zoom.canZoom ? undefined : true}
            inert={!zoom.canZoom}
            data-tip={zoom.canZoom ? (zoom.isZoomed ? 'Fit' : 'Zoom 1:1') : undefined}
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
      </div>
    </>
  );
}

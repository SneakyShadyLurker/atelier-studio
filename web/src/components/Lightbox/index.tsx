import { isVideoMime } from '@atelier/shared';
import type { CSSProperties } from 'react';
import { lazy, Suspense, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { refImageUrl } from '../../api/uploads';
import { getDoneTiles } from '../../hooks/lightboxNav';
import { useExitTransition } from '../../hooks/useExitTransition';
import { runWhenReachable } from '../../lib/focus';
import { getRatioDefinition } from '../../lib/ratios';
import { useAtelierStore } from '../../store/atelier';
import { DialogShell } from '../DialogShell';
import { ErrorBoundary } from '../ErrorBoundary';
import { I } from '../icons/I';
import type { LightboxCancelHandle, LightboxProps, ViewerDescriptor } from './types';
import styles from './index.module.css';

export type { LightboxDeleteVariant } from './types';

const Content = lazy(() => import('./Content'));

function BodyError({ frameHost, onReady, requestClose, returnLabel }: {
  frameHost: HTMLDivElement | null;
  onReady: () => void;
  requestClose: () => void;
  returnLabel: string;
}) {
  // An initial video has no frame until the body (or this fallback) commits.
  useLayoutEffect(() => { onReady(); }, [onReady]);
  return frameHost ? createPortal(
    <div className={styles.imageError} role="status">
      <span>Image view unavailable</span>
      <span>The viewer hit an error — the rest of Atelier is unaffected.</span>
      <button className={styles.btn} type="button" onClick={requestClose}>{returnLabel}</button>
    </div>, frameHost,
  ) : null;
}

export default function Lightbox({ batch, modelById, triggerKey, deleteVariant, onClose, onDownload, onDelete, master, returnLabel = 'Back to Unsorted' }: LightboxProps) {
  // Selection stays live even while the body chunk is pending or has failed.
  const storeTileId = useAtelierStore((state) => state.lightbox?.tileId);
  const setLightboxTile = useAtelierStore((state) => state.setLightboxTile);
  const activeTileId = storeTileId ?? triggerKey;
  const [activeRefImageId, setActiveRefImageId] = useState<string | null>(null);
  const [prevTileId, setPrevTileId] = useState(activeTileId);
  if (prevTileId !== activeTileId) {
    setPrevTileId(activeTileId);
    setActiveRefImageId(null);
  }
  const readyTiles = getDoneTiles(batch);
  const activeIndex = Math.max(0, readyTiles.findIndex((tile) => tile.id === activeTileId));
  const tile = readyTiles[activeIndex] ?? readyTiles[0];
  const showingMaster = master !== undefined;
  const fullSrc = master?.url ?? (activeRefImageId ? refImageUrl(activeRefImageId) : tile?.url);
  const showingReference = activeRefImageId !== null && !showingMaster;
  const showingVideo = showingMaster || (tile !== undefined && activeRefImageId === null && isVideoMime(tile.mime));
  const thumbSrc = showingMaster || activeRefImageId ? undefined : tile?.thumbUrl;
  const fittedRatio = getRatioDefinition(batch.ratio);
  const promptPreview = `${batch.prompt.slice(0, 120)}${batch.prompt.length > 120 ? '…' : ''}`;
  const imageContext = `prompt: ${promptPreview}`;
  const dialogLabel = showingMaster
    ? `Sequence master preview, ${master.durationLabel}`
    : showingReference
      ? `Reference image preview, ${imageContext}`
      : `${showingVideo ? 'Video' : 'Image'} preview, ${activeIndex + 1} of ${readyTiles.length}, ${imageContext}`;
  const descriptor: ViewerDescriptor = { tile, activeIndex, tileCount: readyTiles.length, activeRefImageId, fullSrc, thumbSrc, showingMaster, showingReference, showingVideo, fittedRatio, imageContext };
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<LightboxCancelHandle | null>(null);
  const titleId = useId();
  const { closing, requestClose } = useExitTransition(onClose);
  const [bodyReady, setBodyReady] = useState(false);
  const onReady = useCallback(() => { setBodyReady(true); }, []);
  const [frameMounted, setFrameMounted] = useState(!showingVideo);
  if (!frameMounted && (!showingVideo || bodyReady)) setFrameMounted(true);
  const [frameHost, setFrameHost] = useState<HTMLDivElement | null>(null);

  // Only the shell's initial commit chooses focus. Body readiness never does.
  useEffect(() => {
    const target = closeRef.current;
    runWhenReachable(() => { target?.focus(); }, target);
  }, []);

  if (!tile || !fullSrc) return null;
  const frameStyle = showingVideo
    ? bodyReady ? undefined : { backgroundColor: 'transparent' }
    : {
        '--frame-ratio': fittedRatio.w / fittedRatio.h,
        ...(thumbSrc ? { backgroundImage: `url(${JSON.stringify(thumbSrc)})` } : {}),
      } as CSSProperties;
  const showTileAt = (index: number) => {
    const next = readyTiles[index];
    if (next) setLightboxTile(next.id);
  };
  const cancel = () => {
    if (cancelRef.current) cancelRef.current.cancel();
    else requestClose();
  };

  return (
    <DialogShell open onCancel={cancel} closing={closing} labelledBy={titleId} backdropClassName={styles.backdrop} portalRef={dialogRef}>
      <h2 id={titleId} className="srOnly">{dialogLabel}</h2>
      <button ref={closeRef} className={styles.close} type="button" aria-label="Close lightbox" data-tip="Close" data-tip-place="below" onClick={requestClose}>
        <I.close />
      </button>
      {!showingMaster && <button className={`${styles.nav} ${styles.prev}`} type="button" aria-label="Previous image" data-tip="Previous" disabled={activeIndex === 0} onClick={() => { showTileAt(activeIndex - 1); }}>
        <I.chevronLeft width="18" height="18" />
      </button>}
      {!showingMaster && <button className={`${styles.nav} ${styles.next}`} type="button" aria-label="Next image" data-tip="Next" disabled={activeIndex === readyTiles.length - 1} onClick={() => { showTileAt(activeIndex + 1); }}>
        <I.chevronRight width="18" height="18" />
      </button>}
      {frameMounted && <div ref={setFrameHost} className={styles.frame} data-media={showingVideo ? 'video' : 'image'} style={frameStyle} aria-busy={!bodyReady} onMouseDown={(event) => { event.stopPropagation(); }} />}
      <ErrorBoundary resetKeys={[showingMaster ? master.url : activeTileId]} fallback={<BodyError frameHost={frameHost} onReady={onReady} requestClose={requestClose} returnLabel={returnLabel} />}>
        <Suspense fallback={null}>
          <Content batch={batch} modelById={modelById} deleteVariant={deleteVariant} onDownload={onDownload} onDelete={onDelete} {...(master ? { master } : {})} descriptor={descriptor} frameHost={frameHost} requestClose={requestClose} setActiveRefImageId={setActiveRefImageId} cancelRef={cancelRef} onReady={onReady} />
        </Suspense>
      </ErrorBoundary>
    </DialogShell>
  );
}

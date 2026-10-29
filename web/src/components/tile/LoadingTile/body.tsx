import { useQueryClient } from '@tanstack/react-query';
import type { CSSProperties } from 'react';
import { useEffect } from 'react';
import { findTileInCache } from '../../../hooks/historyCache';
import { liveActiveScopeKey } from '../../../hooks/scopedHistoryMutation';
import { useAtelierStore } from '../../../store/atelier';
import { useNowTick } from '../../../hooks/useNowTick';
import { formatClock } from '../../../lib/clock';
import { I2V_ESTIMATED_RENDER_MS } from '../../../lib/i2v';
import styles from './index.module.css';

interface LoadingTileBodyProps {
  tileId: string;
  batchId: string;
  modelName: string;
  startedAt: number;
  isVideo?: boolean;
  sourceStillUrl?: string | undefined;
}

const I2V_ESTIMATE_CLOCK = formatClock(I2V_ESTIMATED_RENDER_MS / 1000);

function ElapsedTime({ modelName, startedAt, isVideo }: { modelName: string; startedAt: number; isVideo: boolean }) {
  const now = useNowTick();
  // Clamped: a client clock slightly behind the server must not show "-2s".
  const elapsedSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  // Video renders run minutes, not seconds — a raw "740s" reads as broken.
  // Show m:ss against the rough ETA so the long wait is legible and bounded.
  if (isVideo) {
    return <span>{modelName} · {formatClock(elapsedSeconds)} / {I2V_ESTIMATE_CLOCK}</span>;
  }
  return <span>{modelName} · {elapsedSeconds}s</span>;
}

function LoadingTileBody({ tileId, batchId, modelName, startedAt, isVideo = false, sourceStillUrl }: LoadingTileBodyProps) {
  const previewState = useAtelierStore((state) => state.previews.get(tileId));
  const preview = previewState?.url;
  const previewIndex = previewState?.index;
  const clearTilePreview = useAtelierStore((state) => state.clearTilePreview);
  const clearTileProgress = useAtelierStore((state) => state.clearTileProgress);
  const progress = useAtelierStore((state) => state.tileProgress[tileId]);
  const queryClient = useQueryClient();

  // Unmount-time preview sweep, GUARDED: virtualized Canvas rows unmount when
  // scrolled out of the window, and dropping a still-loading tile's partial
  // frame would show the noise placeholder until the next partial event when
  // it scrolls back. Only clear when the cache says the tile is definitively
  // not loading anymore (or gone) — the stream-owned sweeps (useGenerate's
  // finally, terminal events, delete/cancel paths) remain the primary owners.
  useEffect(() => () => {
    const cached = findTileInCache(queryClient, liveActiveScopeKey(), batchId, tileId);
    if (cached?.status === 'loading') return;
    clearTilePreview(tileId);
    clearTileProgress(tileId);
  }, [batchId, tileId, clearTilePreview, clearTileProgress, queryClient]);

  const pass = preview !== undefined ? Math.min(previewIndex ?? 0, 5) : undefined;
  const progressPercent = progress === undefined ? undefined : Math.round(progress * 100);
  // A live partial preview (cloud image gen) wins; otherwise, for a video
  // render, veil the uploaded source still so the user watches the frame being
  // animated through the multi-minute wait instead of an abstract gradient.
  const sourceBackdrop = preview === undefined && isVideo ? sourceStillUrl : undefined;
  const backdrop = preview ?? sourceBackdrop;

  return (
    <>
      {backdrop !== undefined && (
        <img
          className={styles.preview}
          src={backdrop}
          alt=""
          aria-hidden="true"
          data-pass={pass}
          data-source={sourceBackdrop !== undefined ? 'true' : undefined}
        />
      )}
      <div className={`${styles.loading} ${backdrop !== undefined ? styles.veiled : ''}`}>
        {backdrop === undefined && <div className={styles.noise} />}
      </div>
      <div className={styles.text}>
        {progressPercent === undefined ? (
          <div className={styles.bar} data-video={isVideo ? 'true' : undefined} aria-hidden="true" />
        ) : (
          <div
            className={styles.bar}
            role="progressbar"
            aria-label="Generation progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progressPercent}
            aria-valuetext={`${String(progressPercent)}%`}
            data-progress="true"
            data-video={isVideo ? 'true' : undefined}
            style={{ '--tile-progress': progress } as CSSProperties}
          />
        )}
        <ElapsedTime modelName={modelName} startedAt={startedAt} isVideo={isVideo} />
      </div>
    </>
  );
}

export default LoadingTileBody;

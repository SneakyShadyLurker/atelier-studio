import { useQueryClient } from '@tanstack/react-query';
import type { CSSProperties } from 'react';
import { useEffect } from 'react';
import { findTileInCache } from '../../../hooks/historyCache';
import { liveActiveScopeKey } from '../../../hooks/scopedHistoryMutation';
import { useAtelierStore, type TileProgress, type TileProgressSteps } from '../../../store/atelier';
import { useNowTick } from '../../../hooks/useNowTick';
import { formatClock } from '../../../lib/clock';
import { I2V_ESTIMATED_RENDER_MS } from '../../../lib/i2v';
import { describeEta, formatEta, isFinishing, remainingMs, stepDurationMs } from '../../../lib/stepEta';
import { Meta } from '../../Meta';
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

function elapsedLabel(now: number, startedAt: number, isVideo: boolean): string {
  // Clamped: a client clock slightly behind the server must not show "-2s".
  const elapsedSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  // Video renders run minutes, not seconds — a raw "740s" reads as broken.
  // Show m:ss against the rough ETA so the long wait is legible and bounded.
  return isVideo ? `${formatClock(elapsedSeconds)} / ${I2V_ESTIMATE_CLOCK}` : `${String(elapsedSeconds)}s`;
}

function ElapsedTime({ modelName, startedAt, isVideo }: { modelName: string; startedAt: number; isVideo: boolean }) {
  const now = useNowTick();
  return <Meta className={styles.elapsed} items={[<span key="model" className={styles.model}>{modelName}</span>, elapsedLabel(now, startedAt, isVideo)]} />;
}

interface StepProgressProps {
  entry: TileProgress & TileProgressSteps;
  modelName: string;
  startedAt: number;
  isVideo: boolean;
}

/**
 * Sampler step readout: determinate bar, model, `12/25` (or `Refine 3/8` on a
 * later pass) and an ETA once the rate is reliable, else elapsed time. The
 * final step of the last pass reads `Finishing` over a full, sheened bar.
 */
function StepProgress({ entry, modelName, startedAt, isVideo }: StepProgressProps) {
  const now = useNowTick();
  const { step, totalSteps, pass, passCount } = entry;
  const finishing = isFinishing(entry);
  const refine = passCount > 1 && pass > 1;
  const eta = remainingMs(entry, now);
  const stepMs = stepDurationMs(entry);
  const percent = Math.round((finishing ? 1 : entry.progress) * 100);
  const stage = refine ? 'Refine step' : 'Step';
  const valueText = finishing
    ? 'Finishing'
    : `${stage} ${String(step)} of ${String(totalSteps)}${eta === null ? '' : `, ${describeEta(eta)}`}`;
  const barStyle = {
    '--tile-progress': finishing ? 1 : entry.progress,
    ...(stepMs === null ? {} : { '--tile-step-ms': `${String(stepMs)}ms` }),
  } as CSSProperties;
  const readout = finishing ? 'Finishing' : (
    <span className={styles.steps}>
      {refine && <><span className={styles.stage}>Refine</span>{' '}</>}
      <span className={styles.stepNow} style={{ '--digits': String(totalSteps).length } as CSSProperties}>
        <span key={`${String(pass)}-${String(step)}`} className={styles.stepNum}>{step}</span>
      </span>
      <span className={styles.stepTotal}>/{totalSteps}</span>
    </span>
  );
  const time = finishing ? null : (
    <span className={styles.time}>{eta === null ? elapsedLabel(now, startedAt, isVideo) : formatEta(eta)}</span>
  );
  return (
    <>
      <div
        className={styles.bar}
        role="progressbar"
        aria-label="Generation progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={valueText}
        data-progress="true"
        data-steps="true"
        data-finishing={finishing ? 'true' : undefined}
        data-video={isVideo ? 'true' : undefined}
        style={barStyle}
      />
      <Meta className={styles.elapsed} items={[<span key="model" className={styles.model}>{modelName}</span>, readout, time]} />
    </>
  );
}

function hasSteps(entry: TileProgress | undefined): entry is TileProgress & TileProgressSteps {
  return entry?.step !== undefined && entry.totalSteps !== undefined && entry.pass !== undefined && entry.passCount !== undefined;
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
  // frame would show the bare plate until the next partial event when
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
  // A live partial preview (cloud image gen) wins; otherwise, for a video
  // render, veil the uploaded source still so the user watches the frame being
  // animated through the multi-minute wait instead of the bare plate.
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
          decoding="async"
          data-pass={pass}
          data-source={sourceBackdrop !== undefined ? 'true' : undefined}
        />
      )}
      <div className={`${styles.loading} ${backdrop !== undefined ? styles.veiled : ''}`} />
      <div className={styles.text}>
        {hasSteps(progress) ? (
          <StepProgress entry={progress} modelName={modelName} startedAt={startedAt} isVideo={isVideo} />
        ) : (
          <>
            {progress === undefined ? (
              <div className={styles.bar} data-video={isVideo ? 'true' : undefined} aria-hidden="true" />
            ) : (
              <div
                className={styles.bar}
                role="progressbar"
                aria-label="Generation progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(progress.progress * 100)}
                aria-valuetext={`${String(Math.round(progress.progress * 100))}%`}
                data-progress="true"
                data-video={isVideo ? 'true' : undefined}
                style={{ '--tile-progress': progress.progress } as CSSProperties}
              />
            )}
            <ElapsedTime modelName={modelName} startedAt={startedAt} isVideo={isVideo} />
          </>
        )}
      </div>
    </>
  );
}

export default LoadingTileBody;

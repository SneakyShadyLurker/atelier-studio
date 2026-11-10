import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from 'react';
import { I } from '../../icons/I';
import { isTouchViewport } from '../../../hooks/useIsPhone';
import { useReducedMotion } from '../../../hooks/useReducedMotion';
import { formatClock } from '../../../lib/clock';
import { useAtelierStore } from '../../../store/atelier';
import styles from './index.module.css';

interface ClipFrameProps {
  src: string;
  poster?: string | undefined;
  /** The video failed to load or decode (its `error` event). */
  onMediaError?: (() => void) | undefined;
  /**
   * Identity of the media element. A new value remounts the `<video>`, so a
   * parent's Retry reloads a clip whose media errored.
   */
  mediaKey?: string | number | undefined;
}

/** Share of the clip that must be on screen before touch autoplay starts. */
const TOUCH_PLAY_RATIO = 0.6;

function subscribeVisibility(listener: () => void): () => void {
  document.addEventListener('visibilitychange', listener);
  return () => { document.removeEventListener('visibilitychange', listener); };
}

function documentHidden(): boolean {
  return document.visibilityState === 'hidden';
}

/**
 * Grid/archive clip preview. A still poster + play badge by default; the clip
 * comes alive on hover (pointer devices) or while at least 60% in view (touch
 * devices), muted and looped — the sanctioned low-energy pattern (paused
 * off-screen, never auto-playing audio). Reduced-motion keeps it a static
 * poster. Every preview pauses while the Lightbox is open or the document is
 * hidden, and resumes afterwards only if it still wants to play (still
 * hovered, still in view).
 */
export default function ClipFrame({ mediaKey, ...props }: ClipFrameProps) {
  return <ClipMedia key={mediaKey ?? 0} {...props} />;
}

function ClipMedia({ src, poster, onMediaError }: Omit<ClipFrameProps, 'mediaKey'>) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const reducedMotion = useReducedMotion();
  // The mounted viewer, not the selection: a selection whose batch left the
  // scope shows no viewer and must not keep every preview paused.
  const lightboxOpen = useAtelierStore((state) => state.viewerOpen);
  const hidden = useSyncExternalStore(subscribeVisibility, documentHidden, () => false);
  const suspended = lightboxOpen || hidden;
  // What the reader asked for (hovered on a pointer device, in view on touch).
  // Kept apart from `suspended` so lifting a suspension resumes exactly the
  // previews that still want to play.
  const wantsPlayRef = useRef(false);
  const suspendedRef = useRef(suspended);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState<number | null>(null);
  const knownDuration = duration !== null && Number.isFinite(duration) && duration > 0;

  const sync = (rewind: boolean) => {
    const video = videoRef.current;
    if (!video) return;
    if (wantsPlayRef.current && !suspendedRef.current && !reducedMotion) {
      void video.play().catch(() => undefined);
      return;
    }
    video.pause();
    if (rewind) video.currentTime = 0;
  };
  const syncFromEffect = useEffectEvent((rewind: boolean) => { sync(rewind); });

  useEffect(() => {
    suspendedRef.current = suspended;
    // Paused in place: the resume continues from the same frame.
    syncFromEffect(false);
  }, [suspended]);

  // Touch devices have no hover — drive playback from viewport visibility,
  // pausing (and rewinding to the poster frame) when the tile scrolls away.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    // Reduced motion switched on mid-playback: settle back on the poster.
    if (reducedMotion && !video.paused) {
      video.pause();
      video.currentTime = 0;
    }
    if (reducedMotion || !isTouchViewport()) return;
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          // `isIntersecting` is true for any overlap; the ratio is the gate.
          wantsPlayRef.current = entry.isIntersecting && entry.intersectionRatio >= TOUCH_PLAY_RATIO;
          syncFromEffect(true);
        }
      },
      { threshold: [0, TOUCH_PLAY_RATIO] },
    );
    observer.observe(video);
    return () => { observer.disconnect(); };
  }, [reducedMotion]);

  const startHoverPlayback = () => {
    if (reducedMotion || isTouchViewport()) return;
    wantsPlayRef.current = true;
    sync(false);
  };
  const stopHoverPlayback = () => {
    if (isTouchViewport()) return;
    wantsPlayRef.current = false;
    sync(true);
  };

  return (
    <>
      <video
        ref={videoRef}
        className={styles.media}
        src={src}
        poster={poster}
        muted
        loop
        playsInline
        preload="none"
        onPointerEnter={startHoverPlayback}
        onPointerLeave={stopHoverPlayback}
        onPlaying={() => { setPlaying(true); }}
        onPause={() => { setPlaying(false); }}
        onLoadedMetadata={(event) => { setDuration(event.currentTarget.duration); }}
        onError={onMediaError}
      />
      {/* Always mounted: the chip fades in once metadata names a length. */}
      <span className={styles.duration} aria-hidden="true" data-ready={knownDuration ? 'true' : undefined}>
        {knownDuration ? formatClock(duration) : null}
      </span>
      <span
        className={styles.playBadge}
        data-testid="play-badge"
        data-playing={playing ? 'true' : undefined}
        aria-hidden="true"
      >
        <I.play />
      </span>
    </>
  );
}

import { useEffect, useRef, useState } from 'react';
import { I } from '../../icons/I';
import { isTouchViewport } from '../../../hooks/useIsPhone';
import { useReducedMotion } from '../../../hooks/useReducedMotion';
import { formatClock } from '../../../lib/clock';
import styles from './index.module.css';

interface ClipFrameProps {
  src: string;
  poster?: string | undefined;
}

/**
 * Grid/archive clip preview. A still poster + play badge by default; the clip
 * comes alive on hover (pointer devices) or while in view (touch devices),
 * muted and looped — the sanctioned low-energy pattern (paused off-screen,
 * never auto-playing audio). Reduced-motion keeps it a static poster.
 */
export default function ClipFrame({ src, poster }: ClipFrameProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const reducedMotion = useReducedMotion();
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState<number | null>(null);

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
          if (entry.isIntersecting) {
            void video.play().catch(() => undefined);
          } else {
            video.pause();
            video.currentTime = 0;
          }
        }
      },
      { threshold: 0.6 },
    );
    observer.observe(video);
    return () => { observer.disconnect(); };
  }, [reducedMotion]);

  const startHoverPlayback = () => {
    if (reducedMotion || isTouchViewport()) return;
    void videoRef.current?.play().catch(() => undefined);
  };
  const stopHoverPlayback = () => {
    if (isTouchViewport()) return;
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    video.currentTime = 0;
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
      />
      {duration !== null && Number.isFinite(duration) && duration > 0 && (
        <span className={styles.duration} aria-hidden="true">{formatClock(duration)}</span>
      )}
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

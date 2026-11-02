import { reducedMotionStore } from './mediaQueryStore';

/**
 * Read a motion-duration CSS token at the point an animation starts, so a JS
 * timer that waits on a CSS animation never drifts from it. Under reduced
 * motion every animation runs at `--dur-reduced`.
 */
export function motionDurationMs(token: '--dur-overlay' | '--dur-sheet', fallbackMs: number): number {
  const reduced = reducedMotionStore.matches();
  const fallback = reduced ? 80 : fallbackMs;
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return fallback;

  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(reduced ? '--dur-reduced' : token).trim();
  const match = /^([\d.]+)(ms|s)$/.exec(value);
  if (!match) return fallback;
  const ms = Number(match[1]) * (match[2] === 's' ? 1000 : 1);
  return Number.isFinite(ms) && ms >= 0 ? ms : fallback;
}

/** Read the exit animation's CSS token at the point it starts. */
export function overlayExitDurationMs(): number {
  return motionDurationMs('--dur-overlay', 160);
}

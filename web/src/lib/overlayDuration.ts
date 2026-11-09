/**
 * Read a motion-duration CSS token at the point an animation starts, so a JS
 * timer that waits on a CSS animation never drifts from it. Under reduced
 * motion the reduced-motion rule set in styles/motion.css already redefines
 * every `--dur-*` token to `--dur-reduced`, so the computed value is the one
 * the animation runs with; nothing is swapped here. The fallback is for
 * environments without computed styles (tests).
 */
export function motionDurationMs(token: '--dur-overlay' | '--dur-sheet', fallbackMs: number): number {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return fallbackMs;

  const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  const match = /^([\d.]+)(ms|s)$/.exec(value);
  if (!match) return fallbackMs;
  const ms = Number(match[1]) * (match[2] === 's' ? 1000 : 1);
  return Number.isFinite(ms) && ms >= 0 ? ms : fallbackMs;
}

/** Read the exit animation's CSS token at the point it starts. */
export function overlayExitDurationMs(): number {
  return motionDurationMs('--dur-overlay', 160);
}

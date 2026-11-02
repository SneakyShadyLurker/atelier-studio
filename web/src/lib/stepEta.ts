import type { TileProgress } from '../store/atelier';
import { formatClock } from './clock';

/** Progress events needed before the rate is trusted for an ETA. */
export const ETA_MIN_OBSERVATIONS = 3;
const ETA_FLOOR_MS = 1_000;
const STEP_MS_MIN = 120;
const STEP_MS_MAX = 1_500;

/** The last pass's final step: sampling is done, decode and save remain. */
export function isFinishing(entry: TileProgress): boolean {
  return entry.step !== undefined && entry.step === entry.totalSteps && entry.pass === entry.passCount;
}

/**
 * Remaining milliseconds for a sampling tile, counting down from the latest
 * progress event, or null while the rate is not yet reliable (fewer than
 * three observations, unknown rate) or once the tile is finishing.
 */
export function remainingMs(entry: TileProgress, now: number): number | null {
  if (entry.observations < ETA_MIN_OBSERVATIONS || entry.msPerUnit === null || isFinishing(entry)) return null;
  const remaining = (1 - entry.progress) * entry.msPerUnit - Math.max(0, now - entry.lastAt);
  return Math.max(ETA_FLOOR_MS, remaining);
}

function etaSeconds(ms: number): number {
  return Math.max(1, Math.round(ms / 1000));
}

/** `~9s` under a minute, otherwise `~m:ss`. */
export function formatEta(ms: number): string {
  const seconds = etaSeconds(ms);
  return seconds < 60 ? `~${String(seconds)}s` : `~${formatClock(seconds)}`;
}

/** Spoken form for `aria-valuetext`: "about 9 seconds left". */
export function describeEta(ms: number): string {
  const seconds = etaSeconds(ms);
  const unit = (count: number, word: string) => `${String(count)} ${word}${count === 1 ? '' : 's'}`;
  if (seconds < 60) return `about ${unit(seconds, 'second')} left`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `about ${unit(minutes, 'minute')}${rest > 0 ? ` ${unit(rest, 'second')}` : ''} left`;
}

/**
 * Measured duration of one sampler step (rate × the latest advance), clamped
 * so the bar glide stays calm; null until a rate exists.
 */
export function stepDurationMs(entry: TileProgress): number | null {
  if (entry.msPerUnit === null || entry.lastDelta === null) return null;
  return Math.min(STEP_MS_MAX, Math.max(STEP_MS_MIN, Math.round(entry.msPerUnit * entry.lastDelta)));
}

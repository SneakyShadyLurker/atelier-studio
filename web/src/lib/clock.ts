/** Format a whole-second duration as `m:ss` with tabular-friendly padding. */
export function formatClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${String(minutes)}:${String(seconds).padStart(2, '0')}`;
}

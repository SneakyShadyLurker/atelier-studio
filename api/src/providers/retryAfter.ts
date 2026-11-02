export function parseRetryAfterMs(value: string | null, nowMs = Date.now()): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;

  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10) * 1000;
  }

  const dateMs = Date.parse(trimmed);
  if (!Number.isFinite(dateMs)) return undefined;
  return Math.max(0, dateMs - nowMs);
}

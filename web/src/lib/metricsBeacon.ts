import { API_BASE } from '../api/client';

// Fire-and-forget POST to the api's `/_metrics` sink. Skipped under Bun (tests),
// opaque origins and browsers without sendBeacon; never throws, because the
// observability transport must not perturb the user session.
export function sendMetricBeacon(payload: object): void {
  if (
    typeof Bun !== 'undefined'
    || typeof window === 'undefined'
    || window.location.origin === 'null'
    || typeof navigator.sendBeacon !== 'function'
  ) return;
  try {
    navigator.sendBeacon(`${API_BASE}/_metrics`, new Blob([JSON.stringify(payload)], { type: 'application/json' }));
  } catch {
    // Best-effort reporting.
  }
}

// Local-pool host gate. The local pool runs on one ComfyUI host with no
// failover, so a host that is briefly unreachable (a supervised worker restart
// takes 30-60 s) must pause the local queue instead of failing it. The pause
// itself is the shared per-pool upstream gate; this module decides when the
// local pool opens and closes it.
//
// Two signals open it:
//  - the health probe reports a host-level transition (wired at boot to
//    noteLocalHostAvailability), and closes it again on recovery;
//  - a local generation fails with a transport-class error. A refused
//    connection fails in milliseconds, long before the next probe round, so
//    without this the queue could drain through fast failures. That batch
//    still fails; a forced probe then decides whether the pause holds.
//
// Row-level unavailability (missing weights, CLIP type, node classes) never
// pauses: waiting does not fix it, so dequeue keeps failing those batches.
//
// In-memory by design: after an API restart the seed snapshot means "try the
// host", and the first transport failure or probe round re-establishes the
// pause for the rebuilt queue.

import { PrivacyRequestError } from '../providers/comfyui/privacy';
import { noteBreakerState } from './upstreamGate';

export interface LocalHostGateWiring {
  /** True when the latest committed probe for this model failed at host level. */
  hostUnavailable(modelId: string): boolean;
  /** Forces a probe so the snapshot catches up with a generation-time failure. */
  probeNow(modelId: string): Promise<unknown>;
}

let wiring: LocalHostGateWiring | null = null;

export function configureLocalHostGate(w: LocalHostGateWiring): void {
  wiring = w;
}

export function resetLocalHostGateForTests(): void {
  wiring = null;
}

export function localHostUnavailable(modelId: string): boolean {
  return wiring?.hostUnavailable(modelId) ?? false;
}

// Called on host-level snapshot transitions, and by dequeue when it holds a
// head whose host is down while the gate is closed (after a ceiling, or before
// the transition callback ran). Both directions are idempotent in the gate.
export function noteLocalHostAvailability(available: boolean): void {
  noteBreakerState('local', available ? 'closed' : 'open');
}

// Errors that prove the request never reached a listening host. Bun reports
// socket failures as errors carrying a POSIX-style `code`; a gateway status
// from the privacy endpoint means the worker behind it is not answering.
// Timeouts are excluded: the lease admission wait legitimately runs long
// behind a busy worker, and the probe catches a hung host on its own.
const TRANSPORT_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'EHOSTUNREACH', 'EHOSTDOWN',
  'ENETUNREACH', 'ENETDOWN', 'EPIPE', 'ConnectionRefused', 'ConnectionClosed', 'FailedToOpenSocket',
]);
const GATEWAY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

export function isHostTransportError(error: unknown): boolean {
  if (error instanceof PrivacyRequestError) return GATEWAY_STATUSES.has(error.status);
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return typeof error.code === 'string' && TRANSPORT_CODES.has(error.code);
}

export function noteLocalGenerationFailure(modelId: string, error: unknown): void {
  const w = wiring;
  if (!w || !isHostTransportError(error)) return;
  // Open synchronously: the failed tile's slot release kicks the queue in a
  // later microtask, and that kick must already see the pause.
  noteLocalHostAvailability(false);
  void w.probeNow(modelId).then(() => {
    // A probe that reached the host (ok or row-level) ends this pause; a
    // host-level result leaves it to the probe's own recovery transition.
    if (wiring === w && !w.hostUnavailable(modelId)) noteLocalHostAvailability(true);
  }, () => {
    // probeNow resolves on every failure; the gate ceiling still bounds a pause.
  });
}

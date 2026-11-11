import { KEEPALIVE_MS, sseComment, sseEvent } from './sse';

// Shared SSE stream lifecycle for long-running LLM routes (/enhance-prompt,
// /prompts/dimensions/infer). Owns the encoder, the closed-flag guard, the
// keepalive interval, the client-disconnect↔timeout abort bridge, and the
// teardown — everything except the route-specific work. The route supplies a
// `run` body that receives `send` + the composed `signal` and does its own
// error logging (the safe-message wording differs per route).

// Identity sentinel: a timeout abort is distinguishable from a client
// disconnect by `signal.reason === LLM_SSE_TIMEOUT` rather than a mutable
// flag the type-aware lint can't see written.
const LLM_SSE_TIMEOUT = new Error('llm sse upstream timeout');

// Backpressure (same model as /batches/:id/events). Keepalives are optional
// and skipped once the queue reaches the mark; data frames are never dropped.
// A reader that falls this far behind the mark is treated as gone: the route
// ends through the disconnect path so the upstream call is aborted instead of
// buffering a long brainstorm for nobody.
const LLM_SSE_HIGH_WATER_MARK_BYTES = 256 * 1024;
const LLM_SSE_MAX_OVERFLOW_BYTES = 4 * 1024 * 1024;
const LLM_SSE_STALLED_READER = new DOMException('sse reader stalled', 'AbortError');

export interface LlmSseContext {
  /** Emit one `event:`/`data:` SSE frame (no-op once the stream is closed). */
  readonly send: (event: string, data: unknown) => void;
  /** Composed signal: aborts on client disconnect OR after `timeoutMs`. */
  readonly signal: AbortSignal;
  /** Abort the composed signal with a route-defined reason (e.g. batch failure). */
  readonly abort: (reason: unknown) => void;
  /** True once the duration cap fired (vs a client disconnect / route abort). */
  readonly timedOut: () => boolean;
  /** True once the client disconnected — route error paths stay silent then. */
  readonly clientDisconnected: () => boolean;
}

export function createLlmSseStream(
  opts: { readonly timeoutMs: number; readonly disconnect: AbortSignal },
  run: (ctx: LlmSseContext) => Promise<void>,
): ReadableStream<Uint8Array> {
  const { timeoutMs, disconnect } = opts;
  let ac: AbortController | undefined;
  let cleanup: (() => void) | undefined;
  let closed = false;
  let readerStalled = false;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const safeEnqueue = (s: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          closed = true;
          return;
        }
        if ((controller.desiredSize ?? 0) < -LLM_SSE_MAX_OVERFLOW_BYTES) {
          readerStalled = true;
          closed = true;
          ac?.abort(LLM_SSE_STALLED_READER);
          // Erroring discards the queued frames the reader is not taking.
          controller.error(LLM_SSE_STALLED_READER);
        }
      };
      const send = (event: string, data: unknown): void => { safeEnqueue(sseEvent(event, data)); };
      const sendKeepalive = (): void => {
        if ((controller.desiredSize ?? 1) <= 0) return;
        safeEnqueue(sseComment());
      };

      const routeAc = new AbortController();
      ac = routeAc;
      const onClientAbort = (): void => { routeAc.abort(disconnect.reason); };
      if (disconnect.aborted) {
        routeAc.abort(disconnect.reason);
      } else {
        disconnect.addEventListener('abort', onClientAbort, { once: true });
      }
      const timer = setTimeout(() => { routeAc.abort(LLM_SSE_TIMEOUT); }, timeoutMs);
      // Architecture invariant (docs/architecture.md): emit `:keepalive` every
      // 15s so an intermediary (Cloudflare edge, nginx, browser) doesn't
      // read-timeout during the model's pre-first-token reasoning phase.
      const keepalive = setInterval(sendKeepalive, KEEPALIVE_MS);
      cleanup = () => {
        clearTimeout(timer);
        clearInterval(keepalive);
        disconnect.removeEventListener('abort', onClientAbort);
      };

      try {
        await run({
          send,
          signal: routeAc.signal,
          abort: (reason) => { routeAc.abort(reason); },
          timedOut: () => routeAc.signal.reason === LLM_SSE_TIMEOUT,
          clientDisconnected: () => disconnect.aborted || readerStalled,
        });
      } finally {
        cleanup();
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
    cancel(reason) {
      if (closed) return;
      closed = true;
      ac?.abort(reason ?? new DOMException('stream canceled', 'AbortError'));
      cleanup?.();
    },
  }, new ByteLengthQueuingStrategy({ highWaterMark: LLM_SSE_HIGH_WATER_MARK_BYTES }));
}

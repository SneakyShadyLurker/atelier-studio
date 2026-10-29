import type { BatchEvent, DoneEvent, QueueEvent, TileEvent } from '@atelier/shared';

export const KEEPALIVE_MS = 15_000;

// No `id:` or `retry:` field on emitted frames by design: the web client
// uses fetch + AbortController, not EventSource auto-reconnect. On resume
// tile state is reconciled via the DB-backed /history query, so
// Last-Event-ID has nothing to resume to.
export function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const encoder = new TextEncoder();

// Build a wire-ready SSE frame as bytes. Single owner of the
// `new TextEncoder().encode(sseEvent(...))` pattern that was copy-pasted
// across the orchestrator + route modules.
export function encodeSseFrame(event: string, data: unknown): Uint8Array {
  return encoder.encode(sseEvent(event, data));
}

export type TerminalTileEvent = Extract<TileEvent, { status: 'done' | 'failed' | 'canceled' }>;

// Dedup identity of a terminal bus frame. /batches/:id/events keeps exactly
// one frame per terminal tile, one `done` and one `batch` per stream; `null`
// (queue status) passes through undeduped.
export type TerminalFrameKey =
  | { readonly event: 'tile'; readonly tileId: string }
  | { readonly event: 'done' | 'batch' };

// A terminal bus message: wire-ready bytes plus the dedup key the producer
// already knows, so subscribers never re-parse the bytes.
export interface TerminalFrame {
  readonly bytes: Uint8Array;
  readonly key: TerminalFrameKey | null;
}

export function terminalFrame(event: 'tile', data: TerminalTileEvent): TerminalFrame;
export function terminalFrame(event: 'done', data: DoneEvent): TerminalFrame;
export function terminalFrame(event: 'batch', data: BatchEvent): TerminalFrame;
export function terminalFrame(event: 'queue', data: QueueEvent): TerminalFrame;
export function terminalFrame(
  event: 'tile' | 'done' | 'batch' | 'queue',
  data: TerminalTileEvent | DoneEvent | BatchEvent | QueueEvent,
): TerminalFrame {
  const bytes = encodeSseFrame(event, data);
  if (event === 'tile') return { bytes, key: { event, tileId: (data as TerminalTileEvent).tileId } };
  if (event === 'queue') return { bytes, key: null };
  return { bytes, key: { event } };
}

export function sseComment(comment = 'keepalive'): string {
  return `:${comment}\n\n`;
}

export function encodeSseComment(comment?: string): Uint8Array {
  return encoder.encode(sseComment(comment));
}

export function sseHeaders(): Record<string, string> {
  return {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Belt-and-braces against any intermediary that would otherwise gzip
    // text/event-stream and buffer until flush boundaries. SWAG's
    // proxy_buffering off already covers it; this defends if the deploy
    // ever moves behind a different proxy.
    'Content-Encoding': 'identity',
    'X-Accel-Buffering': 'no',
  };
}

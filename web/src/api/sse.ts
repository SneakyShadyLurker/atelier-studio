import { SseTerminalErrorSchema, TILE_MIMES } from '@atelier/shared';
import { nextSseFrame, parseSseFrame } from '@atelier/shared/sse';
import type { BatchEvent, BrainstormSseEvent, DoneEvent, EnhanceSseEvent, QueueEvent, TileEvent } from '@atelier/shared';
import type { SseFrame } from '@atelier/shared/sse';
import { ApiError, apiFetch, extractApiError, request, responseRequestId } from './client';
import { isMediaPair, isRecord, isTileErrorCategory } from '../lib/guards';
import { GptModerationNoticeSchema } from '@atelier/shared';
import { ModerationError, useModerationNotice } from '../lib/moderationNotice';

export class QuotaExhaustedError extends Error {
  constructor(readonly retryAfterSeconds: number | null) {
    super('Codex quota exhausted');
    this.name = 'QuotaExhaustedError';
  }
}

// Variant that operates on an already-parsed value (avoids double parse in
// handlers that receive the frame payload as `unknown` rather than raw string).
export function parseTerminalSseErrorFromData(data: unknown): Error {
  const parsed = SseTerminalErrorSchema.safeParse(data);
  if (parsed.success && parsed.data.moderation) return new ModerationError(parsed.data.moderation);
  if (parsed.success && parsed.data.code === 'quota-exhausted') {
    return new QuotaExhaustedError(parsed.data.retryAfterSeconds ?? null);
  }
  return new Error(parsed.success ? parsed.data.message : 'request failed');
}

// Variant that accepts the raw SSE frame data string.
export function parseTerminalSseError(data: string): Error {
  try {
    return parseTerminalSseErrorFromData(JSON.parse(data));
  } catch {
    return new Error('request failed');
  }
}

export type { SseFrame };

export type GenerateSseEvent =
  | { event: 'batch'; data: BatchEvent }
  | { event: 'queue'; data: QueueEvent }
  | { event: 'tile'; data: TileEvent }
  | { event: 'done'; data: DoneEvent };

interface ReadSseFramesOptions {
  onRead?: () => void;
}

// Whitelist for partial-preview data URLs. The api enforces the same
// constraint (per output_format) at egress; this is the second line of
// defence in case any other code path ever forwards a `partial` event
// without going through the api validator. Derived from TILE_MIMES, so a new
// tile mime is automatically an allowed preview format too.
const allowedPreviewPrefixes = TILE_MIMES.map((mime) => `data:${mime};base64,`);
function isAllowedPreviewDataUrl(value: string): boolean {
  return allowedPreviewPrefixes.some((prefix) => value.startsWith(prefix) && value.length > prefix.length);
}

function isBatchEvent(value: unknown): value is BatchEvent {
  return isRecord(value)
    && typeof value.batchId === 'string'
    && typeof value.createdAt === 'number'
    && (value.startedAt === undefined || typeof value.startedAt === 'number')
    && Array.isArray(value.tiles)
    && value.tiles.every((tile) => isRecord(tile) && typeof tile.tileId === 'string' && typeof tile.tileIndex === 'number' && typeof tile.seed === 'number')
    && (value.status === undefined || value.status === 'queued' || value.status === 'running' || value.status === 'done')
    && (value.queueLengthAhead === undefined || typeof value.queueLengthAhead === 'number')
    && (value.refImageIds === undefined
        || (Array.isArray(value.refImageIds)
            && value.refImageIds.every((id) => typeof id === 'string')));
}

function isQueueEvent(value: unknown): value is QueueEvent {
  return isRecord(value)
    && typeof value.batchId === 'string'
    && value.status === 'running'
    && (value.startedAt === undefined || typeof value.startedAt === 'number');
}

export function isTileEvent(value: unknown): value is TileEvent {
  if (!isRecord(value) || typeof value.tileId !== 'string' || typeof value.tileIndex !== 'number') return false;
  if (value.status === 'partial') {
    return typeof value.preview === 'string'
      && isAllowedPreviewDataUrl(value.preview)
      && typeof value.index === 'number';
  }
  if (value.status === 'progress') {
    return typeof value.progress === 'number'
      && Number.isFinite(value.progress)
      && value.progress >= 0
      && value.progress <= 1
      && (value.phase === undefined || typeof value.phase === 'string');
  }
  if (typeof value.completedAt !== 'number') return false;
  if (value.status === 'canceled') return true;
  if (value.status === 'failed') return isTileErrorCategory(value.error)
    && (value.moderation === undefined || GptModerationNoticeSchema.safeParse(value.moderation).success);
  return value.status === 'done'
    && typeof value.url === 'string'
    && (value.thumbUrl === undefined || typeof value.thumbUrl === 'string')
    && isMediaPair(value.ext, value.mime);
}

function isDoneEvent(value: unknown): value is DoneEvent {
  return isRecord(value) && typeof value.batchId === 'string';
}

export function toGenerateEvent(frame: SseFrame | undefined): GenerateSseEvent {
  if (!frame) throw new Error('missing SSE frame');
  const data = JSON.parse(frame.data) as unknown;
  if (frame.event === 'batch' && isBatchEvent(data)) return { event: 'batch', data };
  if (frame.event === 'queue' && isQueueEvent(data)) return { event: 'queue', data };
  if (frame.event === 'tile' && isTileEvent(data)) return { event: 'tile', data };
  if (frame.event === 'done' && isDoneEvent(data)) return { event: 'done', data };
  if (frame.event !== 'batch' && frame.event !== 'queue' && frame.event !== 'tile' && frame.event !== 'done') throw new Error(`unknown SSE event: ${frame.event}`);
  throw new Error(`invalid ${frame.event} SSE payload`);
}

export async function* readSseFrames(
  stream: ReadableStream<Uint8Array>,
  options: Readonly<ReadSseFramesOptions> = {},
): AsyncGenerator<SseFrame> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const shownModeration = new Set<string>();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (let next = nextSseFrame(buffer); next; next = nextSseFrame(buffer)) {
        buffer = next.rest;
        options.onRead?.();
        const frame = parseSseFrame(next.raw);
        if (frame) {
          // One presentation per reason per stream, even for multi-tile batches.
          // The typed error/tile still follows the normal terminal lifecycle.
          // A notice only shows when `data.moderation` parses, so frames that
          // cannot carry one (e.g. large partial-preview tiles) skip the sniff
          // instead of paying for a second JSON parse and validation.
          if ((frame.event === 'error' || frame.event === 'tile' || frame.event === 'rescue-failed')
            && frame.data.includes('"moderation"')) {
            try {
              const data: unknown = JSON.parse(frame.data);
              const notice = GptModerationNoticeSchema.safeParse(isRecord(data) ? data.moderation : undefined);
              const terminal = frame.event === 'tile'
                ? isTileEvent(data) && data.status === 'failed'
                : frame.event === 'error'
                  ? SseTerminalErrorSchema.safeParse(data).success
                  : isRecord(data) && data.reason === 'upstream-error';
              if (terminal && notice.success) {
                const key = `${notice.data.target}:${notice.data.reason}:${notice.data.categories?.slice().sort().join(',') ?? ''}`;
                if (!shownModeration.has(key)) {
                  shownModeration.add(key);
                  useModerationNotice.getState().show(notice.data);
                }
              }
            } catch { /* Terminal parsing below remains authoritative. */ }
          }
          yield frame;
        }
      }
    }
  } finally {
    // cancel() (not releaseLock()) so abandoning this generator without an
    // accompanying fetch abort still tears down the underlying response body.
    // Matches the api-side SSE primitive (api/src/providers/_sse.ts).
    await reader.cancel().catch(() => { /* best-effort body teardown */ });
  }
}

export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
  options: Readonly<ReadSseFramesOptions> = {},
): AsyncGenerator<GenerateSseEvent> {
  for await (const frame of readSseFrames(stream, options)) {
    yield toGenerateEvent(frame);
  }
}

function toEnhanceEvent(frame: SseFrame): EnhanceSseEvent {
  const data = JSON.parse(frame.data) as unknown;
  if (frame.event === 'delta' && isRecord(data) && typeof data.text === 'string') {
    return { event: 'delta', data: { text: data.text } };
  }
  if (frame.event === 'done') return { event: 'done', data: {} };
  if (frame.event === 'error') {
    throw parseTerminalSseError(frame.data);
  }
  if (frame.event !== 'delta' && frame.event !== 'done') {
    throw new Error(`unknown SSE event: ${frame.event}`);
  }
  throw new Error(`invalid ${frame.event} SSE payload`);
}

export async function* parseEnhanceStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<EnhanceSseEvent> {
  for await (const frame of readSseFrames(stream)) {
    yield toEnhanceEvent(frame);
  }
}

function toBrainstormEvent(frame: SseFrame): BrainstormSseEvent {
  const data = JSON.parse(frame.data) as unknown;
  if (frame.event === 'prompt' && isRecord(data) && typeof data.index === 'number' && typeof data.text === 'string') {
    return { event: 'prompt', data: { index: data.index, text: data.text } };
  }
  if (frame.event === 'done' && isRecord(data) && typeof data.count === 'number') {
    return { event: 'done', data: { count: data.count } };
  }
  if (frame.event === 'error') {
    throw parseTerminalSseError(frame.data);
  }
  if (frame.event !== 'prompt' && frame.event !== 'done') {
    throw new Error(`unknown SSE event: ${frame.event}`);
  }
  throw new Error(`invalid ${frame.event} SSE payload`);
}

export async function* parseBrainstormStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<BrainstormSseEvent> {
  for await (const frame of readSseFrames(stream)) {
    yield toBrainstormEvent(frame);
  }
}

// Open a POST request whose response is an SSE stream. Owns the shared
// preamble — ok-check (JSON error envelope → ApiError), content-type
// assertion, body presence — so every streaming module pipes the returned
// stream into its own event parser instead of re-rolling the checks.
export async function openSseStream(
  path: string,
  body: unknown,
  label: string,
  signal?: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const init: RequestInit = {
    method: 'POST',
    headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
  if (signal) init.signal = signal;
  const response = await apiFetch(path, init);
  if (!response.ok) {
    const details = await extractApiError(response, `${label} failed`);
    throw new ApiError(response.status, details.message, details.body, responseRequestId(response));
  }
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    throw new ApiError(response.status, 'unexpected response content-type', undefined, responseRequestId(response));
  }
  if (!response.body) throw new Error(`${label} response did not include a stream`);
  return response.body;
}

// A resolver for a single SSE terminal frame: it either returns the result
// (resolving the consumer) or throws (rejecting it). The frame data is parsed
// once before dispatch.
export type SseTerminalHandler<T> = (data: unknown) => T;

// Shared consumer for SSE responses that carry their result in a single
// terminal frame (the long-LLM draft/rescue routes — see api/src/lifecycle
// /llm-sse.ts). `handlers` maps an event name to its resolver; the first
// matching frame terminates the stream. Unmatched events are skipped so
// keepalive/progress frames pass through. If the body closes without any
// handler firing, throws ApiError(streamEndedMessage).
export async function consumeSseResult<T>(
  body: ReadableStream<Uint8Array>,
  status: number,
  reqId: string | undefined,
  handlers: Readonly<Record<string, SseTerminalHandler<T>>>,
  streamEndedMessage: string,
  advisoryHandlers?: Readonly<Record<string, (data: unknown) => void>>,
): Promise<T> {
  for await (const frame of readSseFrames(body)) {
    const advisoryHandler = advisoryHandlers?.[frame.event];
    if (advisoryHandler) {
      try {
        advisoryHandler(JSON.parse(frame.data));
      } catch {
        // Advisory frames are decoration: malformed data or a consumer failure
        // must never change the stream's terminal outcome.
      }
      continue;
    }
    const handler = handlers[frame.event];
    if (!handler) continue;
    let data: unknown;
    try {
      data = JSON.parse(frame.data);
    } catch {
      // A malformed terminal frame still rejects with a typed ApiError, not a
      // raw SyntaxError (matches parseTerminalSseError's graceful behavior).
      throw new ApiError(status, `malformed ${frame.event} SSE frame`, undefined, reqId);
    }
    return handler(data);
  }
  throw new ApiError(status, streamEndedMessage, undefined, reqId);
}

export interface RequestSseResultOptions<T> {
  signal?: AbortSignal;
  guard: (value: unknown) => value is T;
  noBodyMessage: string;
  invalidPayloadMessage: string;
  errorFallback: string;
  streamEndedMessage: string;
}

// POST a request whose result streams back as SSE (long upstream LLM call vs
// the Cloudflare ~100s edge cutoff). Pre-LLM validation still returns plain
// JSON errors (4xx) — `request()` throws ApiError for those. The single `done`
// frame is validated via `guard` and relayed as the resolved payload so
// callers keep their original `Promise<T>` contract; an `error` frame rejects.
export async function requestSseResult<T>(
  path: string,
  body: unknown,
  options: Readonly<RequestSseResultOptions<T>>,
): Promise<T> {
  const init: RequestInit = {
    method: 'POST',
    headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
  if (options.signal) init.signal = options.signal;
  const response = await request(path, init);
  const reqId = responseRequestId(response);
  if (!response.body) throw new ApiError(response.status, options.noBodyMessage, undefined, reqId);
  return consumeSseResult<T>(response.body, response.status, reqId, {
    done: (data) => {
      if (options.guard(data)) return data;
      throw new ApiError(response.status, options.invalidPayloadMessage, undefined, reqId);
    },
    error: (data) => {
      throw parseTerminalSseErrorFromData(data);
    },
  }, options.streamEndedMessage);
}

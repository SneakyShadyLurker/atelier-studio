import type { TileExt, TileMime } from '@atelier/shared';
import { toTileMime } from './types';
import { NOOP_PROVIDER_LOGGER, type Provider, type ProviderLogger, type ProviderRequest, type ProviderResult } from './types';
import { errorToRawString as providerErrorRaw, readBodyBounded as readBodyBoundedShared, tryParseJson } from './_http';
import { frameDataText, readSseFrames } from './_sse';
import { createRefMemo } from './_refMemo';
import {
  ERROR_PATTERN_DID_NOT_RETURN_IMAGE,
  ERROR_PATTERN_MODERATION,
  ERROR_PATTERN_STREAM_DISCONNECTED_TEXT,
} from './_errorPatterns';
import { sniffImage } from '../storage/imageSniff';
import { parseRetryAfterMs } from './retryAfter';
import {
  CLIPROXY_AUTHORIZATION_HEADER,
  CLIPROXY_DEFAULTS,
  CLIPROXY_EDITS_PATH,
  CLIPROXY_GENERATIONS_PATH,
  CLIPROXY_MODEL_ID,
  CLIPROXY_RATIO_SIZES,
  type CliproxyOutputFormat,
  type CliproxyQuality,
} from './cliproxy.config';
import type { ProviderErrorReason } from './types';
import { GptModerationError, moderateGptInput } from '../routing/gptModeration';

export interface CliproxyProviderConfig {
  baseUrl: string;
  token: string;
  /** Operational events; defaults to a no-op logger. */
  logger?: ProviderLogger;
  openrouterApiKey?: string | undefined;
  // Hard ceiling on response body bytes the provider will buffer. A
  // misbehaving / compromised upstream that returns an unbounded SSE stream
  // would otherwise blow through RAM and the disk volume. Counts the entire
  // SSE response (partials + completed), not just the final image.
  maxResponseBytes: number;
  quality?: CliproxyQuality;
  outputFormat?: CliproxyOutputFormat;
  /** 0..3 — number of partial preview frames upstream may emit before completion. */
  partialImages?: number;
}

export class CliproxyResponseTooLargeError extends Error {
  constructor(readonly limit: number, readonly seenBytes: number) {
    super(`CLIProxyAPI response exceeded ${limit} bytes (saw ${seenBytes})`);
    this.name = 'CliproxyResponseTooLargeError';
  }
}

interface CliproxyPartialPayload {
  type?: string;
  partial_image_index?: number;
  partial_image_b64?: string;
  b64_json?: string;
  url?: string;
}

interface ResponsesImageOutput {
  type?: string;
  result?: string;
  revised_prompt?: string;
}

interface CliproxyCompletedPayload {
  type?: string;
  b64_json?: string;
  url?: string;
  revised_prompt?: string;
  response?: { output?: ResponsesImageOutput[] };
}

// Single-shot /v1/images/* response body (the OpenAI images shape). Newer
// CLIProxyAPI builds emit this raw — see sniffImagesFraming.
interface CliproxyRawImagesResponse {
  data?: CliproxyCompletedPayload[];
  error?: { message?: string; type?: string };
}

interface CliproxyErrorPayload {
  error?: { message?: string; type?: string };
}

// In-stream `event: error` classification (see the error branch in generate()).
// Match order is load-bearing:
//   1. policy — a moderation refusal must never be retried or relabeled.
//   2. no-image — "upstream did not return image output" is how gpt-image-2
//      output-stage moderation usually manifests on the Codex path. Its body
//      carries type:"server_error", so the server-class pattern would claim
//      it; it must stay non-retriable (typed like Gemini's NO_IMAGE) or
//      moderation storms would burn retry budget and trip the pool breaker.
//   3. rate-limit / server-class — genuine infra failures, stamped with a
//      transient status so the resilient wrapper retries first-yield
//      occurrences and exhaustion lands on 'service unavailable'.
const IN_STREAM_POLICY_PATTERN = ERROR_PATTERN_MODERATION;
const IN_STREAM_NO_IMAGE_PATTERN = ERROR_PATTERN_DID_NOT_RETURN_IMAGE;
const IN_STREAM_RATE_LIMIT_PATTERN = /\b(rate[-_\s]?limit(?:_exceeded|ed)?|usage_limit_reached|at capacity)\b/i;
const IN_STREAM_SERVER_PATTERN =
  new RegExp(`\\b(auth_unavailable|auth_not_found|no auth available|internal_server_error|server_error|${ERROR_PATTERN_STREAM_DISCONNECTED_TEXT})\\b`, 'i');

type InStreamErrorClass = 'policy' | 'no-image' | 'rate-limit' | 'server' | 'unknown';

function classifyInStreamError(raw: string): InStreamErrorClass {
  if (IN_STREAM_POLICY_PATTERN.test(raw)) return 'policy';
  if (IN_STREAM_NO_IMAGE_PATTERN.test(raw)) return 'no-image';
  if (IN_STREAM_RATE_LIMIT_PATTERN.test(raw)) return 'rate-limit';
  if (IN_STREAM_SERVER_PATTERN.test(raw)) return 'server';
  return 'unknown';
}

function inStreamErrorReason(raw: string): ProviderErrorReason {
  switch (classifyInStreamError(raw)) {
    case 'no-image':
      return { kind: 'no-image', raw };
    case 'rate-limit':
      return { kind: 'http', status: 429, raw };
    case 'server':
      return { kind: 'http', status: 502, raw };
    case 'policy':
    case 'unknown':
      return { kind: 'http', status: 400, raw };
  }
}

export function createCliproxyProvider(config: CliproxyProviderConfig): Provider {
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  const outputFormat = config.outputFormat ?? CLIPROXY_DEFAULTS.outputFormat;
  const quality = config.quality ?? CLIPROXY_DEFAULTS.quality;
  const partialImages = clampPartialImages(config.partialImages ?? CLIPROXY_DEFAULTS.partialImages);
  const logger = config.logger ?? NOOP_PROVIDER_LOGGER;
  let warnedMissingPartials = false;
  const warnMissingPartials = (): void => {
    if (partialImages === 0 || warnedMissingPartials) return;
    warnedMissingPartials = true;
    // No prompt, image data, URL, token, or provider body is logged. This
    // distinguishes a healthy terminal with no upstream preview capability
    // from an Atelier parsing/delivery failure.
    logger.warn(
      { event: 'cliproxy_image_stream_completed_without_partials', requested: partialImages },
      'image stream completed without partial previews',
    );
  };
  // Same refImages array per batch (orchestrator forwards by reference) —
  // memoize the base64 data-URL build so an N-tile batch encodes refs once,
  // not N×. See createRefMemo.
  type CliproxyRefList = NonNullable<ProviderRequest['refImages']>;
  const refPayloadMemo = createRefMemo<CliproxyRefList, { image_url: string }[]>();

  return {
    id: CLIPROXY_MODEL_ID,
    backend: 'cloud',
    async *generate(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderResult> {
      try {
        await moderateGptInput(config.openrouterApiKey, { task: 'image-generation', input: req.prompt }, signal);
      } catch (error) {
        if (!(error instanceof GptModerationError)) throw error;
        // No HTTP status/cause: this local decision must not trigger GPT's
        // retry policy or circuit breaker. The typed reason owns UI mapping.
        yield {
          status: 'failed', seed: req.seed, index: 0,
          error: { moderation: error.moderation, reason: {
            kind: error.kind === 'moderation-blocked' ? 'policy' : 'service-unavailable',
          } satisfies ProviderErrorReason },
        };
        return;
      }
      const refImages = req.refImages ?? [];
      const hasRefImages = refImages.length > 0;
      const body: Record<string, unknown> = {
        model: CLIPROXY_MODEL_ID,
        prompt: req.prompt,
        size: CLIPROXY_RATIO_SIZES[req.ratio],
        quality,
        output_format: outputFormat,
        moderation: CLIPROXY_DEFAULTS.moderation,
        stream: true,
        partial_images: partialImages,
      };
      if (hasRefImages) {
        body.images = await refPayloadMemo.get(refImages, (refs) =>
          Promise.resolve(buildReferenceImagePayloads(refs)),
        );
        body.response_format = 'b64_json';
      }

      let response: Response;
      try {
        response = await fetch(`${baseUrl}${hasRefImages ? CLIPROXY_EDITS_PATH : CLIPROXY_GENERATIONS_PATH}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            [CLIPROXY_AUTHORIZATION_HEADER]: `Bearer ${config.token}`,
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        yield { status: 'failed', error: { status: null, cause: error }, seed: req.seed, index: 0 };
        return;
      }

      if (!response.ok) {
        // Errors come back as a single non-SSE JSON body. Buffer it
        // (bounded) so the orchestrator gets a structured error instead of
        // raw bytes.
        let errorBody: string | Error;
        try {
          errorBody = await readBodyBounded(response, config.maxResponseBytes, signal);
        } catch (error) {
          if (signal.aborted) throw error;
          errorBody = error instanceof Error ? error : new Error(String(error));
        }
        const payload = errorBody instanceof CliproxyResponseTooLargeError
          ? errorBody.message
          : errorBody instanceof Error
            ? { cause: errorBody }
            : tryParseJson(errorBody);
        const retryAfterMs = parseRetryAfterMs(response.headers.get('Retry-After'));
        yield {
          status: 'failed',
          error: {
            status: response.status,
            error: payload,
            ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
            reason: { kind: 'http', status: response.status, raw: providerErrorRaw(payload) } satisfies ProviderErrorReason,
          },
          seed: req.seed,
          index: 0,
        };
        return;
      }

      if (!response.body) {
        yield { status: 'failed', error: 'CLIProxyAPI returned no body', seed: req.seed, index: 0 };
        return;
      }

      try {
        let sawPartial = false;
        // An abort during the sniff surfaces as a throw of signal.reason
        // (rethrown by the catch below), so no post-sniff aborted check here.
        const framing = await sniffImagesFraming(response.body, config.maxResponseBytes, signal);
        if (framing.kind === 'json') {
          const trimmed = framing.text.trim();
          if (trimmed.length === 0) {
            yield {
              status: 'failed',
              error: 'CLIProxyAPI stream ended without a completed event',
              seed: req.seed,
              index: 0,
            };
            return;
          }
          const parsed = tryParseJson(trimmed) as CliproxyRawImagesResponse | string;
          if (typeof parsed !== 'string' && parsed.error) {
            const raw = providerErrorRaw(parsed);
            const reason = inStreamErrorReason(raw);
            yield {
              status: 'failed',
              error: {
                status: reason.kind === 'http' ? reason.status : 400,
                error: parsed,
                reason,
              },
              seed: req.seed,
              index: 0,
            };
            return;
          }
          const item = typeof parsed === 'string' ? parsed : (parsed.data?.[0] ?? '');
          const final = completedResult(item, outputFormat, response.status, req.seed);
          if (final.status === 'ready') warnMissingPartials();
          yield final;
          return;
        }
        for await (const frame of readSseFrames(
          framing.stream,
          config.maxResponseBytes,
          (limit, total) => { throw new CliproxyResponseTooLargeError(limit, total); },
          signal,
        )) {
          if (signal.aborted) return;
          // Pretty-printed payload recovery (see frameDataText) runs before
          // event inference so a prefix-less multi-line JSON body can still
          // carry its own `type` field.
          const dataText = frameDataText(frame);
          // Defensive fallback: if upstream ever emits frames without an
          // `event:` line (the spec leaves room — some servers carry the
          // type only inside the JSON payload), recover by reading the
          // `type` field. cliproxy's writeEvent() always writes the
          // event line today; this is insurance against a future change.
          const eventName = frame.event === 'message' ? inferEventFromPayload(dataText) : frame.event;
          // Edits and generations differ only by SSE prefix; dispatch on behavior.
          // Error payloads carry `{ error: {...} }` with no top-level `type`,
          // so a data-only error frame (no `event:` line) cannot be inferred
          // from `type` — treat any otherwise-unclassified frame with a
          // top-level error object as terminal instead of skipping it into a
          // misleading "stream ended without a completed event".
          const normalizedEvent = normalizeEvent(eventName) ?? (hasTopLevelError(dataText) ? 'error' : null);
          if (normalizedEvent === 'partial_image') {
            const payload = tryParseJson(dataText) as CliproxyPartialPayload | string;
            const partial = extractPartialPreview(payload, outputFormat);
            if (partial) {
              sawPartial = true;
              yield { status: 'partial', preview: partial.preview, index: partial.index, batchIndex: 0, seed: req.seed };
            }
            continue;
          }
          if (normalizedEvent === 'completed') {
            const payload = tryParseJson(dataText) as CliproxyCompletedPayload | string;
            const final = completedResult(payload, outputFormat, response.status, req.seed);
            if (!sawPartial && final.status === 'ready') warnMissingPartials();
            yield final;
            return;
          }
          if (normalizedEvent === 'error') {
            const payload = tryParseJson(dataText) as CliproxyErrorPayload | string;
            // CLIProxyAPI commits HTTP 200 before the generation finishes, so
            // server-side failures (codex credential cooldown, upstream
            // returning no image, severed upstream stream, shared-org rate
            // limits) arrive as in-stream `error` frames — NOT as non-2xx
            // responses. Classify by body (see inStreamErrorReason): policy
            // and no-image refusals stay non-retriable rejections; server /
            // rate-limit class errors get a transient status so the
            // resilient wrapper retries them and exhaustion lands on
            // 'service unavailable' instead of the misleading
            // 'upstream rejected'.
            const raw = providerErrorRaw(payload);
            const reason = inStreamErrorReason(raw);
            yield {
              status: 'failed',
              error: {
                status: reason.kind === 'http' ? reason.status : 400,
                error: payload,
                reason,
              },
              seed: req.seed,
              index: 0,
            };
            return;
          }
          // Unknown event names are ignored; cliproxy may add new types over time.
        }
      } catch (error) {
        if (signal.aborted) throw error;
        yield {
          status: 'failed',
          error: error instanceof CliproxyResponseTooLargeError
            ? {
                status: response.status,
                error: error.message,
                reason: { kind: 'too-large', status: response.status, raw: error.message } satisfies ProviderErrorReason,
              }
            : { status: response.status, cause: error },
          seed: req.seed,
          index: 0,
        };
        return;
      }

      // Loop exited without an early-return = stream EOF without a
      // terminal event. Treat as failure so the orchestrator surfaces a
      // clean tile error instead of silently emitting nothing.
      yield {
        status: 'failed',
        error: 'CLIProxyAPI stream ended without a completed event',
        seed: req.seed,
        index: 0,
      };
    },
  };
}

export function buildReferenceImagePayloads(
  refImages: readonly { bytes: Uint8Array; mime: string }[],
): { image_url: string }[] {
  return refImages.map((ref) => {
    const imageUrl = `data:${ref.mime};base64,${Buffer.from(ref.bytes).toString('base64')}`;
    // CLIProxyAPI accepts arbitrary image_url values; Atelier only forwards data images it built.
    if (!imageUrl.startsWith('data:image/')) throw new Error('invalid reference image data URL');
    return { image_url: imageUrl };
  });
}

function normalizeEvent(name: string): 'partial_image' | 'completed' | 'error' | null {
  if (
    name === 'image_generation.partial_image'
    || name === 'image_edit.partial_image'
    || name === 'response.image_generation_call.partial_image'
  ) return 'partial_image';
  if (
    name === 'image_generation.completed'
    || name === 'image_edit.completed'
    || name === 'response.completed'
  ) return 'completed';
  if (name === 'error' || name === 'response.failed' || name === 'response.incomplete') return 'error';
  return null;
}

function hasTopLevelError(data: string): boolean {
  const parsed = tryParseJson(data);
  return typeof parsed === 'object' && parsed !== null && (parsed as { error?: unknown }).error != null;
}

function inferEventFromPayload(data: string): string {
  // Cheap parse + read of the `type` field. Returns 'message' (the SSE
  // default) when the payload doesn't carry a recognizable type, so the
  // caller's existing "unknown event names are ignored" path still wins.
  const parsed = tryParseJson(data);
  if (typeof parsed === 'object' && parsed !== null) {
    const type = (parsed as { type?: unknown }).type;
    if (typeof type === 'string') return type;
  }
  return 'message';
}

function clampPartialImages(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const integer = Math.floor(value);
  if (integer < 0) return 0;
  if (integer > 3) return 3;
  return integer;
}

function extractPartialPreview(
  payload: CliproxyPartialPayload | string,
  outputFormat: CliproxyOutputFormat,
): { preview: string; index: number } | null {
  if (typeof payload === 'string') return null;
  const index = typeof payload.partial_image_index === 'number' ? payload.partial_image_index : 0;
  // Strict: only accept `data:image/<format>;base64,` for the configured
  // output_format. cliproxy is upstream-of-trust but a misbehaving or
  // compromised proxy could otherwise push `data:text/html`,
  // `data:image/svg+xml`, or any other MIME through to the browser. The
  // rendering site is `<img>` today (which won't execute scripts in SVG
  // and won't render text/html at all), but the wire contract specifies
  // image data URLs only — and we keep that contract enforced as the
  // first line of defence in case the rendering surface ever changes.
  const expectedPrefix = `data:${mimeForOutputFormat(outputFormat)};base64,`;
  if (typeof payload.url === 'string' && payload.url.startsWith(expectedPrefix)) {
    return { preview: payload.url, index };
  }
  const b64 = typeof payload.b64_json === 'string' && payload.b64_json.length > 0
    ? payload.b64_json
    : payload.partial_image_b64;
  if (typeof b64 === 'string' && b64.length > 0) {
    return { preview: `${expectedPrefix}${b64}`, index };
  }
  return null;
}

type ImagesFraming =
  | { kind: 'sse'; stream: ReadableStream<Uint8Array> }
  | { kind: 'json'; text: string };

// Some CLIProxyAPI builds (v7.2.4x) answer /v1/images/* with
// `content-type: text/event-stream` but a body that is a `: keep-alive`
// comment followed by ONE raw pretty-printed JSON object — no `data:`/`event:`
// frames and no partial previews, even with partial_images > 0. Sniff the
// first significant character after leading comments/blank lines: `{` routes
// to single-shot JSON handling, anything else replays the buffered bytes into
// the SSE frame reader (pre-regression proxies and any future upstream fix).
async function sniffImagesFraming(
  body: ReadableStream<Uint8Array>,
  byteLimit: number,
  signal?: AbortSignal,
): Promise<ImagesFraming> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const chunks: Uint8Array[] = [];
  let text = '';
  let total = 0;

  // First significant char after complete comment lines / leading newlines,
  // plus its offset; null while undecidable on the bytes seen so far.
  const classify = (): { char: string; offset: number } | null => {
    let pos = 0;
    for (;;) {
      while (pos < text.length && (text[pos] === '\n' || text[pos] === '\r' || text[pos] === ' ' || text[pos] === '\t')) pos++;
      if (pos >= text.length) return null;
      if (text[pos] === ':') {
        const nl = text.indexOf('\n', pos);
        if (nl === -1) return null;
        pos = nl + 1;
        continue;
      }
      const char = text[pos];
      return char === undefined ? null : { char, offset: pos };
    }
  };

  for (;;) {
    const result = await reader.read();
    if (signal?.aborted) throw signal.reason;
    if (result.done) break;
    chunks.push(result.value);
    total += result.value.byteLength;
    if (total > byteLimit) throw new CliproxyResponseTooLargeError(byteLimit, total);
    text += decoder.decode(result.value, { stream: true });
    const sig = classify();
    if (!sig) continue;
    if (sig.char !== '{') return { kind: 'sse', stream: replayPrefixedStream(chunks, reader) };
    // Raw JSON mode: drain the rest of the body (bounded), return the JSON text.
    for (;;) {
      const rest = await reader.read();
      if (signal?.aborted) throw signal.reason;
      if (rest.done) break;
      total += rest.value.byteLength;
      if (total > byteLimit) throw new CliproxyResponseTooLargeError(byteLimit, total);
      text += decoder.decode(rest.value, { stream: true });
    }
    text += decoder.decode();
    return { kind: 'json', text: text.slice(sig.offset) };
  }
  // EOF before any significant content (e.g. keep-alive comments only).
  return { kind: 'json', text: '' };
}

// Structural reader type: Bun types `response.body` as node:stream/web's
// ReadableStream, whose reader lacks the global lib's `readMany` — the
// documented pattern is to accept the minimal read/cancel surface instead.
interface ByteStreamReader {
  read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>;
  cancel(reason?: unknown): Promise<void>;
}

function replayPrefixedStream(
  prefix: readonly Uint8Array[],
  reader: ByteStreamReader,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of prefix) controller.enqueue(chunk);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done || value === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

// Shared terminal handling for a completed image payload — reached via an SSE
// `completed` frame or the raw single-shot JSON body's data[0].
function completedResult(
  payload: CliproxyCompletedPayload | string,
  outputFormat: CliproxyOutputFormat,
  responseStatus: number,
  seed: ProviderRequest['seed'],
): ProviderResult {
  const final = extractCompletedBytes(payload, outputFormat);
  if (!final) {
    return { status: 'failed', error: 'empty CLIProxyAPI image response', seed, index: 0 };
  }
  const sniffed = sniffImage(final.bytes);
  if (!matchesOutputFormat(sniffed, outputFormat)) {
    return {
      status: 'failed',
      error: {
        status: responseStatus,
        error: 'response bytes did not match declared output_format',
        reason: { kind: 'unsupported', raw: 'response bytes did not match declared output_format' } satisfies ProviderErrorReason,
      },
      seed,
      index: 0,
    };
  }
  return {
    status: 'ready',
    bytes: final.bytes,
    ext: extForOutputFormat(outputFormat),
    mime: mimeForOutputFormat(outputFormat),
    seed,
    index: 0,
    ...(final.revisedPrompt ? { revisedPrompt: final.revisedPrompt } : {}),
  };
}

function extractCompletedBytes(
  payload: CliproxyCompletedPayload | string,
  outputFormat: CliproxyOutputFormat,
): { bytes: Uint8Array; revisedPrompt?: string } | null {
  if (typeof payload === 'string') return null;
  let b64: string | undefined;
  let revisedPrompt = payload.revised_prompt;
  if (typeof payload.b64_json === 'string' && payload.b64_json.length > 0) {
    b64 = payload.b64_json;
  } else if (typeof payload.url === 'string') {
    const expectedPrefix = `data:${mimeForOutputFormat(outputFormat)};base64,`;
    if (payload.url.startsWith(expectedPrefix)) b64 = payload.url.slice(expectedPrefix.length);
  }
  if (!b64) {
    const output = payload.response?.output?.find(
      (item) => item.type === 'image_generation_call' && typeof item.result === 'string' && item.result.length > 0,
    );
    if (output?.result) {
      b64 = output.result;
      revisedPrompt = output.revised_prompt ?? revisedPrompt;
    }
  }
  if (!b64) return null;
  const decoded = Buffer.from(b64, 'base64');
  const bytes = new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength);
  return revisedPrompt
    ? { bytes, revisedPrompt }
    : { bytes };
}

function readBodyBounded(
  response: Response,
  limit: number,
  signal?: AbortSignal,
): Promise<string> {
  return readBodyBoundedShared(response, limit, {
    onOversize: (lim, total) => {
      throw new CliproxyResponseTooLargeError(lim, total);
    },
    ...(signal ? { signal } : {}),
  });
}

function extForOutputFormat(format: CliproxyOutputFormat): TileExt {
  return format === 'jpeg' ? 'jpg' : format;
}

function mimeForOutputFormat(format: CliproxyOutputFormat): TileMime {
  return toTileMime(extForOutputFormat(format));
}

function matchesOutputFormat(sniffed: ReturnType<typeof sniffImage>, format: CliproxyOutputFormat): boolean {
  return sniffed?.ext === extForOutputFormat(format) && sniffed.mime === mimeForOutputFormat(format);
}

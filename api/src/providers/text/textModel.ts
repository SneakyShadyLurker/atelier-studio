import {
  APICallError,
  InvalidResponseDataError,
  JSONParseError,
  TypeValidationError,
  type JSONSchema7,
  type LanguageModelV4,
  type LanguageModelV4CallOptions,
  type LanguageModelV4FilePart,
  type LanguageModelV4FinishReason,
  type LanguageModelV4StreamPart,
  type LanguageModelV4TextPart,
  type LanguageModelV4Usage,
  type SharedV4ProviderOptions,
  type SharedV4Warning,
} from '@ai-sdk/provider';
import type { TextReasoningEffort } from '@atelier/shared';
import { nextSseFrame, parseSseFrame, SSE_TERMINATOR_REWIND } from '@atelier/shared/sse';
import type { IPolicy } from 'cockatiel';
import type { TextModelRecord, TextProviderRecord } from '../../db/textProviders';
import { isAbortError } from '../../lifecycle/abort';
import { policyBreakerState, QuotaExhaustedError, TransientUpstreamError } from '../../lifecycle/resilient-call';
import { buildBrainstormBrief, buildBrainstormSystemPrompt } from '../../prompts/brainstormCharactersSystemPrompt';
import { DRAFT_LIST_SYSTEM_PROMPT } from '../../prompts/draftListSystemPrompt';
import { DRAFT_TEMPLATE_SYSTEM_PROMPT } from '../../prompts/draftTemplateSystemPrompt';
import { ENHANCE_SYSTEM_PROMPT } from '../../prompts/enhanceSystemPrompt';
import { imageAuthoringSystemPrompt } from '../../prompts/gptSystemPrompt';
import { INFER_DIMENSIONS_SYSTEM_PROMPT } from '../../prompts/inferDimensionsSystemPrompt';
import { parseInferPayload, RESCUE_RESPONSE_FORMAT } from '../../prompts/inferParse';
import type { RawInferOp } from '../../prompts/inferTypes';
import { isLikelyContentFilterFailure } from '../../prompts/modelOutput';
import { RESCUE_DIMENSION_SYSTEM_PROMPT } from '../../prompts/rescueSystemPrompt';
import { moderateGptInput } from '../../routing/gptModeration';
import { errorToRawString as detailOf, tryParseJson } from '../_http';
import { frameDataText } from '../_sse';
import {
  createBrainstormRecordAssembler,
  draftBrief,
  DRAFT_TEMPLATE_RESPONSE_FORMAT,
  draftTemplateBrief,
  draftTemplateResultFromContent,
  parseDraftPayload,
  safeTextDetail,
  textFailureFromError,
  unparseableFailure,
  type AiFillProviderInput,
  type AiFillResult,
  type BrainstormCharactersInput,
  type BrainstormChunk,
  type ChatResponseFormat,
  type TextCallPolicies,
  type TextFeatureProvider,
  type DraftListProviderInput,
  type DraftResult,
  type DraftTemplateProviderInput,
  type DraftTemplateResult,
  type EnhanceCallOptions,
  type EnhanceChunk,
  type EnhanceImageInput,
  type InferCallOptions,
  type InferResult,
  type RescueDimensionArgs,
  type RewriteRequest,
  type RewriteResult,
} from './featureHelpers';
import {
  AI_FILL_BATCH_MAX_OUTPUT_TOKENS,
  AI_FILL_MAX_OUTPUT_TOKENS,
  brainstormMaxOutputTokens,
  DRAFT_LIST_MAX_OUTPUT_TOKENS,
  draftTemplateMaxOutputTokens,
  draftTemplateMaxResponseBytes,
  ENHANCE_MAX_OUTPUT_TOKENS,
  INFER_DIMENSIONS_MAX_OUTPUT_TOKENS,
  pinnedEffortMaxResponseBytes,
} from './textBudgets';
import { NOOP_PROVIDER_LOGGER, type ProviderLogger } from '../types';
import { ANTHROPIC_OPTIONS_KEY } from './anthropic';
import { classifyApiError, classifyStreamError } from './classify';
import { boundedFetch, TextResponseTooLargeError } from './fetch';
import { classifyFinish, incompleteTextStream, TextFinishError } from './finish';
import { OPENAI_COMPATIBLE_OPTIONS_KEY } from './openaiCompatible';
import type { ResolvedProvider, TextProtocolAdapter } from './protocol';

// The text feature interface (enhance, brainstorm, drafts, ai-fill, infer,
// rescue) over one admin-managed provider + model row. The AI SDK provider
// packages shape the wire; this module keeps what the SDK cannot own (spec § 5.3):
//
// - The cockatiel policy wraps the open (`doStream`) so a failed open is
//   retried; streams whose deltas reach the client (enhance, brainstorm) drain
//   outside the policy and are never replayed. Accumulating calls (rewrite,
//   drafts, infer, ai-fill, rescue) drain inside it, so a mid-stream transient
//   fault is retried before any text leaves the provider.
// - The terminal rule (`finish.ts`) and error taxonomy (`classify.ts`).
// - One reasoning signal per enhance stream.
// - Body byte caps through the bounded fetch, sized per call.
// - The JEV pre-screen when the model row has `screenRequests`.
//
// Stream differences from the legacy hand-written SSE reader, and how they
// are matched (Task 4 findings, re-read from @ai-sdk/openai-compatible 3.0.81
// dist and @ai-sdk/provider-utils 5.0.71 `parseJsonEventStream`):
// - The SDK drops `data: [DONE]` and ignores `event:` names; a stream without
//   any finish_reason ends with an `error` part (InvalidResponseDataError) and
//   finish `{ unified: 'error', raw: undefined }`. The legacy reader treated
//   `[DONE]` as a successful terminal and `event: error` frames as upstream
//   errors, so a pass-through tap on the response body (`wireTap`) records
//   both with the shared SSE frame parser before the SDK sees the bytes.
// - Unparseable chunks become `error` parts (JSONParseError /
//   TypeValidationError) where the legacy reader skipped them; they are
//   skipped here unless the tap saw an upstream error frame there (for
//   example CLIProxyAPI's pretty-printed multi-line error JSON, which the
//   SDK parser cannot read).

/** One text call before it is shaped into SDK call options. */
export interface TextCallRequest {
  /** Per-task output budget; `fixedOutputTokens` on the row replaces it. */
  readonly maxOutputTokens: number;
  readonly systemPrompt: string;
  readonly user: string;
  readonly images?: readonly EnhanceImageInput[];
  readonly responseFormat?: ChatResponseFormat;
  /** The user's pinned effort; replaces the row default when the row lists levels. */
  readonly userEffort?: TextReasoningEffort;
}

type SdkResponseFormat = NonNullable<LanguageModelV4CallOptions['responseFormat']>;

function sdkResponseFormat(format: ChatResponseFormat): { format: SdkResponseFormat; strict?: boolean } {
  if (format === 'json_object') return { format: { type: 'json' } };
  const { name, strict, schema, description } = format.json_schema;
  return {
    format: {
      type: 'json',
      schema: schema as JSONSchema7,
      ...(typeof name === 'string' ? { name } : {}),
      ...(typeof description === 'string' ? { description } : {}),
    },
    ...(typeof strict === 'boolean' ? { strict } : {}),
  };
}

/** Images a model receives: none without vision (routing never sends any), else up to `maxImages`. */
function imagesFor(model: TextModelRecord, images: readonly EnhanceImageInput[]): readonly EnhanceImageInput[] {
  if (!model.vision) return [];
  return model.maxImages === null ? images : images.slice(0, model.maxImages);
}

/** The effort sent: the row default, or the user's pin when the row lets users pick (spec § 5.4). */
export function effectiveEffort(model: TextModelRecord, userEffort: TextReasoningEffort | undefined): TextReasoningEffort | null {
  return model.reasoningLevels.length === 0 ? model.reasoningDefault : (userEffort ?? model.reasoningDefault);
}

/** The `userEffort` field of a request, omitted when the caller has no pin. */
function withUserEffort(userEffort: TextReasoningEffort | undefined): { userEffort?: TextReasoningEffort } {
  return userEffort === undefined ? {} : { userEffort };
}

function mergeProviderOptions(a: SharedV4ProviderOptions, b: SharedV4ProviderOptions): SharedV4ProviderOptions {
  const merged: Record<string, SharedV4ProviderOptions[string]> = { ...a };
  for (const [key, value] of Object.entries(b)) merged[key] = { ...merged[key], ...value };
  return merged;
}

/** Call options for one request, as spec § 5.4 derives them from the model row. */
export function textCallOptions(
  adapter: TextProtocolAdapter,
  model: TextModelRecord,
  request: TextCallRequest,
): LanguageModelV4CallOptions {
  const effort = effectiveEffort(model, request.userEffort);
  const format = model.structuredOutput === 'none' || request.responseFormat === undefined
    ? undefined
    : sdkResponseFormat(request.responseFormat);
  const userParts: (LanguageModelV4TextPart | LanguageModelV4FilePart)[] = [
    { type: 'text', text: request.user },
    ...imagesFor(model, request.images ?? []).map((img): LanguageModelV4FilePart => ({
      type: 'file',
      mediaType: img.mime,
      data: { type: 'data', data: img.bytes },
    })),
  ];
  const strict: SharedV4ProviderOptions = adapter.protocol === 'openai-compatible' && format?.strict !== undefined
    ? { [OPENAI_COMPATIBLE_OPTIONS_KEY]: { strictJsonSchema: format.strict } }
    : {};
  // The system prompts are large and static per feature, so Anthropic rows
  // mark the system block as a cache breakpoint (`cache_control` on the wire).
  const systemCache: SharedV4ProviderOptions | undefined = adapter.protocol === 'anthropic'
    ? { [ANTHROPIC_OPTIONS_KEY]: { cacheControl: { type: 'ephemeral' } } }
    : undefined;
  return {
    prompt: [
      { role: 'system', content: request.systemPrompt, ...(systemCache === undefined ? {} : { providerOptions: systemCache }) },
      { role: 'user', content: userParts },
    ],
    maxOutputTokens: model.fixedOutputTokens ?? request.maxOutputTokens,
    ...(model.temperature === null ? {} : { temperature: model.temperature }),
    ...(model.topP === null ? {} : { topP: model.topP }),
    ...(format === undefined ? {} : { responseFormat: format.format }),
    providerOptions: mergeProviderOptions(adapter.reasoningOptions(effort).providerOptions, strict),
  };
}

// ---------------------------------------------------------------------------
// Wire tap: what the legacy reader saw that the SDK drops.

interface WireTap {
  sawDone: boolean;
  /** A `[DONE]` or a `finish_reason` frame went by: the answer is complete. */
  ended: boolean;
  /**
   * `Date.now()` of the first `finish_reason` frame. From then on only a usage
   * frame or `[DONE]` is forwarded, and the grace period runs.
   */
  finishedAt: number | null;
  /** The tap forwards nothing more and closes the body. */
  closed: boolean;
  /** Payloads of upstream error frames not yet matched to an SDK error part. */
  readonly errors: unknown[];
  /**
   * `Date.now()` of the last upstream body chunk (or of the response opening).
   * The stall watchdog measures silence on raw bytes, so keepalive comments and
   * reasoning the SDK turns into no text part still count as activity.
   */
  lastChunkAt: number;
}

function hasFinishReason(parsed: object): boolean {
  const choices = (parsed as { choices?: unknown }).choices;
  return Array.isArray(choices) && choices.some((choice: unknown) =>
    typeof choice === 'object' && choice !== null
    && typeof (choice as { finish_reason?: unknown }).finish_reason === 'string');
}

function hasUsage(parsed: object): boolean {
  const usage = (parsed as { usage?: unknown }).usage;
  return typeof usage === 'object' && usage !== null;
}

/** How long the tap waits after a `finish_reason` frame for the usage frame or `[DONE]`. */
export const FINISH_GRACE_MS = 2_000;

// Same decoding as the legacy `decodeChatFrame`: `[DONE]` ends the stream,
// non-object data is skipped, an `{ error }` body or an `event: error` frame is
// an upstream error. The first `finish_reason` completes the answer, but
// OpenAI-style servers send usage in a later `choices: []` frame, so the
// stream ends there only when that frame carries usage itself; otherwise at
// the next usage frame or `[DONE]`. Returns whether to forward the frame:
// after the finish frame, content is not part of the answer and is dropped.
function observeFrame(tap: WireTap, frame: Parameters<typeof frameDataText>[0]): boolean {
  if (tap.closed) return false;
  const data = frameDataText(frame).trim();
  if (data === '[DONE]') {
    tap.sawDone = true;
    tap.ended = true;
    tap.closed = true;
    return true;
  }
  const parsed = tryParseJson(data);
  const afterFinish = tap.finishedAt !== null;
  if (typeof parsed !== 'object' || parsed === null) return !afterFinish;
  if (afterFinish) {
    if (!hasUsage(parsed)) return false;
    tap.closed = true;
    return true;
  }
  const errObj = (parsed as { error?: unknown }).error;
  if (frame.event === 'error' || errObj != null) tap.errors.push(errObj ?? parsed);
  if (hasFinishReason(parsed)) {
    tap.ended = true;
    tap.finishedAt = Date.now();
    if (hasUsage(parsed)) tap.closed = true;
  }
  return true;
}

/**
 * Scans SSE frames and returns the text to forward. Up to the `finish_reason`
 * frame the text passes through as it arrives; after it, only the whole
 * frames `observeFrame` lets through (usage, `[DONE]`); nothing once closed.
 */
function frameScanner(tap: WireTap): { push(chunk: Uint8Array): string; flush(): string } {
  const decoder = new TextDecoder();
  let buffer = '';
  let searchFrom = 0;
  const scan = (text: string): string => {
    buffer += text;
    let passthrough = tap.finishedAt === null && !tap.closed;
    let out = passthrough ? text : '';
    for (;;) {
      const next = nextSseFrame(buffer, searchFrom);
      if (!next) {
        searchFrom = Math.max(0, buffer.length - SSE_TERMINATOR_REWIND);
        return out;
      }
      buffer = next.rest;
      searchFrom = 0;
      const parsed = parseSseFrame(next.raw);
      const forward = parsed ? observeFrame(tap, { ...parsed, raw: next.raw }) : passthrough;
      if (passthrough) {
        if (tap.finishedAt !== null || tap.closed) {
          // The rest of the buffer (a suffix of `text`) is past the frame
          // that completed the answer.
          out = text.slice(0, Math.max(0, text.length - buffer.length));
          passthrough = false;
        }
      } else if (forward) {
        out += `${next.raw}\n\n`;
      }
      if (tap.closed) return out;
    }
  };
  return {
    push: (chunk) => scan(decoder.decode(chunk, { stream: true })),
    flush: () => scan(decoder.decode()),
  };
}

/** One body read, or `grace-expired` once `deadline` (epoch ms) passes first. */
async function readBefore<R>(read: Promise<R>, deadline: number): Promise<R | 'grace-expired'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<'grace-expired'>((resolve) => {
    timer = setTimeout(() => { resolve('grace-expired'); }, Math.max(0, deadline - Date.now()));
  });
  try {
    return await Promise.race([read, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The upstream body as the SDK reads it: frames are observed on the way, and
 * the stream closes (cancelling the upstream body) right after the terminal
 * frame, or `graceMs` after the `finish_reason` frame when neither usage nor
 * `[DONE]` follows. The SDK only emits `finish` when the body closes, so an
 * upstream that holds the connection open after the answer would otherwise
 * hang the call.
 */
function tappedBody(body: ReadableStream<Uint8Array>, tap: WireTap, graceMs: number): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const scanner = frameScanner(tap);
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let result: Awaited<ReturnType<typeof reader.read>> | 'grace-expired';
      if (tap.finishedAt === null) {
        result = await reader.read();
      } else {
        // The answer is already complete. A connection that breaks while the
        // tap waits for the usage frame or `[DONE]` must not turn it into a
        // failure, so a failed read ends the wait like an expired grace.
        result = await readBefore(reader.read(), tap.finishedAt + graceMs).catch(() => 'grace-expired' as const);
      }
      if (result === 'grace-expired') {
        controller.close();
        await reader.cancel().catch(() => undefined);
        return;
      }
      if (!result.done) tap.lastChunkAt = Date.now();
      const text = result.done ? scanner.flush() : scanner.push(result.value);
      if (text.length > 0) controller.enqueue(encoder.encode(text));
      if (result.done) {
        controller.close();
      } else if (tap.closed) {
        controller.close();
        await reader.cancel().catch(() => undefined);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

function tappedFetch(fetch: typeof globalThis.fetch, tap: WireTap, graceMs: number): typeof globalThis.fetch {
  const tapped = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const response = await fetch(input, init);
    if (!response.ok || response.body === null) return response;
    tap.lastChunkAt = Date.now();
    return new Response(tappedBody(response.body, tap, graceMs), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  return Object.assign(tapped, { preconnect: fetch.preconnect });
}

// ---------------------------------------------------------------------------
// Stream reading.

type WireEvent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'reasoning' }
  /** An upstream error frame; the payload is the frame's `error` object (or the frame). */
  | { readonly type: 'upstream-error'; readonly payload: unknown }
  /**
   * The stream ended. `finish` is null when the upstream sent no finish
   * reason; `sawDone` then decides between complete and incomplete. `usage`
   * is the finish part's token usage, null without a finish part.
   */
  | {
      readonly type: 'end';
      readonly finish: LanguageModelV4FinishReason | null;
      readonly sawDone: boolean;
      readonly usage: LanguageModelV4Usage | null;
    };

/** Null when the SDK synthesised the finish because the upstream sent none. */
function upstreamFinish(finish: LanguageModelV4FinishReason): LanguageModelV4FinishReason | null {
  return finish.raw === undefined && (finish.unified === 'error' || finish.unified === 'other') ? null : finish;
}

function errorEvent(error: unknown, tap: WireTap): WireEvent | null {
  // The SDK's missing-finish error; the finish part that follows decides.
  if (InvalidResponseDataError.isInstance(error)) return null;
  if (tap.errors.length > 0) {
    const tapped = tap.errors.shift();
    // The SDK's provider stream error carries the status it derived from the
    // frame (Anthropic maps the error type to it), which the raw frame may
    // lack; its `data` keeps the frame itself.
    const statusCode = (error as { readonly statusCode?: unknown } | null)?.statusCode;
    return { type: 'upstream-error', payload: typeof statusCode === 'number' ? error : tapped };
  }
  if (!(error instanceof Error)) return { type: 'upstream-error', payload: error };
  // A chunk the SDK could not parse and the legacy reader skipped.
  if (JSONParseError.isInstance(error) || TypeValidationError.isInstance(error)) return null;
  throw error;
}

/**
 * One read of the SDK stream, failed as a transient in-stream timeout once the
 * upstream body has been silent for `idleMs`. Silence counts from the later of
 * the last body chunk and the start of this read, so time the consumer spent
 * between reads (client backpressure) is never charged to the upstream.
 */
async function readBeforeStall<R>(read: Promise<R>, tap: WireTap, idleMs: number): Promise<R> {
  const readStartedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<never>((_, reject) => {
    const arm = (): void => {
      const silentMs = Date.now() - Math.max(tap.lastChunkAt, readStartedAt);
      if (silentMs >= idleMs) {
        reject(new TransientUpstreamError('in-stream-timeout', null, `upstream stream idle for ${idleMs}ms`));
        return;
      }
      // Bytes arrived since the timer was set: wait out the remainder.
      timer = setTimeout(arm, idleMs - silentMs);
    };
    arm();
  });
  try {
    return await Promise.race([read, stalled]);
  } finally {
    clearTimeout(timer);
  }
}

/** Marks the first content or reasoning part of the current attempt. */
function markFirstPart(call: CallRecord): void {
  call.ttfbMs ??= Date.now() - call.attemptStartedAt;
}

/** The stream's parts as wire events; records timing, warnings and usage on `opened.call`. */
async function* wireEvents(opened: OpenedStream, idleMs: number | undefined): AsyncGenerator<WireEvent> {
  const { stream, tap, call } = opened;
  const reader = stream.getReader();
  try {
    for (;;) {
      const result = idleMs === undefined ? await reader.read() : await readBeforeStall(reader.read(), tap, idleMs);
      if (result.done) {
        yield { type: 'end', finish: null, sawDone: tap.sawDone, usage: null };
        return;
      }
      const part = result.value;
      if (part.type === 'text-delta') {
        if (part.delta.length > 0) {
          markFirstPart(call);
          yield { type: 'text', text: part.delta };
        }
      } else if (part.type === 'reasoning-delta') {
        if (part.delta.length > 0) {
          markFirstPart(call);
          yield { type: 'reasoning' };
        }
      } else if (part.type === 'stream-start') {
        call.warnings = part.warnings;
      } else if (part.type === 'error') {
        const event = errorEvent(part.error, tap);
        if (event !== null) yield event;
      } else if (part.type === 'finish') {
        const finish = upstreamFinish(part.finishReason);
        call.finish = finish;
        call.usage = part.usage;
        yield { type: 'end', finish, sawDone: tap.sawDone, usage: part.usage };
        return;
      }
    }
  } finally {
    // Releases the socket when a caller stops early.
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * The SDK wraps a failed read of a 2xx body in APICallError("Failed to process
 * successful response"); the drain reports the underlying error, as the
 * legacy reader did.
 */
function bodyReadError(error: unknown): unknown {
  if (APICallError.isInstance(error) && error.statusCode !== undefined && error.statusCode < 300 && error.cause !== undefined) {
    return error.cause;
  }
  return error;
}

/** The error a stream end means; null when it completed. */
function endError(end: Extract<WireEvent, { type: 'end' }>): Error | null {
  if (end.finish === null) return end.sawDone ? null : incompleteTextStream();
  return classifyFinish({ finishReason: end.finish });
}

/**
 * The failed chunk for an upstream error frame on an open stream, shared by
 * enhance and brainstorm: the in-stream classifier picks quota / transient /
 * permanent, so routes can tell a cool-down or a retryable overload from a
 * hard failure. The detail is the frame, redacted and capped.
 */
function streamFailureChunk(
  payload: unknown,
  quotaFloorMs: number,
): Extract<EnhanceChunk, { type: 'failed' }> & { kind: 'quota' | 'transient' | 'permanent' } {
  const inStream = classifyStreamError(payload, quotaFloorMs);
  const detail = safeTextDetail(detailOf(payload));
  if (inStream instanceof QuotaExhaustedError) {
    return {
      type: 'failed',
      kind: 'quota',
      status: null,
      detail,
      ...(inStream.retryAfterSeconds !== null ? { retryAfterSeconds: inStream.retryAfterSeconds } : {}),
    };
  }
  return { type: 'failed', kind: inStream instanceof TransientUpstreamError ? 'transient' : 'permanent', status: null, detail };
}

// ---------------------------------------------------------------------------
// The provider.

export type TextModelProvider = TextFeatureProvider;

/** The ai-fill task name: a call that fills several items at once is a batch. */
function aiFillTask(input: AiFillProviderInput): string {
  return (input.batchSize ?? 1) > 1 ? 'ai-fill-batch' : 'ai-fill';
}

export interface TextModelProviderInit extends TextCallPolicies {
  readonly adapter: TextProtocolAdapter;
  readonly provider: TextProviderRecord;
  /** Plaintext credential (null = none); resolved on first use and kept for this instance. */
  readonly credential: () => Promise<string | null>;
  readonly model: TextModelRecord;
  /** Response byte cap of every call without its own cap below. */
  readonly maxResponseBytes: number;
  /** infer / taxonomy / rescue / ai-fill cap; defaults to `maxResponseBytes`. */
  readonly inferMaxResponseBytes?: number;
  /** Brainstorm cap; defaults to `maxResponseBytes`. */
  readonly brainstormMaxResponseBytes?: number;
  /** 429 Retry-After at or above this is quota exhaustion. Default 300 000. */
  readonly quotaMinRetryAfterMs?: number;
  readonly enhanceOpenTimeoutMs?: number;
  readonly brainstormOpenTimeoutMs?: number;
  /**
   * Fail a streamed call as a transient in-stream timeout after this long with
   * no upstream body bytes. Absent: no stall watchdog.
   */
  readonly streamIdleMs?: number;
  /** The JEV pre-screen key; used when the row has `screenRequests`. */
  readonly moderation?: { readonly openrouterApiKey: string | undefined };
  readonly logger?: ProviderLogger;
  /**
   * Ask OpenAI-compatible streams for a trailing usage frame
   * (`stream_options.include_usage`). Absent: not asked.
   */
  readonly includeUsage?: boolean;
  /** Wait for the usage frame or `[DONE]` after `finish_reason`. Default `FINISH_GRACE_MS`. */
  readonly finishGraceMs?: number;
}

/**
 * What one feature call observed across its attempts, for its `text_call`
 * event. Timing, usage and finish describe the last attempt. Content-free by
 * construction: no prompt, output or upstream text is ever stored here.
 */
interface CallRecord {
  attempts: number;
  attemptStartedAt: number;
  ttfbMs: number | undefined;
  usage: LanguageModelV4Usage | null;
  finish: LanguageModelV4FinishReason | null;
  warnings: readonly SharedV4Warning[];
}

function newCallRecord(): CallRecord {
  return { attempts: 0, attemptStartedAt: Date.now(), ttfbMs: undefined, usage: null, finish: null, warnings: [] };
}

interface OpenedStream {
  readonly stream: ReadableStream<LanguageModelV4StreamPart>;
  readonly tap: WireTap;
  readonly call: CallRecord;
}

/** Token counts the upstream reported; a count it did not send is omitted. */
function tokenFields(usage: LanguageModelV4Usage | null): Record<string, number> {
  if (usage === null) return {};
  const fields: Record<string, number | undefined> = {
    inputTokens: usage.inputTokens.total,
    outputTokens: usage.outputTokens.total,
    reasoningTokens: usage.outputTokens.reasoning,
    cacheReadTokens: usage.inputTokens.cacheRead,
  };
  return Object.fromEntries(Object.entries(fields).filter((entry): entry is [string, number] => typeof entry[1] === 'number'));
}

/** A warning's identifiers only; its free-text `message` and `details` never reach a log. */
function warningType(warning: SharedV4Warning): string {
  switch (warning.type) {
    case 'unsupported':
    case 'compatibility':
      return `${warning.type}:${warning.feature}`;
    case 'deprecated':
      return `deprecated:${warning.setting}`;
    case 'other':
      return warning.type;
  }
}

/** Model rows whose SDK call warnings were logged in this process. */
const warnedTextModelIds = new Set<string>();

/** The feature result's outcome: `ok` or its failure kind. */
interface TrackedResult {
  readonly type: string;
  readonly kind?: string;
}

function resultOutcome(result: TrackedResult): string {
  return result.type === 'failed' ? (result.kind ?? 'failed') : 'ok';
}

function thrownOutcome(error: unknown): string {
  return isAbortError(error) ? 'aborted' : 'error';
}

export function createTextModelProvider(init: TextModelProviderInit): TextModelProvider {
  const { adapter, model } = init;
  const logger = init.logger ?? NOOP_PROVIDER_LOGGER;
  const quotaFloorMs = init.quotaMinRetryAfterMs ?? 300_000;
  const inferMaxResponseBytes = init.inferMaxResponseBytes ?? init.maxResponseBytes;
  /** Response cap for the effort this row actually sends (a user pin or the row default). */
  const responseCap = (configuredBytes: number, userEffort: TextReasoningEffort | undefined): number =>
    pinnedEffortMaxResponseBytes(configuredBytes, effectiveEffort(model, userEffort) ?? undefined);
  const {
    enhancePolicy,
    rewritePolicy,
    draftListPolicy,
    inferPolicy,
    taxonomyPolicy,
    inferRetryGapsPolicy,
    rescuePolicy,
    aiFillPolicy,
    aiFillBatchPolicy,
  } = init;

  let credential: Promise<string | null> | null = null;
  const resolved = async (): Promise<ResolvedProvider> => {
    credential ??= init.credential().catch((error: unknown) => {
      credential = null;
      throw error;
    });
    return { ...init.provider, credential: await credential };
  };

  const finishGraceMs = init.finishGraceMs ?? FINISH_GRACE_MS;
  const modelOptions = init.includeUsage === undefined ? undefined : { includeUsage: init.includeUsage };

  /** A language model whose fetch caps the body at `maxBytes` (and taps it when given a tap). */
  const languageModel = async (maxBytes: number, tap?: WireTap): Promise<LanguageModelV4> => {
    const bounded = boundedFetch({ maxBytes });
    const fetch = tap === undefined ? bounded : tappedFetch(bounded, tap, finishGraceMs);
    return adapter.languageModel(await resolved(), model, fetch, modelOptions);
  };

  // The single place text calls are logged: one content-free `text_call` per
  // feature call (retries included, counted in `attempts`), and the SDK's call
  // warnings once per model row per process.
  const logCall = (task: string, call: CallRecord, startedAt: number, outcome: string): void => {
    if (call.warnings.length > 0 && !warnedTextModelIds.has(model.id)) {
      warnedTextModelIds.add(model.id);
      logger.warn(
        { event: 'text_call_warnings', textModelId: model.id, warningTypes: call.warnings.map(warningType) },
        'text call warnings',
      );
    }
    logger.info({
      event: 'text_call',
      task,
      textModelId: model.id,
      protocol: adapter.protocol,
      durationMs: Date.now() - startedAt,
      ...(call.ttfbMs === undefined ? {} : { ttfbMs: call.ttfbMs }),
      ...tokenFields(call.usage),
      ...(call.finish === null ? {} : { finish: call.finish.unified }),
      outcome,
      attempts: call.attempts,
    }, 'text call');
  };

  /** A whole-result feature method, logged once when it settles. */
  const tracked = <A extends unknown[], R extends TrackedResult>(
    task: string | ((...args: A) => string),
    fn: (call: CallRecord, ...args: A) => Promise<R>,
  ) => async (...args: A): Promise<R> => {
    const call = newCallRecord();
    const startedAt = Date.now();
    const name = typeof task === 'string' ? task : task(...args);
    try {
      const result = await fn(call, ...args);
      logCall(name, call, startedAt, resultOutcome(result));
      return result;
    } catch (error) {
      logCall(name, call, startedAt, thrownOutcome(error));
      throw error;
    }
  };

  /** A streamed feature method, logged once when the stream ends or its reader stops. */
  const trackedStream = <A extends unknown[], C extends TrackedResult>(
    task: string,
    fn: (call: CallRecord, ...args: A) => AsyncIterable<C>,
  ) => async function* (...args: A): AsyncIterable<C> {
    const call = newCallRecord();
    const startedAt = Date.now();
    // Ending before a terminal chunk means the reader stopped or the signal fired.
    let outcome = 'aborted';
    try {
      for await (const chunk of fn(call, ...args)) {
        if (chunk.type === 'done') outcome = 'ok';
        else if (chunk.type === 'failed') outcome = resultOutcome(chunk);
        yield chunk;
      }
    } catch (error) {
      outcome = thrownOutcome(error);
      throw error;
    } finally {
      logCall(task, call, startedAt, outcome);
    }
  };

  const moderate = async (request: TextCallRequest, signal: AbortSignal): Promise<void> => {
    if (!model.screenRequests) return;
    await moderateGptInput(init.moderation?.openrouterApiKey, {
      task: 'text-generation',
      instructions: request.systemPrompt,
      // JEV is text-only. Never send reference-image bytes or data URLs to it.
      input: (request.images?.length ?? 0) === 0 ? request.user : [request.user],
    }, signal, { modelLabel: model.displayName, logger });
  };

  /**
   * Opens one stream (`doStream`, headers received). Typed errors for the
   * policy. The screen runs once per call before the policy (see `moderate`
   * call sites), so a retried open never screens again and an open deadline
   * never includes it.
   */
  const open = async (request: TextCallRequest, maxBytes: number, signal: AbortSignal, call: CallRecord): Promise<OpenedStream> => {
    const tap: WireTap = { sawDone: false, ended: false, finishedAt: null, closed: false, errors: [], lastChunkAt: Date.now() };
    // A new attempt: timing, usage and finish describe the last one.
    call.attempts += 1;
    call.attemptStartedAt = Date.now();
    call.ttfbMs = undefined;
    call.usage = null;
    call.finish = null;
    try {
      const lm = await languageModel(maxBytes, tap);
      const { stream } = await lm.doStream({ ...textCallOptions(adapter, model, request), abortSignal: signal });
      return { stream, tap, call };
    } catch (error) {
      if (signal.aborted) throw error;
      throw classifyApiError(error, quotaFloorMs);
    }
  };

  // Enhance-family opens carry their own open deadline; it stops at headers,
  // so a slow drain is never cut by it.
  const openWithTimeout = async (
    request: TextCallRequest,
    maxBytes: number,
    signal: AbortSignal,
    openTimeoutMs: number,
    call: CallRecord,
  ): Promise<OpenedStream> => {
    const openAc = new AbortController();
    const timeout = setTimeout(() => {
      openAc.abort(new DOMException('open timeout', 'TimeoutError'));
    }, openTimeoutMs);
    try {
      return await open(request, maxBytes, AbortSignal.any([signal, openAc.signal]), call);
    } catch (error) {
      if (!signal.aborted && openAc.signal.aborted) {
        throw new TransientUpstreamError('timeout', error, detailOf(error));
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };

  const accumulate = async (opened: OpenedStream, signal: AbortSignal): Promise<string> => {
    let acc = '';
    try {
      for await (const event of wireEvents(opened, init.streamIdleMs)) {
        if (signal.aborted) throw new DOMException('aborted', 'AbortError');
        if (event.type === 'text') acc += event.text;
        else if (event.type === 'upstream-error') throw classifyStreamError(event.payload, quotaFloorMs);
        else if (event.type === 'end') {
          const failure = endError(event);
          if (failure) throw failure;
        }
      }
    } catch (error) {
      if (signal.aborted) throw error;
      throw classifyApiError(bodyReadError(error), quotaFloorMs);
    }
    return acc;
  };

  /** Open and drain inside the policy: nothing reaches the caller before the text is complete. */
  const callWithPolicy = async (
    call: CallRecord,
    policy: IPolicy,
    outerSignal: AbortSignal,
    request: TextCallRequest,
    maxBytes: number,
  ): Promise<string> => {
    await moderate(request, outerSignal);
    return policy.execute(async ({ signal }) => {
      if (signal.aborted) throw signal.reason ?? new DOMException('aborted', 'AbortError');
      return accumulate(await open(request, maxBytes, signal, call), signal);
    }, outerSignal);
  };

  const inferWithPolicy = async (
    call: CallRecord,
    policy: IPolicy,
    snapshotJson: string,
    signal: AbortSignal,
    systemPrompt: string = INFER_DIMENSIONS_SYSTEM_PROMPT,
    userEffort?: TextReasoningEffort,
  ): Promise<InferResult> => {
    try {
      const text = await callWithPolicy(call, policy, signal, {
        maxOutputTokens: INFER_DIMENSIONS_MAX_OUTPUT_TOKENS,
        systemPrompt,
        user: snapshotJson,
        responseFormat: 'json_object',
        ...withUserEffort(userEffort),
      }, responseCap(inferMaxResponseBytes, userEffort));
      const ops = parseInferPayload(text);
      // Model output can vary on another attempt; let chunk retry-gaps recover
      // without accepting a proposal with silently discarded operations.
      if (!ops) return unparseableFailure('unparseable infer response');
      return { type: 'ok', ops };
    } catch (err) {
      if (signal.aborted) throw err;
      if (isAbortError(err)) throw err;
      return textFailureFromError(err);
    }
  };

  /** The enhance request of one call, shared by `enhance` and `rewrite`. */
  const enhanceRequest = (
    prompt: string,
    images: readonly EnhanceImageInput[],
    systemPrompt: string | undefined,
    opts: EnhanceCallOptions | undefined,
  ): TextCallRequest => ({
    maxOutputTokens: opts?.maxOutputTokens ?? ENHANCE_MAX_OUTPUT_TOKENS,
    systemPrompt: systemPrompt ?? ENHANCE_SYSTEM_PROMPT,
    user: prompt,
    images,
    ...(opts?.responseFormat ? { responseFormat: opts.responseFormat } : {}),
    ...withUserEffort(opts?.reasoningEffort),
  });

  return {
    enhance: trackedStream('enhance', async function* (
      call: CallRecord,
      prompt: string,
      images: readonly EnhanceImageInput[],
      signal: AbortSignal,
      systemPrompt?: string,
      opts?: EnhanceCallOptions,
    ): AsyncIterable<EnhanceChunk> {
      const request = enhanceRequest(prompt, images, systemPrompt, opts);
      let opened: OpenedStream;
      try {
        await moderate(request, signal);
        opened = await enhancePolicy.execute(
          ({ signal: policySignal }) => openWithTimeout(
            request,
            responseCap(init.maxResponseBytes, opts?.reasoningEffort),
            AbortSignal.any([policySignal, signal]),
            init.enhanceOpenTimeoutMs ?? 15_000,
            call,
          ),
          signal,
        );
      } catch (error) {
        yield textFailureFromError(error);
        return;
      }

      // Content alone is not completion: require a successful terminal.
      // Drain failures never replay the deltas already exposed to the client.
      let sawContent = false;
      let sawReasoning = false;
      try {
        for await (const event of wireEvents(opened, init.streamIdleMs)) {
          if (signal.aborted) return;
          if (event.type === 'upstream-error') {
            // Surface an in-stream failure with detail rather than letting it
            // degrade to a silent "ended without content".
            yield streamFailureChunk(event.payload, quotaFloorMs);
            return;
          }
          if (event.type === 'reasoning') {
            // Reasoning never satisfies `sawContent`: a stream that spends its
            // whole budget on CoT and answers nothing is still a failure.
            if (!sawReasoning) {
              sawReasoning = true;
              yield { type: 'reasoning' };
            }
          } else if (event.type === 'text') {
            sawContent = true;
            yield { type: 'delta', text: event.text };
          } else {
            const failure = endError(event);
            if (failure !== null) {
              if (event.finish === null && !sawContent) {
                yield { type: 'failed', status: null, detail: 'stream ended without content' };
                return;
              }
              throw failure;
            }
          }
        }
      } catch (error) {
        if (signal.aborted) throw error;
        yield textFailureFromError(bodyReadError(error));
        return;
      }

      if (sawContent) {
        yield { type: 'done' };
        return;
      }
      yield { type: 'failed', status: null, detail: 'stream ended without content' };
    }),

    rewrite: tracked('rewrite', async (call: CallRecord, rewriteRequest: RewriteRequest, signal: AbortSignal): Promise<RewriteResult> => {
      const { prompt, images, systemPrompt, ...opts } = rewriteRequest;
      try {
        const text = await callWithPolicy(
          call,
          rewritePolicy,
          signal,
          enhanceRequest(prompt, images ?? [], systemPrompt, opts),
          responseCap(init.maxResponseBytes, opts.reasoningEffort),
        );
        // Like enhance, a clean finish with no text is a failure. Output
        // varies between attempts, so it is transient.
        if (text.length === 0) return unparseableFailure('stream ended without content');
        return { type: 'ok', text };
      } catch (err) {
        if (signal.aborted) throw err;
        if (isAbortError(err)) throw err;
        return textFailureFromError(err);
      }
    }),

    brainstormCharacters: trackedStream('brainstorm', async function* (
      call: CallRecord,
      input: BrainstormCharactersInput,
      signal: AbortSignal,
    ): AsyncIterable<BrainstormChunk> {
      // Budget and cap follow the effort actually sent, which can be the row default.
      const sentEffort = effectiveEffort(model, input.reasoningEffort) ?? undefined;
      const request: TextCallRequest = {
        maxOutputTokens: brainstormMaxOutputTokens(input.count, sentEffort),
        systemPrompt: buildBrainstormSystemPrompt({
          count: input.count,
          modelId: input.modelId,
          ...(input.layout === undefined ? {} : { layout: input.layout }),
          ...(input.medium === undefined ? {} : { medium: input.medium }),
          ...(input.variationSeed === undefined ? {} : { variationSeed: input.variationSeed }),
        }),
        user: buildBrainstormBrief(input.brief),
        ...withUserEffort(input.reasoningEffort),
      };
      let opened: OpenedStream;
      try {
        // Screens for this model row only; a failover to another model
        // calls that model's brainstormCharacters, which screens for its row.
        await moderate(request, signal);
        opened = await enhancePolicy.execute(
          ({ signal: policySignal }) => openWithTimeout(
            request,
            pinnedEffortMaxResponseBytes(init.brainstormMaxResponseBytes ?? init.maxResponseBytes, sentEffort),
            AbortSignal.any([policySignal, signal]),
            init.brainstormOpenTimeoutMs ?? init.enhanceOpenTimeoutMs ?? 15_000,
            call,
          ),
          signal,
        );
      } catch (error) {
        const failure = textFailureFromError(error);
        yield isLikelyContentFilterFailure(failure.detail) ? { ...failure, kind: 'content-filter' } : failure;
        return;
      }

      const records = createBrainstormRecordAssembler(input, logger);
      try {
        for await (const event of wireEvents(opened, init.streamIdleMs)) {
          if (signal.aborted) return;
          if (event.type === 'upstream-error') {
            // Refusal wording wins, then the in-stream classifier decides
            // quota / transient / permanent so the route's failover sees a
            // mid-stream upstream timeout as transient.
            const failure = streamFailureChunk(event.payload, quotaFloorMs);
            yield isLikelyContentFilterFailure(failure.detail) ? { ...failure, kind: 'content-filter' } : failure;
            return;
          }
          if (event.type === 'text') {
            // Once the count is met the rest of the text is not needed.
            if (records.fulfilled()) continue;
            for (const c of records.push(event.text)) {
              yield c;
              if (c.type === 'failed') return;
            }
            // Like the legacy reader, stop at the frame that met the count
            // unless a terminal frame already went by: then read on to its
            // finish (the tap closes the stream there), so a refusal in that
            // frame still fails the call.
            if (records.fulfilled() && !opened.tap.ended) break;
          } else if (event.type === 'end') {
            // A fulfilled count needs no terminal and keeps the full-count
            // length exception; any other non-stop finish fails.
            if (records.fulfilled() && (event.finish === null || event.finish.unified === 'length')) break;
            const failure = endError(event);
            if (failure) throw failure;
          }
        }
      } catch (caught) {
        if (signal.aborted) throw caught;
        const error = bodyReadError(caught);
        // A mid-stream network fault is transient; a response-cap breach is
        // ours and would recur on the other model.
        if (error instanceof TextFinishError && error.reason === 'content-filter') {
          yield { type: 'failed', kind: 'content-filter', status: null, detail: error.message };
        } else if (error instanceof TextFinishError && error.reason === 'length') {
          yield { type: 'failed', status: null, detail: 'length' };
        } else if (error instanceof TextFinishError || error instanceof TransientUpstreamError) {
          yield textFailureFromError(error);
        } else {
          const tooLarge = error instanceof TextResponseTooLargeError;
          yield {
            type: 'failed',
            ...(tooLarge ? {} : { kind: 'transient' as const }),
            status: null,
            detail: safeTextDetail(detailOf(error)),
          };
        }
        return;
      }

      yield* records.finish();
    }),

    draftList: tracked('draft-list', async (call: CallRecord, input: DraftListProviderInput, signal: AbortSignal): Promise<DraftResult> => {
      try {
        const text = await callWithPolicy(call, draftListPolicy, signal, {
          maxOutputTokens: DRAFT_LIST_MAX_OUTPUT_TOKENS,
          systemPrompt: imageAuthoringSystemPrompt(DRAFT_LIST_SYSTEM_PROMPT, input.modelId),
          user: draftBrief(input),
          responseFormat: 'json_object',
          ...withUserEffort(input.reasoningEffort),
        }, responseCap(init.maxResponseBytes, input.reasoningEffort));
        const payload = parseDraftPayload(text);
        if (!payload) return unparseableFailure('unparseable draft response');
        return { type: 'ok', payload };
      } catch (err) {
        if (signal.aborted) throw err;
        if (isAbortError(err)) throw err;
        return textFailureFromError(err);
      }
    }),

    // The list draft's policy: an interactive draft the user is waiting on.
    draftTemplate: tracked('draft-template', async (
      call: CallRecord,
      input: DraftTemplateProviderInput,
      signal: AbortSignal,
    ): Promise<DraftTemplateResult> => {
      const knownNames = new Set(input.library.lists.map((l) => l.name));
      try {
        const text = await callWithPolicy(call, draftListPolicy, signal, {
          maxOutputTokens: draftTemplateMaxOutputTokens(input.existingBody, effectiveEffort(model, input.reasoningEffort)),
          systemPrompt: imageAuthoringSystemPrompt(DRAFT_TEMPLATE_SYSTEM_PROMPT, input.modelId),
          user: draftTemplateBrief(input),
          responseFormat: DRAFT_TEMPLATE_RESPONSE_FORMAT,
          ...withUserEffort(input.reasoningEffort),
        }, draftTemplateMaxResponseBytes(responseCap(init.maxResponseBytes, input.reasoningEffort), input.existingBody));
        return draftTemplateResultFromContent(text, knownNames, input.existingBody);
      } catch (err) {
        if (signal.aborted) throw err;
        if (isAbortError(err)) throw err;
        return textFailureFromError(err);
      }
    }),

    aiFill: tracked<[AiFillProviderInput, AbortSignal], AiFillResult>(aiFillTask, async (call: CallRecord, input: AiFillProviderInput, signal: AbortSignal): Promise<AiFillResult> => {
      try {
        const batchSize = input.batchSize ?? 1;
        const isBatch = batchSize > 1;
        const maxOutputTokens = isBatch
          ? Math.min(AI_FILL_MAX_OUTPUT_TOKENS * batchSize, AI_FILL_BATCH_MAX_OUTPUT_TOKENS)
          : AI_FILL_MAX_OUTPUT_TOKENS;
        const text = await callWithPolicy(call, isBatch ? aiFillBatchPolicy : aiFillPolicy, signal, {
          maxOutputTokens,
          systemPrompt: input.systemPrompt,
          user: input.userContent,
          ...withUserEffort(input.reasoningEffort),
        }, responseCap(inferMaxResponseBytes, input.reasoningEffort));
        return { type: 'ok', text };
      } catch (err) {
        if (signal.aborted) throw err;
        if (isAbortError(err)) throw err;
        return textFailureFromError(err);
      }
    }),

    inferDimensions: tracked('infer', (call: CallRecord, snapshotJson: string, signal: AbortSignal, systemPrompt?: string, opts?: InferCallOptions) =>
      inferWithPolicy(call, inferPolicy, snapshotJson, signal, systemPrompt, opts?.reasoningEffort)),

    inferTaxonomy: tracked('taxonomy', (call: CallRecord, snapshotJson: string, signal: AbortSignal, systemPrompt?: string, opts?: InferCallOptions) =>
      inferWithPolicy(call, taxonomyPolicy, snapshotJson, signal, systemPrompt, opts?.reasoningEffort)),

    inferDimensionsSingleAttempt: tracked('infer-retry-gaps', (
      call: CallRecord,
      snapshotJson: string,
      signal: AbortSignal,
      systemPrompt?: string,
      opts?: InferCallOptions,
    ) => inferWithPolicy(call, inferRetryGapsPolicy, snapshotJson, signal, systemPrompt, opts?.reasoningEffort)),

    rescueDimension: tracked('rescue', async (call: CallRecord, args: RescueDimensionArgs, signal: AbortSignal): Promise<InferResult> => {
      // Single-shot per rescue cap; the single-attempt retry-gaps policy keeps
      // a structural 4xx `permanent` and a flapping 5xx `transient`.
      const lists = args.previewSnapshot.lists;
      const targetListIdx = lists.findIndex((l) => l.name === args.targetListName);
      const user = JSON.stringify({
        dimensions: args.previewSnapshot.dimensions,
        lists,
        targetListName: args.targetListName,
        targetListIdx,
        templateLists: args.templateLists,
        conflictReason: args.conflictReason,
      });
      try {
        const text = await callWithPolicy(call, rescuePolicy, signal, {
          maxOutputTokens: INFER_DIMENSIONS_MAX_OUTPUT_TOKENS,
          systemPrompt: imageAuthoringSystemPrompt(RESCUE_DIMENSION_SYSTEM_PROMPT, args.modelId),
          user,
          responseFormat: RESCUE_RESPONSE_FORMAT,
          ...withUserEffort(args.reasoningEffort),
        }, responseCap(inferMaxResponseBytes, args.reasoningEffort));
        const ops = parseInferPayload(text);
        if (!ops) return { type: 'failed', kind: 'permanent', status: null, detail: 'unparseable rescue response' };
        // The provider boundary does not leak unrelated ops.
        const addOptionOps = ops.filter((o): o is Extract<RawInferOp, { op: 'addOption' }> => o.op === 'addOption');
        return { type: 'ok', ops: addOptionOps };
      } catch (err) {
        if (signal.aborted) throw err;
        if (isAbortError(err)) throw err;
        return textFailureFromError(err);
      }
    }),

    inferBreakerState() {
      return policyBreakerState(inferPolicy);
    },
  };
}

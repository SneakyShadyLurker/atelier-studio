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
  type SharedV4ProviderOptions,
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
  draftResultFromError,
  draftTemplateBrief,
  draftTemplateResultFromContent,
  enhanceFailureChunk,
  inferResultFromError,
  parseDraftPayload,
  safeTextDetail,
  type AiFillProviderInput,
  type AiFillResult,
  type BrainstormCharactersInput,
  type BrainstormChunk,
  type ChatResponseFormat,
  type CliproxyTextPolicies,
  type CliproxyTextProvider,
  type DraftListProviderInput,
  type DraftResult,
  type DraftTemplateProviderInput,
  type DraftTemplateResult,
  type EnhanceCallOptions,
  type EnhanceChunk,
  type EnhanceImageInput,
  type InferResult,
  type RescueDimensionArgs,
} from '../cliproxyText';
import {
  AI_FILL_BATCH_MAX_COMPLETION_TOKENS,
  AI_FILL_DEFAULTS,
  brainstormDefaults,
  CLIPROXY_TEXT_DEFAULTS,
  DRAFT_LIST_DEFAULTS,
  DRAFT_TEMPLATE_DEFAULTS,
  INFER_DIMENSIONS_DEFAULTS,
  pinnedEffortMaxResponseBytes,
} from '../cliproxyText.config';
import { NOOP_PROVIDER_LOGGER, type ProviderLogger } from '../types';
import { classifyApiError, classifyStreamError } from './classify';
import { boundedFetch, TextResponseTooLargeError } from './fetch';
import { classifyFinish, incompleteTextStream, TextFinishError } from './finish';
import { OPENAI_COMPATIBLE_OPTIONS_KEY } from './openaiCompatible';
import type { ResolvedProvider, TextProtocolAdapter } from './protocol';

// The text feature interface (enhance, brainstorm, drafts, ai-fill, infer,
// rescue) over one admin-managed provider + model row. Replaces
// `createCliproxyTextProvider`: the AI SDK provider packages shape the wire,
// this module keeps what the SDK cannot own (spec § 5.3):
//
// - The cockatiel policy wraps the open (`doStream`) so a failed open is
//   retried; streams whose deltas reach the client (enhance, brainstorm) drain
//   outside the policy and are never replayed. Accumulating calls (drafts,
//   infer, ai-fill, rescue) drain inside it, as before.
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
// - A non-streaming answer without finish_reason maps to
//   `{ unified: 'other', raw: undefined }`; the legacy body accepted it.

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
  return {
    prompt: [
      { role: 'system', content: request.systemPrompt },
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
  /** Payloads of upstream error frames not yet matched to an SDK error part. */
  readonly errors: unknown[];
}

// Same decoding as the legacy `decodeChatFrame`: `[DONE]` ends the stream,
// non-object data is skipped, an `{ error }` body or an `event: error` frame is
// an upstream error.
function observeFrame(tap: WireTap, frame: Parameters<typeof frameDataText>[0]): void {
  if (tap.sawDone) return;
  const data = frameDataText(frame).trim();
  if (data === '[DONE]') {
    tap.sawDone = true;
    return;
  }
  const parsed = tryParseJson(data);
  if (typeof parsed !== 'object' || parsed === null) return;
  const errObj = (parsed as { error?: unknown }).error;
  if (frame.event === 'error' || errObj != null) tap.errors.push(errObj ?? parsed);
}

/** Pass-through transform: scans each chunk's SSE frames before forwarding the bytes. */
function tapStream(tap: WireTap): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  let buffer = '';
  let searchFrom = 0;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      for (;;) {
        const next = nextSseFrame(buffer, searchFrom);
        if (!next) {
          searchFrom = Math.max(0, buffer.length - SSE_TERMINATOR_REWIND);
          break;
        }
        buffer = next.rest;
        searchFrom = 0;
        const parsed = parseSseFrame(next.raw);
        if (parsed) observeFrame(tap, { ...parsed, raw: next.raw });
      }
      controller.enqueue(chunk);
    },
  });
}

function tappedFetch(fetch: typeof globalThis.fetch, tap: WireTap): typeof globalThis.fetch {
  const tapped = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const response = await fetch(input, init);
    if (!response.ok || response.body === null) return response;
    return new Response(response.body.pipeThrough(tapStream(tap)), {
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
   * reason; `sawDone` then decides between complete and incomplete.
   */
  | { readonly type: 'end'; readonly finish: LanguageModelV4FinishReason | null; readonly sawDone: boolean };

/** Null when the SDK synthesised the finish because the upstream sent none. */
function upstreamFinish(finish: LanguageModelV4FinishReason): LanguageModelV4FinishReason | null {
  return finish.raw === undefined && (finish.unified === 'error' || finish.unified === 'other') ? null : finish;
}

function errorEvent(error: unknown, tap: WireTap): WireEvent | null {
  // The SDK's missing-finish error; the finish part that follows decides.
  if (InvalidResponseDataError.isInstance(error)) return null;
  if (tap.errors.length > 0) return { type: 'upstream-error', payload: tap.errors.shift() };
  if (!(error instanceof Error)) return { type: 'upstream-error', payload: error };
  // A chunk the SDK could not parse and the legacy reader skipped.
  if (JSONParseError.isInstance(error) || TypeValidationError.isInstance(error)) return null;
  throw error;
}

async function* wireEvents(stream: ReadableStream<LanguageModelV4StreamPart>, tap: WireTap): AsyncGenerator<WireEvent> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) {
        yield { type: 'end', finish: null, sawDone: tap.sawDone };
        return;
      }
      const part = result.value;
      if (part.type === 'text-delta') {
        if (part.delta.length > 0) yield { type: 'text', text: part.delta };
      } else if (part.type === 'reasoning-delta') {
        if (part.delta.length > 0) yield { type: 'reasoning' };
      } else if (part.type === 'error') {
        const event = errorEvent(part.error, tap);
        if (event !== null) yield event;
      } else if (part.type === 'finish') {
        yield { type: 'end', finish: upstreamFinish(part.finishReason), sawDone: tap.sawDone };
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

// ---------------------------------------------------------------------------
// The provider.

export type TextModelProvider = CliproxyTextProvider;

export interface TextModelProviderInit extends CliproxyTextPolicies {
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
  /** The JEV pre-screen key; used when the row has `screenRequests`. */
  readonly moderation?: { readonly openrouterApiKey: string | undefined };
  readonly logger?: ProviderLogger;
}

interface OpenedStream {
  readonly stream: ReadableStream<LanguageModelV4StreamPart>;
  readonly tap: WireTap;
}

export function createTextModelProvider(init: TextModelProviderInit): TextModelProvider {
  const { adapter, model } = init;
  const logger = init.logger ?? NOOP_PROVIDER_LOGGER;
  const quotaFloorMs = init.quotaMinRetryAfterMs ?? 300_000;
  const inferMaxResponseBytes = init.inferMaxResponseBytes ?? init.maxResponseBytes;
  const {
    enhancePolicy,
    draftListPolicy,
    inferPolicy,
    taxonomyPolicy,
    inferRetryGapsPolicy,
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

  /** A language model whose fetch caps the body at `maxBytes` (and taps it when given a tap). */
  const languageModel = async (maxBytes: number, tap?: WireTap): Promise<LanguageModelV4> => {
    const bounded = boundedFetch({ maxBytes });
    return adapter.languageModel(await resolved(), model, tap === undefined ? bounded : tappedFetch(bounded, tap));
  };

  const moderate = async (request: TextCallRequest, signal: AbortSignal): Promise<void> => {
    if (!model.screenRequests) return;
    await moderateGptInput(init.moderation?.openrouterApiKey, {
      task: 'text-generation',
      instructions: request.systemPrompt,
      // JEV is text-only. Never send reference-image bytes or data URLs to it.
      input: (request.images?.length ?? 0) === 0 ? request.user : [request.user],
    }, signal);
  };

  /** Opens one stream: screen, then `doStream` (headers received). Typed errors for the policy. */
  const open = async (request: TextCallRequest, maxBytes: number, signal: AbortSignal): Promise<OpenedStream> => {
    await moderate(request, signal);
    const tap: WireTap = { sawDone: false, errors: [] };
    try {
      const lm = await languageModel(maxBytes, tap);
      const { stream } = await lm.doStream({ ...textCallOptions(adapter, model, request), abortSignal: signal });
      return { stream, tap };
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
  ): Promise<OpenedStream> => {
    const openAc = new AbortController();
    const timeout = setTimeout(() => {
      openAc.abort(new DOMException('open timeout', 'TimeoutError'));
    }, openTimeoutMs);
    try {
      return await open(request, maxBytes, AbortSignal.any([signal, openAc.signal]));
    } catch (error) {
      if (!signal.aborted && openAc.signal.aborted) {
        throw new TransientUpstreamError('timeout', error, detailOf(error));
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };

  const accumulate = async ({ stream, tap }: OpenedStream, signal: AbortSignal): Promise<string> => {
    let acc = '';
    try {
      for await (const event of wireEvents(stream, tap)) {
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
  const callWithPolicy = (policy: IPolicy, outerSignal: AbortSignal, request: TextCallRequest, maxBytes: number): Promise<string> =>
    policy.execute(async ({ signal }) => {
      if (signal.aborted) throw signal.reason ?? new DOMException('aborted', 'AbortError');
      return accumulate(await open(request, maxBytes, signal), signal);
    }, outerSignal);

  const inferWithPolicy = async (
    policy: IPolicy,
    snapshotJson: string,
    signal: AbortSignal,
    systemPrompt: string = INFER_DIMENSIONS_SYSTEM_PROMPT,
  ): Promise<InferResult> => {
    try {
      const text = await callWithPolicy(policy, signal, {
        maxOutputTokens: INFER_DIMENSIONS_DEFAULTS.max_completion_tokens,
        systemPrompt,
        user: snapshotJson,
        responseFormat: 'json_object',
      }, inferMaxResponseBytes);
      const ops = parseInferPayload(text);
      // Model output can vary on another attempt; let chunk retry-gaps recover
      // without accepting a proposal with silently discarded operations.
      if (!ops) return { type: 'failed', kind: 'transient', status: null, detail: 'unparseable infer response' };
      return { type: 'ok', ops };
    } catch (err) {
      if (signal.aborted) throw err;
      if (isAbortError(err)) throw err;
      return inferResultFromError(err);
    }
  };

  return {
    async *enhance(
      prompt: string,
      images: readonly EnhanceImageInput[],
      signal: AbortSignal,
      systemPrompt?: string,
      opts?: EnhanceCallOptions,
    ): AsyncIterable<EnhanceChunk> {
      const request: TextCallRequest = {
        maxOutputTokens: (opts?.defaults ?? CLIPROXY_TEXT_DEFAULTS).max_completion_tokens,
        systemPrompt: systemPrompt ?? ENHANCE_SYSTEM_PROMPT,
        user: prompt,
        images,
        ...(opts?.responseFormat ? { responseFormat: opts.responseFormat } : {}),
        ...(opts?.reasoningEffort === undefined ? {} : { userEffort: opts.reasoningEffort }),
      };
      let opened: OpenedStream;
      try {
        opened = await enhancePolicy.execute(
          ({ signal: policySignal }) => openWithTimeout(
            request,
            pinnedEffortMaxResponseBytes(init.maxResponseBytes, opts?.reasoningEffort),
            AbortSignal.any([policySignal, signal]),
            init.enhanceOpenTimeoutMs ?? 15_000,
          ),
          signal,
        );
      } catch (error) {
        yield enhanceFailureChunk(error);
        return;
      }

      // Content alone is not completion: require a successful terminal.
      // Drain failures never replay the deltas already exposed to the client.
      let sawContent = false;
      let sawReasoning = false;
      try {
        for await (const event of wireEvents(opened.stream, opened.tap)) {
          if (signal.aborted) return;
          if (event.type === 'upstream-error') {
            // Surface an in-stream failure with detail rather than letting it
            // degrade to a silent "ended without content".
            yield { type: 'failed', status: null, detail: safeTextDetail(detailOf(event.payload)) };
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
        yield enhanceFailureChunk(bodyReadError(error));
        return;
      }

      if (sawContent) {
        yield { type: 'done' };
        return;
      }
      yield { type: 'failed', status: null, detail: 'stream ended without content' };
    },

    async *brainstormCharacters(input: BrainstormCharactersInput, signal: AbortSignal): AsyncIterable<BrainstormChunk> {
      const request: TextCallRequest = {
        maxOutputTokens: brainstormDefaults(input.count, input.reasoningEffort).max_completion_tokens,
        systemPrompt: buildBrainstormSystemPrompt({
          count: input.count,
          modelId: input.modelId,
          ...(input.layout === undefined ? {} : { layout: input.layout }),
          ...(input.medium === undefined ? {} : { medium: input.medium }),
          ...(input.variationSeed === undefined ? {} : { variationSeed: input.variationSeed }),
        }),
        user: buildBrainstormBrief(input.brief),
        ...(input.reasoningEffort === undefined ? {} : { userEffort: input.reasoningEffort }),
      };
      let opened: OpenedStream;
      try {
        opened = await enhancePolicy.execute(
          ({ signal: policySignal }) => openWithTimeout(
            request,
            pinnedEffortMaxResponseBytes(init.brainstormMaxResponseBytes ?? init.maxResponseBytes, input.reasoningEffort),
            AbortSignal.any([policySignal, signal]),
            init.brainstormOpenTimeoutMs ?? init.enhanceOpenTimeoutMs ?? 15_000,
          ),
          signal,
        );
      } catch (error) {
        const chunk = enhanceFailureChunk(error);
        if (chunk.type === 'failed') {
          const contentFilter = isLikelyContentFilterFailure(chunk.detail);
          yield {
            type: 'failed',
            ...(contentFilter
              ? { kind: 'content-filter' as const }
              : chunk.kind !== undefined ? { kind: chunk.kind } : {}),
            status: chunk.status,
            detail: chunk.detail,
            ...(chunk.moderation ? { moderation: chunk.moderation } : {}),
            ...(chunk.retryAfterSeconds !== undefined ? { retryAfterSeconds: chunk.retryAfterSeconds } : {}),
          };
        } else {
          yield { type: 'failed', kind: 'permanent' as const, status: null, detail: 'brainstorm open failed' };
        }
        return;
      }

      const records = createBrainstormRecordAssembler(input, logger);
      try {
        for await (const event of wireEvents(opened.stream, opened.tap)) {
          if (signal.aborted) return;
          if (event.type === 'upstream-error') {
            const detail = safeTextDetail(detailOf(event.payload));
            // Refusal wording wins, then the in-stream classifier decides
            // quota / transient / permanent so the route's failover sees a
            // mid-stream upstream timeout as transient.
            const inStream = classifyStreamError(event.payload, quotaFloorMs);
            const kind = isLikelyContentFilterFailure(detail)
              ? 'content-filter' as const
              : inStream instanceof QuotaExhaustedError
                ? 'quota' as const
                : inStream instanceof TransientUpstreamError
                  ? 'transient' as const
                  : 'permanent' as const;
            yield { type: 'failed', kind, status: null, detail };
            return;
          }
          if (event.type === 'text') {
            for (const c of records.push(event.text)) {
              yield c;
              if (c.type === 'failed') return;
            }
            // The requested count is complete; the rest of the stream is not needed.
            if (records.fulfilled()) break;
          } else if (event.type === 'end') {
            // Preserve the full-count length exception: complete records have
            // already satisfied the request and no partial tail is needed.
            if (event.finish?.unified === 'length' && records.fulfilled()) break;
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
          const failure = enhanceFailureChunk(error);
          if (failure.type === 'failed') yield failure;
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
    },

    async draftList(input: DraftListProviderInput, signal: AbortSignal): Promise<DraftResult> {
      try {
        const text = await callWithPolicy(draftListPolicy, signal, {
          maxOutputTokens: DRAFT_LIST_DEFAULTS.max_completion_tokens,
          systemPrompt: imageAuthoringSystemPrompt(DRAFT_LIST_SYSTEM_PROMPT, input.modelId),
          user: draftBrief(input),
          responseFormat: 'json_object',
        }, init.maxResponseBytes);
        const payload = parseDraftPayload(text);
        if (!payload) return { type: 'failed', status: null, detail: 'unparseable draft response' };
        return { type: 'ok', payload };
      } catch (err) {
        if (signal.aborted) throw err;
        if (isAbortError(err)) throw err;
        return draftResultFromError(err);
      }
    },

    // Non-streaming and outside any policy, as before.
    async draftTemplate(input: DraftTemplateProviderInput, signal: AbortSignal): Promise<DraftTemplateResult> {
      const knownNames = new Set(input.library.lists.map((l) => l.name));
      const request: TextCallRequest = {
        maxOutputTokens: DRAFT_TEMPLATE_DEFAULTS.max_completion_tokens,
        systemPrompt: imageAuthoringSystemPrompt(DRAFT_TEMPLATE_SYSTEM_PROMPT, input.modelId),
        user: draftTemplateBrief(input),
      };
      let result: Awaited<ReturnType<LanguageModelV4['doGenerate']>>;
      try {
        await moderate(request, signal);
        const lm = await languageModel(init.maxResponseBytes);
        result = await lm.doGenerate({ ...textCallOptions(adapter, model, request), abortSignal: signal });
      } catch (err) {
        if (signal.aborted) throw err;
        if (isAbortError(err)) throw err;
        return draftTemplateFailure(err);
      }
      const finish = upstreamFinish(result.finishReason);
      const finishError = finish === null ? null : classifyFinish({ finishReason: finish });
      if (finishError) return draftResultFromError(finishError);
      const textParts = result.content.filter((part): part is { type: 'text'; text: string } => part.type === 'text');
      if (textParts.length === 0) return { type: 'failed', status: null, detail: 'unparseable draft response' };
      return draftTemplateResultFromContent(textParts.map((part) => part.text).join(''), knownNames, null);
    },

    async aiFill(input: AiFillProviderInput, signal: AbortSignal): Promise<AiFillResult> {
      try {
        const batchSize = input.batchSize ?? 1;
        const isBatch = batchSize > 1;
        const maxOutputTokens = isBatch
          ? Math.min(AI_FILL_DEFAULTS.max_completion_tokens * batchSize, AI_FILL_BATCH_MAX_COMPLETION_TOKENS)
          : AI_FILL_DEFAULTS.max_completion_tokens;
        const text = await callWithPolicy(isBatch ? aiFillBatchPolicy : aiFillPolicy, signal, {
          maxOutputTokens,
          systemPrompt: input.systemPrompt,
          user: input.userContent,
          ...(input.reasoningEffort === undefined ? {} : { userEffort: input.reasoningEffort }),
        }, pinnedEffortMaxResponseBytes(inferMaxResponseBytes, input.reasoningEffort));
        return { type: 'ok', text };
      } catch (err) {
        if (signal.aborted) throw err;
        if (isAbortError(err)) throw err;
        const failed = inferResultFromError(err);
        if (failed.type === 'failed') return failed;
        throw err;
      }
    },

    inferDimensions(snapshotJson: string, signal: AbortSignal, systemPrompt?: string): Promise<InferResult> {
      return inferWithPolicy(inferPolicy, snapshotJson, signal, systemPrompt);
    },

    inferTaxonomy(snapshotJson: string, signal: AbortSignal, systemPrompt?: string): Promise<InferResult> {
      return inferWithPolicy(taxonomyPolicy, snapshotJson, signal, systemPrompt);
    },

    inferDimensionsSingleAttempt(snapshotJson: string, signal: AbortSignal, systemPrompt?: string): Promise<InferResult> {
      return inferWithPolicy(inferRetryGapsPolicy, snapshotJson, signal, systemPrompt);
    },

    async rescueDimension(args: RescueDimensionArgs, signal: AbortSignal): Promise<InferResult> {
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
        const text = await callWithPolicy(inferRetryGapsPolicy, signal, {
          maxOutputTokens: INFER_DIMENSIONS_DEFAULTS.max_completion_tokens,
          systemPrompt: imageAuthoringSystemPrompt(RESCUE_DIMENSION_SYSTEM_PROMPT, args.modelId),
          user,
          responseFormat: RESCUE_RESPONSE_FORMAT,
        }, inferMaxResponseBytes);
        const ops = parseInferPayload(text);
        if (!ops) return { type: 'failed', kind: 'permanent', status: null, detail: 'unparseable rescue response' };
        // The provider boundary does not leak unrelated ops.
        const addOptionOps = ops.filter((o): o is Extract<RawInferOp, { op: 'addOption' }> => o.op === 'addOption');
        return { type: 'ok', ops: addOptionOps };
      } catch (err) {
        if (signal.aborted) throw err;
        if (isAbortError(err)) throw err;
        return inferResultFromError(err);
      }
    },

    inferBreakerState() {
      return policyBreakerState(inferPolicy);
    },
  };
}

// The legacy draft-template call read the body itself: an HTTP failure kept its
// status and raw body, an oversized or unreadable 2xx answer was a plain
// failure, a transport error went through the shared mapper.
function draftTemplateFailure(err: unknown): Extract<DraftTemplateResult, { type: 'failed' }> {
  const tooLarge = classifyApiError(err, Number.POSITIVE_INFINITY) instanceof TextResponseTooLargeError;
  const status = APICallError.isInstance(err) ? err.statusCode ?? null : null;
  if (tooLarge) return { type: 'failed', status, detail: 'response too large' };
  if (APICallError.isInstance(err) && status !== null) {
    if (status >= 400) return { type: 'failed', status, detail: safeTextDetail(err.responseBody ?? '').slice(0, 500) };
    return { type: 'failed', status, detail: 'unparseable draft response' };
  }
  if (InvalidResponseDataError.isInstance(err) || TypeValidationError.isInstance(err) || JSONParseError.isInstance(err)) {
    return { type: 'failed', status: null, detail: 'unparseable draft response' };
  }
  return draftResultFromError(err);
}

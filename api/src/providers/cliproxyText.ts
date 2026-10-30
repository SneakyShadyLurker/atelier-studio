import type { Config } from '../config';
import type { AiFillBackend, GptModerationNotice, TextReasoningEffort } from '@atelier/shared';
import { GptModerationError, moderateGptInput, type GptModerationFailureKind } from '../routing/gptModeration';
import { errorToRawString as detailOf, readBodyBounded as readBodyBoundedShared, tryParseJson } from './_http';
import { frameDataText, readSseFrames, type ParsedSseFrame } from './_sse';
import {
  AI_FILL_BATCH_MAX_COMPLETION_TOKENS,
  aiFillBatchPerAttemptTimeoutMs,
  aiFillPerAttemptTimeoutMs,
  AI_FILL_DEFAULTS,
  pinnedEffortMaxResponseBytes,
  AI_FILL_MAX_ATTEMPTS,
  CLIPROXY_CHAT_PATH,
  CLIPROXY_TEXT_DEFAULTS,
  DRAFT_LIST_DEFAULTS,
  DRAFT_TEMPLATE_DEFAULTS,
  GLM_ABLITERATED_MAX_COMPLETION_TOKENS,
  GLM_ABLITERATED_REASONING_EFFORT,
  GPT_REASONING_EFFORT,
  GROK_SAMPLING,
  INFER_DIMENSIONS_DEFAULTS,
  MAX_DRAFT_RAW_BODY_CHARS,
  TEXT_BACKEND_DEFAULT_REASONING_EFFORT,
  brainstormDefaults,
  textBackendModels,
  textMaxResponseBytes,
} from './cliproxyText.config';
import { ENHANCE_SYSTEM_PROMPT } from '../prompts/enhanceSystemPrompt';
import {
  BRAINSTORM_RECORD_SEPARATOR,
  BRAINSTORM_FIELD_SEPARATOR,
  assembleBrainstormCharacterPrompt,
  buildBrainstormBrief,
  buildBrainstormSystemPrompt,
} from '../prompts/brainstormCharactersSystemPrompt';
import { classifyImageModelTarget } from '../prompts/gptImagePhrasing';
import { DRAFT_LIST_SYSTEM_PROMPT } from '../prompts/draftListSystemPrompt';
import { DRAFT_TEMPLATE_SYSTEM_PROMPT } from '../prompts/draftTemplateSystemPrompt';
import { INFER_DIMENSIONS_SYSTEM_PROMPT } from '../prompts/inferDimensionsSystemPrompt';
import { RESCUE_DIMENSION_SYSTEM_PROMPT } from '../prompts/rescueSystemPrompt';
import { isLikelyContentFilterFailure, isLikelyModelRefusal } from '../prompts/modelOutput';
import { parseInferPayload, RESCUE_RESPONSE_FORMAT } from '../prompts/inferParse';
import type { LibrarySnapshot, RawInferOp } from '../prompts/inferTypes';
import { findTokens, VAR_TOKEN_ANCHORED } from '@atelier/shared/template-tokens';
import { imageAuthoringSystemPrompt } from '../prompts/gptSystemPrompt';
import type { LibraryOverview } from '../prompts/libraryOverview';
import {
  parseVarToken,
  type BrainstormLayout,
  type BrainstormMedium,
  type DraftTemplateRequest,
  type DraftTemplateResponse,
  type DraftVariableListResponse,
} from '@atelier/shared';
import {
  buildResilientPolicy,
  PermanentUpstreamError,
  Parse4xxError,
  policyBreakerState,
  QuotaExhaustedError,
  TransientUpstreamError,
} from '../lifecycle/resilient-call';
import { isAbortError } from '../lifecycle/abort';
import { parseRetryAfterMs } from './retryAfter';
import { sliceJsonObject } from '../prompts/lenientJson';
import { BrokenCircuitError, TaskCancelledError, type IPolicy } from 'cockatiel';
import { redactSecrets } from '../observability/redact';
import { loggerForConfig } from '../observability/logger';
import { NOOP_PROVIDER_LOGGER, type ProviderLogger } from './types';

export interface CliproxyTextProviderConfig {
  baseUrl: string;
  token: string;
  openrouterApiKey?: string | undefined;
  model: string;
  /**
   * Routed backend whose wire shape and moderation this provider uses. Absent
   * means a generic OpenAI-compatible body; `model` never selects the shape.
   */
  backend?: AiFillBackend | undefined;
  maxResponseBytes: number;
  // Larger raw-stream cap for the infer/taxonomy/rescue path (32000-token
  // budget streamed with per-token SSE framing). Optional — defaults to
  // maxResponseBytes so lightweight test fakes keep their tighter limit.
  inferMaxResponseBytes?: number;
  // Brainstorm raw-stream cap (N prose prompts). Optional — falls back to
  // maxResponseBytes so lightweight test fakes keep their tighter limit.
  brainstormMaxResponseBytes?: number;
  // Floor (ms) at or above which a raw Retry-After on a 429 is treated as
  // 5h-budget exhaustion rather than transient overload. Defaults to 300_000
  // (5 min) when absent — same as the QUOTA_MIN_RETRY_AFTER_MS config knob.
  quotaMinRetryAfterMs?: number;
  enhanceOpenTimeoutMs?: number;
  brainstormOpenTimeoutMs?: number;
  /** Operational events; defaults to a no-op logger. */
  logger?: ProviderLogger;
}

/**
 * One resilience policy (own retry and breaker) per text call family, built by
 * `cliproxyTextPolicies` — production and tests share that one derivation.
 */
export interface CliproxyTextPolicies {
  enhancePolicy: IPolicy;
  draftListPolicy: IPolicy;
  inferPolicy: IPolicy;
  taxonomyPolicy: IPolicy;
  inferRetryGapsPolicy: IPolicy;
  aiFillPolicy: IPolicy;
  aiFillBatchPolicy: IPolicy;
}

export type CliproxyTextPolicyKnobs = Pick<
  Config,
  | 'RESILIENT_PER_ATTEMPT_TIMEOUT_MS'
  | 'RESILIENT_MAX_ATTEMPTS'
  | 'RESILIENT_INITIAL_BACKOFF_MS'
  | 'RESILIENT_MAX_BACKOFF_MS'
  | 'RESILIENT_BREAKER_THRESHOLD'
  | 'RESILIENT_HALF_OPEN_AFTER_MS'
  | 'INFER_TAXONOMY_TIMEOUT_MS'
  | 'AI_FILL_PER_ATTEMPT_TIMEOUT_MS'
>;

/**
 * The single source of the text resilience policies. `deadlineBackend` keys
 * GLM Abliterated's longer ai-fill attempts. Every policy shares the RESILIENT_*
 * backoff and breaker knobs; each gets its own breaker instance.
 */
export function cliproxyTextPolicies(
  knobs: CliproxyTextPolicyKnobs,
  deadlineBackend: 'glm-abliterated' | null,
): CliproxyTextPolicies {
  const policy = (timeoutPerAttemptMs: number, maxAttempts: number, noTimeout = false): IPolicy => buildResilientPolicy({
    timeoutPerAttemptMs,
    maxAttempts,
    initialBackoffMs: knobs.RESILIENT_INITIAL_BACKOFF_MS,
    maxBackoffMs: knobs.RESILIENT_MAX_BACKOFF_MS,
    breakerThreshold: knobs.RESILIENT_BREAKER_THRESHOLD,
    halfOpenAfterMs: knobs.RESILIENT_HALF_OPEN_AFTER_MS,
    ...(noTimeout ? { noTimeout: true } : {}),
  });
  return {
    // Enhance streams own their deadlines (open timeout + drain), so the
    // policy adds no per-attempt timeout.
    enhancePolicy: policy(0, knobs.RESILIENT_MAX_ATTEMPTS, true),
    draftListPolicy: policy(knobs.RESILIENT_PER_ATTEMPT_TIMEOUT_MS, knobs.RESILIENT_MAX_ATTEMPTS),
    inferPolicy: policy(knobs.RESILIENT_PER_ATTEMPT_TIMEOUT_MS, knobs.RESILIENT_MAX_ATTEMPTS),
    // One attempt per provider call. The route may recover one transient result
    // under a single shared INFER_TAXONOMY_TIMEOUT_MS signal, so totalEnvelope
    // still budgets one taxonomy wall-time envelope, not two full timeouts.
    taxonomyPolicy: policy(knobs.INFER_TAXONOMY_TIMEOUT_MS, 1),
    inferRetryGapsPolicy: policy(knobs.RESILIENT_PER_ATTEMPT_TIMEOUT_MS, 1),
    // ai-fill: one retry on transient errors, retaining the historical
    // per-attempt ceiling as latency headroom.
    aiFillPolicy: policy(aiFillPerAttemptTimeoutMs(deadlineBackend, knobs.AI_FILL_PER_ATTEMPT_TIMEOUT_MS), AI_FILL_MAX_ATTEMPTS),
    aiFillBatchPolicy: policy(aiFillBatchPerAttemptTimeoutMs(deadlineBackend), AI_FILL_MAX_ATTEMPTS),
  };
}

export type EnhanceChunk =
  | { type: 'delta'; text: string }
  // Emitted at most once per stream, on the first reasoning token, and
  // deliberately carrying no text: the CoT is discarded by contract, this only
  // says the model has started thinking. Long-running routes turn it into a
  // progress signal; every other consumer ignores it.
  | { type: 'reasoning' }
  | { type: 'done' }
  | { type: 'failed'; kind?: 'transient' | 'permanent' | 'quota' | GptModerationFailureKind; status: number | null; detail: string; retryAfterSeconds?: number; moderation?: GptModerationNotice };

export type BrainstormChunk =
  | { type: 'prompt'; index: number; text: string }
  | { type: 'done'; count: number }
  | { type: 'failed'; kind?: 'transient' | 'permanent' | 'quota' | 'content-filter' | GptModerationFailureKind; status: number | null; detail: string; retryAfterSeconds?: number; moderation?: GptModerationNotice };

export interface BrainstormCharactersInput {
  readonly brief?: string;
  readonly count: number;
  readonly layout?: BrainstormLayout;
  readonly medium?: BrainstormMedium;
  readonly modelId: string;
  readonly variationSeed?: number;
  /** User-pinned effort; replaces the backend's default. See ChatStreamRequest. */
  readonly reasoningEffort?: TextReasoningEffort;
}

export interface EnhanceImageInput {
  bytes: Uint8Array;
  mime: string;
}

type ChatUserContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface DraftListProviderInput {
  readonly modelId?: string;
  name: string;
  existing: readonly string[];
  description?: string;
  target: number;
}

export type DraftResult =
  | { type: 'ok'; payload: DraftVariableListResponse }
  | { type: 'failed'; kind?: GptModerationFailureKind; status: number | null; detail: string; retryAfterSeconds?: number; moderation?: GptModerationNotice };

export type InferResult =
  | { type: 'ok'; ops: RawInferOp[] }
  | { type: 'failed'; kind: 'transient' | 'permanent' | 'quota' | GptModerationFailureKind; status: number | null; detail: string; retryAfterSeconds?: number; moderation?: GptModerationNotice };

export interface AiFillProviderInput {
  readonly systemPrompt: string;
  readonly userContent: string;
  readonly batchSize?: number;
  /** User-pinned effort; replaces the backend's default. See ChatStreamRequest. */
  readonly reasoningEffort?: TextReasoningEffort;
}

export type AiFillResult =
  | { type: 'ok'; text: string }
  | { type: 'failed'; kind: 'transient' | 'permanent' | 'quota' | GptModerationFailureKind; status: number | null; detail: string; retryAfterSeconds?: number; moderation?: GptModerationNotice };

export type DraftTemplateProviderInput = DraftTemplateRequest & {
  readonly library: LibraryOverview;
};

export type DraftTemplateResult =
  | { type: 'ok'; payload: DraftTemplateResponse }
  | { type: 'failed'; kind?: GptModerationFailureKind; status: number | null; detail: string; retryAfterSeconds?: number; moderation?: GptModerationNotice };

export interface RescueDimensionArgs {
  readonly modelId?: string;
  readonly previewSnapshot: LibrarySnapshot;
  readonly templateLists: readonly string[];
  readonly targetListName: string;
  readonly conflictReason: string;
}

export interface CliproxyTextProvider {
  enhance(prompt: string, images: readonly EnhanceImageInput[], signal: AbortSignal, systemPrompt?: string, opts?: EnhanceCallOptions): AsyncIterable<EnhanceChunk>;
  brainstormCharacters(input: BrainstormCharactersInput, signal: AbortSignal): AsyncIterable<BrainstormChunk>;
  draftList(input: DraftListProviderInput, signal: AbortSignal): Promise<DraftResult>;
  draftTemplate(input: DraftTemplateProviderInput, signal: AbortSignal): Promise<DraftTemplateResult>;
  aiFill(input: AiFillProviderInput, signal: AbortSignal): Promise<AiFillResult>;
  inferDimensions(snapshotJson: string, signal: AbortSignal, systemPrompt?: string): Promise<InferResult>;
  // Pass-1 (taxonomy) call on its own longer single-attempt policy. Required
  // (not optional) so a provider that forgot to wire the taxonomy timeout
  // cannot compile — preventing a silent regression to the 70s inferDimensions
  // ceiling that this fix exists to remove. Test fakes implement it explicitly.
  inferTaxonomy(snapshotJson: string, signal: AbortSignal, systemPrompt?: string): Promise<InferResult>;
  inferDimensionsSingleAttempt(snapshotJson: string, signal: AbortSignal, systemPrompt?: string): Promise<InferResult>;
  rescueDimension(args: RescueDimensionArgs, signal: AbortSignal): Promise<InferResult>;
  inferBreakerState?(): 'open' | 'half-open' | 'closed';
}

// Explicit long-budget wording, distinct from transient overload. Kept narrow:
// matches upstream quota phrasing, not generic "rate limit"/"slow down".
const QUOTA_BODY_RE = /usage limit|quota|5\s*hour|weekly limit|exceeded your (current )?(plan|usage)/i;

function bodyText(body: unknown): string {
  const msg = (body as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof msg === 'string' ? msg : detailOf(body);
}

function classifyHttpFailure(status: number, body: unknown, headers: Headers, quotaFloorMs: number): Error {
  const retryAfterMs = parseRetryAfterMs(headers.get('retry-after')) ?? null;
  const cause = { status, body, retryAfterMs };
  if (status >= 500 && status <= 599) {
    return new TransientUpstreamError('5xx', cause, `upstream ${status}`);
  }
  if (status === 429) {
    const quotaByHeader = retryAfterMs !== null && retryAfterMs >= quotaFloorMs;
    const quotaByBody = QUOTA_BODY_RE.test(bodyText(body));
    if (quotaByHeader || quotaByBody) {
      const secs = retryAfterMs !== null ? Math.round(retryAfterMs / 1000) : null;
      return new QuotaExhaustedError(secs, cause, 'upstream quota exhausted');
    }
    return new TransientUpstreamError('429', cause, 'upstream rate-limited');
  }
  if (status === 408) {
    return new TransientUpstreamError('408', cause, 'upstream request-timeout');
  }
  return new PermanentUpstreamError('4xx', cause, `upstream ${status}`);
}

/** Exported for unit tests only — not part of the public provider API. */
export function classifyUpstreamFailureForTests(
  status: number,
  body: unknown,
  headers: Headers,
  quotaFloorMs: number,
): Error {
  return classifyHttpFailure(status, body, headers, quotaFloorMs);
}

/** Exported for unit tests only — not part of the public provider API. */
export const inferResultFromErrorForTests = inferResultFromError;

const IN_STREAM_TIMEOUT_RE = /timed?\s*out|deadline\s*exceeded|connection\s*reset/i;
const TEXT_DETAIL_LOG_CAP = 2048;

function safeTextDetail(detail: string): string {
  const redacted = redactSecrets(detail);
  return redacted.length > TEXT_DETAIL_LOG_CAP
    ? `${redacted.slice(0, TEXT_DETAIL_LOG_CAP)}…[truncated]`
    : redacted;
}

function classifyInStreamFrame(errObj: unknown): Error {
  const msg =
    typeof errObj === 'string'
      ? errObj
      : (errObj as { readonly message?: unknown } | null)?.message;
  const text = typeof msg === 'string' ? msg : detailOf(errObj);
  if (QUOTA_BODY_RE.test(text)) {
    return new QuotaExhaustedError(null, errObj, text);
  }
  if (IN_STREAM_TIMEOUT_RE.test(text)) {
    return new TransientUpstreamError('in-stream-timeout', errObj, text);
  }
  return new PermanentUpstreamError('in-stream', errObj, text);
}

function classifyNetworkError(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  return new TransientUpstreamError('socket', err, msg);
}

function statusFromCause(cause: unknown): number | null {
  if (
    typeof cause === 'object' &&
    cause !== null &&
    typeof (cause as { readonly status?: unknown }).status === 'number'
  ) {
    return (cause as { readonly status: number }).status;
  }
  return null;
}

function detailFromTypedUpstreamError(err: TransientUpstreamError | PermanentUpstreamError): string {
  if (
    typeof err.cause === 'object' &&
    err.cause !== null &&
    'body' in err.cause
  ) {
    return safeTextDetail(detailOf((err.cause as { readonly body: unknown }).body));
  }
  return safeTextDetail(err.message);
}

// Shared error-to-result mappers for the policy-wrapped flows. The three
// methods (`draftList`, `inferDimensions[SingleAttempt]`, `rescueDimension`)
// each ran an identical catch ladder before extraction. Aborts and
// DOMException-AbortError are still rethrown by the caller — they are
// orchestrator signals, not failures.
function moderationFailure(err: GptModerationError) {
  return { type: 'failed' as const, kind: err.kind, status: err.status, detail: err.message, moderation: err.moderation };
}

function inferResultFromError(err: unknown): InferResult {
  if (err instanceof GptModerationError) return moderationFailure(err);
  if (err instanceof QuotaExhaustedError) {
    return {
      type: 'failed',
      kind: 'quota',
      status: statusFromCause(err.cause),
      detail: safeTextDetail(detailOf(err)),
      ...(err.retryAfterSeconds !== null ? { retryAfterSeconds: err.retryAfterSeconds } : {}),
    };
  }
  if (err instanceof TransientUpstreamError) {
    return { type: 'failed', kind: 'transient', status: statusFromCause(err.cause), detail: detailFromTypedUpstreamError(err) };
  }
  if (err instanceof BrokenCircuitError) {
    return { type: 'failed', kind: 'transient', status: null, detail: safeTextDetail(detailOf(err)) };
  }
  if (err instanceof PermanentUpstreamError) {
    return { type: 'failed', kind: 'permanent', status: statusFromCause(err.cause), detail: detailFromTypedUpstreamError(err) };
  }
  if (err instanceof Parse4xxError) {
    return { type: 'failed', kind: 'permanent', status: null, detail: safeTextDetail(detailOf(err)) };
  }
  // A per-attempt timeout (cockatiel raises TaskCancelledError, "Operation
  // timed out after Nms") is inherently transient — the upstream was slow under
  // concurrent load, and a retry (esp. the post-wave-1 retry-gaps pass, which
  // runs with the contention cleared) usually succeeds. Without this it falls
  // through to `permanent` below and a single slow chunk aborts the whole run.
  if (err instanceof TaskCancelledError) {
    return { type: 'failed', kind: 'transient', status: null, detail: safeTextDetail(detailOf(err)) };
  }
  return { type: 'failed', kind: 'permanent', status: null, detail: safeTextDetail(detailOf(err)) };
}

function draftResultFromError(err: unknown): Extract<DraftResult, { type: 'failed' }> {
  if (err instanceof GptModerationError) return moderationFailure(err);
  if (err instanceof QuotaExhaustedError) {
    return {
      type: 'failed',
      status: statusFromCause(err.cause),
      detail: safeTextDetail(detailOf(err)),
      ...(err.retryAfterSeconds !== null ? { retryAfterSeconds: err.retryAfterSeconds } : {}),
    };
  }
  if (err instanceof TransientUpstreamError) {
    return { type: 'failed', status: statusFromCause(err.cause), detail: detailFromTypedUpstreamError(err) };
  }
  if (err instanceof PermanentUpstreamError) {
    return { type: 'failed', status: statusFromCause(err.cause), detail: detailFromTypedUpstreamError(err) };
  }
  return { type: 'failed', status: null, detail: safeTextDetail(detailOf(err)) };
}

function enhanceFailureChunk(err: unknown): EnhanceChunk {
  if (err instanceof GptModerationError) return moderationFailure(err);
  if (err instanceof QuotaExhaustedError) {
    return {
      type: 'failed',
      kind: 'quota',
      status: statusFromCause(err.cause),
      detail: safeTextDetail(detailOf(err)),
      ...(err.retryAfterSeconds !== null ? { retryAfterSeconds: err.retryAfterSeconds } : {}),
    };
  }
  if (err instanceof TransientUpstreamError) {
    return { type: 'failed', kind: 'transient', status: statusFromCause(err.cause), detail: detailFromTypedUpstreamError(err) };
  }
  if (err instanceof PermanentUpstreamError) {
    return { type: 'failed', kind: 'permanent', status: statusFromCause(err.cause), detail: detailFromTypedUpstreamError(err) };
  }
  // An open breaker or a per-attempt timeout is transient by the same
  // reasoning as inferResultFromError: the other backend, or a later attempt,
  // is unaffected. Brainstorm's cross-backend failover keys on this kind.
  if (err instanceof BrokenCircuitError || err instanceof TaskCancelledError) {
    return { type: 'failed', kind: 'transient', status: null, detail: safeTextDetail(detailOf(err)) };
  }
  return { type: 'failed', kind: 'permanent', status: null, detail: safeTextDetail(detailOf(err)) };
}

class CliproxyTextTooLargeError extends Error {
  constructor(readonly limit: number, readonly seenBytes: number) {
    super(`CLIProxyAPI text response exceeded ${limit} bytes (saw ${seenBytes})`);
    this.name = 'CliproxyTextTooLargeError';
  }
}


function parseDraftPayload(raw: string): DraftVariableListResponse | null {
  const parsed = tryParseJson(sliceJsonObject(raw));
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as { kind?: unknown; entries?: unknown; question?: unknown };
  if (obj.kind === 'entries' && Array.isArray(obj.entries)) {
    const entries = obj.entries.filter((e): e is string => typeof e === 'string');
    return { kind: 'entries', entries };
  }
  if (obj.kind === 'clarify' && typeof obj.question === 'string' && obj.question.trim().length > 0) {
    return { kind: 'clarify', question: obj.question };
  }
  return null;
}

function draftBrief(input: DraftListProviderInput): string {
  const lines = [
    `List name: ${JSON.stringify(input.name)}`,
    `Existing values (do not repeat these): ${input.existing.length > 0 ? JSON.stringify(input.existing) : 'none'}`,
    `Produce up to ${input.target} new values.`,
  ];
  if (input.description) lines.push(`User description of the list: ${JSON.stringify(input.description)}`);
  return lines.join('\n');
}

function draftTemplateBrief(input: DraftTemplateProviderInput): string {
  const parts: string[] = [];
  parts.push(`<name>${JSON.stringify(input.name)}</name>`);
  if (input.existingBody) {
    parts.push(`<existing_body>${JSON.stringify(input.existingBody)}</existing_body>`);
  }
  if (input.description) {
    parts.push(`<description>${JSON.stringify(input.description)}</description>`);
  }
  parts.push('<library>');
  for (const list of input.library.lists) {
    const samples = list.samples.map((s) => JSON.stringify(s)).join(', ');
    parts.push(`  - ${JSON.stringify(list.name)} (${list.optionCount} options): [${samples}]`);
  }
  parts.push('</library>');
  return parts.join('\n');
}

function stripUnknownTokens(
  body: string,
  knownNames: ReadonlySet<string>,
): { body: string; warnings: string[] } {
  const tokens = findTokens(body);
  if (tokens.length === 0) return { body, warnings: [] };

  const unknownVarNames = new Set<string>();
  let nonVarCount = 0;
  let out = body;
  // Walk back-to-front so prior splice offsets stay valid.
  for (let i = tokens.length - 1; i >= 0; i--) {
    const tok = tokens[i];
    if (tok === undefined) continue;
    const m = tok.text.match(VAR_TOKEN_ANCHORED);
    if (m) {
      const inner = m[1];
      if (!inner) continue;
      const { listName } = parseVarToken(inner);
      if (!listName) continue;
      if (knownNames.has(listName)) continue;
      unknownVarNames.add(listName);
      const replacement = listName.replace(/_/g, ' ');
      out = out.slice(0, tok.start) + replacement + out.slice(tok.end);
    } else {
      nonVarCount += 1;
      out = out.slice(0, tok.start) + out.slice(tok.end);
    }
  }

  const warnings: string[] = [];
  for (const name of unknownVarNames) {
    warnings.push(`Removed unknown {{var::${name}}} reference`);
  }
  if (nonVarCount > 0) {
    warnings.push(
      `Removed ${nonVarCount} non-var macro token${nonVarCount === 1 ? '' : 's'} (advanced syntax — add by hand)`,
    );
  }
  return { body: out, warnings };
}

interface ChatDefaults {
  reasoning_effort: string;
  verbosity: string;
  max_completion_tokens: number;
}

interface ChatStreamRequest {
  defaults: ChatDefaults;
  systemPrompt: string;
  userContent: string | readonly ChatUserContentPart[];
  // When set, forwards a `response_format` so the model is constrained to valid
  // JSON — syntactically for 'json_object' (caption-format safety belt) or
  // structurally where the selected backend supports json_schema. See
  // ChatResponseFormat.
  responseFormat?: ChatResponseFormat;
  /**
   * The user's Settings effort for this workload's pinned backend. When set it
   * replaces both the per-path default and a backend's own default effort; the
   * GPT branch alone keeps its pin. Validated per backend before it gets here.
   */
  reasoningEffort?: TextReasoningEffort;
}

/** `response_format` body value: json_object, or the caller's strict schema forwarded verbatim. */
function responseFormatBody(format: ChatResponseFormat): Record<string, unknown> {
  return format === 'json_object' ? { type: 'json_object' } : { ...format };
}

type SharedChatBackend = 'kimi' | 'mimo' | 'grok' | 'gemini-argon' | 'deepseek-abliterated';

/**
 * The backends that share one OpenAI-compatible wire body. Keyed on the backend
 * key, so GLM Abliterated (its own branch) and an unrouted provider fall through.
 */
function sharedChatBackend(backend: AiFillBackend | undefined): SharedChatBackend | null {
  return backend === 'kimi'
    || backend === 'mimo'
    || backend === 'grok'
    || backend === 'gemini-argon'
    || backend === 'deepseek-abliterated'
    ? backend
    : null;
}

// Per-call overrides for enhance()/the caption-format path. Lets the route use
// json_object with model-safe token bounds without disturbing the default path.
/**
 * `'json_object'` is the syntactic guarantee every backend supports. The
 * `json_schema` form is schema-constrained decoding (`strict: true`), which
 * enforces the shape AND enum members. Verified live through CLIProxyAPI: under
 * plain json_object the model answered a `genre` enum with free text, under
 * json_schema it could not. The shared chat branch (Kimi, MiMo, Grok, Gemini,
 * DeepSeek Abliterated) and the GPT branch forward that schema form; strict
 * schema in streaming mode was verified through CLIProxyAPI.
 * The GLM Abliterated branch omits `response_format` entirely.
 */
export type ChatResponseFormat =
  | 'json_object'
  | { readonly type: 'json_schema'; readonly json_schema: Readonly<Record<string, unknown>> };

export interface EnhanceCallOptions {
  responseFormat?: ChatResponseFormat;
  defaults?: ChatDefaults;
  /** User-pinned effort; replaces the backend's default. See ChatStreamRequest. */
  reasoningEffort?: TextReasoningEffort;
}

function buildChatBody(
  model: string,
  backend: AiFillBackend | undefined,
  req: ChatStreamRequest,
  stream = true,
): Record<string, unknown> {
  const messages = [
    { role: 'system', content: req.systemPrompt },
    { role: 'user', content: req.userContent },
  ];
  // Kimi, MiMo, Grok, Gemini and DeepSeek Abliterated, selected by backend key.
  // OpenAI-compatible: effort, `max_completion_tokens` and strict
  // `response_format` are the live knobs.
  // Kimi takes the per-path default effort (all 'low', a level it lists); every
  // other backend sends its own default, because the proxy silently remaps an
  // unlisted level and the per-path 'low' is unlisted on MiMo. A user pin
  // replaces either. Sampling is provider-owned except Grok, which takes xAI's
  // recommended temperature/top_p. No `verbosity`, `thinking` or host cache
  // controls are sent.
  const sharedBackend = sharedChatBackend(backend);
  if (sharedBackend !== null) {
    const backendDefaultEffort = TEXT_BACKEND_DEFAULT_REASONING_EFFORT[sharedBackend];
    return {
      model,
      stream,
      reasoning_effort: req.reasoningEffort ?? backendDefaultEffort ?? req.defaults.reasoning_effort,
      max_completion_tokens: req.defaults.max_completion_tokens,
      ...(sharedBackend === 'grok' ? GROK_SAMPLING : {}),
      ...(req.responseFormat ? { response_format: responseFormatBody(req.responseFormat) } : {}),
      messages,
    };
  }
  // GLM 5.3 Abliterated, selected by backend key. OpenAI-compatible, so the
  // OpenAI knobs are the live ones. Verified through the proxy:
  // `max_completion_tokens` bounds the answer (finish_reason 'length' at 12
  // tokens) and both stream modes answer. The upstream rejects every
  // `response_format` on this model (HTTP 400
  // `model_response_format_unsupported`), so it is never sent; the one
  // GLM-reachable caller that sets one, the story planner, spells out its JSON
  // shape in the prompt and parses leniently against its schema. The model is
  // text-only, so routing never hands it an image. Effort and the output ceiling
  // are pinned, never forwarded from per-path defaults; only a user-pinned
  // effort replaces the effort ('none' is rejected upstream and never offered).
  // No `verbosity`, `thinking`, sampling or host cache controls are sent.
  if (backend === 'glm-abliterated') {
    return {
      model,
      stream,
      reasoning_effort: req.reasoningEffort ?? GLM_ABLITERATED_REASONING_EFFORT,
      max_completion_tokens: GLM_ABLITERATED_MAX_COMPLETION_TOKENS,
      messages,
    };
  }
  // GPT-6.1 Sol, verified with vision and strict schema.
  // Pin medium even for Studio's max defaults; 'none' is rejected. Omit verbosity
  // because it is ignored upstream. No sampling, thinking, or host cache knobs.
  if (backend === 'gpt') {
    return {
      model,
      stream,
      reasoning_effort: GPT_REASONING_EFFORT,
      max_completion_tokens: req.defaults.max_completion_tokens,
      ...(req.responseFormat ? { response_format: responseFormatBody(req.responseFormat) } : {}),
      messages,
    };
  }
  // Generic OpenAI-compatible fallback: reasoning_effort + verbosity +
  // max_completion_tokens. `thinking` is never sent on this path.
  return {
    model,
    stream,
    reasoning_effort: req.reasoningEffort ?? req.defaults.reasoning_effort,
    verbosity: req.defaults.verbosity,
    max_completion_tokens: req.defaults.max_completion_tokens,
    ...(req.responseFormat ? { response_format: responseFormatBody(req.responseFormat) } : {}),
    messages,
  };
}

async function moderateChatRequest(config: CliproxyTextProviderConfig, req: ChatStreamRequest, signal: AbortSignal): Promise<void> {
  if (config.backend !== 'gpt') return;
  await moderateGptInput(config.openrouterApiKey, {
    task: 'text-generation',
    instructions: req.systemPrompt,
    // JEV is text-only. Never send reference-image bytes or data URLs to it.
    input: typeof req.userContent === 'string'
      ? req.userContent
      : req.userContent.flatMap((part) => part.type === 'text' ? [part.text] : []),
  }, signal);
}

// Shared CLIProxyAPI chat-completion plumbing for the three text capabilities
// (enhance / draftList / inferDimensions): builds the request body, POSTs it,
// and throws typed upstream errors for policy classification.
async function openChatStreamOrThrow(
  config: CliproxyTextProviderConfig,
  baseUrl: string,
  req: ChatStreamRequest,
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  await moderateChatRequest(config, req, signal);
  const body = buildChatBody(config.model, config.backend, req);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${CLIPROXY_CHAT_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw classifyNetworkError(error);
  }

  if (!response.ok) {
    await throwForFailedChatResponse(response, config, signal);
  }
  if (!response.body) {
    throw new PermanentUpstreamError('in-stream', null, 'no response body');
  }
  return response.body;
}

async function throwForFailedChatResponse(
  response: Response,
  config: CliproxyTextProviderConfig,
  signal: AbortSignal,
): Promise<never> {
  let raw: string;
  try {
    raw = await readBodyBoundedShared(response, config.maxResponseBytes, {
      onOversize: (limit, total) => {
        throw new CliproxyTextTooLargeError(limit, total);
      },
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    raw = detailOf(error);
  }
  throw classifyHttpFailure(
    response.status,
    tryParseJson(raw) ?? raw,
    response.headers,
    config.quotaMinRetryAfterMs ?? 300_000,
  );
}

async function openChatStreamOrThrowForEnhance(
  config: CliproxyTextProviderConfig,
  baseUrl: string,
  req: ChatStreamRequest,
  signal: AbortSignal,
  openTimeoutMs: number,
): Promise<ReadableStream<Uint8Array>> {
  const openAc = new AbortController();
  const timeout = setTimeout(() => {
    openAc.abort(new DOMException('open timeout', 'TimeoutError'));
  }, openTimeoutMs);
  try {
    return await openChatStreamOrThrow(
      config,
      baseUrl,
      req,
      AbortSignal.any([signal, openAc.signal]),
    );
  } catch (error) {
    if (!signal.aborted && openAc.signal.aborted) {
      throw new TransientUpstreamError('timeout', error, detailOf(error));
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

class ChatCompletionFinishError extends PermanentUpstreamError {
  constructor(readonly reason: unknown) {
    super('in-stream', reason, String(reason));
  }
}

// Only a natural stop completes unconstrained text. Tool/function calls and
// filtering and token-budget truncation are terminal failures. Capacity
// failures remain retryable before accumulator callers expose any content.
function chatFinishFailure(reason: unknown): Error | null {
  if (reason == null || reason === 'stop') return null;
  if (reason === 'insufficient_system_resource') {
    return new TransientUpstreamError('socket', reason, reason);
  }
  return new ChatCompletionFinishError(reason);
}

// One decoded OpenAI chat-completion SSE frame. Callers own what content
// means and how an in-stream error maps to their failure shape.
type ChatFrame =
  | { readonly kind: 'done' }
  | { readonly kind: 'skip' }
  | { readonly kind: 'error'; readonly payload: unknown }
  | {
      readonly kind: 'chunk';
      readonly content: unknown;
      readonly reasoning: unknown;
      readonly finishReason: unknown;
    };

// `[DONE]` ends the stream; non-object data is skipped. CLIProxyAPI / OpenAI
// emit an in-stream failure as a `{ "error": {...} }` data frame on an
// otherwise-200 stream, and proxy variants may use an `event: error` line.
function decodeChatFrame(frame: ParsedSseFrame): ChatFrame {
  const data = frameDataText(frame).trim();
  if (data === '[DONE]') return { kind: 'done' };
  const parsed = tryParseJson(data);
  if (typeof parsed !== 'object' || parsed === null) return { kind: 'skip' };
  const errObj = (parsed as { error?: unknown }).error;
  if (frame.event === 'error' || errObj != null) return { kind: 'error', payload: errObj ?? parsed };
  const choice = (parsed as { choices?: unknown[] }).choices?.[0] as
    | { delta?: { content?: unknown; reasoning_content?: unknown }; finish_reason?: unknown }
    | undefined;
  return {
    kind: 'chunk',
    content: choice?.delta?.content,
    reasoning: choice?.delta?.reasoning_content,
    finishReason: choice?.finish_reason,
  };
}

function incompleteChatStream(): TransientUpstreamError {
  return new TransientUpstreamError('socket', null, 'stream ended without successful terminal');
}

async function accumulateChatStreamOrThrow(
  body: ReadableStream<Uint8Array>,
  maxResponseBytes: number,
  signal: AbortSignal,
): Promise<string> {
  let acc = '';
  let completed = false;
  try {
    for await (const frame of readSseFrames(
      body,
      maxResponseBytes,
      (limit, total) => {
        throw new CliproxyTextTooLargeError(limit, total);
      },
      signal,
    )) {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      const decoded = decodeChatFrame(frame);
      if (decoded.kind === 'done') { completed = true; break; }
      if (decoded.kind === 'skip') continue;
      if (decoded.kind === 'error') throw classifyInStreamFrame(decoded.payload);
      if (typeof decoded.content === 'string') acc += decoded.content;
      const finishError = chatFinishFailure(decoded.finishReason);
      if (finishError) throw finishError;
      if (decoded.finishReason === 'stop') { completed = true; break; }
    }
    if (!completed) throw incompleteChatStream();
  } catch (error) {
    if (signal.aborted) throw error;
    if (
      error instanceof TransientUpstreamError ||
      error instanceof PermanentUpstreamError ||
      error instanceof QuotaExhaustedError ||
      error instanceof CliproxyTextTooLargeError
    ) {
      throw error;
    }
    throw classifyNetworkError(error);
  }
  return acc;
}

async function callWithPolicy<T>(
  policy: IPolicy,
  outerSignal: AbortSignal,
  body: ChatStreamRequest,
  config: CliproxyTextProviderConfig,
  baseUrl: string,
  drain: (body: ReadableStream<Uint8Array>, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return policy.execute(async ({ signal }) => {
    if (signal.aborted) throw signal.reason ?? new DOMException('aborted', 'AbortError');
    const stream = await openChatStreamOrThrow(config, baseUrl, body, signal);
    return drain(stream, signal);
  }, outerSignal);
}

export function createCliproxyTextProvider(config: CliproxyTextProviderConfig & CliproxyTextPolicies): CliproxyTextProvider {
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  const inferMaxResponseBytes = config.inferMaxResponseBytes ?? config.maxResponseBytes;
  const {
    enhancePolicy,
    draftListPolicy,
    inferPolicy,
    taxonomyPolicy,
    inferRetryGapsPolicy,
    aiFillPolicy,
    aiFillBatchPolicy,
  } = config;
  const logger = config.logger ?? NOOP_PROVIDER_LOGGER;

  const inferWithPolicy = async (
    policy: IPolicy,
    snapshotJson: string,
    signal: AbortSignal,
    systemPrompt: string = INFER_DIMENSIONS_SYSTEM_PROMPT,
  ): Promise<InferResult> => {
    try {
      const text = await callWithPolicy(
        policy,
        signal,
        { defaults: INFER_DIMENSIONS_DEFAULTS, systemPrompt, userContent: snapshotJson, responseFormat: 'json_object' },
        config,
        baseUrl,
        (body, sig) => accumulateChatStreamOrThrow(body, inferMaxResponseBytes, sig),
      );
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
    async *enhance(prompt: string, images: readonly EnhanceImageInput[], signal: AbortSignal, systemPrompt?: string, opts?: EnhanceCallOptions): AsyncIterable<EnhanceChunk> {
      const userContent: string | readonly ChatUserContentPart[] =
        images.length === 0
          ? prompt
          : [
              { type: 'text', text: prompt },
              ...images.map((img): ChatUserContentPart => ({
                type: 'image_url',
                image_url: { url: `data:${img.mime};base64,${Buffer.from(img.bytes).toString('base64')}` },
              })),
            ];
      let body: ReadableStream<Uint8Array>;
      try {
        body = await enhancePolicy.execute(
          async ({ signal: policySignal }) => {
            return await openChatStreamOrThrowForEnhance(
              config,
              baseUrl,
              {
                defaults: opts?.defaults ?? CLIPROXY_TEXT_DEFAULTS,
                systemPrompt: systemPrompt ?? ENHANCE_SYSTEM_PROMPT,
                userContent,
                ...(opts?.responseFormat ? { responseFormat: opts.responseFormat } : {}),
                ...(opts?.reasoningEffort === undefined ? {} : { reasoningEffort: opts.reasoningEffort }),
              },
              AbortSignal.any([policySignal, signal]),
              config.enhanceOpenTimeoutMs ?? 15_000,
            );
          },
          signal,
        );
      } catch (error) {
        yield enhanceFailureChunk(error);
        return;
      }

      // Content alone is not completion: require a successful terminal marker.
      // Drain failures never replay the deltas already exposed to the client.
      let sawContent = false;
      let sawReasoning = false;
      let completed = false;
      try {
        for await (const frame of readSseFrames(
          body,
          pinnedEffortMaxResponseBytes(config.maxResponseBytes, opts?.reasoningEffort),
          (limit, total) => { throw new CliproxyTextTooLargeError(limit, total); },
          signal,
        )) {
          if (signal.aborted) return;
          const decoded = decodeChatFrame(frame);
          if (decoded.kind === 'done') { completed = true; break; }
          if (decoded.kind === 'skip') continue;
              // Surface an in-stream failure with detail rather than letting it
          // degrade to a silent "ended without content".
          if (decoded.kind === 'error') {
            yield { type: 'failed', status: null, detail: safeTextDetail(detailOf(decoded.payload)) };
            return;
          }
          const reasoning = decoded.reasoning;
          // Reasoning never satisfies `sawContent`: a stream that spends its
          // whole budget on CoT and answers nothing is still a failure.
          if (!sawReasoning && typeof reasoning === 'string' && reasoning.length > 0) {
            sawReasoning = true;
            yield { type: 'reasoning' };
          }
          const content = decoded.content;
          if (typeof content === 'string' && content.length > 0) {
            sawContent = true;
            yield { type: 'delta', text: content };
          }
          const finishError = chatFinishFailure(decoded.finishReason);
          if (finishError) throw finishError;
          if (decoded.finishReason === 'stop') { completed = true; break; }
        }
        if (!completed) {
          if (!sawContent) {
            yield { type: 'failed', status: null, detail: 'stream ended without content' };
            return;
          }
          throw incompleteChatStream();
        }
      } catch (error) {
        if (signal.aborted) throw error;
        yield enhanceFailureChunk(error);
        return;
      }

      if (sawContent) {
        yield { type: 'done' };
        return;
      }
      yield { type: 'failed', status: null, detail: 'stream ended without content' };
    },

    async *brainstormCharacters(
      input: BrainstormCharactersInput,
      signal: AbortSignal,
    ): AsyncIterable<BrainstormChunk> {
      const systemPrompt = buildBrainstormSystemPrompt({
        count: input.count,
        modelId: input.modelId,
        ...(input.layout === undefined ? {} : { layout: input.layout }),
        ...(input.medium === undefined ? {} : { medium: input.medium }),
        ...(input.variationSeed === undefined ? {} : { variationSeed: input.variationSeed }),
      });
      const userContent = buildBrainstormBrief(input.brief);
      const brainstormTuning = brainstormDefaults(input.count, input.reasoningEffort);
      let body: ReadableStream<Uint8Array>;
      try {
        body = await enhancePolicy.execute(
          async ({ signal: policySignal }) => {
            return await openChatStreamOrThrowForEnhance(
              config,
              baseUrl,
              {
                defaults: brainstormTuning,
                systemPrompt,
                userContent,
                ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
              },
              AbortSignal.any([policySignal, signal]),
              config.brainstormOpenTimeoutMs ?? config.enhanceOpenTimeoutMs ?? 15_000,
            );
          },
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

      let buffer = '';
      let emitted = 0;
      let completed = false;
      const deferredShortRecords: { fieldCount: number; text: string }[] = [];
      // A record that is non-empty but holds only separators/whitespace has no
      // usable field content; assembling it would emit a constraints-only prompt
      // and count it toward done. Drop such records instead of promoting them.
      const hasUsableContent = (record: string): boolean =>
        record.split(BRAINSTORM_FIELD_SEPARATOR).some((field) => field.trim().length > 0);
      const brainstormTarget = classifyImageModelTarget(input.modelId);
      const toPromptChunk = (record: string, index: number): BrainstormChunk | null => {
        const result = assembleBrainstormCharacterPrompt(record, brainstormTarget, input.layout, input.medium);
        const refusal = isLikelyModelRefusal(record);
        if (refusal) {
          logger.warn({ event: 'brainstorm_output_rejected', cause: 'refusal', index }, 'brainstorm record rejected');
          return {
            type: 'failed',
            kind: 'content-filter',
            status: null,
            detail: 'brainstorm output did not satisfy the prompt contract',
          };
        }
        if (result.usedFallback) {
          // Keep short records out of the stream while a conforming record may
          // still arrive. If the cleanly-finished response contains no valid
          // record at all, the complete prose is still a usable image prompt:
          // assembleBrainstormCharacterPrompt has preserved it and appended the
          // code-owned target constraints. Deferring avoids promoting a short
          // preamble ahead of a later well-formed concept.
          deferredShortRecords.push({ fieldCount: result.fieldCount, text: result.text });
          return null;
        }
        if (result.fieldCount > 3) {
          logger.info(
            { event: 'brainstorm_output_merged', cause: 'extra-fields', fields: result.fieldCount, index },
            'brainstorm record fields merged',
          );
        }
        return { type: 'prompt', index, text: result.text };
      };
      const flushComplete = function* (): Generator<BrainstormChunk> {
        for (;;) {
          if (emitted >= input.count) {
            buffer = '';
            return;
          }
          const idx = buffer.indexOf(BRAINSTORM_RECORD_SEPARATOR);
          if (idx === -1) return;
          const record = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + BRAINSTORM_RECORD_SEPARATOR.length);
          if (hasUsableContent(record)) {
            const chunk = toPromptChunk(record, emitted);
            if (chunk === null) continue;
            yield chunk;
            if (chunk.type === 'failed') {
              buffer = '';
              return;
            }
            emitted += 1;
          }
        }
      };

      try {
        for await (const frame of readSseFrames(
          body,
          pinnedEffortMaxResponseBytes(
            config.brainstormMaxResponseBytes ?? config.maxResponseBytes,
            input.reasoningEffort,
          ),
          (limit, total) => { throw new CliproxyTextTooLargeError(limit, total); },
          signal,
        )) {
          if (signal.aborted) return;
          const decoded = decodeChatFrame(frame);
          if (decoded.kind === 'done') { completed = true; break; }
          if (decoded.kind === 'skip') continue;
          if (decoded.kind === 'error') {
            const detail = safeTextDetail(detailOf(decoded.payload));
            // Same taxonomy as the enhance drain: refusal wording wins, then
            // the in-stream classifier decides quota / transient / permanent so
            // the route's failover sees a mid-stream upstream timeout as transient.
            const inStream = classifyInStreamFrame(decoded.payload);
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
          const content = decoded.content;
          if (typeof content === 'string' && content.length > 0) {
            buffer += content;
            for (const c of flushComplete()) {
              yield c;
              if (c.type === 'failed') return;
            }
          }
          // Preserve the existing full-count length exception: complete records
          // have already satisfied the request and no partial tail is needed.
          if (decoded.finishReason === 'length' && emitted >= input.count) { completed = true; break; }
          const finishError = chatFinishFailure(decoded.finishReason);
          if (finishError) throw finishError;
          if (decoded.finishReason === 'stop' || emitted >= input.count) { completed = true; break; }
        }
        if (!completed) throw incompleteChatStream();
      } catch (error) {
        if (signal.aborted) throw error;
        // A mid-stream network fault is transient; a response-cap breach is
        // ours and would recur on the other backend.
        if (error instanceof ChatCompletionFinishError && error.reason === 'content_filter') {
          yield { type: 'failed', kind: 'content-filter', status: null, detail: error.message };
        } else if (error instanceof ChatCompletionFinishError && error.reason === 'length') {
          yield { type: 'failed', status: null, detail: 'length' };
        } else if (error instanceof ChatCompletionFinishError || error instanceof TransientUpstreamError) {
          const failure = enhanceFailureChunk(error);
          if (failure.type === 'failed') yield failure;
        } else {
          yield {
            type: 'failed',
            ...(error instanceof CliproxyTextTooLargeError ? {} : { kind: 'transient' as const }),
            status: null,
            detail: safeTextDetail(detailOf(error)),
          };
        }
        return;
      }

      for (const c of flushComplete()) {
        yield c;
        if (c.type === 'failed') return;
      }
      // Models commonly omit the trailing separator after the FINAL prompt (they
      // stop generating once the last concept is written), so a complete last
      // record sits unterminated in the buffer. On graceful stream end (we only
      // reach here after stop/[DONE]/fulfilled count; incomplete EOF and errors
      // return early above), emit that tail rather than silently dropping it.
      // Without this, count=1 yields zero prompts presented as success.
      const tail = buffer.trim();
      if (emitted < input.count && hasUsableContent(tail)) {
        const chunk = toPromptChunk(tail, emitted);
        if (chunk !== null) {
          yield chunk;
          if (chunk.type === 'failed') return;
          emitted += 1;
        }
        buffer = '';
      }
      // Short records are recoverable only after a graceful terminal stream.
      // Provider errors, aborts, response caps, content filters, and token-cap
      // truncation all return above, so incomplete output can never reach this
      // fallback. Prefer any well-formed record; salvage only when rejecting the
      // short prose would otherwise turn a complete response into a hard failure.
      if (emitted === 0 && deferredShortRecords.length > 0) {
        for (const candidate of deferredShortRecords.slice(0, input.count)) {
          logger.warn(
            { event: 'brainstorm_output_salvaged', cause: 'short-record', fields: candidate.fieldCount, index: emitted },
            'brainstorm short record salvaged',
          );
          yield { type: 'prompt', index: emitted, text: candidate.text };
          emitted += 1;
        }
      } else {
        for (const candidate of deferredShortRecords) {
          logger.warn(
            { event: 'brainstorm_output_rejected', cause: 'field-count-mismatch', fields: candidate.fieldCount },
            'brainstorm record rejected',
          );
        }
      }
      // A terminal stream that produced zero prompts is a failure, not a silent
      // done{count:0} — mirrors the enhance path's "ended without content" rule.
      // An empty / refused-as-empty terminal still lands here; complete short
      // prose has already been salvaged above.
      if (emitted === 0) {
        yield { type: 'failed', status: null, detail: 'stream ended without content' };
        return;
      }
      yield { type: 'done', count: emitted };
    },

    async draftList(input: DraftListProviderInput, signal: AbortSignal): Promise<DraftResult> {
      try {
        const text = await callWithPolicy(
          draftListPolicy,
          signal,
          { defaults: DRAFT_LIST_DEFAULTS, systemPrompt: imageAuthoringSystemPrompt(DRAFT_LIST_SYSTEM_PROMPT, input.modelId), userContent: draftBrief(input), responseFormat: 'json_object' },
          config,
          baseUrl,
          (body, sig) => accumulateChatStreamOrThrow(body, config.maxResponseBytes, sig),
        );
        const payload = parseDraftPayload(text);
        if (!payload) return { type: 'failed', status: null, detail: 'unparseable draft response' };
        return { type: 'ok', payload };
      } catch (err) {
        if (signal.aborted) throw err;
        if (isAbortError(err)) throw err;
        return draftResultFromError(err);
      }
    },

    async draftTemplate(input: DraftTemplateProviderInput, signal: AbortSignal): Promise<DraftTemplateResult> {
      const knownNames = new Set(input.library.lists.map((l) => l.name));
      const request: ChatStreamRequest = {
        defaults: DRAFT_TEMPLATE_DEFAULTS,
        systemPrompt: imageAuthoringSystemPrompt(DRAFT_TEMPLATE_SYSTEM_PROMPT, input.modelId),
        userContent: draftTemplateBrief(input),
      };
      // Route through the shared model-family builder (non-streaming) so each
      // provider receives its model-specific request shape.
      const reqBody = JSON.stringify(
        buildChatBody(
          config.model,
          config.backend,
          request,
          false,
        ),
      );

      let response: Response;
      try {
        await moderateChatRequest(config, request, signal);
        response = await fetch(`${baseUrl}${CLIPROXY_CHAT_PATH}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` },
          body: reqBody,
          signal,
        });
      } catch (err) {
        if (signal.aborted) throw err;
        if (isAbortError(err)) throw err;
        return draftResultFromError(err);
      }

      if (!response.ok) {
        const text = await readBodyBoundedShared(response, config.maxResponseBytes, {
          onOversize: () => { throw new Error('oversize'); },
          signal,
        }).catch(() => '');
        return { type: 'failed', status: response.status, detail: safeTextDetail(text).slice(0, 500) };
      }

      let raw: string;
      try {
        raw = await readBodyBoundedShared(response, config.maxResponseBytes, {
          onOversize: (limit, total) => {
            throw new CliproxyTextTooLargeError(limit, total);
          },
          signal,
        });
      } catch (err) {
        if (err instanceof CliproxyTextTooLargeError) {
          return { type: 'failed', status: response.status, detail: 'response too large' };
        }
        throw err;
      }

      const outer = tryParseJson(raw);
      const choice = (outer as { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[] } | null)
        ?.choices?.[0];
      const finishError = chatFinishFailure(choice?.finish_reason);
      if (finishError) return draftResultFromError(finishError);
      const content = choice?.message?.content;
      if (typeof content !== 'string') {
        return { type: 'failed', status: response.status, detail: 'unparseable draft response' };
      }
      const stripped = sliceJsonObject(content);
      const parsed = tryParseJson(stripped);
      if (!parsed || typeof parsed !== 'object') {
        return { type: 'failed', status: response.status, detail: 'unparseable draft response' };
      }

      const kind = (parsed as { kind?: unknown }).kind;
      if (kind === 'clarify') {
        const q = (parsed as { question?: unknown }).question;
        if (typeof q !== 'string' || !q.trim()) {
          return { type: 'failed', status: response.status, detail: 'unparseable draft response' };
        }
        return { type: 'ok', payload: { kind: 'clarify', question: q.trim() } };
      }
      if (kind !== 'body') {
        return { type: 'failed', status: response.status, detail: 'unparseable draft response' };
      }

      const rawBodyText = (parsed as { body?: unknown }).body;
      if (typeof rawBodyText !== 'string') {
        return { type: 'failed', status: response.status, detail: 'unparseable draft response' };
      }
      let bodyText: string = rawBodyText.replace(/\s+$/, '');

      const truncationWarnings: string[] = [];
      const codepoints = Array.from(bodyText);
      if (codepoints.length > MAX_DRAFT_RAW_BODY_CHARS) {
        bodyText = codepoints.slice(0, MAX_DRAFT_RAW_BODY_CHARS).join('');
        // Strip a partial token if the cap landed inside an unclosed {{.
        const lastClose = bodyText.lastIndexOf('}}');
        const lastOpen = bodyText.lastIndexOf('{{');
        if (lastOpen > lastClose) {
          bodyText = bodyText.slice(0, lastOpen).replace(/\s+$/, '');
        }
        truncationWarnings.push('Body truncated at MAX_DRAFT_RAW_BODY_CHARS');
      }

      const { body: cleaned, warnings: stripWarnings } = stripUnknownTokens(bodyText, knownNames);
      return {
        type: 'ok',
        payload: { kind: 'body', body: cleaned, warnings: [...truncationWarnings, ...stripWarnings] },
      };
    },

    async aiFill(input: AiFillProviderInput, signal: AbortSignal): Promise<AiFillResult> {
      try {
        const batchSize = input.batchSize ?? 1;
        const isBatch = batchSize > 1;
        const defaults = isBatch
          ? {
              ...AI_FILL_DEFAULTS,
              max_completion_tokens: Math.min(
                AI_FILL_DEFAULTS.max_completion_tokens * batchSize,
                AI_FILL_BATCH_MAX_COMPLETION_TOKENS,
              ),
            }
          : AI_FILL_DEFAULTS;
        const text = await callWithPolicy(
          isBatch ? aiFillBatchPolicy : aiFillPolicy,
          signal,
          {
            defaults,
            systemPrompt: input.systemPrompt,
            userContent: input.userContent,
            ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
          },
          config,
          baseUrl,
          (body, sig) => accumulateChatStreamOrThrow(
            body,
            pinnedEffortMaxResponseBytes(inferMaxResponseBytes, input.reasoningEffort),
            sig,
          ),
        );
        return { type: 'ok', text };
      } catch (err) {
        if (signal.aborted) throw err;
        if (isAbortError(err)) throw err;
        const failed = inferResultFromError(err);
        // inferResultFromError only ever returns the failed variant; narrow so the
        // shape (kind/status/detail) is assignable to AiFillResult's failed arm.
        if (failed.type === 'failed') return failed;
        throw err;
      }
    },

    async inferDimensions(snapshotJson: string, signal: AbortSignal, systemPrompt?: string): Promise<InferResult> {
      return inferWithPolicy(inferPolicy, snapshotJson, signal, systemPrompt);
    },

    async inferTaxonomy(snapshotJson: string, signal: AbortSignal, systemPrompt?: string): Promise<InferResult> {
      return inferWithPolicy(taxonomyPolicy, snapshotJson, signal, systemPrompt);
    },

    async inferDimensionsSingleAttempt(snapshotJson: string, signal: AbortSignal, systemPrompt?: string): Promise<InferResult> {
      return inferWithPolicy(inferRetryGapsPolicy, snapshotJson, signal, systemPrompt);
    },

    async rescueDimension(args: RescueDimensionArgs, signal: AbortSignal): Promise<InferResult> {
      // Single-shot per rescue cap (one attempt per template); reuse the
      // single-attempt retry-gaps policy so a structural permanent 4xx still
      // surfaces as `permanent` and a flapping 5xx still surfaces as
      // `transient`. The route consumes the rescue cap regardless.
      const lists = args.previewSnapshot.lists;
      const targetListIdx = lists.findIndex((l) => l.name === args.targetListName);
      const userContent = JSON.stringify({
        dimensions: args.previewSnapshot.dimensions,
        lists,
        targetListName: args.targetListName,
        targetListIdx,
        templateLists: args.templateLists,
        conflictReason: args.conflictReason,
      });
      try {
        const text = await callWithPolicy(
          inferRetryGapsPolicy,
          signal,
          { defaults: INFER_DIMENSIONS_DEFAULTS, systemPrompt: imageAuthoringSystemPrompt(RESCUE_DIMENSION_SYSTEM_PROMPT, args.modelId), userContent, responseFormat: RESCUE_RESPONSE_FORMAT },
          config,
          baseUrl,
          (body, sig) => accumulateChatStreamOrThrow(body, inferMaxResponseBytes, sig),
        );
        const ops = parseInferPayload(text);
        if (!ops) return { type: 'failed', kind: 'permanent', status: null, detail: 'unparseable rescue response' };
        // Filter to addOption ops only — the route validates the op
        // structurally (one op, correct list, non-dup value, …), but the
        // provider boundary should not leak unrelated ops.
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

// Memoize against the frozen Config reference (mirrors registry.ts
// registryForConfig). The provider is stateless config — no need to rebuild it
// per request.
// Cached per (frozen Config, backend): cliproxyTextForConfig and the Simulate
// ai-fill variant share the same base/token/policies and differ only by backend.
const textProviderCache = new WeakMap<Config, Map<AiFillBackend, CliproxyTextProvider>>();
let testProvider: CliproxyTextProvider | null = null;

// Test fakes rarely care about the taxonomy-vs-chunk timeout distinction, so
// they may omit `inferTaxonomy`. Back-fill it from `inferDimensions` here —
// in the TEST setter only — so `inferTaxonomy` stays REQUIRED on the interface
// (the production path through `cliproxyTextForConfig` always wires the real
// long-timeout taxonomy policy; nothing can silently fall back to the 70s
// inferDimensions ceiling).
export type TestCliproxyTextProvider =
  Omit<CliproxyTextProvider, 'inferTaxonomy' | 'brainstormCharacters' | 'aiFill'>
  & Partial<Pick<CliproxyTextProvider, 'inferTaxonomy' | 'brainstormCharacters' | 'aiFill'>>;

export function setCliproxyTextProviderForTests(p: TestCliproxyTextProvider | null): void {
  testProvider = p === null
    ? null
    : {
        ...p,
        aiFill: p.aiFill ?? (() => Promise.resolve({ type: 'failed', kind: 'permanent', status: null, detail: 'not implemented' })),
        inferTaxonomy: p.inferTaxonomy ?? p.inferDimensions,
        brainstormCharacters: p.brainstormCharacters ?? (async function* () {
          await Promise.resolve();
          yield { type: 'failed', status: null, detail: 'not implemented' };
        }),
      };
}

// Shared CLIProxy provider options — base/token/policies are backend-independent;
// only the backend (and its configured model id) varies between the default and
// explicit feature overrides.
function cliproxyTextOptions(config: Config, backend: AiFillBackend): CliproxyTextProviderConfig & CliproxyTextPolicies {
  // GLM's deadlines and byte caps are keyed by its backend, the same key the
  // router selects, so the provider and route keys stay in step.
  const deadlineBackend = backend === 'glm-abliterated' ? backend : null;
  return {
    baseUrl: config.CLIPROXY_BASE_URL,
    token: config.CLIPROXY_TOKEN,
    openrouterApiKey: config.OPENROUTER_API_KEY,
    model: textBackendModels(config)[backend],
    backend,
    maxResponseBytes: textMaxResponseBytes(deadlineBackend, config.CLIPROXY_TEXT_MAX_RESPONSE_BYTES),
    inferMaxResponseBytes: config.CLIPROXY_TEXT_INFER_MAX_RESPONSE_BYTES,
    brainstormMaxResponseBytes: textMaxResponseBytes(deadlineBackend, config.BRAINSTORM_MAX_RESPONSE_BYTES),
    quotaMinRetryAfterMs: config.QUOTA_MIN_RETRY_AFTER_MS,
    enhanceOpenTimeoutMs: config.ENHANCE_OPEN_TIMEOUT_MS,
    brainstormOpenTimeoutMs: config.BRAINSTORM_OPEN_TIMEOUT_MS,
    logger: loggerForConfig(config),
    ...cliproxyTextPolicies(config, deadlineBackend),
  };
}

// Returns a CLIProxy text provider for a routed backend (cached per
// config+backend). The test override wins so route tests stub it unchanged.
export function cliproxyTextForBackend(config: Config, backend: AiFillBackend): CliproxyTextProvider {
  if (testProvider) return testProvider;
  let byBackend = textProviderCache.get(config);
  if (!byBackend) {
    byBackend = new Map();
    textProviderCache.set(config, byBackend);
  }
  const cached = byBackend.get(backend);
  if (cached) return cached;
  const provider = createCliproxyTextProvider(cliproxyTextOptions(config, backend));
  byBackend.set(backend, provider);
  return provider;
}

export function cliproxyTextForConfig(config: Config): CliproxyTextProvider {
  return cliproxyTextForBackend(config, 'kimi');
}

import type { GptModerationNotice, TextLatencyProfile, TextReasoningEffort } from '@atelier/shared';
import {
  parseVarToken,
  type BrainstormLayout,
  type BrainstormMedium,
  type DraftTemplateRequest,
  type DraftTemplateResponse,
  type DraftVariableListResponse,
} from '@atelier/shared';
import { findTokens, VAR_TOKEN_ANCHORED } from '@atelier/shared/template-tokens';
import { BrokenCircuitError, TaskCancelledError, type IPolicy } from 'cockatiel';
import type { Config } from '../../config';
import {
  buildResilientPolicy,
  PermanentUpstreamError,
  Parse4xxError,
  QuotaExhaustedError,
  TransientUpstreamError,
} from '../../lifecycle/resilient-call';
import { redactSecrets } from '../../observability/redact';
import {
  BRAINSTORM_RECORD_SEPARATOR,
  BRAINSTORM_FIELD_SEPARATOR,
  assembleBrainstormCharacterPrompt,
} from '../../prompts/brainstormCharactersSystemPrompt';
import { classifyImageModelTarget } from '../../prompts/gptImagePhrasing';
import type { LibrarySnapshot, RawInferOp } from '../../prompts/inferTypes';
import { sliceJsonObject } from '../../prompts/lenientJson';
import type { LibraryOverview } from '../../prompts/libraryOverview';
import { isLikelyModelRefusal } from '../../prompts/modelOutput';
import { GptModerationError, type GptModerationFailureKind } from '../../routing/gptModeration';
import { errorToRawString as detailOf, tryParseJson } from '../_http';
import type { ProviderLogger } from '../types';
import {
  AI_FILL_MAX_ATTEMPTS,
  aiFillBatchPerAttemptTimeoutMs,
  aiFillPerAttemptTimeoutMs,
  MAX_DRAFT_RAW_BODY_CHARS,
} from './textBudgets';

// The text feature interface (types the routes and fakes share), its
// resilience policies and the provider-independent helpers: error-to-result
// mappers, draft briefs and parsers, and the brainstorm record assembler.
// `textModel.ts` implements the interface over the AI SDK adapters.

/**
 * One resilience policy (own retry and breaker) per text call family, built by
 * `textCallPolicies` — production and tests share that one derivation.
 */
export interface TextCallPolicies {
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
 * The single source of the text resilience policies. A 'slow' latency profile
 * keys the longer ai-fill attempts. Every policy shares the RESILIENT_*
 * backoff and breaker knobs; each gets its own breaker instance.
 */
export function textCallPolicies(
  knobs: CliproxyTextPolicyKnobs,
  latencyProfile: TextLatencyProfile,
): TextCallPolicies {
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
    aiFillPolicy: policy(aiFillPerAttemptTimeoutMs(latencyProfile, knobs.AI_FILL_PER_ATTEMPT_TIMEOUT_MS), AI_FILL_MAX_ATTEMPTS),
    aiFillBatchPolicy: policy(aiFillBatchPerAttemptTimeoutMs(latencyProfile), AI_FILL_MAX_ATTEMPTS),
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
  /** User-pinned effort; replaces the model's default effort. */
  readonly reasoningEffort?: TextReasoningEffort;
}

export interface EnhanceImageInput {
  bytes: Uint8Array;
  mime: string;
}

export interface DraftListProviderInput {
  readonly modelId?: string;
  name: string;
  existing: readonly string[];
  description?: string;
  target: number;
  /** User-pinned effort; replaces the model's default effort. */
  readonly reasoningEffort?: TextReasoningEffort;
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
  /** User-pinned effort; replaces the model's default effort. */
  readonly reasoningEffort?: TextReasoningEffort;
}

export type AiFillResult =
  | { type: 'ok'; text: string }
  | { type: 'failed'; kind: 'transient' | 'permanent' | 'quota' | GptModerationFailureKind; status: number | null; detail: string; retryAfterSeconds?: number; moderation?: GptModerationNotice };

export type DraftTemplateProviderInput = DraftTemplateRequest & {
  readonly library: LibraryOverview;
  /** User-pinned effort; replaces the model's default effort. */
  readonly reasoningEffort?: TextReasoningEffort;
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
  /** User-pinned effort; replaces the model's default effort. */
  readonly reasoningEffort?: TextReasoningEffort;
}

/** Per-call options of the infer family. */
export interface InferCallOptions {
  /** User-pinned effort; replaces the model's default effort. */
  readonly reasoningEffort?: TextReasoningEffort;
}

export interface TextFeatureProvider {
  enhance(prompt: string, images: readonly EnhanceImageInput[], signal: AbortSignal, systemPrompt?: string, opts?: EnhanceCallOptions): AsyncIterable<EnhanceChunk>;
  brainstormCharacters(input: BrainstormCharactersInput, signal: AbortSignal): AsyncIterable<BrainstormChunk>;
  draftList(input: DraftListProviderInput, signal: AbortSignal): Promise<DraftResult>;
  draftTemplate(input: DraftTemplateProviderInput, signal: AbortSignal): Promise<DraftTemplateResult>;
  aiFill(input: AiFillProviderInput, signal: AbortSignal): Promise<AiFillResult>;
  inferDimensions(snapshotJson: string, signal: AbortSignal, systemPrompt?: string, opts?: InferCallOptions): Promise<InferResult>;
  // Pass-1 (taxonomy) call on its own longer single-attempt policy. Required
  // (not optional) so a provider that forgot to wire the taxonomy timeout
  // cannot compile — preventing a silent regression to the 70s inferDimensions
  // ceiling that this fix exists to remove. Test fakes implement it explicitly.
  inferTaxonomy(snapshotJson: string, signal: AbortSignal, systemPrompt?: string, opts?: InferCallOptions): Promise<InferResult>;
  inferDimensionsSingleAttempt(snapshotJson: string, signal: AbortSignal, systemPrompt?: string, opts?: InferCallOptions): Promise<InferResult>;
  rescueDimension(args: RescueDimensionArgs, signal: AbortSignal): Promise<InferResult>;
  inferBreakerState?(): 'open' | 'half-open' | 'closed';
}

// Explicit long-budget wording, distinct from transient overload. Kept narrow:

/** A test fake; `setTextModelProviderForTests` back-fills the optional methods. */
export type TestTextFeatureProvider =
  Omit<TextFeatureProvider, 'inferTaxonomy' | 'brainstormCharacters' | 'aiFill'>
  & Partial<Pick<TextFeatureProvider, 'inferTaxonomy' | 'brainstormCharacters' | 'aiFill'>>;

const TEXT_DETAIL_LOG_CAP = 2048;

export function safeTextDetail(detail: string): string {
  const redacted = redactSecrets(detail);
  return redacted.length > TEXT_DETAIL_LOG_CAP
    ? `${redacted.slice(0, TEXT_DETAIL_LOG_CAP)}…[truncated]`
    : redacted;
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

export function inferResultFromError(err: unknown): InferResult {
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

export function draftResultFromError(err: unknown): Extract<DraftResult, { type: 'failed' }> {
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

export function enhanceFailureChunk(err: unknown): EnhanceChunk {
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
  // reasoning as inferResultFromError: the other model, or a later attempt,
  // is unaffected. Brainstorm's cross-model failover keys on this kind.
  if (err instanceof BrokenCircuitError || err instanceof TaskCancelledError) {
    return { type: 'failed', kind: 'transient', status: null, detail: safeTextDetail(detailOf(err)) };
  }
  return { type: 'failed', kind: 'permanent', status: null, detail: safeTextDetail(detailOf(err)) };
}

export function parseDraftPayload(raw: string): DraftVariableListResponse | null {
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

export function draftBrief(input: DraftListProviderInput): string {
  const lines = [
    `List name: ${JSON.stringify(input.name)}`,
    `Existing values (do not repeat these): ${input.existing.length > 0 ? JSON.stringify(input.existing) : 'none'}`,
    `Produce up to ${input.target} new values.`,
  ];
  if (input.description) lines.push(`User description of the list: ${JSON.stringify(input.description)}`);
  return lines.join('\n');
}

export function draftTemplateBrief(input: DraftTemplateProviderInput): string {
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

/**
 * Turns a draft-template answer into the result: parses the JSON (fences and
 * prose tolerated), caps the body at MAX_DRAFT_RAW_BODY_CHARS and strips
 * unknown tokens. `status` is the HTTP status reported on parse failures.
 */
export function draftTemplateResultFromContent(
  content: string,
  knownNames: ReadonlySet<string>,
  status: number | null,
): DraftTemplateResult {
  const stripped = sliceJsonObject(content);
  const parsed = tryParseJson(stripped);
  if (!parsed || typeof parsed !== 'object') {
    return { type: 'failed', status, detail: 'unparseable draft response' };
  }

  const kind = (parsed as { kind?: unknown }).kind;
  if (kind === 'clarify') {
    const q = (parsed as { question?: unknown }).question;
    if (typeof q !== 'string' || !q.trim()) {
      return { type: 'failed', status, detail: 'unparseable draft response' };
    }
    return { type: 'ok', payload: { kind: 'clarify', question: q.trim() } };
  }
  if (kind !== 'body') {
    return { type: 'failed', status, detail: 'unparseable draft response' };
  }

  const rawBodyText = (parsed as { body?: unknown }).body;
  if (typeof rawBodyText !== 'string') {
    return { type: 'failed', status, detail: 'unparseable draft response' };
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
}

export interface ChatDefaults {
  reasoning_effort: string;
  verbosity: string;
  max_completion_tokens: number;
}

// Per-call overrides for enhance()/the caption-format path. Lets the route use
// json_object with model-safe token bounds without disturbing the default path.
/**
 * `'json_object'` asks for syntactically valid JSON. The `json_schema` form is
 * schema-constrained decoding (`strict: true`), which enforces the shape AND
 * enum members: under plain json_object a model answered a `genre` enum with
 * free text, under json_schema it could not.
 */
export type ChatResponseFormat =
  | 'json_object'
  | { readonly type: 'json_schema'; readonly json_schema: Readonly<Record<string, unknown>> };

export interface EnhanceCallOptions {
  responseFormat?: ChatResponseFormat;
  defaults?: ChatDefaults;
  /** User-pinned effort; replaces the model's default effort. */
  reasoningEffort?: TextReasoningEffort;
}

/**
 * Splits a brainstorm answer into records and assembles each into an image
 * prompt. `push` takes streamed content and returns the prompts completed so
 * far; `finish` runs after a graceful terminal only and returns the remaining
 * prompts plus the final done/failed chunk. A returned `failed` chunk is
 * always last: the caller stops there.
 */
export interface BrainstormRecordAssembler {
  push(content: string): BrainstormChunk[];
  /** The requested count has been emitted. */
  fulfilled(): boolean;
  finish(): BrainstormChunk[];
}

export function createBrainstormRecordAssembler(
  input: BrainstormCharactersInput,
  logger: ProviderLogger,
): BrainstormRecordAssembler {
  let buffer = '';
  let emitted = 0;
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
  const flushComplete = (out: BrainstormChunk[]): boolean => {
    for (;;) {
      if (emitted >= input.count) {
        buffer = '';
        return true;
      }
      const idx = buffer.indexOf(BRAINSTORM_RECORD_SEPARATOR);
      if (idx === -1) return true;
      const record = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + BRAINSTORM_RECORD_SEPARATOR.length);
      if (hasUsableContent(record)) {
        const chunk = toPromptChunk(record, emitted);
        if (chunk === null) continue;
        out.push(chunk);
        if (chunk.type === 'failed') {
          buffer = '';
          return false;
        }
        emitted += 1;
      }
    }
  };

  return {
    push(content) {
      buffer += content;
      const out: BrainstormChunk[] = [];
      flushComplete(out);
      return out;
    },
    fulfilled: () => emitted >= input.count,
    finish() {
      const out: BrainstormChunk[] = [];
      if (!flushComplete(out)) return out;
      // Models commonly omit the trailing separator after the FINAL prompt (they
      // stop generating once the last concept is written), so a complete last
      // record sits unterminated in the buffer. On graceful stream end (callers
      // only get here after stop/[DONE]/fulfilled count; incomplete EOF and
      // errors return early), emit that tail rather than silently dropping it.
      // Without this, count=1 yields zero prompts presented as success.
      const tail = buffer.trim();
      if (emitted < input.count && hasUsableContent(tail)) {
        const chunk = toPromptChunk(tail, emitted);
        if (chunk !== null) {
          out.push(chunk);
          if (chunk.type === 'failed') return out;
          emitted += 1;
        }
        buffer = '';
      }
      // Short records are recoverable only after a graceful terminal stream.
      // Provider errors, aborts, response caps, content filters, and token-cap
      // truncation all return early, so incomplete output can never reach this
      // fallback. Prefer any well-formed record; salvage only when rejecting the
      // short prose would otherwise turn a complete response into a hard failure.
      if (emitted === 0 && deferredShortRecords.length > 0) {
        for (const candidate of deferredShortRecords.slice(0, input.count)) {
          logger.warn(
            { event: 'brainstorm_output_salvaged', cause: 'short-record', fields: candidate.fieldCount, index: emitted },
            'brainstorm short record salvaged',
          );
          out.push({ type: 'prompt', index: emitted, text: candidate.text });
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
        out.push({ type: 'failed', status: null, detail: 'stream ended without content' });
        return out;
      }
      out.push({ type: 'done', count: emitted });
      return out;
    },
  };
}

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
import { z } from 'zod';
import type { Config } from '../../config';
import {
  buildResilientPolicy,
  PermanentUpstreamError,
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
import { parseModelJsonObject } from '../../prompts/lenientJson';
import type { LibraryOverview } from '../../prompts/libraryOverview';
import { isLikelyModelRefusal } from '../../prompts/modelOutput';
import { GptModerationError, type GptModerationFailureKind } from '../../routing/gptModeration';
import { errorToRawString as detailOf } from '../_http';
import type { ProviderLogger } from '../types';
import {
  AI_FILL_MAX_ATTEMPTS,
  aiFillBatchPerAttemptTimeoutMs,
  aiFillPerAttemptTimeoutMs,
  MAX_DRAFT_RAW_BODY_CHARS,
  textPerAttemptTimeoutMs,
} from './textBudgets';

// The text feature interface (types the routes and fakes share), its
// resilience policies and the provider-independent helpers: error-to-result
// mapper, draft briefs and parsers, and the brainstorm record assembler.
// `textModel.ts` implements the interface over the AI SDK adapters.

/**
 * One resilience policy (own retry and breaker) per text call family, built by
 * `textCallPolicies` — production and tests share that one derivation.
 */
export interface TextCallPolicies {
  enhancePolicy: IPolicy;
  rewritePolicy: IPolicy;
  draftListPolicy: IPolicy;
  inferPolicy: IPolicy;
  taxonomyPolicy: IPolicy;
  inferRetryGapsPolicy: IPolicy;
  rescuePolicy: IPolicy;
  aiFillPolicy: IPolicy;
  aiFillBatchPolicy: IPolicy;
}

export type TextPolicyKnobs = Pick<
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
 * keys the longer ai-fill and draft attempts. Every policy shares the RESILIENT_*
 * backoff and breaker knobs; each gets its own breaker instance.
 */
export function textCallPolicies(
  knobs: TextPolicyKnobs,
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
    // A rewrite drains inside its policy. The caller's signal bounds the
    // total and the stall watchdog bounds silence, so there is no per-attempt
    // timeout; a transient mid-stream fault gets one retry.
    rewritePolicy: policy(0, 2, true),
    // List and template drafts; a slow row's attempts get the slow floor, and
    // the draft routes size their deadlines from the same numbers.
    draftListPolicy: policy(
      textPerAttemptTimeoutMs(latencyProfile, knobs.RESILIENT_PER_ATTEMPT_TIMEOUT_MS),
      knobs.RESILIENT_MAX_ATTEMPTS,
    ),
    inferPolicy: policy(knobs.RESILIENT_PER_ATTEMPT_TIMEOUT_MS, knobs.RESILIENT_MAX_ATTEMPTS),
    // One attempt per provider call. The route may recover one transient result
    // under a single shared INFER_TAXONOMY_TIMEOUT_MS signal, so totalEnvelope
    // still budgets one taxonomy wall-time envelope, not two full timeouts.
    taxonomyPolicy: policy(knobs.INFER_TAXONOMY_TIMEOUT_MS, 1),
    inferRetryGapsPolicy: policy(knobs.RESILIENT_PER_ATTEMPT_TIMEOUT_MS, 1),
    // One attempt, like retry-gaps, but with the slow floor: the rescue route
    // sizes its deadline from the same number (`rescueRouteTimeoutMs`), and
    // infer's wave timing must not change with it.
    rescuePolicy: policy(textPerAttemptTimeoutMs(latencyProfile, knobs.RESILIENT_PER_ATTEMPT_TIMEOUT_MS), 1),
    // ai-fill: one retry on transient errors, retaining the historical
    // per-attempt ceiling as latency headroom.
    aiFillPolicy: policy(aiFillPerAttemptTimeoutMs(latencyProfile, knobs.AI_FILL_PER_ATTEMPT_TIMEOUT_MS), AI_FILL_MAX_ATTEMPTS),
    aiFillBatchPolicy: policy(aiFillBatchPerAttemptTimeoutMs(latencyProfile), AI_FILL_MAX_ATTEMPTS),
  };
}

/**
 * The failed result every text call returns or yields, from
 * `textFailureFromError` or a parse/content check at the call site.
 */
export interface TextCallFailure {
  type: 'failed';
  kind: 'transient' | 'permanent' | 'quota' | GptModerationFailureKind;
  status: number | null;
  detail: string;
  retryAfterSeconds?: number;
  moderation?: GptModerationNotice;
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

/**
 * A draft failure. The provider always sets `kind`; it stays optional because
 * test fakes model a failure without one, which the routes' terminal mapping
 * reports as a provider error.
 */
export type DraftFailure = Omit<TextCallFailure, 'kind'> & { kind?: TextCallFailure['kind'] };

export type DraftResult =
  | { type: 'ok'; payload: DraftVariableListResponse }
  | DraftFailure;

export type InferResult =
  | { type: 'ok'; ops: RawInferOp[] }
  | TextCallFailure;

export interface AiFillProviderInput {
  readonly systemPrompt: string;
  readonly userContent: string;
  readonly batchSize?: number;
  /** User-pinned effort; replaces the model's default effort. */
  readonly reasoningEffort?: TextReasoningEffort;
}

export type AiFillResult =
  | { type: 'ok'; text: string }
  | TextCallFailure;

export type DraftTemplateProviderInput = DraftTemplateRequest & {
  readonly library: LibraryOverview;
  /** User-pinned effort; replaces the model's default effort. */
  readonly reasoningEffort?: TextReasoningEffort;
};

export type DraftTemplateResult =
  | { type: 'ok'; payload: DraftTemplateResponse }
  | DraftFailure;

/** One whole-answer rewrite: the inputs of `enhance`, accumulated instead of streamed. */
export interface RewriteRequest extends EnhanceCallOptions {
  readonly prompt: string;
  readonly images?: readonly EnhanceImageInput[];
  /** Defaults to the enhance system prompt. */
  readonly systemPrompt?: string;
}

export type RewriteResult =
  | { type: 'ok'; text: string }
  | TextCallFailure;

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
  /**
   * The enhance request for a caller that forwards nothing until the text is
   * complete: drained inside a policy, so a transient mid-stream fault is
   * retried. Aborts reject with the signal's reason.
   */
  rewrite(request: RewriteRequest, signal: AbortSignal): Promise<RewriteResult>;
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

/** A test fake; `setTextModelProviderForTests` back-fills the optional methods. */
export type TestTextFeatureProvider =
  Omit<TextFeatureProvider, 'inferTaxonomy' | 'brainstormCharacters' | 'aiFill' | 'rewrite'>
  & Partial<Pick<TextFeatureProvider, 'inferTaxonomy' | 'brainstormCharacters' | 'aiFill' | 'rewrite'>>;

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

// The one error-to-result mapping of every text call. Aborts and
// DOMException-AbortError never reach it: callers rethrow them, because they
// are orchestrator signals, not failures.
function moderationFailure(err: GptModerationError): TextCallFailure {
  return { type: 'failed', kind: err.kind, status: err.status, detail: err.message, moderation: err.moderation };
}

export function textFailureFromError(err: unknown): TextCallFailure {
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
  // An open breaker is transient: the other model, or a later call, is
  // unaffected. Brainstorm's cross-model failover keys on this kind.
  if (err instanceof BrokenCircuitError) {
    return { type: 'failed', kind: 'transient', status: null, detail: safeTextDetail(detailOf(err)) };
  }
  if (err instanceof PermanentUpstreamError) {
    return { type: 'failed', kind: 'permanent', status: statusFromCause(err.cause), detail: detailFromTypedUpstreamError(err) };
  }
  // A per-attempt timeout (cockatiel raises TaskCancelledError, "Operation
  // timed out after Nms") is inherently transient — the upstream was slow under
  // concurrent load, and a retry (esp. the post-wave-1 retry-gaps pass, which
  // runs with the contention cleared) usually succeeds. Without this it falls
  // through to `permanent` below and a single slow chunk aborts the whole run.
  if (err instanceof TaskCancelledError) {
    return { type: 'failed', kind: 'transient', status: null, detail: safeTextDetail(detailOf(err)) };
  }
  // Everything else, including a response over its byte cap, would recur.
  return { type: 'failed', kind: 'permanent', status: null, detail: safeTextDetail(detailOf(err)) };
}

/**
 * A model answer that does not parse into the expected shape. Transient: the
 * output varies on another attempt, so the user's or the route's retry can
 * succeed.
 */
export function unparseableFailure(detail: string): TextCallFailure {
  return { type: 'failed', kind: 'transient', status: null, detail };
}

export function parseDraftPayload(raw: string): DraftVariableListResponse | null {
  const parsed = parseModelJsonObject(raw);
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

// The two answers of a template draft as one object: OpenAI strict schemas
// and Anthropic's forced json tool both need an object at the root, so the
// union lives in `kind` and the field the other answer does not use is null.
const DraftTemplateAnswerSchema = z.object({
  kind: z.enum(['body', 'clarify']),
  body: z.string().nullable(),
  question: z.string().nullable(),
  warnings: z.array(z.string()),
}).strict();
const { $schema: _draftTemplateDialect, ...draftTemplateSchema } = z.toJSONSchema(DraftTemplateAnswerSchema, { target: 'draft-7', io: 'output' });
export const DRAFT_TEMPLATE_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: { name: 'template_draft', strict: true, schema: draftTemplateSchema },
} as const;

const UNPARSEABLE_DRAFT = 'unparseable draft response';

/**
 * Turns a draft-template answer into the result: parses the JSON (fences,
 * prose and the repairable defects tolerated), caps the body at
 * MAX_DRAFT_RAW_BODY_CHARS and strips unknown tokens.
 */
export function draftTemplateResultFromContent(
  content: string,
  knownNames: ReadonlySet<string>,
): DraftTemplateResult {
  const parsed = parseModelJsonObject(content);
  if (!parsed || typeof parsed !== 'object') return unparseableFailure(UNPARSEABLE_DRAFT);

  const kind = (parsed as { kind?: unknown }).kind;
  if (kind === 'clarify') {
    const q = (parsed as { question?: unknown }).question;
    if (typeof q !== 'string' || !q.trim()) return unparseableFailure(UNPARSEABLE_DRAFT);
    return { type: 'ok', payload: { kind: 'clarify', question: q.trim() } };
  }
  if (kind !== 'body') return unparseableFailure(UNPARSEABLE_DRAFT);

  const rawBodyText = (parsed as { body?: unknown }).body;
  if (typeof rawBodyText !== 'string') return unparseableFailure(UNPARSEABLE_DRAFT);
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
  /** Output budget; defaults to ENHANCE_MAX_OUTPUT_TOKENS. */
  maxOutputTokens?: number;
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

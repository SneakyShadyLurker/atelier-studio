import type { TextLatencyProfile, TextReasoningEffort } from '@atelier/shared';
import type { Config } from '../../config';

// Token budgets, deadlines and byte caps of the text feature calls, keyed by a
// model row's latency profile where slow models need longer ones.

export const KIMI_LOW_REASONING_OVERHEAD_TOKENS = 4000;
// GLM 5.3's catalog `max_output_tokens` is 131,072, but reasoning spends from
// the completion budget and the stream drain below is sized to emit the whole
// budget at the measured throughput, so its migrated row asks for 32,768 on
// every call: a count-12 brainstorm used 21,067 tokens on the earlier GLM
// Flash route.
export const GLM_ABLITERATED_MAX_COMPLETION_TOKENS = 32_768;

// GLM's longer deadlines were sized on a GLM 5.3 Flash route at 'high'
// effort. Real Atelier prompts through the proxy,
// uncapped: a 7-slot ai-fill took 197s (2,531 completion tokens), a 4-item
// batch 137s, a 528-word Krea condense 248s, a six-beat story plan 240s and a
// count-12 brainstorm 1,259s (21,067 tokens), at 13–17 tokens/s and up to ~55
// SSE bytes per completion token. Stock GLM 5.3 measured 50–70 tokens/s
// (2026-10-30; the earlier uncensored build ~20), so they stay generous ceilings. The stream drain covers emitting
// the whole 32,768-token budget at the slowest rate. Every other backend keeps
// its configured deadline.
export const GLM_ABLITERATED_AI_FILL_PER_ATTEMPT_TIMEOUT_MS = 360_000;
export const GLM_ABLITERATED_KREA_CONDENSE_TIMEOUT_MS = 420_000;
export const GLM_ABLITERATED_STREAM_DRAIN_MS = 2_700_000;
export const GLM_ABLITERATED_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * Per-attempt timeout of a policy-wrapped text call: the configured knob on a
 * standard row, at least the slow floor on a slow one. The provider's policy
 * and the route deadline both read it.
 */
export function textPerAttemptTimeoutMs(profile: TextLatencyProfile, configuredMs: number): number {
  return profile === 'slow'
    ? Math.max(configuredMs, GLM_ABLITERATED_AI_FILL_PER_ATTEMPT_TIMEOUT_MS)
    : configuredMs;
}

/** Per-attempt ai-fill timeout; the provider's policy and the route envelope both read it. */
export function aiFillPerAttemptTimeoutMs(profile: TextLatencyProfile, configuredMs: number): number {
  return textPerAttemptTimeoutMs(profile, configuredMs);
}

// Lifecycle margin a route deadline keeps beyond its policy envelope, for SSE
// teardown and scheduling jitter.
export const TEXT_ROUTE_TIMEOUT_MARGIN_MS = 30_000;

// Rescue's route deadline on a standard row. Rescue is one single-attempt call.
export const RESCUE_ROUTE_TIMEOUT_MS = 90_000;

export interface TextPolicyShape {
  /** The configured per-attempt knob, before the slow floor. */
  readonly perAttemptTimeoutMs: number;
  readonly maxAttempts: number;
  readonly maxBackoffMs: number;
}

/**
 * Route deadline of one policy-wrapped call (list draft, template draft,
 * rescue). A standard row keeps `standardMs`. A slow row's attempts run on
 * the slow floor, so its deadline covers every attempt plus the backoff
 * between them, and never drops below `standardMs`.
 */
export function textPolicyRouteTimeoutMs(
  profile: TextLatencyProfile,
  standardMs: number,
  policy: TextPolicyShape,
): number {
  if (profile !== 'slow') return standardMs;
  const envelope = textPerAttemptTimeoutMs(profile, policy.perAttemptTimeoutMs) * policy.maxAttempts
    + policy.maxBackoffMs * Math.max(0, policy.maxAttempts - 1);
  return Math.max(standardMs, envelope + TEXT_ROUTE_TIMEOUT_MARGIN_MS);
}

/** Drain budget of one enhance, storytelling-planner or brainstorm stream. */
export function textStreamDrainMs(profile: TextLatencyProfile, cloudTimeoutMs: number): number {
  return profile === 'slow' ? Math.max(cloudTimeoutMs, GLM_ABLITERATED_STREAM_DRAIN_MS) : cloudTimeoutMs;
}

// A slow row may think for minutes before its first byte when the upstream
// streams no reasoning and sends no keepalives.
export const SLOW_STREAM_IDLE_FLOOR_MS = 600_000;

/** Longest upstream silence a streamed text call tolerates before failing as a stall. */
export function textStreamIdleMs(profile: TextLatencyProfile, baseMs: number): number {
  return profile === 'slow' ? Math.max(baseMs, SLOW_STREAM_IDLE_FLOOR_MS) : baseMs;
}

/** Deadline of a queued prompt rewrite (Krea condense, H3 Image expand); both fail open, so a short one silently skips them. */
export function promptRewriteTimeoutMs(profile: TextLatencyProfile, configuredMs: number): number {
  return profile === 'slow'
    ? Math.max(configuredMs, GLM_ABLITERATED_KREA_CONDENSE_TIMEOUT_MS)
    : configuredMs;
}

// A pinned effort above 'low' may reason through a 32,768-token output budget.
// Kimi streamed ~480 raw SSE bytes per frame at 'max' through the proxy
// (292 KB over 613 frames for one enhance), so covering the whole
// ceiling takes ~16 MiB.
export const PINNED_EFFORT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/** An effort that reasons past the low-effort overhead the fixed budgets assume. */
function effortAboveLow(effort: TextReasoningEffort | null | undefined): boolean {
  return !(effort === undefined || effort === null || effort === 'none' || effort === 'minimal' || effort === 'low');
}

/** Raw-stream cap for a call carrying a user-pinned effort; default and low-or-less efforts keep `configuredBytes`. */
export function pinnedEffortMaxResponseBytes(
  configuredBytes: number,
  effort: TextReasoningEffort | undefined,
): number {
  return effortAboveLow(effort) ? Math.max(configuredBytes, PINNED_EFFORT_MAX_RESPONSE_BYTES) : configuredBytes;
}

/** Raw SSE byte cap; slow models' long streams would exhaust the shared 1 MiB cap first. */
export function textMaxResponseBytes(profile: TextLatencyProfile, configuredBytes: number): number {
  return profile === 'slow' ? Math.max(configuredBytes, GLM_ABLITERATED_MAX_RESPONSE_BYTES) : configuredBytes;
}

// Output-token budgets of the text calls (`maxOutputTokens`; a row's
// `fixedOutputTokens` replaces them). Reasoning spends from the same budget on
// every backend measured, so each ceiling sits well clear of a plausible
// reasoning-plus-answer burn: a tight bound starves the answer rather than
// capping it. The effort sent comes from the model row, not from here.

// Generic prompt enhancement (and the rewrite callers that share its request).
export const ENHANCE_MAX_OUTPUT_TOKENS = 36_000;

// MiniMax H3 motion-prompt enhancement: plain-text prose (no json_object) with
// room for reasoning plus the roughly 60–120-word answer.
export const MOTION_ENHANCE_MAX_OUTPUT_TOKENS = 36_000;

// AI Storytelling planning, with room for the full JSON beat sheet.
export const STORY_PLANNER_MAX_OUTPUT_TOKENS = 36_000;

// Draft-list generation: the 1200-token JSON answer allowance plus the shared
// low-reasoning overhead.
export const DRAFT_LIST_MAX_OUTPUT_TOKENS = 1200 + KIMI_LOW_REASONING_OVERHEAD_TOKENS;

// Dimension inference and rescue: the 32000-token answer allowance handles
// large libraries, plus the shared low-reasoning overhead.
export const INFER_DIMENSIONS_MAX_OUTPUT_TOKENS = 32000 + KIMI_LOW_REASONING_OVERHEAD_TOKENS;

// Draft-template generation: the 1500-token answer allowance plus the shared
// low-reasoning overhead.
export const DRAFT_TEMPLATE_MAX_OUTPUT_TOKENS = 1500 + KIMI_LOW_REASONING_OVERHEAD_TOKENS;

/** Tokens a rework's answer spends carrying the revised body back: about one per three characters. */
function reworkBodyTokens(existingBody: string): number {
  return Math.ceil(Array.from(existingBody).length / 3);
}

/**
 * Output budget of one template draft. A rework answers with the whole revised
 * body, so the existing body adds its tokens; an effort above low (the effort
 * actually sent) reasons through at least the enhance budget.
 */
export function draftTemplateMaxOutputTokens(
  existingBody: string,
  effort: TextReasoningEffort | null | undefined,
): number {
  const answer = DRAFT_TEMPLATE_MAX_OUTPUT_TOKENS + reworkBodyTokens(existingBody);
  return effortAboveLow(effort) ? Math.max(answer, ENHANCE_MAX_OUTPUT_TOKENS) : answer;
}

// Raw SSE bytes one streamed completion token may cost, at the rate the
// pinned-effort cap assumes (16 MiB for a 32,768-token budget).
const STREAM_BYTES_PER_TOKEN_CEILING = PINNED_EFFORT_MAX_RESPONSE_BYTES / 32_768;

/** Raw-stream cap of one template draft: `capBytes` plus room for the body a rework streams back. */
export function draftTemplateMaxResponseBytes(capBytes: number, existingBody: string): number {
  return capBytes + reworkBodyTokens(existingBody) * STREAM_BYTES_PER_TOKEN_CEILING;
}

// ai-fill writes at most AI_FILL_MAX_SLOTS short blanks, so it must not inherit
// the 32k infer ceiling.
export const AI_FILL_MAX_OUTPUT_TOKENS = 36_000;

// All ai-fill policies permit one transient retry. The route deadline is
// derived from that complete policy envelope rather than the unrelated image
// CLOUD_TIMEOUT_MS, with a final margin for SSE teardown and scheduling jitter.
export const AI_FILL_MAX_ATTEMPTS = 2;
export const AI_FILL_ROUTE_TIMEOUT_MARGIN_MS = 30_000;

export function aiFillPolicyEnvelopeMs(
  perAttemptTimeoutMs: number,
  maxBackoffMs: number,
): number {
  return perAttemptTimeoutMs * AI_FILL_MAX_ATTEMPTS
    + maxBackoffMs * (AI_FILL_MAX_ATTEMPTS - 1);
}

/**
 * Each entry represents one possible policy-wrapped provider.aiFill call on
 * the one resolved model. The route can make a second call for format
 * recovery, so the complete envelopes of both calls are summed.
 */
export function aiFillRouteTimeoutMs(
  perAttemptTimeoutsMs: readonly number[],
  maxBackoffMs: number,
): number {
  return perAttemptTimeoutsMs.reduce(
    (total, perAttemptTimeoutMs) => (
      total + aiFillPolicyEnvelopeMs(perAttemptTimeoutMs, maxBackoffMs)
    ),
    AI_FILL_ROUTE_TIMEOUT_MARGIN_MS,
  );
}

type DraftDeadlineKnobs = Pick<
  Config,
  'CLOUD_TIMEOUT_MS' | 'RESILIENT_PER_ATTEMPT_TIMEOUT_MS' | 'RESILIENT_MAX_ATTEMPTS' | 'RESILIENT_MAX_BACKOFF_MS'
>;

/** Route deadline of a list or template draft, which runs under the draft policy. */
export function draftRouteTimeoutMs(profile: TextLatencyProfile, knobs: DraftDeadlineKnobs): number {
  return textPolicyRouteTimeoutMs(profile, knobs.CLOUD_TIMEOUT_MS, {
    perAttemptTimeoutMs: knobs.RESILIENT_PER_ATTEMPT_TIMEOUT_MS,
    maxAttempts: knobs.RESILIENT_MAX_ATTEMPTS,
    maxBackoffMs: knobs.RESILIENT_MAX_BACKOFF_MS,
  });
}

/** Route deadline of a rescue, one single-attempt call (`rescueDimension`). */
export function rescueRouteTimeoutMs(
  profile: TextLatencyProfile,
  knobs: Pick<Config, 'RESILIENT_PER_ATTEMPT_TIMEOUT_MS' | 'RESILIENT_MAX_BACKOFF_MS'>,
): number {
  return textPolicyRouteTimeoutMs(profile, RESCUE_ROUTE_TIMEOUT_MS, {
    perAttemptTimeoutMs: knobs.RESILIENT_PER_ATTEMPT_TIMEOUT_MS,
    maxAttempts: 1,
    maxBackoffMs: knobs.RESILIENT_MAX_BACKOFF_MS,
  });
}

// Historical thinking-on batch-4 trials reached 117.6s; adding 25% gives
// 147s, rounded to 150s (32.4s / 27.6% above the observed worst). The route then
// budgets every permitted policy call and adds a separate 30s lifecycle margin.
export const AI_FILL_BATCH_PER_ATTEMPT_TIMEOUT_MS = 150_000;
export const AI_FILL_BATCH_MAX_OUTPUT_TOKENS = 144_000;

export function aiFillBatchPerAttemptTimeoutMs(profile: TextLatencyProfile): number {
  return aiFillPerAttemptTimeoutMs(profile, AI_FILL_BATCH_PER_ATTEMPT_TIMEOUT_MS);
}

export function aiFillBatchRouteTimeoutMs(
  profile: TextLatencyProfile,
  maxBackoffMs: number,
): number {
  // The batch permits the initial call plus one format recovery call, and
  // each of those calls owns a complete retry policy.
  const perAttemptMs = aiFillBatchPerAttemptTimeoutMs(profile);
  return aiFillRouteTimeoutMs([perAttemptMs, perAttemptMs], maxBackoffMs);
}

// 600/prompt (was 400): measured, K3 writes ~350-500 content tokens
// per character, so the old 2000-token floor at count=4 capped pure content in
// 1 of 3 runs. Reasoning ALSO spends from the output budget, so low effort
// adds a flat CoT overhead below.
const BRAINSTORM_TOKENS_PER_PROMPT = 600;
const BRAINSTORM_TOKENS_FLOOR = 2000;
const BRAINSTORM_TOKENS_CAP = 24000;

// Reasoning headroom for a user-pinned brainstorm effort above 'low'. The
// low overhead is the measured default; these scale it so a higher pinned
// effort is not starved into finish_reason 'length' (the historical 'high'
// failure above).
const BRAINSTORM_REASONING_OVERHEAD_TOKENS = {
  none: KIMI_LOW_REASONING_OVERHEAD_TOKENS,
  minimal: KIMI_LOW_REASONING_OVERHEAD_TOKENS,
  low: KIMI_LOW_REASONING_OVERHEAD_TOKENS,
  medium: 8_000,
  high: 16_000,
  xhigh: 24_000,
  max: 32_000,
} as const satisfies Record<TextReasoningEffort, number>;

function brainstormTokenBudget(count: number, effort: TextReasoningEffort): number {
  return Math.min(
    BRAINSTORM_TOKENS_CAP,
    Math.max(BRAINSTORM_TOKENS_FLOOR, count * BRAINSTORM_TOKENS_PER_PROMPT)
      + KIMI_LOW_REASONING_OVERHEAD_TOKENS,
  ) + BRAINSTORM_REASONING_OVERHEAD_TOKENS[effort] - KIMI_LOW_REASONING_OVERHEAD_TOKENS;
}

/** Brainstorm output budget for `count` prompts at the effort actually sent. */
export function brainstormMaxOutputTokens(count: number, effort: TextReasoningEffort = 'low'): number {
  // 'low' (was 'none'): K3 reasoning tokens spend from the output budget.
  // At 'high' a count-4 brainstorm burned 5.3-8.4k
  // chars of CoT into the budget: 2/2 runs hit finish_reason 'length', one
  // with zero content. Low keeps a short think and the budget above adds a
  // CoT overhead, scaled up for a user-pinned effort, so content is not starved.
  return brainstormTokenBudget(count, effort);
}

/**
 * Route deadline for /prompts/characters/brainstorm. The selected backend and
 * its one-shot failover are two sequential policy groups, each permitted
 * `maxAttempts` open attempts with backoff between them; `drainBudgetMs` is the
 * time left for the stream itself once a backend has opened, plus teardown.
 */
export function brainstormRouteTimeoutMs(
  drainBudgetMs: number,
  openTimeoutMs: number,
  maxAttempts: number,
  maxBackoffMs: number,
): number {
  const perBackendMs = openTimeoutMs * maxAttempts + maxBackoffMs * Math.max(0, maxAttempts - 1);
  return drainBudgetMs + 2 * perBackendMs;
}

/**
 * Raw-body cap for AI-generated template bodies. Roughly a third of the
 * resolved-length meter ceiling (MAX_PROMPT_CHARS = 6000 in @atelier/shared) so {{var::name}} token
 * expansion still fits the meter at runtime. DISTINCT from MAX_PROMPT_CHARS;
 * do not collapse the two.
 */
export const MAX_DRAFT_RAW_BODY_CHARS = 2000;

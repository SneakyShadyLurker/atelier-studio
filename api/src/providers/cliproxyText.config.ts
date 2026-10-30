import type { AiFillBackend, TextReasoningEffort } from '@atelier/shared';
import type { Config } from '../config';

export const CLIPROXY_CHAT_PATH = '/v1/chat/completions';
// Text backends reached through an OpenAI-compatible proxy such as CLIProxyAPI.
// Each backend's upstream model id is configuration (`CLIPROXY_TEXT_MODEL_*`,
// see `textBackendModels`); the wire shape follows the backend key. Kimi, MiMo,
// Grok and Gemini answered streaming strict `json_schema` with a base64 PNG
// image part and non-streaming `json_object` with HTTP 200 through the proxy.
// DeepSeek V4.1 Flash Abliterated's vision path is unverified; it is selectable
// regardless.
export const KIMI_LOW_REASONING_OVERHEAD_TOKENS = 4000;
// xAI's recommended sampling for Grok (docs.x.ai best practices).
// Every other backend sends no sampling fields: Kimi, MiMo, Gemini and GPT fix
// or ignore sampling under reasoning, and MiMo produced token salad at
// temperature 1.5.
export const GROK_SAMPLING = { temperature: 0.7, top_p: 0.95 } as const;
// GPT-6.1 Sol: vision, strict schema, medium effort and both stream modes
// verified through CLIProxyAPI.
export const GPT_REASONING_EFFORT = 'medium';

// GLM 5.3 (a text-only model, backend key 'glm-abliterated'). User-selectable only — never an automatic-routing target.
// The upstream publishes low/high/max efforts; the wire branch pins 'low' unless
// the user pins another. Its catalog `max_output_tokens` is 131,072, but
// reasoning spends from the completion budget and the stream drain below is
// sized to emit the whole budget at the measured throughput, so every call
// asks for 32,768: a count-12 brainstorm used 21,067 tokens on the earlier
// GLM Flash route.
export const GLM_ABLITERATED_REASONING_EFFORT = 'low';
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

// `null` = a provider whose model is not a routed backend key (the caller passes
// 'glm-abliterated' when its model is that backend's).
const isSlowGlmBackend = (backend: AiFillBackend | null): boolean => backend === 'glm-abliterated';

/** Per-attempt ai-fill timeout; the provider's policy and the route envelope both read it. */
export function aiFillPerAttemptTimeoutMs(backend: AiFillBackend | null, configuredMs: number): number {
  return isSlowGlmBackend(backend)
    ? Math.max(configuredMs, GLM_ABLITERATED_AI_FILL_PER_ATTEMPT_TIMEOUT_MS)
    : configuredMs;
}

/** Drain budget of one enhance, storytelling-planner or brainstorm stream. */
export function textStreamDrainMs(backend: AiFillBackend, cloudTimeoutMs: number): number {
  return isSlowGlmBackend(backend) ? Math.max(cloudTimeoutMs, GLM_ABLITERATED_STREAM_DRAIN_MS) : cloudTimeoutMs;
}

/** Krea condense deadline; condense fails open, so a short one silently skips it. */
export function kreaCondenseTimeoutMs(backend: AiFillBackend, configuredMs: number): number {
  return isSlowGlmBackend(backend)
    ? Math.max(configuredMs, GLM_ABLITERATED_KREA_CONDENSE_TIMEOUT_MS)
    : configuredMs;
}

// A pinned effort above 'low' may reason through a 32,768-token output budget.
// Kimi streamed ~480 raw SSE bytes per frame at 'max' through the proxy
// (292 KB over 613 frames for one enhance), so covering the whole
// ceiling takes ~16 MiB.
export const PINNED_EFFORT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/** Raw-stream cap for a call carrying a user-pinned effort; default and low-or-less efforts keep `configuredBytes`. */
export function pinnedEffortMaxResponseBytes(
  configuredBytes: number,
  effort: TextReasoningEffort | undefined,
): number {
  return effort === undefined || effort === 'none' || effort === 'minimal' || effort === 'low'
    ? configuredBytes
    : Math.max(configuredBytes, PINNED_EFFORT_MAX_RESPONSE_BYTES);
}

/** Raw SSE byte cap; GLM's long streams would exhaust the shared 1 MiB cap first. */
export function textMaxResponseBytes(backend: AiFillBackend | null, configuredBytes: number): number {
  return isSlowGlmBackend(backend) ? Math.max(configuredBytes, GLM_ABLITERATED_MAX_RESPONSE_BYTES) : configuredBytes;
}

// Generic prompt enhancement runs on Kimi K3 with low reasoning.
// Reasoning spends from the same completion budget, so the
// ceiling is set well clear of any plausible reasoning+answer burn — a tight
// bound starves the answer rather than capping it. `verbosity` is retained for
// ChatDefaults shape parity but is never sent on the Kimi wire.
export const CLIPROXY_TEXT_DEFAULTS = {
  reasoning_effort: 'low',
  verbosity: 'low',
  max_completion_tokens: 36_000,
} as const;

// MiniMax H3 motion-prompt enhancement on the routed Kimi K3
// backend. Plain-text prose (no json_object), low-effort, with enough room for
// model reasoning plus the roughly 60–120-word answer.
export const MOTION_ENHANCE_DEFAULTS = {
  reasoning_effort: 'low',
  verbosity: 'low',
  max_completion_tokens: 36_000,
} as const;

// AI Storytelling planning uses Kimi low reasoning with room for the full JSON beat sheet.
export const STORY_PLANNER_DEFAULTS = {
  reasoning_effort: 'low',
  verbosity: 'low',
  max_completion_tokens: 36_000,
} as const;

// Draft-list generation uses Kimi low reasoning. Its reasoning tokens share the
// completion budget with the JSON answer, so retain the 1200-token
// answer allowance plus the shared low-reasoning overhead. `verbosity` is inert
// on the Kimi wire and retained only for ChatDefaults shape parity.
export const DRAFT_LIST_DEFAULTS = {
  reasoning_effort: 'low',
  verbosity: 'low',
  max_completion_tokens: 1200 + KIMI_LOW_REASONING_OVERHEAD_TOKENS,
} as const;

// Dimension inference uses Kimi low reasoning. The 32000-token answer allowance
// handles large libraries; K3 reasoning spends from the same
// completion ceiling, so add the shared low-reasoning overhead. `verbosity` is
// inert on the Kimi wire and retained only for ChatDefaults shape parity.
export const INFER_DIMENSIONS_DEFAULTS = {
  reasoning_effort: 'low',
  verbosity: 'low',
  max_completion_tokens: 32000 + KIMI_LOW_REASONING_OVERHEAD_TOKENS,
} as const;

// Draft-template generation uses Kimi low reasoning. The prose answer keeps its
// 1500-token allowance plus shared low-reasoning overhead. `verbosity` is
// inert on the Kimi wire and retained only for ChatDefaults shape parity.
export const DRAFT_TEMPLATE_DEFAULTS = {
  reasoning_effort: 'low',
  verbosity: 'low',
  max_completion_tokens: 1500 + KIMI_LOW_REASONING_OVERHEAD_TOKENS,
} as const;

/** The config slice holding each backend's CLIProxy model id. */
export type TextBackendModelConfig = Pick<
  Config,
  | 'CLIPROXY_TEXT_MODEL_KIMI'
  | 'CLIPROXY_TEXT_MODEL_MIMO'
  | 'CLIPROXY_TEXT_MODEL_GROK'
  | 'CLIPROXY_TEXT_MODEL_GEMINI_ARGON'
  | 'CLIPROXY_TEXT_MODEL_DEEPSEEK_ABLITERATED'
  | 'CLIPROXY_TEXT_MODEL_GLM_ABLITERATED'
  | 'CLIPROXY_TEXT_MODEL_GPT'
>;

/**
 * Single owner of the backend → CLIProxy model id mapping (the configured
 * `CLIPROXY_TEXT_MODEL_*` ids). Routing and the `/v1/models` availability
 * check both read it, so they cannot drift.
 */
export function textBackendModels(config: TextBackendModelConfig): Readonly<Record<AiFillBackend, string>> {
  return {
    kimi: config.CLIPROXY_TEXT_MODEL_KIMI,
    mimo: config.CLIPROXY_TEXT_MODEL_MIMO,
    grok: config.CLIPROXY_TEXT_MODEL_GROK,
    'gemini-argon': config.CLIPROXY_TEXT_MODEL_GEMINI_ARGON,
    'deepseek-abliterated': config.CLIPROXY_TEXT_MODEL_DEEPSEEK_ABLITERATED,
    'glm-abliterated': config.CLIPROXY_TEXT_MODEL_GLM_ABLITERATED,
    gpt: config.CLIPROXY_TEXT_MODEL_GPT,
  };
}

/**
 * Reasoning effort each backend sends when the user has not pinned one.
 * `null` = the per-path default (`AI_FILL_DEFAULTS.reasoning_effort` and
 * friends, all 'low'), which only Kimi takes. Every other entry is one of the
 * backend's own listed levels: CLIProxyAPI silently remaps an unlisted level
 * (MiMo 'low' -> 'high'), so a per-path default must never reach
 * them. GPT keeps its fixed pin even under a user effort.
 */
export const TEXT_BACKEND_DEFAULT_REASONING_EFFORT = {
  kimi: null,
  mimo: 'none',
  grok: 'low',
  'gemini-argon': 'low',
  'deepseek-abliterated': 'none',
  'glm-abliterated': GLM_ABLITERATED_REASONING_EFFORT,
  gpt: GPT_REASONING_EFFORT,
} as const satisfies Record<AiFillBackend, TextReasoningEffort | null>;

// ai-fill writes at most AI_FILL_MAX_SLOTS short blanks, so it must not inherit
// the 32k infer ceiling. Kimi uses low reasoning for this bounded compilation.
// The ceiling is deliberately generous: reasoning spends from the same
// completion budget, so a tight bound starves the answer rather than capping it.
export const AI_FILL_DEFAULTS = {
  reasoning_effort: 'low',
  verbosity: 'low',
  max_completion_tokens: 36_000,
} as const;

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
 * Each entry represents one possible policy-wrapped provider.aiFill call. The
 * route can make a second call for format recovery, and a mixed batch processes
 * both backend groups sequentially, so their complete envelopes must be summed.
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

// Historical thinking-on batch-4 trials reached 117.6s; adding 25% gives
// 147s, rounded to 150s (32.4s / 27.6% above the observed worst). The route then
// budgets every permitted policy call and adds a separate 30s lifecycle margin.
export const AI_FILL_BATCH_PER_ATTEMPT_TIMEOUT_MS = 150_000;
export const AI_FILL_BATCH_MAX_COMPLETION_TOKENS = 144_000;

export function aiFillBatchPerAttemptTimeoutMs(backend: AiFillBackend | null): number {
  return aiFillPerAttemptTimeoutMs(backend, AI_FILL_BATCH_PER_ATTEMPT_TIMEOUT_MS);
}

export function aiFillBatchRouteTimeoutMs(
  backend: AiFillBackend,
  maxBackoffMs: number,
): number {
  // The batch permits the initial call plus one format recovery call, and
  // each of those calls owns a complete retry policy.
  const perAttemptMs = aiFillBatchPerAttemptTimeoutMs(backend);
  return aiFillRouteTimeoutMs([perAttemptMs, perAttemptMs], maxBackoffMs);
}

// 600/prompt (was 400): measured, K3 writes ~350-500 content tokens
// per character, so the old 2000-token floor at count=4 capped pure content in
// 1 of 3 runs. Reasoning ALSO spends from max_completion_tokens, so low effort
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

export function brainstormDefaults(count: number, effort: TextReasoningEffort = 'low'): {
  reasoning_effort: string;
  verbosity: string;
  max_completion_tokens: number;
} {
  // 'low' (was 'none'): K3 reasoning tokens spend from max_completion_tokens.
  // At 'high' a count-4 brainstorm burned 5.3-8.4k
  // chars of CoT into the budget — 2/2 runs hit finish_reason 'length', one
  // with zero content. Low keeps a short think and the budget above adds a
  // CoT overhead, scaled up for a user-pinned effort, so content is not starved.
  return { reasoning_effort: effort, verbosity: 'low', max_completion_tokens: brainstormTokenBudget(count, effort) };
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

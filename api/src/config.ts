// Typed env loader. Parsed once at boot, frozen, then imported wherever
// runtime config is needed. See architecture.md § Configuration for the
// canonical list of required + optional vars.
//
// Failure mode: missing or malformed required vars cause `loadConfig()` to
// throw `ConfigError` carrying every missing/invalid var name. The server's
// boot path catches it and exits 1 with the message — never
// recovers, never falls back to defaults.

import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { z } from 'zod';
import {
  BRAINSTORM_MAX_COUNT_CEILING,
  MAX_OPTIONS_PER_LIST,
  MAX_REF_BYTES_PER_BATCH,
  MAX_TILE_COUNT,
} from '@atelier/shared';
import { isValidHexKey } from './crypto/hex-key';
import { PROMPT_ARRAY_TRANSPORT_MAX, TEMPLATE_BODY_HARD_MAX } from './prompts/limits';

const numericString = (defaultValue: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? defaultValue : Number(v)))
    // One operator-facing message covers every failure mode (NaN from a
    // non-numeric value, a float, zero, or a negative) instead of Zod's terse
    // 'expected int'. ConfigError already prefixes the offending var name.
    .refine((n) => Number.isInteger(n) && n > 0, { message: 'must be a positive integer' });

// Treat `''` like `undefined` so an empty .env entry (`AUTH_HEADER_USER=`) or
// an unset shell variable (`AUTH_HEADER_USER="$NOT_SET"`) falls back to the
// documented default instead of silently neutering the auth header.
const stringWithDefault = (defaultValue: string) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? defaultValue : v));

// Comma-separated allowlist → Set of trimmed non-empty values. Empty / unset
// uses the supplied default; an explicit empty string yields an EMPTY set
// (operator kill switch — feature disabled for everyone).
const csvAllowlist = (defaultValue: string) =>
  z
    .string()
    .optional()
    .transform((v) => {
      const raw = v ?? defaultValue;
      return new Set(raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0));
    });

const nonEmptyString = z.string().min(1, 'must be non-empty');

// Comma-separated list → array of trimmed non-empty values, in order. Unset or
// empty yields an empty list.
const csvList = z
  .string()
  .optional()
  .transform((v) => (v ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0));

function isReadableDirectory(path: string): boolean {
  try {
    if (!statSync(path).isDirectory()) return false;
    accessSync(path, fsConstants.R_OK | fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const optionalSecret = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v === '' ? undefined : v));

const boolish = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return defaultValue;
      const norm = v.toLowerCase();
      if (norm === '1' || norm === 'true' || norm === 'yes' || norm === 'on') return true;
      if (norm === '0' || norm === 'false' || norm === 'no' || norm === 'off') return false;
      return defaultValue;
    });

// Base URLs are operator-supplied and concatenated with absolute provider
// paths (`baseUrl + '/v1/...'`). A path / query / hash / credentials segment
// on the base would produce path-confusion fetches against exotic upstreams.
// Lock the surface to bare `scheme://host[:port]` so the env value can only
// vary along its intended axis (host) and refresh from upstream over hard
// invariants. Trailing slash is preserved by callers via `.replace(/\/+$/, '')`.
const urlString = z
  .string()
  .min(1, 'must be non-empty')
  .refine(
    (v) => {
      try {
        const parsed = new URL(v);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
        if (parsed.pathname !== '/' && parsed.pathname !== '') return false;
        if (parsed.search.length > 0) return false;
        if (parsed.hash.length > 0) return false;
        if (parsed.username.length > 0 || parsed.password.length > 0) return false;
        return true;
      } catch {
        return false;
      }
    },
    { message: 'must be a bare http(s) base URL (no path/query/hash/credentials)' },
  );

// Optional base URL: empty or unset means "not configured" (an operator turns
// an integration off with `NAME=`); anything else must pass `urlString`.
const optionalUrlString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v === '' ? undefined : v))
  .pipe(urlString.optional());

// Optional exact origin (`scheme://host[:port]`, no trailing slash): empty or
// unset means "not configured".
const optionalOriginString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v === '' ? undefined : v))
  .pipe(
    z
      .string()
      .refine((v) => URL.canParse(v) && new URL(v).origin === v, {
        message: 'must be an exact origin (scheme://host[:port], no path or trailing slash)',
      })
      .optional(),
  );

const ConfigSchema = z.object({
  // Required.
  CLIPROXY_BASE_URL: urlString,
  CLIPROXY_TOKEN: nonEmptyString,
  DATA_DIR: nonEmptyString,

  // Required for GPT requests, not for boot or local/BYOK generation.
  // Missing key makes the GPT moderation gate fail closed.
  OPENROUTER_API_KEY: optionalSecret,

  // Optional direct ComfyUI host. Local models are registered only when it is
  // configured.
  COMFYUI_BASE_URL: optionalUrlString,
  // Optional directory of model manifests; must be a readable directory when set.
  COMFYUI_MODELS_DIR: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? undefined : v))
    .pipe(
      nonEmptyString
        .refine(isReadableDirectory, { message: 'must be a readable directory' })
        .optional(),
    ),
  // Comma-separated local model ids to enable; empty enables none.
  COMFYUI_ENABLE_MODELS: csvList,

  COMFYUI_ATELIER_TOKEN: z.string().optional(),
  COMFYUI_ATELIER_CA: z.string().optional(),

  // Optional Ephemera character-card integration (docs/providers.md
  // § Ephemera character cards). An unset or empty base URL turns it off;
  // when set, the key and origin are required (checked after the parse).
  EPHEMERA_BASE_URL: optionalUrlString,
  EPHEMERA_INTEGRATION_KEY: optionalSecret,
  EPHEMERA_ORIGIN: optionalOriginString,
  EPHEMERA_USERS: csvAllowlist(''),
  // SSE lifetime of one card request. Must stay 60 s under
  // SWAG_PROXY_READ_TIMEOUT_MS and below Ephemera's request timeout.
  EPHEMERA_CARD_TIMEOUT_MS: numericString(540_000),

  // Optional with defaults (architecture.md § Configuration).
  API_HOST: stringWithDefault('0.0.0.0'),
  API_PORT: numericString(8787),
  AUTH_HEADER_USER: stringWithDefault('Remote-User'),
  CLOUD_TIMEOUT_MS: numericString(300_000),
  LOCAL_TIMEOUT_MS: numericString(600_000),
  // Video (I2V) generations are far slower than image gens — a MiniMax H3
  // 124-frame clip plus first-load model staging can run minutes, and larger
  // canvases scale up. An 8-step turbo build finishes a 124-frame 1344x768
  // clip in about two minutes; this ceiling keeps headroom for a 20-step
  // build plus cold staging.
  // resolveTimeoutMs scales it linearly off the 124-frame baseline.
  // LOCAL_TIMEOUT_MS could abort long clips, so video models get their own
  // ceiling. Only outputKind:'video' registry entries use it.
  LOCAL_VIDEO_TIMEOUT_MS: numericString(1_200_000),
  MAX_SEQUENCE_SEGMENTS: numericString(12).pipe(z.number().int().min(2).max(100)),
  SEQUENCE_STITCH_TIMEOUT_MS: numericString(120_000),
  SEQUENCE_MASTER_MAX_BYTES: numericString(1024 * 1024 * 1024),
  MAX_CONCURRENT_TILES: numericString(5),
  MAX_CONCURRENT_TILES_PER_USER: numericString(4),
  // BYOK requests (user supplies their own upstream API key) use a separate
  // semaphore with no server-wide cap — each user spends their own quota,
  // so one user cannot starve another. Only a per-user cap applies.
  MAX_CONCURRENT_TILES_PER_USER_BYOK: numericString(8),
  // Local-backend requests (ComfyUI on a single GPU host) use a server-wide
  // semaphore, NOT per-user. The GPU runs one prompt at a time anyway;
  // queuing beyond this would only inflate the apparent backlog without
  // helping throughput. PINNED to 1 (not just defaulted): the per-host
  // model-switch VRAM eviction (residentKeyByHost in comfyui.ts) is
  // correct ONLY because the local pool is strictly serial — two concurrent
  // local jobs would race the unsynchronized resident-model tracker and could
  // load two models on one card (OOM). Raising this needs a per-host mutex first.
  MAX_CONCURRENT_TILES_LOCAL: numericString(1).pipe(z.number().int().min(1).max(1)),
  // Starvation bound for local model-affinity dequeue: a queued job that has
  // been passed over by same-model work for this long (monotonic time since
  // the first skip, NOT queue age) is dispatched next. One video job outlasts
  // this default, so for video the bound trips after a single skip; raise it
  // to let deeper same-model video runs drain first.
  LOCAL_QUEUE_AFFINITY_MAX_HEAD_WAIT_MS: numericString(600_000),
  MAX_INFLIGHT_VIDEO_PER_USER: numericString(1),
  // Maximum number of images a single ComfyUI batch job may produce.
  // Capped at MAX_TILE_COUNT (4) on the generate route. Independent of the
  // concurrency cap — a batch_size=4 job still occupies just one local slot.
  COMFYUI_BATCH_MAX: numericString(4).pipe(z.number().int().min(1).max(4)),
  MAX_CONCURRENT_LLM_ENHANCE_PER_USER: numericString(15).pipe(z.number().int().min(1).max(64)),
  MAX_CONCURRENT_LLM_DRAFT_PER_USER: numericString(2).pipe(z.number().int().min(1).max(64)),
  MAX_CONCURRENT_LLM_INFER_PER_USER: numericString(1).pipe(z.number().int().min(1).max(64)),
  MAX_CONCURRENT_LLM_RESCUE_PER_USER: numericString(1).pipe(z.number().int().min(1).max(64)),
  MAX_CONCURRENT_LLM_TOTAL: numericString(20).pipe(z.number().int().min(1).max(64)),
  // Enhance and draft may each occupy at most their configured share of the
  // global slots; infer/rescue use the full maxTotal ceiling.
  MAX_CONCURRENT_LLM_ENHANCE_GLOBAL_CAP: numericString(18).pipe(z.number().int().min(1).max(64)),
  MAX_CONCURRENT_LLM_DRAFT_GLOBAL_CAP: numericString(8).pipe(z.number().int().min(1).max(64)),
  MAX_QUEUED_BATCHES_PER_USER: numericString(20),
  // Background health-probe cadence for `pool: 'local'` providers (ComfyUI).
  // 15s = fast enough that an outage flips the chip to "Offline" before a
  // typical user composes their next prompt, slow enough that a healthy host
  // isn't hammered (4 requests/minute). Probe budget is per-attempt — a
  // probe that overruns is aborted and recorded as offline.
  HEALTH_PROBE_INTERVAL_MS: numericString(15_000),
  HEALTH_PROBE_TIMEOUT_MS: numericString(2_000),
  // Hard ceiling on the response body the cliproxy provider will read
  // before it aborts the fetch. A misbehaving / compromised upstream that
  // returns a multi-GB JSON would otherwise blow through RAM and the disk
  // volume. SWAG's inbound `client_max_body_size 50M` doesn't apply to
  // outbound provider fetches — this is the matching outbound bound.
  CLIPROXY_MAX_RESPONSE_BYTES: numericString(50 * 1024 * 1024),
  LOCAL_VIDEO_MAX_RESPONSE_BYTES: numericString(200 * 1024 * 1024),
  // Hard ceiling on the prompt-enhance response body. This byte cap plus the
  // AbortController bounds a malformed or runaway Kimi stream independently of
  // its completion-token ceiling. 1 MB is far above any sane rewritten prompt.
  CLIPROXY_TEXT_MAX_RESPONSE_BYTES: numericString(1 * 1024 * 1024),
  // CLIProxyAPI model id each text backend sends (providers/cliproxyText.config.ts
  // maps backend keys to these). Wire shapes follow the backend key, not the id.
  CLIPROXY_TEXT_MODEL_KIMI: stringWithDefault('kimi-latest'),
  CLIPROXY_TEXT_MODEL_MIMO: stringWithDefault('mimo-v2.6-pro'),
  CLIPROXY_TEXT_MODEL_GROK: stringWithDefault('grok-latest'),
  CLIPROXY_TEXT_MODEL_GEMINI_ARGON: stringWithDefault('gemini-4-argon'),
  CLIPROXY_TEXT_MODEL_DEEPSEEK_ABLITERATED: stringWithDefault('abliterated-model-large-flash'),
  CLIPROXY_TEXT_MODEL_GLM_ABLITERATED: stringWithDefault('glm-5.3'),
  CLIPROXY_TEXT_MODEL_GPT: stringWithDefault('gpt-6.1-sol'),
  // Runaway-stream guard for the dimensions-infer path (taxonomy + chunk +
  // rescue calls). This counts RAW SSE wire bytes, not parsed content — at
  // Kimi's ~200-byte-per-token streaming frame overhead, a single
  // infer call against a large library (74 lists) blows past the 1 MB
  // enhance/draftList guard purely on framing (observed 1.05 MB for a ~tens-of-
  // KB taxonomy payload). The functional output bound is max_completion_tokens
  // (36000 for infer), so 8 MB is the matching anti-runaway ceiling; the tight
  // 1 MB guard stays on the small enhance/draftList/draftTemplate paths.
  CLIPROXY_TEXT_INFER_MAX_RESPONSE_BYTES: numericString(8 * 1024 * 1024),
  // Brainstorm Characters. The operator MAX_COUNT clamps to the shared wire
  // ceiling via a transform (not a max, which would reject an above-ceiling
  // override and fail config load). Clamp, never reject. The DEFAULT count is
  // NOT a server config knob — the client sources it from the shared
  // BRAINSTORM_DEFAULT_COUNT constant and the route requires count in the
  // request, so a server-side default would be dead config.
  BRAINSTORM_MAX_COUNT: numericString(BRAINSTORM_MAX_COUNT_CEILING)
    .pipe(z.number().int().min(1))
    .transform((n) => Math.min(n, BRAINSTORM_MAX_COUNT_CEILING)),
  // Brainstorm response cap, larger than the 1 MB enhance cap and sized for the
  // ceiling count. A pinned effort above 'low' raises it to a code-owned 16 MiB
  // floor (`pinnedEffortMaxResponseBytes`).
  BRAINSTORM_MAX_RESPONSE_BYTES: numericString(4 * 1024 * 1024),
  INFER_TOTAL_BUDGET_MS: numericString(500_000).pipe(z.number().int().min(120_000).max(580_000)),
  RESILIENT_PER_ATTEMPT_TIMEOUT_MS: numericString(70_000).pipe(z.number().int().min(15_000).max(180_000)),
  // Pass-1 (taxonomy) shared wall-time envelope. Taxonomy is a
  // non-parallelizable reasoning call over the WHOLE library; for large
  // libraries (70+ lists) its output-bound latency runs ~140s — well past the
  // 70s RESILIENT_PER_ATTEMPT_TIMEOUT_MS used for the fast per-list Pass-2
  // chunks. Provider calls each make one attempt; route recovery of one
  // transient result shares this ceiling across both calls. Wired into
  // the totalEnvelope invariant below. Min 70s so it never undercuts the chunk
  // timeout; max 300s to stay within INFER_TOTAL_BUDGET_MS headroom.
  INFER_TAXONOMY_TIMEOUT_MS: numericString(180_000).pipe(z.number().int().min(70_000).max(300_000)),
  RESILIENT_MAX_ATTEMPTS: numericString(2).pipe(z.number().int().min(1).max(5)),
  RESILIENT_INITIAL_BACKOFF_MS: numericString(800).pipe(z.number().int().min(100).max(10_000)),
  RESILIENT_MAX_BACKOFF_MS: numericString(8_000).pipe(z.number().int().min(500).max(60_000)),
  RESILIENT_BREAKER_THRESHOLD: numericString(8).pipe(z.number().int().min(3).max(32)),
  RESILIENT_HALF_OPEN_AFTER_MS: numericString(30_000).pipe(z.number().int().min(5_000).max(120_000)),
  // A 429 is treated as 5h-budget EXHAUSTION (non-retriable, breaker-exempt)
  // only on explicit evidence: token-budget body wording OR a raw Retry-After
  // at/above this floor. Short/absent Retry-After stays transient (overload),
  // still retried once and still breaker-eligible. Default 5 min.
  QUOTA_MIN_RETRY_AFTER_MS: numericString(300_000).pipe(z.number().int().min(30_000).max(3_600_000)),
  IMAGE_RETRY_MAX_ATTEMPTS: numericString(3).pipe(z.number().int().min(1).max(6)),
  IMAGE_RETRY_INITIAL_BACKOFF_MS: numericString(1_000).pipe(z.number().int().min(100).max(10_000)),
  IMAGE_RETRY_MAX_BACKOFF_MS: numericString(8_000).pipe(z.number().int().min(500).max(60_000)),
  IMAGE_BREAKER_THRESHOLD: numericString(5).pipe(z.number().int().min(2).max(32)),
  IMAGE_BREAKER_HALF_OPEN_MS: numericString(15_000).pipe(z.number().int().min(2_000).max(120_000)),
  IMAGE_BREAKER_MAX_PAUSE_MS: numericString(300_000).pipe(z.number().int().min(30_000).max(1_800_000)),
  ENHANCE_OPEN_TIMEOUT_MS: numericString(15_000).pipe(z.number().int().min(5_000).max(60_000)),
  // Brainstorm is a draft-pool (minutes-long) workload; a historical
  // time-to-first-token tail of 30-40s gave it its own open cap.
  BRAINSTORM_OPEN_TIMEOUT_MS: numericString(45_000).pipe(z.number().int().min(5_000).max(120_000)),
  // Historical thinking-on fills reached 62.7s; 120s is retained as tail headroom.
  AI_FILL_PER_ATTEMPT_TIMEOUT_MS: numericString(120_000).pipe(z.number().int().min(30_000).max(180_000)),
  // Krea prompt condensation runs in the batch worker, so this bounds a
  // background call and no client connection — the batch id is already back
  // with the caller. Historical thinking-on calls measured 57-120s. The wait
  // overlaps GPU queue time, and a skip costs
  // real output quality (an over-budget prompt reaches the sampler). Kept a
  // separate knob from AI_FILL_PER_ATTEMPT_TIMEOUT_MS because the two bound
  // different workloads.
  KREA_CONDENSE_TIMEOUT_MS: numericString(150_000).pipe(z.number().int().min(1_000).max(300_000)),
  SWAG_PROXY_READ_TIMEOUT_MS: numericString(600_000).pipe(z.number().int().min(60_000).max(3_600_000)),
  // Raw on-disk ref-image budget per batch. Note: providers may impose tighter
  // per-request ceilings on the post-encode payload — see
  // `providers/google.ts::MAX_INLINE_PAYLOAD_BYTES` (18 MB after downscale +
  // base64). Raising this env without raising the matching adapter constants
  // does not unlock larger ref images on Google.
  MAX_REF_BYTES_PER_BATCH: numericString(MAX_REF_BYTES_PER_BATCH),
  // Reconciliation guard knobs. Threshold is a 0..1 fraction of orphans-to-total
  // above which the reconciler refuses bulk-unlink; FORCE=true overrides for
  // one boot after an operator manually verified the mount.
  RECONCILE_ORPHAN_THRESHOLD: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? 0.5 : Number(v)))
    .pipe(z.number().min(0).max(1)),
  RECONCILE_FORCE: boolish(false),
  UPLOAD_TTL_MS: numericString(24 * 60 * 60 * 1000),
  // Mock provider's slow-path delay routed through Config so tests inject
  // it via `loadConfig({ MOCK_PROVIDER_DELAY_MS: '300' })` instead of
  // mutating process.env. Reading process.env directly inside the
  // adapter sidesteps Config's "loaded once at boot, frozen" contract.
  MOCK_PROVIDER_DELAY_MS: numericString(30_000),
  MOCK_PROVIDER_TILE_DELAYS: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? undefined : v)),
  LOG_LEVEL: stringWithDefault('info').pipe(
    z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),
  ),
  PROMPT_LIBRARY_USERS: csvAllowlist(''),
  LOCAL_MODELS_USERS: csvAllowlist(''),
  // Users who manage text providers, models and routing (admin API). Unset or
  // empty = nobody; every admin route answers 404 to everyone else.
  TEXT_PROVIDER_ADMINS: csvAllowlist(''),
  MAX_PROMPT_TEMPLATES: numericString(200),
  MAX_VARIABLE_LISTS: numericString(100),
  MAX_OPTIONS_PER_LIST: numericString(MAX_OPTIONS_PER_LIST).pipe(
    z.number().int().min(1).max(PROMPT_ARRAY_TRANSPORT_MAX),
  ),
  MAX_TAG_DIMENSIONS: numericString(20),
  MAX_TAGS_PER_DIMENSION: numericString(30).pipe(
    z.number().int().min(1).max(PROMPT_ARRAY_TRANSPORT_MAX),
  ),
  INFER_DIMENSIONS_MAX_SNAPSHOT_TOKENS: numericString(12_000),
  // Two-pass trigger based on projected assignOptionTags output. Originally
  // sized at 16K to close a silent-truncation gap on a 522-option library
  // (~13K projected output, under a single-shot 32K ceiling with reasoning
  // headroom). The actual production failure was wallclock, not
  // truncation: a 522-option single-shot call under reasoning_effort
  // 'medium' + the comprehensive system prompt exceeded the 300s upstream
  // watchdog. 4_000 trips two-pass for any library with >160 assignable
  // options — small enough that per-list batches stay fast, large enough
  // that toy/dev libraries still single-shot. Parallel batch dispatch
  // (`runBatchesParallel`) keeps overall wallclock bounded by
  // ceil(listCount / INFER_DIMENSIONS_BATCH_CONCURRENCY) instead of summing.
  INFER_DIMENSIONS_MAX_OUTPUT_BUDGET_TOKENS: numericString(4_000),
  // Max concurrent per-list calls during two-pass tagging. 6 is the sweet
  // spot on the production CLIProxyAPI deployment: enough parallelism to bring
  // a 22-list library under ~2-3 minutes, low enough not to swamp the
  // upstream reasoning model's queue. Each in-flight call still respects
  // the per-request AbortSignal so client disconnect / watchdog cancels
  // everything in flight. Hard-capped at 16 so a mis-set env can't fan a
  // single /infer into one upstream call per list.
  INFER_DIMENSIONS_BATCH_CONCURRENCY: numericString(12).pipe(z.number().int().min(1).max(16)),
  // Hard ceiling is TEMPLATE_BODY_HARD_MAX (prompts/limits.ts), the transport cap
  // the route's Zod schema enforces. That cap is the transport guard (rejects oversize bodies
  // before parse), this runtime check is the operator-tunable ratchet under it.
  // An env value above the transport cap would 400 every legitimate request,
  // so reject at config load instead of letting it ship broken.
  MAX_TEMPLATE_BODY_BYTES: numericString(65_536).pipe(z.number().int().min(1).max(TEMPLATE_BODY_HARD_MAX)),

  // Defense in depth.
  //
  // ENABLE_MOCK_PROVIDER: the mock provider was
  // previously gated only by `NODE_ENV !== 'production'`. A misconfigured
  // staging environment that forgets to set NODE_ENV would silently expose
  // the mock as a usable model. Now requires explicit opt-in. Default
  // `true` in dev/test, `false` in production unless explicitly set.
  ENABLE_MOCK_PROVIDER: boolish(process.env.NODE_ENV !== 'production'),
  VIDEO_MODELS_ENABLED: boolish(false),
  // MiniMax H3 I2V submit-time motion-prompt enhancement (Kimi K3). Default ON;
  // operator kill-switch. Off → the /enhance-prompt h3-motion branch skips and
  // the client submits the raw motion prompt.
  I2V_MOTION_ENHANCE: boolish(true),
  // TRUSTED_PROXY_KEY: the api trusts `Remote-User` only when
  // SWAG/Authelia is the sole upstream. If the api ever gets exposed
  // directly (port leak, misconfigured network), Remote-User format
  // validation alone is not enough — any caller can spoof it. When this
  // env var is set, the auth middleware additionally requires the request
  // to carry an `X-Atelier-Proxy-Key: <value>` header that SWAG injects.
  // Production must set this and inject the matching header in SWAG.
  // Empty/unset = no extra check (dev/test default).
  TRUSTED_PROXY_KEY: optionalSecret,
  // BYOK_ENCRYPTION_KEY: AES-256 master key (32 bytes, hex-encoded).
  // Required in production; optional in dev/test.
  BYOK_ENCRYPTION_KEY: optionalSecret.refine(
    (v) => v === undefined || isValidHexKey(v),
    'BYOK_ENCRYPTION_KEY must be 64 hex characters (32 bytes)',
  ),
  // STORAGE_ROOT_RECIPIENT: public age recipient of the artifact-encryption
  // root (docs/deployment.md § Artifact encryption). Not secret: the matching
  // identity stays in a host secret store and is pushed in over the unseal
  // socket. Required in production; dev/test fall back to a local dev root.
  STORAGE_ROOT_RECIPIENT: z
    .string()
    .optional()
    .transform((v) => {
      const trimmed = v?.trim();
      return trimmed === undefined || trimmed === '' ? undefined : trimmed;
    })
    .pipe(
    z
      .string()
      .regex(/^age1[0-9a-z]+$/, 'STORAGE_ROOT_RECIPIENT must be an age recipient (age1…)')
      .optional(),
  ),
  // STORAGE_UNSEAL_SOCKET: container-local Unix socket for the storage
  // unseal/verify control plane (storage/encryptionBoot.ts). Production
  // defaults to /run/atelier/unseal.sock (tmpfs); dev/test start no socket
  // unless set.
  STORAGE_UNSEAL_SOCKET: z.string().min(1).optional(),
  // CSRF_PROTECT: when true, the api enforces same-origin via Origin/Referer
  // headers on all state-changing methods (POST/PATCH/PUT/DELETE). Without
  // it, the api relies entirely on Authelia's session-cookie SameSite
  // posture, which defaults to Lax (does NOT cover top-level POST CSRF).
  // Default `true` in production, `false` elsewhere so test runtimes don't
  // need to spoof Origin headers.
  CSRF_PROTECT: boolish(process.env.NODE_ENV === 'production'),
});

export type Config = Readonly<z.infer<typeof ConfigSchema>>;

export class ConfigError extends Error {
  readonly issues: readonly { var: string; message: string }[];
  constructor(issues: readonly { var: string; message: string }[]) {
    super(
      `invalid configuration:\n` +
        issues.map((i) => `  ${i.var}: ${i.message}`).join('\n'),
    );
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

// Substrings that mark unconfigured placeholder values shipped in
// `.env.production.example`. Production deploys must replace them with a
// real secret before boot; we refuse to start otherwise.
const TRUSTED_PROXY_KEY_PLACEHOLDERS: readonly string[] = [
  'replace-with',
  'placeholder',
  'changeme',
  'change-me',
  'your-secret',
];
const TRUSTED_PROXY_KEY_MIN_LENGTH = 32;

function looksLikePlaceholder(value: string): boolean {
  const lower = value.toLowerCase();
  return TRUSTED_PROXY_KEY_PLACEHOLDERS.some((needle) => lower.includes(needle));
}

/** Config narrowed to a configured Ephemera integration. */
export type EphemeraConfig = Config & {
  readonly EPHEMERA_BASE_URL: string;
  readonly EPHEMERA_INTEGRATION_KEY: string;
  readonly EPHEMERA_ORIGIN: string;
};

/** True when the Ephemera character-card integration is configured. */
export function ephemeraEnabled(config: Config): config is EphemeraConfig {
  return (
    config.EPHEMERA_BASE_URL !== undefined &&
    config.EPHEMERA_INTEGRATION_KEY !== undefined &&
    config.EPHEMERA_ORIGIN !== undefined
  );
}

// Cross-field Ephemera rules. With the base URL unset the integration is off
// and nothing else is checked. The key follows the TRUSTED_PROXY_KEY rules in
// production (long, never a template placeholder).
function ephemeraIssues(
  data: z.infer<typeof ConfigSchema>,
  production: boolean,
): { var: string; message: string }[] {
  if (data.EPHEMERA_BASE_URL === undefined) return [];
  const issues: { var: string; message: string }[] = [];
  const key = data.EPHEMERA_INTEGRATION_KEY;
  if (key === undefined) {
    issues.push({ var: 'EPHEMERA_INTEGRATION_KEY', message: 'is required when EPHEMERA_BASE_URL is set' });
  } else if (production && looksLikePlaceholder(key)) {
    issues.push({
      var: 'EPHEMERA_INTEGRATION_KEY',
      message: 'looks like a placeholder from .env.production.example; replace with the key Ephemera holds',
    });
  } else if (production && key.length < TRUSTED_PROXY_KEY_MIN_LENGTH) {
    issues.push({
      var: 'EPHEMERA_INTEGRATION_KEY',
      message: `must be at least ${TRUSTED_PROXY_KEY_MIN_LENGTH} characters in production (got ${key.length})`,
    });
  }
  if (data.EPHEMERA_ORIGIN === undefined) {
    issues.push({ var: 'EPHEMERA_ORIGIN', message: 'is required when EPHEMERA_BASE_URL is set' });
  }
  if (data.EPHEMERA_CARD_TIMEOUT_MS + 60_000 > data.SWAG_PROXY_READ_TIMEOUT_MS) {
    issues.push({
      var: 'EPHEMERA_CARD_TIMEOUT_MS',
      message: `must leave 60s margin under SWAG_PROXY_READ_TIMEOUT_MS (${data.SWAG_PROXY_READ_TIMEOUT_MS})`,
    });
  }
  return issues;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Migration guard: MAX_CONCURRENT_BATCHES was renamed to MAX_CONCURRENT_TILES
  // when the cap moved from per-user, per-batch to global, per-tile. Silently
  // ignoring the old name would let an operator who set
  // `MAX_CONCURRENT_BATCHES=1` boot with the new default of 4, quietly
  // increasing upstream concurrency beyond what they configured. Refuse to
  // start until they migrate the env explicitly.
  if (env.MAX_CONCURRENT_BATCHES !== undefined && env.MAX_CONCURRENT_BATCHES !== '') {
    throw new ConfigError([
      {
        var: 'MAX_CONCURRENT_BATCHES',
        message:
          'renamed to MAX_CONCURRENT_TILES (default 4). The cap is now global across all users and counts in-flight tiles (one CLIProxyAPI call per tile), not per-user batches. Update your environment.',
      },
    ]);
  }
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({
      var: String(issue.path[0] ?? '<root>'),
      message: issue.message,
    }));
    throw new ConfigError(issues);
  }
  if (parsed.data.VIDEO_MODELS_ENABLED && !parsed.data.COMFYUI_BASE_URL) {
    throw new ConfigError([{
      var: 'COMFYUI_BASE_URL',
      message: 'is required when VIDEO_MODELS_ENABLED=true',
    }]);
  }
  const resilienceIssues: { var: string; message: string }[] = [];
  const perCallEnvelope =
    parsed.data.RESILIENT_PER_ATTEMPT_TIMEOUT_MS * parsed.data.RESILIENT_MAX_ATTEMPTS +
    parsed.data.RESILIENT_MAX_BACKOFF_MS * Math.max(0, parsed.data.RESILIENT_MAX_ATTEMPTS - 1);
  // Pass 1 (taxonomy) is a single attempt on its own larger timeout — no retry
  // backoff term. Pass-2 waves keep the RESILIENT per-call envelope below.
  const taxonomyEnvelope = parsed.data.INFER_TAXONOMY_TIMEOUT_MS;
  const wave2Envelope = parsed.data.RESILIENT_PER_ATTEMPT_TIMEOUT_MS;
  const concurrency = Math.max(1, parsed.data.INFER_DIMENSIONS_BATCH_CONCURRENCY);
  const TYPICAL_CHUNKS = 12;
  const chunksPerWave = Math.ceil(TYPICAL_CHUNKS / concurrency);
  const totalEnvelope =
    taxonomyEnvelope +
    chunksPerWave * perCallEnvelope +
    chunksPerWave * wave2Envelope +
    60_000;
  if (totalEnvelope > parsed.data.INFER_TOTAL_BUDGET_MS) {
    resilienceIssues.push({
      var: 'INFER_TOTAL_BUDGET_MS',
      message: `INFER_TOTAL_BUDGET_MS (${parsed.data.INFER_TOTAL_BUDGET_MS}) too low for taxonomy + 2 waves of ${chunksPerWave} chunks at concurrency ${concurrency}: need at least ${totalEnvelope}ms`,
    });
  }
  if (parsed.data.INFER_TOTAL_BUDGET_MS + 60_000 > parsed.data.SWAG_PROXY_READ_TIMEOUT_MS) {
    resilienceIssues.push({
      var: 'INFER_TOTAL_BUDGET_MS',
      message: `must leave 60s margin under SWAG_PROXY_READ_TIMEOUT_MS (${parsed.data.SWAG_PROXY_READ_TIMEOUT_MS})`,
    });
  }
  if (resilienceIssues.length > 0) throw new ConfigError(resilienceIssues);
  // Per-user cap above the global cap is silently ineffective — the global
  // cap binds first — so refuse to start with the misleading config rather
  // than letting an operator believe they've raised per-user limits.
  if (parsed.data.MAX_CONCURRENT_TILES_PER_USER > parsed.data.MAX_CONCURRENT_TILES) {
    throw new ConfigError([
      {
        var: 'MAX_CONCURRENT_TILES_PER_USER',
        message: `must be <= MAX_CONCURRENT_TILES (got ${parsed.data.MAX_CONCURRENT_TILES_PER_USER} > ${parsed.data.MAX_CONCURRENT_TILES}). The global cap binds first; a higher per-user cap has no effect.`,
      },
    ]);
  }
  // A probe round that can outlast the interval makes model-availability
  // snapshots grow stale without bound: a generate request then reads a
  // snapshot up to (timeout + interval) old and can admit a batch to an
  // offline local GPU, pinning the cap=1 semaphore for LOCAL_TIMEOUT_MS
  // before failing. Require the per-probe timeout to be strictly shorter
  // than the polling interval so rounds stay bounded.
  if (parsed.data.HEALTH_PROBE_TIMEOUT_MS >= parsed.data.HEALTH_PROBE_INTERVAL_MS) {
    throw new ConfigError([
      {
        var: 'HEALTH_PROBE_TIMEOUT_MS',
        message: `must be < HEALTH_PROBE_INTERVAL_MS (got ${parsed.data.HEALTH_PROBE_TIMEOUT_MS} >= ${parsed.data.HEALTH_PROBE_INTERVAL_MS}). A probe round longer than the interval lets availability snapshots grow unbounded-stale.`,
      },
    ]);
  }
  // Per-user pool caps below the `GenerateRequest.count` ceiling (MAX_TILE_COUNT)
  // would silently reject every multi-tile batch on that pool with a 429. Tests
  // deliberately exercise the rejection path with cap=1; production should
  // refuse to boot with a misconfiguration that disables multi-tile generation
  // entirely. The local cap is GLOBAL (not per-user) and defaults to 1 —
  // intentionally exempt; local users must send count=1 to fit the single GPU.
  // Single production-invariant block: accumulate EVERY violation and throw
  // once (mirrors resilienceIssues above), so an operator fixing one prod
  // misconfiguration isn't surprised by a second on the next boot.
  //
  // - per-user caps must clear the max generate count or multi-tile batches
  //   429 (local cap is GLOBAL, default 1, intentionally exempt).
  // - TRUSTED_PROXY_KEY must be set/non-placeholder/long: the Authelia
  //   middleware silently trusts raw `Remote-User` without it (fine for dev,
  //   unsafe in prod if atelier-api is ever exposed beyond SWAG).
  // - BYOK_ENCRYPTION_KEY must be set.
  const production = env.NODE_ENV === 'production';
  const integrationIssues = ephemeraIssues(parsed.data, production);
  if (!production && integrationIssues.length > 0) throw new ConfigError(integrationIssues);
  if (production) {
    const issues: { var: string; message: string }[] = [...integrationIssues];

    const MIN_PER_USER_CAP = MAX_TILE_COUNT;
    const perUserMinimums: { var: string; value: number }[] = [
      { var: 'MAX_CONCURRENT_TILES_PER_USER', value: parsed.data.MAX_CONCURRENT_TILES_PER_USER },
      { var: 'MAX_CONCURRENT_TILES_PER_USER_BYOK', value: parsed.data.MAX_CONCURRENT_TILES_PER_USER_BYOK },
    ];
    for (const { var: name, value } of perUserMinimums) {
      if (value < MIN_PER_USER_CAP) {
        issues.push({
          var: name,
          message: `must be >= ${MIN_PER_USER_CAP} (max generate count). Got ${value} — multi-tile batches on this pool would 429.`,
        });
      }
    }

    const key = parsed.data.TRUSTED_PROXY_KEY;
    if (!key) {
      issues.push({
        var: 'TRUSTED_PROXY_KEY',
        message: 'is required when NODE_ENV=production (set in .env and inject the matching X-Atelier-Proxy-Key header in SWAG)',
      });
    } else if (looksLikePlaceholder(key)) {
      issues.push({
        var: 'TRUSTED_PROXY_KEY',
        message: 'looks like a placeholder from .env.production.example; replace with a long random secret',
      });
    } else if (key.length < TRUSTED_PROXY_KEY_MIN_LENGTH) {
      issues.push({
        var: 'TRUSTED_PROXY_KEY',
        message: `must be at least ${TRUSTED_PROXY_KEY_MIN_LENGTH} characters in production (got ${key.length})`,
      });
    }

    if (!parsed.data.BYOK_ENCRYPTION_KEY) {
      issues.push({
        var: 'BYOK_ENCRYPTION_KEY',
        message: 'is required when NODE_ENV=production',
      });
    }

    if (!parsed.data.STORAGE_ROOT_RECIPIENT) {
      issues.push({
        var: 'STORAGE_ROOT_RECIPIENT',
        message: 'is required when NODE_ENV=production',
      });
    }

    if (issues.length > 0) throw new ConfigError(issues);
  }
  return Object.freeze(parsed.data);
}

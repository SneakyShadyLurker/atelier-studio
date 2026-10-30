// Wire-type contract between atelier-web and atelier-api.
//
// Public surface ONLY — these are the types the frontend sees. DB-internal
// shapes (UserRow, BatchRow with userId, raw provider errors, etc.) live in
// api/src/db/types.ts and MUST NOT be re-exported through this package.
// Keeping `userId` out of the wire is what makes server auth state invisible
// to the client and why TileEvent.error is a sanitized category, not the raw
// upstream string.
//
// Source of truth: docs/architecture.md § Generate stream contract + § shared/.
// Any drift between this file and the architecture doc is a bug.

export * from './sse-error';
import type { SseTerminalError } from './sse-error';
import type { GptModerationNotice } from './moderation';
import type { BatchWire, DimensionTagWire, PromptLibraryResponseWire, PromptTemplateWire, StorySummaryWire, TagDimensionWire, TileWire, VariableListWire, VariableOptionWire, VideoSequenceSummaryWire } from './wireSchemas';
export { GPT_MODERATION_REASONS, GptModerationNoticeSchema, GptModerationCategoriesSchema } from './moderation';
export type { GptModerationNotice, GptModerationReason, GptModerationCategory } from './moderation';

// Bounded request policy for upload holds on history/archive DELETEs.
// Large lists travel in JSON; the legacy query remains limited to 64 ids.
export const MAX_DELETE_KEEP_UPLOADS = 8192;

// ─── Enums (string literal unions) ──────────────────────────────────────

// Aspect ratios supported across all providers. Source of truth — every Zod
// schema, registry entry, and UI option derives its allowed set from here so
// adding/removing a ratio touches exactly one place.
export const RATIO_VALUES = ['1:1', '4:5', '3:4', '16:9', '9:16'] as const;
export type Ratio = (typeof RATIO_VALUES)[number];

// Video clip lengths, in FRAMES — the wire unit, because MiniMax H3 quantizes
// clip length to a 17k+5 grid at 24 fps and only grid points are valid `length`
// values on the sampler node. 124 = 5.17 s (k=7), 243 = 10.13 s (k=14),
// 362 = 15.08 s (k=21, the closest grid point to the model's 15 s ceiling).
// Source of truth — the Zod schema, registry, workflow substitution, and the
// composer's duration chip all derive their allowed set from here.
export const VIDEO_FPS = 24;
export const VIDEO_DURATION_FRAMES = [124, 243, 362] as const;
export type VideoDurationFrames = (typeof VIDEO_DURATION_FRAMES)[number];
export const DEFAULT_VIDEO_DURATION_FRAMES = 124 satisfies VideoDurationFrames;

/**
 * Narrows a persisted/unvalidated frame count to the grid. Batches predating
 * the duration column carry `null`, and the DB CHECK is not a type — both
 * paths funnel through here so a stale row can never reach a workflow.
 */
export function isVideoDurationFrames(value: number | null | undefined): value is VideoDurationFrames {
  return value !== null && value !== undefined
    && (VIDEO_DURATION_FRAMES as readonly number[]).includes(value);
}

/** Whole-second clip length for display and prompt pacing. */
export function videoDurationSeconds(frames: VideoDurationFrames): number {
  return frames / VIDEO_FPS;
}

/**
 * Frames of the previous segment anchored at frame 0 of a continuation clip
 * via `MiniMaxH3AddGuide`, so H3 continues the motion and the soundtrack it
 * can see rather than restarting both from a frozen still.
 *
 * 22 is not a tunable: AddGuide crops a multi-frame guide down to the model's
 * own clip grid (5, 22, 39 …), so only grid values survive intact, and 22
 * (~0.92 s) is the shortest one that carries a usable motion phase. The head
 * is regenerated rather than pinned bit-for-bit, so the stitcher discards
 * exactly these frames from every continuation segment.
 */
export const VIDEO_CONTEXT_FRAMES = 22;

/**
 * Snaps a frame count UP to H3's 17k+5 clip grid. `MiniMaxH3ImageToVideo`
 * snaps internally too, but the value is persisted and re-read on requeue, so
 * it is resolved here rather than left to the node.
 */
export function snapVideoFrameGrid(frames: number): number {
  if (frames <= 5) return 5;
  return 5 + 17 * Math.ceil((frames - 5) / 17);
}

/**
 * Clip length to actually render for a segment that carries a context head.
 *
 * The context head is consumed by the guide, so the rendered clip is inflated
 * to keep the DELIVERED length equal to the duration the user picked. H3's
 * grid has no point at exactly `duration + context`, so this also overshoots
 * the sum by up to 16 frames. The stitcher drops BOTH the head and the
 * overshoot, which is what makes delivery exact and keeps the master in step
 * with `batches.duration_frames` (what the sequence summaries add up).
 *
 * At the 362-frame chip this renders 396 frames, ~9% past the model's stated
 * trained range (~124-362) — allowed, because the alternative is silently
 * handing back a segment ~0.9 s shorter than the chip promises, but it is the
 * first place to look if long continuations degrade.
 */
export function renderedVideoFrames(duration: number, contextFrames: number): number {
  if (contextFrames <= 0) return duration;
  return snapVideoFrameGrid(duration + contextFrames);
}

export const BACKEND_VALUES = ['local', 'cloud'] as const;
export type Backend = (typeof BACKEND_VALUES)[number];

export const LATENCY_VALUES = ['instant', 'fast', 'medium', 'slow'] as const;
export type LatencyClass = (typeof LATENCY_VALUES)[number];

export const POOL_VALUES = ['shared', 'byok', 'local'] as const;
export type Pool = (typeof POOL_VALUES)[number];

export type BatchStatus = Batch['status'];

// Max length of the history/archive search query the api accepts. Wire-contract
// bound: the client must not send more than the server's Zod `.max()` allows.
// Source of truth — referenced by the api schema and the web store.
export const MAX_HISTORY_Q_LEN = 200;
/** Maximum tracked batches/stories in one read-only history refresh. */
export const HISTORY_REFRESH_MAX_IDS = 100;

// Default per-variable-list option cap. Seeds the api config default
// (`MAX_OPTIONS_PER_LIST`, still env-overridable) and is the web "AI Draft
// List" button gate value. The *effective* server cap is the env-overridable
// `c.var.config.MAX_OPTIONS_PER_LIST`, enforced identically by the draft
// target clamp and the save endpoint — so AI-drafted entries are always
// saveable. The client gate uses this compile-time default as a safe
// approximation (like MAX_HISTORY_Q_LEN): the authoritative server clamp
// prevents exceeding the effective cap even if the two ever differ.
export const MAX_OPTIONS_PER_LIST = 500;

export { MAX_PROMPT_CHARS } from './promptLimits';

/**
 * Source string for the canonical {{var::name}} template-token regex.
 * shared/src/templateTokens.ts compiles this into the canonical local RegExp
 * instances; api/web token modules re-export that shared implementation so
 * token boundaries cannot drift across workspaces.
 * Joins MAX_PROMPT_CHARS as a documented exception to the wire-types-only rule:
 * a string constant that crosses the workspace boundary, not a type or executable code.
 *
 * Group 1 = the bare list name. Group 2 = the optional `@N` subject digits
 * (undefined for bare tokens). Use `parseVarToken` as the canonical consumer
 * for whitespace-padded `@N` subject suffixes.
 */
export const VAR_TOKEN_PATTERN = '\\{\\{var::([^}]+?)(?:@(\\d+))?\\}\\}';

/**
 * Token-envelope pattern: captures the FULL inner of a `{{var::...}}` token
 * (group 1), including any whitespace-padded `@N` subject suffix. Pair with
 * `parseVarToken` to split name/subject canonically — the two-group
 * `VAR_TOKEN_PATTERN` cannot split a padded suffix (`{{var:: face @1 }}` leaves
 * `@1` inside group 1 because the trailing space defeats the `@(\d+)` anchor at
 * the `}}` boundary). Documented exception to wire-types-only, like
 * VAR_TOKEN_PATTERN.
 */
export const VAR_TOKEN_ENVELOPE = '\\{\\{var::([^}]+?)\\}\\}';

/** The canonical (listName, subject) split for one `{{var::...}}` token inner. */
export interface ParsedVarToken {
  readonly listName: string;
  readonly subject: number | null;
}

const VAR_SUBJECT_SUFFIX = /@(\d+)$/;

/**
 * Canonical parse for a `{{var::...}}` token's inner text, consumed in lockstep
 * by both web (web/src/lib/subjectKey.ts) and api (api/src/prompts) so the
 * client resolver and the server SAT audit cluster identical tokens identically
 * — including whitespace-padded subject suffixes (`{{var:: face @1 }}` →
 * `{ listName: 'face', subject: 1 }`). Trims, then anchors `@(\d+)$` on the
 * trimmed inner; a trailing `@` with no digits stays part of the name.
 */
export function parseVarToken(inner: string): ParsedVarToken {
  const trimmed = inner.trim();
  const m = VAR_SUBJECT_SUFFIX.exec(trimmed);
  if (m === null) return { listName: trimmed, subject: null };
  const digits = m[1];
  if (digits === undefined) return { listName: trimmed, subject: null };
  return { listName: trimmed.slice(0, m.index).trim(), subject: Number(digits) };
}

// Maximum tiles per generation batch. Wire-contract bound: the generate
// schema's `count.max()`, the production per-user-cap boot invariant in
// api/src/config.ts, and the composer's count chips all derive from this.
export const MAX_TILE_COUNT = 4;

// Maximum accepted stored reference-upload file payload. The api's 53 MB
// multipart request envelope cap stays api-local; this shared value is the
// post-conversion file-size contract used by both server validation and client
// preflight.
export const MAX_UPLOAD_FILE_BYTES = 25 * 1024 * 1024;

// Pre-conversion raw upload ceiling. Originals up to this size are accepted so the
// api can transcode/downscale them; MAX_UPLOAD_FILE_BYTES stays the post-conversion
// STORED cap. Matches OpenAI's per-image input limit.
export const MAX_UPLOAD_INPUT_BYTES = 50 * 1024 * 1024;

// Raw on-disk reference-image budget per generation batch. Providers may have
// tighter post-encode adapter ceilings, but this is the api route's shared
// pre-generation upload sum bound.
export const MAX_REF_BYTES_PER_BATCH = 60 * 1024 * 1024;

/**
 * Allowed image artifact formats. The orchestrator coerces any provider
 * result with an `ext` outside this set to `failed: 'unsupported format'`,
 * so by construction every persisted tile has one of these three. The two
 * const-arrays are the single source for every runtime ext/mime guard;
 * `EXT_MIME` is the canonical ext→mime pairing.
 */
export const TILE_EXTS = ['png', 'webp', 'jpg'] as const;
export type TileExt = (typeof TILE_EXTS)[number];

export const TILE_MIMES = ['image/png', 'image/webp', 'image/jpeg'] as const;
export type TileMime = (typeof TILE_MIMES)[number];

export const EXT_MIME = {
  png: 'image/png',
  webp: 'image/webp',
  jpg: 'image/jpeg',
} as const satisfies Record<TileExt, TileMime>;

export const VIDEO_EXT = 'mp4' as const;
export const VIDEO_MIME = 'video/mp4' as const;
export const MEDIA_EXTS = [...TILE_EXTS, VIDEO_EXT] as const;
export type MediaExt = (typeof MEDIA_EXTS)[number];
export const MEDIA_MIMES = [...TILE_MIMES, VIDEO_MIME] as const;
export type MediaMime = (typeof MEDIA_MIMES)[number];
export const MEDIA_EXT_MIME = {
  ...EXT_MIME,
  [VIDEO_EXT]: VIDEO_MIME,
} as const satisfies Record<MediaExt, MediaMime>;

const mediaExtSet: ReadonlySet<string> = new Set(MEDIA_EXTS);
export function isMediaExt(value: string): value is MediaExt {
  return mediaExtSet.has(value);
}

export function isVideoMime(mime: string): mime is typeof VIDEO_MIME {
  return mime === VIDEO_MIME;
}

/**
 * Public, sanitized tile error categories. The orchestrator maps every raw
 * provider error to one of these before persisting or emitting on SSE.
 * The raw error appears only in api logs (architecture.md § Generate stream
 * contract). Type-level enum prevents an adapter from sneaking a verbatim
 * upstream string through the wire. The const-array is the single source —
 * runtime membership guards (e.g. the web SSE validator) derive from it.
 */
export const TILE_ERROR_CATEGORIES = [
  'timed out',
  'upstream rejected',
  'content-policy violation',
  'interrupted',
  'unsupported format',
  'client disconnected',
  'connection lost',
  'internal error',
  'service unavailable',
] as const;
export type TileErrorCategory = (typeof TILE_ERROR_CATEGORIES)[number];

// JSON error-envelope `code` vocabulary shared by api route handlers
// (`satisfies ApiErrorCode` at every emit site) and the web error mapping
// (web/src/lib/errorCopy.ts). Add codes here, never as bare literals on one
// side of the wire only.
export const API_ERROR_CODES = [
  'NEEDS_GOOGLE_KEY',
  'GOOGLE_AUTH_FAILED',
  'GOOGLE_UNAVAILABLE',
  'MODEL_OFFLINE',
  'QUEUE_FULL',
  'COUNT_EXCEEDS_POOL',
  'VIDEO_BUSY',
  // Motion-prompt enhancement is off (I2V_MOTION_ENHANCE). Client catches
  // the 409 and submits the raw motion prompt (best-effort) — no user-facing copy.
  'MOTION_ENHANCE_UNAVAILABLE',
  // A text-provider quota was exhausted before an SSE stream could open.
  // The envelope may carry retry_after_seconds.
  'QUOTA_EXHAUSTED',
  // The request carried the previous account's session scope (account switch
  // behind the edge). The web locks the session and reloads.
  'SESSION_CHANGED',
  // Text-model routing (409): no model is set up for the call, none that is
  // available accepts its images, or the image model's locked prompt writer
  // cannot serve it. The envelope's `error` carries the plain-English copy.
  'TEXT_MODEL_NOT_CONFIGURED',
  'TEXT_MODEL_NO_VISION',
  'TEXT_MODEL_UNAVAILABLE',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

// `error` discriminator of the BYOK keystore-recovery envelope (carried in
// `error`, not `code` — see routes/keys.ts).
export const RECOVERY_REQUIRED_ERROR = 'recovery_required';

// Field name carrying the QUEUE_FULL retry hint on 429 envelopes.
export const RETRY_AFTER_FIELD = 'retry_after_seconds';

// Per-account cache scope echoed by the api and pinned by the SPA on every
// request; a mismatch answers 409 SESSION_CHANGED.
export const SESSION_SCOPE_HEADER = 'X-Atelier-Session-Scope';

// Correlation id: the web sends one per request, the api echoes (or mints) it.
export const REQUEST_ID_HEADER = 'X-Request-Id';

// UTF-16 length caps on the `POST /api/_metrics` beacon fields. The api schema
// rejects longer values; the web truncates to them before sending.
export const METRICS_LIMITS = {
  vitalsId: 64,
  navigationType: 32,
  href: 2048,
  name: 256,
  message: 2048,
  stack: 1024,
  userAgent: 512,
} as const;

export type ByokProvider = 'google';

export interface ByokKeyStatus {
  present: boolean;
  /** 16 hex chars (8-byte HKDF-derived HMAC). Legacy rows saved before the
   *  width/key-separation change may still display 12 until re-saved —
   *  it is an opaque display aid, never compared. */
  fingerprint?: string;
  /** Epoch milliseconds. */
  updatedAt?: number;
}

// BYOK *business* errors only. A malformed request body (bad key shape) is
// NOT modelled here — it returns the generic `{ error: 'validation failed',
// issues }` envelope every route's body validation produces (see
// routes/_http.ts parseBody). Clients switch on `code`, never on `error`.
export interface ByokKeyError {
  error:
    | 'google rejected the key'
    | 'google unreachable'
    | 'byok-not-configured';
  code?: 'GOOGLE_AUTH_FAILED' | 'GOOGLE_UNAVAILABLE';
}

export interface ModelGate {
  requiresKey?: { provider: ByokProvider };
}

// ─── Public model registry ──────────────────────────────────────────────

/**
 * Wire-public projection of a registry entry. Adapter / provider names live
 * server-side only — the frontend sees `id` and chooses by it.
 */
export interface Model extends ModelGate {
  id: string;
  name: string;
  backend: Backend;
  /**
   * Free-form locator for the chip's tag. Cloud models carry a provider/region
   * hint ("google", "us-central1"); local models carry their host tag
   * ("comfyui"), which the client maps to a display name.
   */
  tag: string;
  latency: LatencyClass;
  /** Optional tooltip metadata such as "SDXL 1.0" or "9:16 max 2K". */
  size?: string;
  /** Per-model — composer's ratio chip filters from this. */
  supportedRatios: readonly Ratio[];
  /** Preferred initial ratio. The Composer resolves to it whenever the draft
   * carries no explicit ratio choice. Must be a member of `supportedRatios`. */
  defaultRatio?: Ratio;
  supportsReferenceImages?: boolean;
  /**
   * Server-defined upper bound on reference images per generation, when
   * `supportsReferenceImages` is true. Authoritative for the client's
   * composer cap; the server re-checks against the resolved registry entry.
   */
  maxRefImages?: number;
  /**
   * Effective raw on-disk reference-image byte budget for one generation
   * batch. Present when `supportsReferenceImages` is true; derived from the
   * frozen API config so client preflight matches route-side enforcement.
   */
  maxRefBytesPerBatch?: number;
  /**
   * Server-defined per-user concurrent tile cap that applies to this model.
   * Authoritative — the client reads this for display, never enforces it.
   * The server's per-pool semaphore is the only gate.
   */
  concurrencyCapPerUser: number;
  /**
   * Maximum tile count the server can ever acquire for one batch in this
   * model's pool. The Composer uses it to keep the count chip within a
   * dequeue-able range; the route still validates authoritatively.
   */
  maxCountPerBatch: number;
  /**
   * When true, the provider supports multi-image batch generation natively
   * (e.g. ComfyUI `batch_size`). The orchestrator issues a single
   * `generate(count=N)` call instead of N individual calls.
   */
  batched?: boolean;
  /**
   * Suggested initial count for batched models. The Composer snaps to this
   * value when the user selects a batched model that has a preferred count.
   */
  defaultCount?: number;
  /**
   * Clip lengths this model can render, in frames. Present only on video
   * models; the composer's duration chip filters from it and the server
   * re-validates the submitted value against this same set.
   */
  supportedDurations?: readonly VideoDurationFrames[];
  /**
   * Preferred initial clip length. The Composer resolves to it whenever the
   * draft carries no explicit duration. Must be a member of
   * `supportedDurations`.
   */
  defaultDuration?: VideoDurationFrames;
  /** True when this model animates a still image into a video artifact. */
  supportsI2V?: boolean;
  /**
   * True when this model's artifact is a video (mp4). Broader than
   * `supportsI2V`: a text-to-video model outputs video without requiring a
   * source still. Drives video loading chrome and the shared per-user
   * in-flight video cap.
   */
  outputsVideo?: boolean;
  /**
   * Which server-side semaphore charges this model. The client attributes its
   * own in-flight observations to the right pool when displaying counts.
   * Survives the `requiresKey` strip in `publicModelsForUser` — Composer
   * gating uses `requiresKey`, but pool identity is needed even after a key
   * is configured.
   */
  pool: Pool;
  /**
   * Server-declared prompt format this model is trained on. When set, the
   * client auto-formats the FINAL resolved prompt (post {{var}}/{{random}}/
   * ai-fill) through `/enhance-prompt` at the submit chokepoint before firing
   * `/api/generate`. Absent → prompts fire as-is.
   */
  promptFormat?: 'h3-motion';
  /**
   * Last known liveness of the upstream host. Populated only for entries the
   * server probes (currently `pool: 'local'`); omitted for entries we treat
   * as always-available (cloud + mock). When present and `ok: false`, the
   * Composer renders the chip disabled with the reason in the tooltip, and
   * `/api/generate` returns 503 if the user races a stale snapshot.
   */
  availability?: ModelAvailability;
}

/**
 * Closed vocabulary for `ModelAvailability.reason`. The only operational
 * categories the wire surface ever advertises. Free-form `err.message` is
 * intentionally NOT representable: the api sanitizes every raw probe error
 * into one of these before storing, mirroring the `/api/generate` 503
 * stripping in `api/src/routes/generate.ts` so `/api/models` cannot leak
 * upstream host:port either. Extending this union requires a code change on
 * BOTH the api (`api/src/lifecycle/health-probe.ts::sanitizeProbeReason`)
 * and the web client (the chip tooltip), which is the desired floor.
 */
export const MODEL_AVAILABILITY_REASONS = ['unavailable', 'timed out'] as const;
export type ModelAvailabilityReason = (typeof MODEL_AVAILABILITY_REASONS)[number];

export interface ModelAvailability {
  ok: boolean;
  /** Epoch ms — when the snapshot value was recorded. */
  checkedAt: number;
  /**
   * Operational category when `ok: false`; absent when `ok: true` and also
   * absent before the first probe round completes after boot. Closed union
   * so a future addition forces an api + web change in lockstep.
   */
  reason?: ModelAvailabilityReason;
}

// ─── Tile (public) ──────────────────────────────────────────────────────

export type TileStatus = Tile['status'];

export type Tile = TileWire;
/** A finished tile: the only kind that can be opened, downloaded or handed off. */
export type DoneTile = Extract<Tile, { status: 'done' }>;

// ─── Batch (public) ─────────────────────────────────────────────────────

/**
 * Public batch shape. NOTE: `userId` is intentionally absent — that's a
 * DB-internal scope key (api/src/db/types.ts). Re-exporting it through this
 * package would leak server auth state to the frontend.
 */
export type Batch = BatchWire;

export type VideoSequenceMasterStatus = VideoSequenceSummary['masterStatus'];

// ─── AI Storytelling (public) ───────────────────────────────────────────

/**
 * Persisted story lifecycle. 'planning' never reaches the DB or the wire —
 * the plan happens inside POST /api/stories, and a failed plan leaves no row.
 * Stitching progress is the sequence's masterStatus, not story state.
 */
export type StoryStatus = StorySummary['status'];

/** Plan-time shape of one story segment (also the POST /api/stories `plan` frame). */
export interface StorySegmentPlan {
  readonly beat: string;
  readonly durationFrames: VideoDurationFrames;
}

/** Per-batch story decoration riding history payloads (mirrors `sequence`). */
export type StorySummary = StorySummaryWire;

export type StoryPlanSseEvent =
  | { event: 'status'; data: { phase: 'planning' } }
  | {
      event: 'plan';
      data: {
        storyId: string;
        logline: string;
        segments: readonly StorySegmentPlan[];
        etaMs: number;
      };
    }
  | { event: 'error'; data: { message: string; code?: string } };

// ─── Ephemera character cards (public) ─────────────────────────────────

/** `GET /api/ephemera` body; the route is a leak-safe 404 when disabled. */
export interface EphemeraStatus {
  origin: string;
  /** The server's character-card SSE lifetime (`EPHEMERA_CARD_TIMEOUT_MS`). */
  timeoutMs: number;
}

/**
 * Terminal error codes of `POST /api/tiles/:tileId/character-card`. The
 * mapping from Ephemera outcomes lives in api/src/providers/ephemera/client.ts.
 */
export const CHARACTER_CARD_ERROR_CODES = [
  'ephemera-forbidden',
  'ephemera-busy',
  'ephemera-unavailable',
  'unsupported-image',
  'no-model',
  'text-only-model',
  'too-large',
  'invalid-card',
  'provider-error',
  'timeout',
  'storage-sealed',
  'image-unavailable',
  'card-failed',
] as const;
export type CharacterCardErrorCode = (typeof CHARACTER_CARD_ERROR_CODES)[number];

/**
 * Longest optional steering text for a character card, forwarded to Ephemera
 * as `direction`. Mirrors Ephemera's `CREATOR_LIMITS.imageCardDirectionLength`.
 */
export const CHARACTER_CARD_DIRECTION_MAX_CHARS = 2000;

/**
 * Kinds of character card Ephemera can write from an image, sent verbatim as
 * its `kind` field: one person, two or three people, or a world with its
 * narrator and cast. Mirrors Ephemera's `creatorKindSchema`
 * (packages/core/src/creator/schema.ts there).
 */
export const CHARACTER_CARD_KINDS = ['subject', 'group', 'scenario'] as const;
export type CharacterCardKind = (typeof CHARACTER_CARD_KINDS)[number];

export type CharacterCardPhase = 'reading' | 'writing' | 'rewriting' | 'saving';

export type CharacterCardSseEvent =
  | { event: 'status'; data: { phase: CharacterCardPhase } }
  | { event: 'result'; data: { characterId: string; name: string; url: string } }
  | { event: 'error'; data: SseTerminalError };

/** Planner segment-count ceiling; deliberately below MAX_SEQUENCE_SEGMENTS. */
export const STORY_MAX_SEGMENTS = 6;
export const STORY_MIN_SEGMENTS = 2;
export const STORY_OUTLINE_MAX_CHARS = 4000;

export type VideoSequenceSummary = VideoSequenceSummaryWire;

// ─── Collections (public) ──────────────────────────────────────────────

// Collection metadata exposed to the frontend. userId is server-internal and
// never re-exported here (mirrors Batch / Tile).
export interface Collection {
  readonly id: string;
  readonly name: string;
  /** Batches in this collection; server-computed and excludes archived. */
  readonly count: number;
  /**
   * Archived **tiles** (not batches) currently surfaced in the Archive view
   * whose parent batch belongs to this collection. Mirrors the visibility
   * predicate of `/api/archive` (done/ext/mime/completed_at) so a row's count
   * matches what the Archive view actually shows.
   */
  readonly archivedCount: number;
  readonly createdAt: number;
}

// Global rail counters returned alongside the collections list so the rail can
// render conditional rows without scanning paginated history. `*Count` fields
// are batch-grain over non-archived rows; `archived*Count` are **tile-grain**
// over the Archive view's visibility predicate, so rail counts agree with the
// scoped feed even when archive state is partial (some tiles archived, others
// still live).
export interface LibrarySummary {
  readonly totalCount: number;
  readonly pinnedCount: number;
  readonly unsortedCount: number;
  readonly archivedTotalCount: number;
  readonly archivedPinnedCount: number;
  readonly archivedUnsortedCount: number;
}

export interface CollectionsResponse {
  readonly items: readonly Collection[];
  readonly summary: LibrarySummary;
}

// ─── Prompt library (public) ────────────────────────────────────────────

export type VariableOption = VariableOptionWire;
export type VariableList = VariableListWire;
export type DimensionTag = DimensionTagWire;
export type TagDimension = TagDimensionWire;
export type PromptTemplate = PromptTemplateWire;
export type PromptLibraryResponse = PromptLibraryResponseWire;

// Library coherence diagnosis (deterministic SAT, no LLM).
//
// Response of POST /api/prompts/library-diagnosis. Computed by running
// templateSatisfiable over the live library with zero proposed bundles —
// any template flagged here is structurally broken right now in prod.

export interface ConflictingPair {
  readonly listA: string;
  readonly listB: string;
  readonly dimensionName: string;
}

export interface LibraryDiagnosisEntry {
  readonly templateName: string;
  /** null means the bounded solver could not establish a verdict. */
  readonly satisfiable: boolean | null;
  readonly reason?: string;
  readonly conflictingPairs?: readonly ConflictingPair[];
}

export const DIAGNOSIS_VERSION_HEADER = 'X-Atelier-Diagnosis-Version';
export const DIAGNOSIS_VERSION = '2';

export interface LibraryDiagnosisResponse {
  readonly templates: readonly LibraryDiagnosisEntry[];
  readonly librarySnapshotHash: string;
  readonly templatesDigest: string;
  /** Legacy boolean-only responses name every omitted inconclusive template. */
  readonly incompleteTemplateNames?: readonly string[];
}

export interface CoverageUntaggedGroup {
  readonly listId: string;
  readonly listName: string;
  readonly dim: string;
  readonly untaggedCount: number;
}

export interface CoverageLowList {
  readonly listName: string;
  readonly dim: string;
  readonly coverage: number;
  readonly taggedCount: number;
  readonly totalCount: number;
}

export interface CoverageOrphanTag {
  readonly dim: string;
  readonly label: string;
}

export interface CoverageMissingDimension {
  readonly listName: string;
  readonly dim: string;
}

export interface LibraryCoverageResponse {
  readonly untaggedByList: readonly CoverageUntaggedGroup[];
  readonly lowCoverageLists: readonly CoverageLowList[];
  readonly orphanTags: readonly CoverageOrphanTag[];
  readonly missingDimensions: readonly CoverageMissingDimension[];
  readonly librarySnapshotHash: string;
  readonly templatesDigest: string;
}

// ─── Pagination ─────────────────────────────────────────────────────────

/**
 * Opaque cursor pagination. Cursor is server-encoded (createdAt + batchId);
 * clients pass it back verbatim via `?cursor=`.
 */
export interface HistoryPage<T> {
  items: readonly T[];
  nextCursor: string | null;
}

// ─── Archive (public) ──────────────────────────────────────────────────

export interface ArchivedTile {
  id: string;
  batchId: string;
  prompt: string;
  modelLabel: string;
  seed: number;
  status: 'done';
  refImageIds?: readonly string[];
  url: string;
  thumbUrl?: string;
  ext: MediaExt;
  mime: MediaMime;
  ratio: Ratio;
  completedAt: number;
  archivedAt: number;
}

export interface ArchivePage {
  items: readonly ArchivedTile[];
  nextCursor: string | null;
  // Total archived done tiles for the current scope filter (collectionId /
  // pinned), regardless of pagination. Present (a number) ONLY on the first
  // page (request without a cursor); `null` on every subsequent page so the
  // server skips a redundant COUNT(*) per scroll. The client carries the
  // freshest non-null value forward (see web useArchiveQuery).
  total: number | null;
}

// ─── Generate request (client → server) ─────────────────────────────────

export interface GenerateRequest {
  prompt: string;
  modelId: string;
  ratio: Ratio;
  /** Tile count: 1..MAX_TILE_COUNT (validated server-side). */
  count: number;
  /** Optional non-negative integer seed. */
  seed?: number;
  refImageIds?: readonly string[];
  i2vSourceUploadId?: string;
  extendsTileId?: string;
  motionPrompt?: string;
  /**
   * Clip length in frames for video models. Omitted means the model's
   * `defaultDuration`; the server validates membership in the resolved
   * model's `supportedDurations` and ignores it for non-video models.
   */
  durationFrames?: VideoDurationFrames;
  /** Optional prompt-library provenance captured at submit time from the picker. */
  provenance?: {
    readonly templateId: string;
    readonly rollSeed: number;
    readonly pins: Readonly<Record<string, string>>;
  };
  /**
   * Identity of one logical roll per user (1..64 chars), not a payload
   * fingerprint: a retried roll may carry a new seed under the same key.
   * When the key already names one of the caller's batches, the server
   * answers 200 with that batch (`replayed: true`) and creates nothing.
   * Omitted means a fresh submission.
   */
  idempotencyKey?: string;
}

export interface GenerateResponse {
  batchId: string;
  tiles: readonly BatchTileDescriptor[];
  /**
   * Creation (201) answers only `queued` or `running`; an idempotent replay
   * (200) reports the batch's current status, which may be `done`.
   */
  status: BatchStatus;
  pool: Pool;
  /** Projected dispatch position (0 = next). Not monotonic: on the local pool it can rise when later same-model work is scheduled ahead. */
  queueLengthAhead?: number;
  refImageIds?: readonly string[];
  /**
   * Present only on an idempotent replay (HTTP 200): the batch already
   * existed and was rebuilt from server rows, so the request's prompt,
   * model or ratio may not describe it.
   */
  replayed?: true;
}

// ─── SSE events (server → client) ───────────────────────────────────────
//
// Wire shape MUST match docs/architecture.md § Generate stream contract.
// Every event lands as the `data` payload of a named SSE frame:
//   event: batch | tile | done

/**
 * Per-tile descriptor inside the initial `batch` event. `tileIndex` is the
 * grid display order; `tileId` is the persistence key used for downstream
 * DELETE / GET /api/img/* calls.
 */
export interface BatchTileDescriptor {
  tileId: string;
  tileIndex: number;
  seed: number;
}

export interface BatchEvent {
  batchId: string;
  /**
   * Server-authoritative createdAt in ms. The client uses this for the
   * optimistic batch's createdAt so the cache stays in canonical
   * `created_at DESC` order — without it, an SSE arrival order that
   * diverges from server creation order causes a visible reorder when
   * any refetch lands.
   */
  createdAt: number;
  /** Dispatch time, present once the batch is running (see Batch.startedAt). */
  startedAt?: number;
  status?: BatchStatus;
  /** Projected dispatch position (0 = next). Not monotonic: on the local pool it can rise when later same-model work is scheduled ahead. */
  queueLengthAhead?: number;
  tiles: readonly BatchTileDescriptor[];
  refImageIds?: readonly string[];
}

export interface QueueEvent {
  batchId: string;
  status: 'running';
  /** Dispatch time (see Batch.startedAt). */
  startedAt?: number;
}

export interface UploadRef {
  id: string;
  mime: TileMime;
  ext: TileExt;
  sizeBytes: number;
  width: number;
  height: number;
  createdAt: number;
}

interface TileEventDoneShape {
  tileId: string;
  tileIndex: number;
  status: 'done';
  url: string;
  thumbUrl?: string;
  ext: MediaExt;
  mime: MediaMime;
  completedAt: number;
}

interface TileEventFailedShape {
  tileId: string;
  tileIndex: number;
  status: 'failed';
  error: TileErrorCategory;
  moderation?: GptModerationNotice;
  completedAt: number;
}

interface TileEventPartialShape {
  tileId: string;
  tileIndex: number;
  status: 'partial';
  /** `data:` URL of the in-flight preview frame. */
  preview: string;
  /** Monotonic ordinal of this partial within the tile (cliproxy `partial_image_index`). */
  index: number;
}

interface TileEventProgressShape {
  tileId: string;
  tileIndex: number;
  status: 'progress';
  progress: number;
  phase?: string;
}

interface TileEventCanceledShape {
  tileId: string;
  tileIndex: number;
  status: 'canceled';
  completedAt: number;
}

/**
 * Emitted as the tile progresses. `partial` may fire 0..N times (based on
 * `partial_images` request param + upstream behavior); the tile finally
 * reaches a terminal state with one `done`, `failed`, or `canceled`. Consumers MUST
 * tolerate a tile that never sees a `partial` (when upstream skips them or
 * `partial_images=0`) and MUST treat a later terminal event as authoritative
 * over any preview already shown. `canceled` is wire-only and is never
 * persisted in the public Tile union.
 */
export type TileEvent =
  | TileEventDoneShape
  | TileEventFailedShape
  | TileEventPartialShape
  | TileEventProgressShape
  | TileEventCanceledShape;

export interface DoneEvent {
  batchId: string;
}

export interface MotionEnhanceExtendContext {
  /** Final enhanced motion prompt from the preceding sequence segment. */
  previousMotionPrompt: string;
  /** Server-owned upload containing that segment's final handoff frame. */
  handoffUploadId: string;
}

export interface EnhancePromptRequest {
  prompt: string;
  refImageIds?: readonly string[];
  /**
   * Selected composer model. The server picks a model-specific enhance
   * system prompt when the target model declares one; omitted/unknown ids
   * fall back to the generic enhance prompt.
   */
  modelId?: string;
  /** Selected composer ratio. */
  ratio?: Ratio;
  /**
   * Selected clip length in frames, forwarded only for the 'h3-motion' format
   * so the motion enhancer paces the beats — and any spoken line — to the
   * clip the user actually chose.
   */
  durationFrames?: VideoDurationFrames;
  /**
   * Source still's original generation prompt, forwarded only for the
   * 'h3-motion' format so the motion enhancer can anchor subject identity.
   * Client-only context — never persisted, never on GenerateRequest.
   */
  sourcePrompt?: string;
  /** Continuation context used only by the 'h3-motion' format. */
  extendContext?: MotionEnhanceExtendContext;
}

export type EnhanceSseEvent =
  | { event: 'delta'; data: { text: string } }
  | { event: 'done'; data: Record<string, never> }
  | { event: 'error'; data: { message: string } };

// {{ai-fill}} resolution request. The client masks the ai-fill tokens, resolves
// the surrounding {{var}}/{{random}} grammar, and sends the RESOLVED static
// segments + the (separately resolved) instructions; the server fills the blanks
// and splices. Parser/assembler live behind the `@atelier/shared/ai-fill` subpath
// (mirrors `./template-tokens`); this is the wire-type half.
export interface AiFillRequest {
  readonly staticSegments: readonly string[];
  readonly instructions: readonly string[];
  readonly modelId: string;
  // Set only by the Prompt Library "Simulate" preview. Both paths use Kimi K3
  // at low reasoning effort.
  readonly simulate?: boolean;
}

export interface AiFillBatchItem {
  readonly staticSegments: readonly string[];
  readonly instructions: readonly string[];
}

export interface AiFillBatchRequest {
  readonly items: readonly AiFillBatchItem[];
  readonly modelId: string;
}

// Not tagged `@deprecated`: the no-deprecated lint rule would fail every
// current consumer until the legacy route is removed.
/**
 * Text-backend wire keys. Keys name the VENDOR + TIER, never a version, so a
 * future swap within a tier does not require another rename. Every key is
 * served through the configured OpenAI-compatible upstream, each with a
 * configurable model id: 'kimi' = Kimi K3, 'mimo' = MiMo V2.6 Pro,
 * 'grok' = Grok 4.7, 'gemini-argon' = Gemini 4 Argon, 'deepseek-abliterated'
 * = DeepSeek V4.1 Flash Abliterated and 'glm-abliterated' = GLM 5.3, a
 * text-only model (the key predates its move off an abliterated build); 'gpt' = GPT-6.1 Sol for cloud image
 * targets. Only 'kimi' and 'gpt' are automatic targets; every
 * other backend is user-selectable only.
 * Purely advisory leading frame naming which backend holds the fill: a client
 * that ignores it gets the same terminal outcome.
 * Legacy: replaced by admin-managed text providers and models (`TEXT_TASKS`, `PublicTextModel`); removed with the legacy settings route.
 */
export const AI_FILL_BACKEND_VALUES = [
  'kimi',
  'mimo',
  'grok',
  'gemini-argon',
  'deepseek-abliterated',
  'glm-abliterated',
  'gpt',
] as const;
/** Legacy: replaced by admin-managed text providers and models (`TEXT_TASKS`, `PublicTextModel`); removed with the legacy settings route. */
export type AiFillBackend = (typeof AI_FILL_BACKEND_VALUES)[number];

/**
 * Backends Atelier will hand an image to. Per the model-capability policy every
 * natively multimodal backend belongs here, and each was verified end to end
 * through the upstream before being added — a backend listed without that check
 * would silently drop the image rather than fail. Kimi K3, MiMo V2.6 Pro,
 * Grok 4.7 and Gemini 4 Argon each read a base64 PNG image part under strict
 * `json_schema` (streaming) and `json_object` (non-streaming). GPT-6.1 Sol
 * read image parts with strict schema, medium reasoning and both streaming and
 * non-streaming responses.
 * GLM 5.3 ('glm-abliterated') is text-only: the upstream publishes
 * no image input for it and answers an image part with HTTP 400
 * `image_input_not_supported`.
 * 'deepseek-abliterated' is documented with text plus up to 4 images, but its
 * vision path is unverified, so it stays out until a live check passes; when
 * it is added, cap its images at 4.
 * Legacy: replaced by admin-managed text providers and models (`TEXT_TASKS`, `PublicTextModel`); removed with the legacy settings route.
 */
export function isVisionTextBackend(
  backend: string,
): backend is Extract<AiFillBackend, 'kimi' | 'mimo' | 'grok' | 'gemini-argon' | 'gpt'> {
  return backend === 'kimi'
    || backend === 'mimo'
    || backend === 'grok'
    || backend === 'gemini-argon'
    || backend === 'gpt';
}

/**
 * Does this backend take the generic ai-fill prompt body rather than the
 * Kimi-tuned one? True for every non-Kimi backend. This is INDEPENDENT of
 * vision — whether the call carries an image is `isVisionTextBackend` — and it
 * selects wording only: no backend receives instructions to disregard its own
 * safety judgement.
 * Legacy: replaced by admin-managed text providers and models (`TEXT_TASKS`, `PublicTextModel`); removed with the legacy settings route.
 */
export function usesGenericPromptVariant(
  backend: string,
): backend is Exclude<AiFillBackend, 'kimi'> {
  return backend !== 'kimi' && (AI_FILL_BACKEND_VALUES as readonly string[]).includes(backend);
}

/**
 * Canonical display labels for the text-backend union. Single source of truth for web copy.
 * Legacy: replaced by admin-managed text providers and models (`TEXT_TASKS`, `PublicTextModel`); removed with the legacy settings route.
 */
export const TEXT_BACKEND_LABELS = {
  kimi: 'Kimi K3',
  mimo: 'MiMo V2.6 Pro',
  grok: 'Grok 4.7',
  'gemini-argon': 'Gemini 4 Argon',
  'deepseek-abliterated': 'DeepSeek V4.1 Flash Abliterated',
  'glm-abliterated': 'GLM 5.3',
  gpt: 'GPT-6.1 Sol',
} as const satisfies Record<AiFillBackend, string>;

/**
 * Workloads a user may pin to a fixed text backend. Absent override = automatic routing.
 * Legacy: replaced by admin-managed text providers and models (`TEXT_TASKS`, `PublicTextModel`); removed with the legacy settings route.
 */
export const TEXT_BACKEND_WORKLOADS = [
  'ai-fill',
  'brainstorm',
  'enhance',
  'condense',
  'storytelling',
] as const;
/** Legacy: replaced by admin-managed text providers and models (`TEXT_TASKS`, `PublicTextModel`); removed with the legacy settings route. */
export type TextBackendWorkload = (typeof TEXT_BACKEND_WORKLOADS)[number];

/**
 * Absent key = automatic routing (the shipped default).
 * Legacy: replaced by admin-managed text providers and models (`TEXT_TASKS`, `PublicTextModel`); removed with the legacy settings route.
 */
export type TextBackendOverrides = Partial<Record<TextBackendWorkload, AiFillBackend>>;

/** Wire values of the OpenAI-compatible `reasoning_effort` ladder, lowest first. */
export const TEXT_REASONING_EFFORT_VALUES = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type TextReasoningEffort = (typeof TEXT_REASONING_EFFORT_VALUES)[number];

export const TEXT_REASONING_EFFORT_LABELS = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
} as const satisfies Record<TextReasoningEffort, string>;

const TEXT_BACKEND_REASONING_EFFORTS = {
  // Catalog `reasoning_efforts` the upstream forwards.
  // The proxy silently remaps an unlisted level (MiMo 'low' -> 'high'), so only
  // listed levels are offered.
  kimi: ['low', 'high', 'max'],
  mimo: ['none', 'high'],
  grok: ['low', 'medium', 'high', 'xhigh'],
  'gemini-argon': ['low', 'medium', 'high'],
  'deepseek-abliterated': TEXT_REASONING_EFFORT_VALUES,
  // GLM 5.3 always thinks and publishes exactly low/high/max; 'none' still
  // reasons, so it is not offered.
  'glm-abliterated': ['low', 'high', 'max'],
  // GPT's effort stays pinned for its fixed cloud-image text work.
  gpt: [],
} as const satisfies Record<AiFillBackend, readonly TextReasoningEffort[]>;

/**
 * Efforts a user may pin on each backend's settings row: the levels each
 * model lists in its catalog and the upstream forwards. Single source for the route validator, the stored-value
 * reader and the Settings options.
 * Legacy: replaced by admin-managed text providers and models (`TEXT_TASKS`, `PublicTextModel`); removed with the legacy settings route.
 */
export function textBackendReasoningEfforts(backend: AiFillBackend): readonly TextReasoningEffort[] {
  return TEXT_BACKEND_REASONING_EFFORTS[backend];
}

/**
 * Pinned reasoning effort per workload. Absent key = the backend's own default.
 * An effort belongs to its workload's pinned backend and is only present with one.
 * Legacy: replaced by admin-managed text providers and models (`TEXT_TASKS`, `PublicTextModel`); removed with the legacy settings route.
 */
export type TextBackendEfforts = Partial<Record<TextBackendWorkload, TextReasoningEffort>>;

/** Legacy: replaced by admin-managed text providers and models (`TEXT_TASKS`, `PublicTextModel`); removed with the legacy settings route. */
export interface TextBackendSettingsResponse {
  readonly overrides: TextBackendOverrides;
  readonly efforts: TextBackendEfforts;
  /**
   * Backends whose model CLIProxyAPI's live inventory does not currently serve;
   * a stored pin to one routes as Auto. Empty when the proxy inventory is unknown.
   */
  readonly unavailable: readonly AiFillBackend[];
}

// ─── Admin-managed text providers and models ────────────────────────────
// Replaces the fixed text-backend keys above. Wire contract: spec
// docs/specs/byo-text-providers.md § 10. Credentials never appear here: the
// browser sees only the auth mode, a fingerprint and an env var name.

export { TEXT_PRESETS } from './textPresets';
export type { TextPreset, TextPresetId } from './textPresets';
export { validateTextProviderBaseUrl } from './textProviderUrl';
export type { TextProviderBaseUrlResult } from './textProviderUrl';

/**
 * Features that call a text model. Single source for the routing DB CHECK, the
 * per-task user picks and the admin task assignments.
 */
export const TEXT_TASKS = [
  'enhance',
  'motion',
  'ai-fill',
  'brainstorm',
  'condense',
  'storytelling',
  'story-segments',
  'infer',
  'rescue',
  'list-draft',
  'template-draft',
] as const;
export type TextTask = (typeof TEXT_TASKS)[number];

export const TEXT_TASK_LABELS = {
  enhance: 'Enhance',
  motion: 'Motion writer',
  'ai-fill': 'AI fill',
  brainstorm: 'Brainstorm',
  condense: 'Krea condense',
  storytelling: 'Story planner',
  'story-segments': 'Story segments',
  infer: 'Dimension inference',
  rescue: 'Dimension rescue',
  'list-draft': 'List drafts',
  'template-draft': 'Template drafts',
} as const satisfies Record<TextTask, string>;

/** How Atelier talks to a provider. */
export const TEXT_PROTOCOLS = ['openai-compatible', 'anthropic'] as const;
export type TextProtocol = (typeof TEXT_PROTOCOLS)[number];

/** Request field carrying the output budget; OpenAI-compatible providers only. */
export const TEXT_TOKEN_FIELDS = ['max_completion_tokens', 'max_tokens'] as const;
export type TextTokenField = (typeof TEXT_TOKEN_FIELDS)[number];

/** Where a provider's credential comes from. 'env' is set only by the migration/seed. */
export const TEXT_PROVIDER_AUTH_MODES = ['none', 'stored', 'env'] as const;
export type TextProviderAuthMode = (typeof TEXT_PROVIDER_AUTH_MODES)[number];

/** JSON output mode a model supports, strongest first. */
export const TEXT_STRUCTURED_OUTPUT_MODES = ['json_schema', 'json_object', 'none'] as const;
export type TextStructuredOutputMode = (typeof TEXT_STRUCTURED_OUTPUT_MODES)[number];

/** 'slow' applies the long timeout and response-size floors. */
export const TEXT_LATENCY_PROFILES = ['standard', 'slow'] as const;
export type TextLatencyProfile = (typeof TEXT_LATENCY_PROFILES)[number];

/** Which ai-fill prompt body a model receives. Wording only. */
export const TEXT_PROMPT_VARIANTS = ['generic', 'kimi'] as const;
export type TextPromptVariant = (typeof TEXT_PROMPT_VARIANTS)[number];

/** Whether the provider currently lists the model. 'unknown' passes routing. */
export type TextModelStatus = 'available' | 'offline' | 'unknown';

/** Admin-editable capability settings of one model. */
export interface TextModelCapabilities {
  readonly vision: boolean;
  /** Cap on image parts per call; null = no cap. Only meaningful with vision. */
  readonly maxImages: number | null;
  readonly structuredOutput: TextStructuredOutputMode;
  /** Levels users may pick. Empty = users cannot pick one. */
  readonly reasoningLevels: readonly TextReasoningEffort[];
  /** Sent when the user picked nothing; null = no effort field. */
  readonly reasoningDefault: TextReasoningEffort | null;
  readonly temperature: number | null;
  readonly topP: number | null;
  /** Replaces every per-task output budget when set. */
  readonly fixedOutputTokens: number | null;
  readonly latencyProfile: TextLatencyProfile;
  readonly promptVariant: TextPromptVariant;
}

/** A model as every signed-in user sees it. */
export interface PublicTextModel {
  readonly id: string;
  readonly displayName: string;
  readonly providerName: string;
  readonly vision: boolean;
  readonly reasoningLevels: readonly TextReasoningEffort[];
  readonly status: TextModelStatus;
}

/** One task row of the user's text-model settings. */
export interface TaskRow {
  readonly task: TextTask;
  /** The user's own pick (model id). */
  readonly pick?: string;
  readonly effort?: TextReasoningEffort;
  /** Model the task would use right now, after every fallback. */
  readonly effectiveModelId?: string;
  /** 'offline' = the pick is skipped and the task falls back. */
  readonly pickState?: 'active' | 'offline';
}

/** `GET /api/text-models` and `PUT /api/text-models/tasks/:task`. */
export interface TextModelsResponse {
  readonly models: readonly PublicTextModel[];
  readonly tasks: readonly TaskRow[];
  readonly defaults: {
    readonly default?: string;
    readonly byTask: Partial<Record<TextTask, string>>;
  };
  /** Image model id → prompt-writer model id. */
  readonly writers: Readonly<Record<string, string>>;
}

/** How a prompt writer applies: 'lock' always, 'prefer' unless the person picked their own. */
export type TextWriterMode = 'lock' | 'prefer';

/** Admin `GET /api/text-routing` and the answer to every routing PUT. */
export interface TextRoutingResponse {
  readonly defaults: TextModelsResponse['defaults'];
  /** Image model id → prompt writer. */
  readonly writers: Readonly<Record<string, { readonly modelId: string; readonly mode: TextWriterMode }>>;
  /** Registered image models a writer can be set for. */
  readonly imageModels: readonly { readonly id: string; readonly label: string }[];
}

/** Where a model is referenced; shown before a delete is confirmed. */
export interface TextModelUsage {
  readonly isDefault: boolean;
  readonly tasks: readonly TextTask[];
  /** Image model ids whose prompts this model writes. */
  readonly writers: readonly string[];
  /** Number of users who picked this model for at least one task. */
  readonly userPicks: number;
}

export interface AdminModel extends TextModelCapabilities {
  readonly id: string;
  readonly providerId: string;
  /** Upstream model id. */
  readonly modelId: string;
  readonly displayName: string;
  readonly enabled: boolean;
  /** Run the content pre-check before every request to this model. */
  readonly screenRequests: boolean;
  readonly sortOrder: number;
  readonly status: TextModelStatus;
  /** Epoch ms of the last passing "Test model"; null = untested. */
  readonly verifiedAt: number | null;
  readonly lastTest: TestReport | null;
  readonly usage: TextModelUsage;
}

export type TextProviderWarning =
  /** A model screens requests but OPENROUTER_API_KEY is unset. */
  | 'screen-requests-without-key'
  /** Stored keys cannot be read or written without BYOK_ENCRYPTION_KEY. */
  | 'byok-not-configured';

export interface AdminProvider {
  readonly id: string;
  readonly name: string;
  readonly protocol: TextProtocol;
  readonly baseUrl: string;
  /** Preset used at creation; informational. */
  readonly preset: string | null;
  readonly auth: TextProviderAuthMode;
  /** Present when auth is 'stored'. */
  readonly fingerprint?: string;
  /** Present when auth is 'env'. */
  readonly envVar?: string;
  readonly tokenField: TextTokenField;
  readonly listModels: boolean;
  readonly enabled: boolean;
  /** Models the last list call returned; null = unknown (not listed, failed or empty). */
  readonly listedCount: number | null;
  readonly warnings: readonly TextProviderWarning[];
  readonly models: readonly AdminModel[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Capability hints a provider's model list reported. Unverified. */
export interface TextModelHints {
  readonly vision?: boolean;
  readonly structuredOutput?: TextStructuredOutputMode;
  readonly reasoningLevels?: readonly TextReasoningEffort[];
  readonly contextLength?: number;
  readonly maxOutputTokens?: number;
}

/** One entry of `GET /api/text-providers/:id/models/available`. */
export interface ListedModel {
  readonly id: string;
  readonly hints?: TextModelHints;
  readonly source: 'provider';
}

export interface TextProbeCheck {
  readonly id: string;
  readonly status: 'pass' | 'fail' | 'skip';
  /** Plain-English result, already redacted. */
  readonly message: string;
}

/** `POST /api/text-providers/test`. */
export interface TextProviderConnectionTestRequest {
  readonly protocol: TextProtocol;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly listModels?: boolean;
  /** Model to send the probe to; required when `listModels` is false. */
  readonly probeModelId?: string;
}

/** Verdict of a provider connection test. */
export interface ConnectionReport {
  readonly ok: boolean;
  readonly checks: readonly TextProbeCheck[];
  readonly listedCount?: number;
  readonly listUnsupported?: boolean;
}

/** Result of "Test model". */
export interface TestReport {
  readonly checks: readonly TextProbeCheck[];
  /** Values the probe confirmed. */
  readonly proposed: Partial<TextModelCapabilities>;
  /** Values the provider's list reported that the probe did not exercise. */
  readonly advertised: Partial<TextModelCapabilities>;
  readonly wireNotes: readonly string[];
}

/** Inclusive bounds for a per-model base-sampler step override (API, DB CHECK, UI). */
export const MODEL_STEPS_MIN = 1;
export const MODEL_STEPS_MAX = 100;

export interface ModelStepsSetting {
  readonly modelId: string;
  readonly name: string;
  /** The model's configured base-sampler step count. */
  readonly defaultSteps: number;
  /** The user's override, or null when the default applies. */
  readonly steps: number | null;
}

export interface ModelStepsSettingsResponse {
  readonly models: readonly ModelStepsSetting[];
  readonly min: number;
  readonly max: number;
}

export interface ModelStepsPutRequest {
  /** null (or the default value) resets to the model's default. */
  readonly steps: number | null;
}

/**
 * Advisory leading ai-fill frame naming the text model serving the fill.
 * `backend` is the migrated row's legacy key, present only for the seven
 * migrated models while the web still reads it.
 */
export interface AiFillBackendFrame {
  readonly modelId: string;
  readonly label: string;
  readonly backend?: AiFillBackend;
}

export type AiFillSseEvent =
  | { event: 'backend'; data: AiFillBackendFrame }
  | { event: 'result'; data: { prompt: string; fills: readonly string[] } }
  | { event: 'error'; data: { message: string; code?: string } };

export type AiFillBatchSseEvent =
  | { event: 'backend'; data: AiFillBackendFrame }
  | {
      event: 'result';
      data: {
        items: readonly (
          | { readonly ok: true; readonly prompt: string; readonly fills: readonly string[] }
          | { readonly ok: false }
        )[];
      };
    }
  | { event: 'error'; data: { message: string; code?: string } };

// Brainstorm Characters — auto-generated character-idea image prompts.
// Count bounds are shared so api clamp and web slider agree. The api also
// reads an env BRAINSTORM_MAX_COUNT (operator override) that must be <= the
// ceiling below; the ceiling is the absolute UI/wire cap.
export const BRAINSTORM_MIN_COUNT = 1;
export const BRAINSTORM_DEFAULT_COUNT = 12;
export const BRAINSTORM_MAX_COUNT_CEILING = 30;
export const BRAINSTORM_VARIATION_SEED_MAX = 0xffff_ffff;

export const BRAINSTORM_LAYOUTS = ['single', 'diptych'] as const;
export type BrainstormLayout = (typeof BRAINSTORM_LAYOUTS)[number];

/** Media a caller may pin. Omitted = the brief decides (photo by default, illustration when asked). */
export const BRAINSTORM_MEDIA = ['photograph'] as const;
export type BrainstormMedium = (typeof BRAINSTORM_MEDIA)[number];

/** Text backends a brainstorm caller may pin. Omitted = routed by image-model family. */
export const BRAINSTORM_TEXT_BACKENDS = AI_FILL_BACKEND_VALUES satisfies readonly AiFillBackend[];
export type BrainstormTextBackend = (typeof BRAINSTORM_TEXT_BACKENDS)[number];

export interface BrainstormCharactersRequest {
  /** Optional steering brief (theme / era / setting). Empty = max variety. */
  readonly brief?: string;
  /** Number of character prompts to generate. Clamped server-side. */
  readonly count: number;
  /** Panel layout. 'diptych' = one image, two panels: front view and rear view. Default 'single'. */
  readonly layout?: BrainstormLayout;
  /** 'photograph' forces every concept to be a real-life photo regardless of the brief. */
  readonly medium?: BrainstormMedium;
  /** Target image model id — tunes phrasing; the composer renders against it. */
  readonly modelId: string;
  /**
   * Pin the writing model by text model row id (an enabled model). A locked
   * prompt writer for the image model still wins. Omitted = routed.
   */
  readonly textModelId?: string;
  /** Legacy pin by migrated backend key; maps to the row with that legacy key. Prefer `textModelId`. */
  readonly textBackend?: BrainstormTextBackend;
  /** Optional 32-bit entropy source for a meaningfully different take of the same brief. */
  readonly variationSeed?: number;
}

export type BrainstormSseEvent =
  | { event: 'prompt'; data: { index: number; text: string } }
  | { event: 'done'; data: { count: number } }
  | { event: 'error'; data: { message: string } };

export interface DraftVariableListRequest {
  readonly modelId?: string;
  name: string;
  existing: string[];
  description?: string;
}

export type DraftVariableListResponse =
  | { kind: 'entries'; entries: string[] }
  | { kind: 'clarify'; question: string };

export interface DraftTemplateRequest {
  readonly modelId?: string;
  /** Template name. */
  name: string;
  /** body.trim() — empty string when raw body is empty or whitespace-only. */
  existingBody: string;
  /** Present on the seed-prompt first call AND on clarify follow-ups; omitted otherwise. */
  description?: string;
}

export type DraftTemplateResponse =
  | { kind: 'body'; body: string; warnings: readonly string[] }
  | { kind: 'clarify'; question: string };

export interface BundleCommon {
  readonly key: string;
  readonly title: string;
  readonly detail: string;
  readonly impact?: string;
  readonly destructive: boolean;
  readonly defaultChecked: boolean;
  readonly dependsOn: readonly string[];
}

export interface DimensionBundle extends BundleCommon {
  readonly kind: 'create' | 'extend' | 'merge' | 'rename';
  readonly dimensionName: string;
  readonly optionCount: number;
  readonly listCount: number;
}

export interface RescueBundle extends BundleCommon {
  readonly kind: 'rescue';
  readonly listName: string;
  readonly optionValue: string;
  readonly templateName: string;
}

export type DimensionChangeBundle = DimensionBundle | RescueBundle;

export interface RescueDimensionsRequest {
  readonly modelId?: string;
  readonly proposalId: string;
  readonly templateName: string;
}

export interface RejectedOp {
  readonly reason: string;
  readonly count: number;
}

export interface TemplateConflict {
  readonly templateName: string;
  readonly reason: string;
  readonly culpritBundleKeys: readonly string[];
  readonly rescueAttempted: boolean;
  readonly culpritKind: 'local' | 'non-local';
  readonly inBranch?: number;
  readonly totalBranches?: number;
}

export interface CoherenceWarning {
  readonly templateName: string;
  readonly detail: string;
}

// Coverage warnings surfaced by the AI inference review. These are
// non-blocking — the user can still apply the proposal — but they flag the
// two failure modes that produce silent wildcards in production: tags
// created without any option assignment, and name-implied lists where the
// post-proposal coverage on the implied dimension stays below the prompt's
// ≥90% target. A third kind, `missingDimension`, fires when a list's name
// strongly implies a dimension that simply doesn't exist after the
// proposal.
export type CoverageWarning =
  | {
      readonly kind: 'orphanTag';
      readonly dim: string;
      readonly label: string;
      readonly detail: string;
    }
  | {
      readonly kind: 'lowCoverage';
      readonly listName: string;
      readonly dim: string;
      readonly coverage: number;
      readonly taggedCount: number;
      readonly totalCount: number;
      readonly detail: string;
    }
  | {
      readonly kind: 'missingDimension';
      readonly listName: string;
      readonly dim: string;
      readonly detail: string;
    };

export interface DimensionProposal {
  readonly bundles: readonly DimensionChangeBundle[];
}

export interface InferDimensionsResponse {
  readonly proposalId: string;
  readonly proposal: DimensionProposal;
  readonly baseSnapshotHash: string;
  readonly warnings: readonly CoherenceWarning[];
  readonly coverage: readonly CoverageWarning[];
  readonly rejected: readonly RejectedOp[];
  readonly conflicts: readonly TemplateConflict[];
  // Non-fatal coverage notices (e.g. "N lists couldn't be fully analyzed —
  // re-run to fill the gaps") surfaced when the run finalized with partial
  // coverage after some chunks failed. Optional for wire back/forward compat.
  readonly notices?: readonly string[];
}


// Live SAT recheck of a dimension proposal against the user's current bundle
// selection. Server validator: api/src/routes/prompts.schema.ts::DiagnoseSelection
// (kept in parity by the trap battery below + the route's response `satisfies`).
export interface DiagnoseSelectionRequest {
  readonly proposalId: string;
  readonly acceptedBundleKeys: readonly string[];
}

export interface DiagnoseSelectionResponse {
  readonly conflicts: readonly TemplateConflict[];
}

export interface InferPhaseEvent {
  readonly phase: 'taxonomy' | 'chunks' | 'retry-gaps' | 'finalize';
}

export interface InferProgressEvent {
  readonly done: number;
  readonly total: number;
  readonly wave: 1 | 2;
}

export interface ApplyDimensionsRequest {
  readonly proposalId: string;
  readonly acceptedBundleKeys: readonly string[];
  readonly acceptUnsatisfiableTemplates?: readonly string[];
  // COMPAT — removed in follow-up commit ~1wk post-deploy. When `true`,
  // server-side expands to every currently-failing template and warn-logs.
  readonly overrideCoherence?: boolean;
}

// ─── Internal sanity barrier ────────────────────────────────────────────
//
// Build-time assertions that no exported type carries `userId`. If a future
// PR adds `userId: string` to Batch or Tile, the conditional resolves to
// `false`, the `_Assert<false>` constraint fails, and `tsc --noEmit` errors
// with "Type 'false' does not satisfy the constraint 'true'". Confirmed
// failure mode — `_Assert` only accepts `true`, so the trap is real, not a
// tautology that resolves to a legal type.
//
// Audit T2-005: the previous `T extends { userId: unknown }` form only
// matched REQUIRED `userId`. A future variant with `userId?: string` would
// slip through silently. The distributive `'userId' extends keyof T` form
// catches both required and optional keys, and `T extends unknown ? ... :
// never` distributes the check across union variants so a leaky variant in
// a discriminated union still trips the trap. The result of the distributed
// check is a union over true/'leak' tags; the outer extends-'ok' narrows it
// back to a single boolean for `_Assert`.

type _Assert<T extends true> = T;

// `true` iff `T` has no `userId` key in any constituent variant (required or
// optional). Distributive over unions; defensible against `userId?: ...`.
export type _NoUserIdOn<T> =
  (T extends unknown ? ('userId' extends keyof T ? 'leak' : 'ok') : never) extends 'ok'
    ? true
    : false;

type _NoUserIdOnBatch = _Assert<_NoUserIdOn<Batch>>;
type _NoUserIdOnVideoSequenceSummary = _Assert<_NoUserIdOn<VideoSequenceSummary>>;
type _NoUserIdOnStorySummary = _Assert<_NoUserIdOn<StorySummary>>;
type _NoUserIdOnStorySegmentPlan = _Assert<_NoUserIdOn<StorySegmentPlan>>;
type _NoUserIdOnEphemeraStatus = _Assert<_NoUserIdOn<EphemeraStatus>>;
type _NoUserIdOnCharacterCardSseEvent = _Assert<_NoUserIdOn<CharacterCardSseEvent>>;
type _NoUserIdOnGenerateResponse = _Assert<_NoUserIdOn<GenerateResponse>>;
type _NoUserIdOnQueueEvent = _Assert<_NoUserIdOn<QueueEvent>>;
type _NoUserIdOnTile = _Assert<_NoUserIdOn<Tile>>;
type _NoUserIdOnTileEvent = _Assert<_NoUserIdOn<TileEvent>>;
type _NoUserIdOnArchivedTile = _Assert<_NoUserIdOn<ArchivedTile>>;
type _NoUserIdOnUpload = _Assert<_NoUserIdOn<UploadRef>>;
type _NoUserIdOnCollection = _Assert<_NoUserIdOn<Collection>>;
type _NoUserIdOnByokStatus = _Assert<_NoUserIdOn<ByokKeyStatus>>;
type _NoUserIdOnByokError = _Assert<_NoUserIdOn<ByokKeyError>>;
type _NoUserIdOnModel = _Assert<_NoUserIdOn<Model>>;
type _NoUserIdOnEnhanceRequest = _Assert<_NoUserIdOn<EnhancePromptRequest>>;
type _NoUserIdOnMotionEnhanceExtendContext = _Assert<_NoUserIdOn<MotionEnhanceExtendContext>>;
type _NoUserIdOnAiFillRequest = _Assert<_NoUserIdOn<AiFillRequest>>;
type _NoUserIdOnAiFillSseEvent = _Assert<_NoUserIdOn<AiFillSseEvent>>;
type _NoUserIdOnAiFillBatchItem = _Assert<_NoUserIdOn<AiFillBatchItem>>;
type _NoUserIdOnAiFillBatchRequest = _Assert<_NoUserIdOn<AiFillBatchRequest>>;
type _NoUserIdOnAiFillBatchSseEvent = _Assert<_NoUserIdOn<AiFillBatchSseEvent>>;
type _NoUserIdOnTextBackendSettings = _Assert<_NoUserIdOn<TextBackendSettingsResponse>>;
type _NoUserIdOnTextRouting = _Assert<_NoUserIdOn<TextRoutingResponse>>;
type _NoUserIdOnModelStepsSettings = _Assert<_NoUserIdOn<ModelStepsSettingsResponse>>;
type _NoUserIdOnModelStepsSetting = _Assert<_NoUserIdOn<ModelStepsSetting>>;
type _NoUserIdOnBrainstormCharactersRequest = _Assert<_NoUserIdOn<BrainstormCharactersRequest>>;
type _NoUserIdOnDraftListRequest = _Assert<_NoUserIdOn<DraftVariableListRequest>>;
type _NoUserIdOnDraftVariableListResponse = _Assert<_NoUserIdOn<DraftVariableListResponse>>;
type _NoUserIdOnDraftTemplateRequest = _Assert<_NoUserIdOn<DraftTemplateRequest>>;
type _NoUserIdOnDraftTemplateResponse = _Assert<_NoUserIdOn<DraftTemplateResponse>>;
type _NoUserIdOnAvailability = _Assert<_NoUserIdOn<ModelAvailability>>;
type _NoUserIdOnPromptTemplate = _Assert<_NoUserIdOn<PromptTemplate>>;
type _NoUserIdOnVariableList = _Assert<_NoUserIdOn<VariableList>>;
type _NoUserIdOnVariableOption = _Assert<_NoUserIdOn<VariableOption>>;
type _NoUserIdOnTagDimension = _Assert<_NoUserIdOn<TagDimension>>;
type _NoUserIdOnDimensionTag = _Assert<_NoUserIdOn<DimensionTag>>;
type _NoUserIdOnApplyDimensionsRequest = _Assert<_NoUserIdOn<ApplyDimensionsRequest>>;
type _NoUserIdOnDimensionChangeBundle = _Assert<_NoUserIdOn<DimensionChangeBundle>>;
type _NoUserIdOnBundleCommon = _Assert<_NoUserIdOn<BundleCommon>>;
type _NoUserIdOnDimensionBundle = _Assert<_NoUserIdOn<DimensionBundle>>;
type _NoUserIdOnRescueBundle = _Assert<_NoUserIdOn<RescueBundle>>;
type _NoUserIdOnRescueDimensionsRequest = _Assert<_NoUserIdOn<RescueDimensionsRequest>>;
// Union-level trap: the distributive `_NoUserIdOn` already
// catches `userId` added to ANY variant of the DimensionChangeBundle union,
// so this is now a thin re-trap of the same union for explicit documentation.
type _NoUserIdOnAnyBundleVariant = _Assert<_NoUserIdOn<DimensionChangeBundle>>;
type _NoUserIdOnRejectedOp = _Assert<_NoUserIdOn<RejectedOp>>;
type _NoUserIdOnTemplateConflict = _Assert<_NoUserIdOn<TemplateConflict>>;

type _NoUserIdOnDiagnoseSelectionRequest = _Assert<_NoUserIdOn<DiagnoseSelectionRequest>>;
type _NoUserIdOnDiagnoseSelectionResponse = _Assert<_NoUserIdOn<DiagnoseSelectionResponse>>;
type _NoUserIdOnCoherenceWarning = _Assert<_NoUserIdOn<CoherenceWarning>>;
type _NoUserIdOnCoverageWarning = _Assert<_NoUserIdOn<CoverageWarning>>;
type _NoUserIdOnDimensionProposal = _Assert<_NoUserIdOn<DimensionProposal>>;
type _NoUserIdOnInferDimensionsResponse = _Assert<_NoUserIdOn<InferDimensionsResponse>>;
type _NoUserIdOnInferPhaseEvent = _Assert<_NoUserIdOn<InferPhaseEvent>>;
type _NoUserIdOnInferProgressEvent = _Assert<_NoUserIdOn<InferProgressEvent>>;
type _NoUserIdOnLibraryDiagnosisResponse = _Assert<_NoUserIdOn<LibraryDiagnosisResponse>>;
type _NoUserIdOnLibraryDiagnosisEntry = _Assert<_NoUserIdOn<LibraryDiagnosisEntry>>;
type _NoUserIdOnConflictingPair = _Assert<_NoUserIdOn<ConflictingPair>>;
type _NoUserIdOnLibraryCoverageResponse = _Assert<_NoUserIdOn<LibraryCoverageResponse>>;
type _NoUserIdOnCoverageUntaggedGroup = _Assert<_NoUserIdOn<CoverageUntaggedGroup>>;
type _NoUserIdOnCoverageLowList = _Assert<_NoUserIdOn<CoverageLowList>>;
type _NoUserIdOnCoverageOrphanTag = _Assert<_NoUserIdOn<CoverageOrphanTag>>;
type _NoUserIdOnCoverageMissingDimension = _Assert<_NoUserIdOn<CoverageMissingDimension>>;

// build-time trap battery — keep covering EVERY public wire type. The
// distributive `_NoUserIdOn` form handles both plain object types and
// discriminated unions (BatchEvent, EnhanceSseEvent) — a leaky variant trips
// the trap whether the key is required or optional. HistoryPage<T> is
// generic and parameterized by the caller's T — it can't be checked here, so
// the wire types that flow through it (Batch, ArchivedTile, etc.) each carry
// their own trap above.
type _NoUserIdOnBatchEvent = _Assert<_NoUserIdOn<BatchEvent>>;
type _NoUserIdOnBatchTileDescriptor = _Assert<_NoUserIdOn<BatchTileDescriptor>>;
type _NoUserIdOnArchivePage = _Assert<_NoUserIdOn<ArchivePage>>;
type _NoUserIdOnLibrarySummary = _Assert<_NoUserIdOn<LibrarySummary>>;
type _NoUserIdOnCollectionsResponse = _Assert<_NoUserIdOn<CollectionsResponse>>;
type _NoUserIdOnPromptLibraryResponse = _Assert<_NoUserIdOn<PromptLibraryResponse>>;
type _NoUserIdOnDoneEvent = _Assert<_NoUserIdOn<DoneEvent>>;
type _NoUserIdOnGenerateRequest = _Assert<_NoUserIdOn<GenerateRequest>>;
// `_NoUserIdOn<T>` is top-level-only (it does not descend into nested objects),
// so the two traps above do NOT cover the nested `provenance` object — these
// two explicit traps do.
type _NoUserIdOnBatchProvenance = _Assert<_NoUserIdOn<NonNullable<Batch['provenance']>>>;
type _NoUserIdOnBatchSequence = _Assert<_NoUserIdOn<NonNullable<Batch['sequence']>>>;
type _NoUserIdOnRequestProvenance = _Assert<_NoUserIdOn<NonNullable<GenerateRequest['provenance']>>>;
type _NoUserIdOnAnyEnhanceVariant = _Assert<_NoUserIdOn<EnhanceSseEvent>>;
type _NoUserIdOnAnyBrainstormVariant = _Assert<_NoUserIdOn<BrainstormSseEvent>>;
type _NoUserIdOnSseTerminalError = _Assert<_NoUserIdOn<SseTerminalError>>;

// Mark the helpers used so tsc doesn't warn — they exist purely for the
// constraint check above.
export type _NoUserIdInWire = [
  _NoUserIdOnBatch,
  _NoUserIdOnGenerateResponse,
  _NoUserIdOnQueueEvent,
  _NoUserIdOnTile,
  _NoUserIdOnArchivedTile,
  _NoUserIdOnUpload,
  _NoUserIdOnCollection,
  _NoUserIdOnByokStatus,
  _NoUserIdOnByokError,
  _NoUserIdOnModel,
  _NoUserIdOnAvailability,
  _NoUserIdOnEnhanceRequest,
] & {
  readonly __promptLibraryTraps: [
    _NoUserIdOnPromptTemplate,
    _NoUserIdOnVariableList,
    _NoUserIdOnVariableOption,
    _NoUserIdOnTagDimension,
    _NoUserIdOnDimensionTag,
    _NoUserIdOnDraftListRequest,
    _NoUserIdOnDraftTemplateRequest,
    _NoUserIdOnDraftTemplateResponse,
    _NoUserIdOnApplyDimensionsRequest,
    _NoUserIdOnDimensionChangeBundle,
    _NoUserIdOnBundleCommon,
    _NoUserIdOnDimensionBundle,
    _NoUserIdOnRescueBundle,
    _NoUserIdOnRescueDimensionsRequest,
    _NoUserIdOnAnyBundleVariant,
    _NoUserIdOnRejectedOp,
    _NoUserIdOnTemplateConflict,
    _NoUserIdOnCoherenceWarning,
    _NoUserIdOnCoverageWarning,
    _NoUserIdOnDimensionProposal,
    _NoUserIdOnInferDimensionsResponse,
    _NoUserIdOnInferPhaseEvent,
    _NoUserIdOnInferProgressEvent,
    _NoUserIdOnLibraryDiagnosisResponse,
    _NoUserIdOnLibraryDiagnosisEntry,
    _NoUserIdOnConflictingPair,
    _NoUserIdOnLibraryCoverageResponse,
    _NoUserIdOnCoverageUntaggedGroup,
    _NoUserIdOnCoverageLowList,
    _NoUserIdOnCoverageOrphanTag,
    _NoUserIdOnCoverageMissingDimension,
  ];
  readonly __wireTrapBatteryFollowups: [
    _NoUserIdOnBatchEvent,
    _NoUserIdOnBatchTileDescriptor,
    _NoUserIdOnArchivePage,
    _NoUserIdOnLibrarySummary,
    _NoUserIdOnCollectionsResponse,
    _NoUserIdOnPromptLibraryResponse,
    _NoUserIdOnDoneEvent,
    _NoUserIdOnGenerateRequest,
    _NoUserIdOnTileEvent,
    _NoUserIdOnAiFillSseEvent,
    _NoUserIdOnAiFillBatchItem,
    _NoUserIdOnAiFillBatchRequest,
    _NoUserIdOnAiFillBatchSseEvent,
    _NoUserIdOnBrainstormCharactersRequest,
    _NoUserIdOnDraftVariableListResponse,
    _NoUserIdOnAnyEnhanceVariant,
    _NoUserIdOnAnyBrainstormVariant,
    _NoUserIdOnBatchProvenance,
    _NoUserIdOnRequestProvenance,
    _NoUserIdOnSseTerminalError,
    _NoUserIdOnVideoSequenceSummary,
    _NoUserIdOnBatchSequence,
    _NoUserIdOnStorySummary,
    _NoUserIdOnStorySegmentPlan,
    _NoUserIdOnEphemeraStatus,
    _NoUserIdOnCharacterCardSseEvent,
  ];
};

type _CanceledIsInTileEventUnion = _Assert<
  Extract<TileEvent, { status: 'canceled' }> extends never ? false : true
>;
type _NoUserIdOnTileEventCanceled = _Assert<
  _NoUserIdOn<Extract<TileEvent, { status: 'canceled' }>>
>;
export type _CanceledWireSanity = [_CanceledIsInTileEventUnion, _NoUserIdOnTileEventCanceled];

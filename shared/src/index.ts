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
import type {
  AiFillBackendFrameWire, AiFillBatchResultWire, AiFillResultWire, BrainstormDoneWire, BrainstormPromptWire, CharacterCardStatusWire, EnhanceDeltaWire, StoryPlanStatusWire, StoryPlanWire, ArchivedTileWire, ArchivePageWire, BatchEventWire, BatchTileDescriptorWire, BatchWire,
  CancelStoryResponseWire, CharacterCardResultWire, CollectionsResponseWire, CollectionWire, ConflictingPairWire,
  CoverageLowListWire, CoverageMissingDimensionWire, CoverageOrphanTagWire, CoverageUntaggedGroupWire, DimensionTagWire,
  DoneEventWire, EphemeraStatusWire, HandoffFrameResponseWire, LibraryCoverageResponseWire, LibraryDiagnosisEntryWire,
  LibraryDiagnosisResponseWire, LibrarySummaryWire, ModelAvailabilityWire, ModelWire, PromptLibraryResponseWire,
  PromptTemplateWire, QueueEventWire, SessionResponseWire, StorySegmentPlanWire, StorySummaryWire, TagDimensionWire,
  TileEventWire, TileWire, UploadRefWire, VariableListWire, VariableOptionWire, VideoSequenceSummaryWire,
} from './wireSchemas';
import type {
  BundleCommonWire, CoherenceWarningWire, CoverageWarningWire, DiagnoseSelectionResponseWire, DimensionBundleWire,
  DimensionProposalWire, DraftTemplateResponseWire, DraftVariableListResponseWire, InferDimensionsResponseWire,
  InferPhaseEventWire, InferProgressEventWire, RejectedOpWire, RescueBundleWire, RescueDonePayloadWire,
  RescueFailedPayloadWire, TemplateChangeWire, TemplateConflictWire, UnplacedTemplateChangeWire,
} from './promptToolSchemas';
export { GPT_MODERATION_REASONS, GptModerationNoticeSchema, GptModerationCategoriesSchema } from './moderation';
export type { GptModerationNotice, GptModerationReason, GptModerationCategory } from './moderation';

// Bounded request policy for upload holds on history/archive DELETEs.
// Large lists travel in JSON; the legacy `?keepUploads=` query remains limited
// to MAX_QUERY_KEEP_UPLOADS ids.
export const MAX_DELETE_KEEP_UPLOADS = 8192;
export const MAX_QUERY_KEEP_UPLOADS = 64;

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
  // The request carried the previous account's session scope (account switch
  // behind the edge). The web locks the session and reloads.
  'SESSION_CHANGED',
  // Text-model routing (409): no model is set up for the call, none that is
  // available accepts its images, or the image model's locked prompt writer
  // cannot serve it. The envelope's `error` carries the plain-English copy.
  'TEXT_MODEL_NOT_CONFIGURED',
  'TEXT_MODEL_NO_VISION',
  'TEXT_MODEL_UNAVAILABLE',
  // Artifact storage is still sealed after a restart (503 with Retry-After).
  // Transient: the read succeeds once the host agent has unsealed it.
  'STORAGE_SEALED',
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

/** `GET /api/session` body: the scope the SPA pins on every request. */
export type SessionResponse = SessionResponseWire;

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
export type Model = ModelWire;

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

export type ModelAvailability = ModelAvailabilityWire;

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
export type StorySegmentPlan = StorySegmentPlanWire;

/** Per-batch story decoration riding history payloads (mirrors `sequence`). */
export type StorySummary = StorySummaryWire;

export type StoryPlanSseEvent =
  | { event: 'status'; data: StoryPlanStatusWire }
  | { event: 'plan'; data: StoryPlanWire }
  | { event: 'error'; data: SseTerminalError };

/** `POST /api/stories` body. */
export interface TellStoryRequest {
  readonly outline: string;
  readonly sourceUploadId?: string;
  readonly extendsTileId?: string;
  readonly sourcePrompt?: string;
  readonly ratio?: Ratio;
}

/** `POST /api/stories/:id/cancel` answer; the segment batch still rendering, if any. */
export type CancelStoryResponse = CancelStoryResponseWire;

// ─── Ephemera character cards (public) ─────────────────────────────────

/** `GET /api/ephemera` body; the route is a leak-safe 404 when disabled. */
export type EphemeraStatus = EphemeraStatusWire;

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

export type CharacterCardPhase = CharacterCardStatusWire['phase'];

export type CharacterCardSseEvent =
  | { event: 'status'; data: CharacterCardStatusWire }
  | { event: 'result'; data: CharacterCardResult }
  | { event: 'error'; data: SseTerminalError };

export type CharacterCardResult = CharacterCardResultWire;

/** Planner segment-count ceiling; deliberately below MAX_SEQUENCE_SEGMENTS. */
export const STORY_MAX_SEGMENTS = 6;
export const STORY_MIN_SEGMENTS = 2;
export const STORY_OUTLINE_MAX_CHARS = 4000;

export type VideoSequenceSummary = VideoSequenceSummaryWire;
export type HandoffFrameResponse = HandoffFrameResponseWire;

// ─── Collections (public) ──────────────────────────────────────────────

// Collection metadata exposed to the frontend. userId is server-internal and
// never re-exported here (mirrors Batch / Tile).
export type Collection = CollectionWire;

// Global rail counters returned alongside the collections list so the rail can
// render conditional rows without scanning paginated history. `*Count` fields
// are batch-grain over non-archived rows; `archived*Count` are **tile-grain**
// over the Archive view's visibility predicate, so rail counts agree with the
// scoped feed even when archive state is partial (some tiles archived, others
// still live).
export type LibrarySummary = LibrarySummaryWire;

export type CollectionsResponse = CollectionsResponseWire;

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

export type ConflictingPair = ConflictingPairWire;

export type LibraryDiagnosisEntry = LibraryDiagnosisEntryWire;

export const DIAGNOSIS_VERSION_HEADER = 'X-Atelier-Diagnosis-Version';
export const DIAGNOSIS_VERSION = '2';

export type LibraryDiagnosisResponse = LibraryDiagnosisResponseWire;

export type CoverageUntaggedGroup = CoverageUntaggedGroupWire;

export type CoverageLowList = CoverageLowListWire;

export type CoverageOrphanTag = CoverageOrphanTagWire;

export type CoverageMissingDimension = CoverageMissingDimensionWire;

export type LibraryCoverageResponse = LibraryCoverageResponseWire;

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

export type ArchivedTile = ArchivedTileWire;

export type ArchivePage = ArchivePageWire;

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

// Shapes and field docs live with their schemas in ./wireSchemas.
export type BatchTileDescriptor = BatchTileDescriptorWire;
export type BatchEvent = BatchEventWire;
export type QueueEvent = QueueEventWire;
export type UploadRef = UploadRefWire;
export type TileEvent = TileEventWire;
export type DoneEvent = DoneEventWire;

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
  | { event: 'delta'; data: EnhanceDeltaWire }
  | { event: 'done'; data: Record<string, never> }
  // `code: 'refusal'` when the finished rewrite is refusal prose.
  | { event: 'error'; data: SseTerminalError };

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

// ─── Admin-managed text providers and models ────────────────────────────
// Wire contract: spec
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

/** Longest text provider name or text model display name (API, store, UI). */
export const TEXT_DISPLAY_NAME_MAX_CHARS = 60;
/** Longest upstream model id of a text model row (API, store, UI). */
export const TEXT_MODEL_ID_MAX_CHARS = 200;

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
  /** Image model ids whose writer is locked: it wins over the user's own pick. */
  readonly lockedWriters: readonly string[];
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
  /** Output-limit field the provider will use; defaults to max_completion_tokens. */
  readonly tokenField?: TextTokenField;
  readonly listModels?: boolean;
  /** Model to send the probe to; required when `listModels` is false. */
  readonly probeModelId?: string;
}

/** `POST /api/text-providers`. */
export interface TextProviderCreateRequest {
  readonly name: string;
  readonly protocol: TextProtocol;
  readonly baseUrl: string;
  readonly preset?: string | null;
  readonly apiKey?: string;
  readonly tokenField?: TextTokenField;
  readonly listModels?: boolean;
}

/** `PATCH /api/text-providers/:id`. */
export interface TextProviderPatchRequest {
  readonly name?: string;
  readonly protocol?: TextProtocol;
  readonly baseUrl?: string;
  readonly preset?: string | null;
  /** A string replaces the stored key; null removes it. */
  readonly apiKey?: string | null;
  readonly tokenField?: TextTokenField;
  readonly listModels?: boolean;
  readonly enabled?: boolean;
}

/** One entry of `POST /api/text-providers/:id/models`. */
export interface TextModelCreateEntry {
  /** Upstream model id. */
  readonly modelId: string;
  readonly displayName?: string;
  /** List hints, used as the starting capability values. */
  readonly hints?: TextModelHints;
}

/** `PATCH /api/text-providers/:id/models/:mid`. */
export interface TextModelPatchRequest extends Partial<TextModelCapabilities> {
  readonly displayName?: string;
  readonly enabled?: boolean;
  readonly screenRequests?: boolean;
  readonly sortOrder?: number;
}

/** `PUT /api/text-routing/writers/:imageModelId`. */
export interface TextWriterPutRequest {
  /** null clears the writer. */
  readonly modelId: string | null;
  /** Omitted = the server default, 'prefer'. */
  readonly mode?: TextWriterMode;
}

/** `PUT /api/text-models/tasks/:task`. */
export interface TextModelTaskPutRequest {
  /** null clears the pick (back to the admin's default). */
  readonly modelId: string | null;
  /** Omitted keeps a stored effort the model still accepts; null resets it. */
  readonly effort?: TextReasoningEffort | null;
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

/** Render sizes a local row may offer (megapixels); delivery size is unchanged. */
export const RENDER_RESOLUTIONS = ['4mp', '8mp', '16mp'] as const;
export type RenderResolution = (typeof RENDER_RESOLUTIONS)[number];

export interface ModelResolutionSetting {
  readonly modelId: string;
  readonly name: string;
  /** The row's text-to-image render size. */
  readonly defaultTextToImage: RenderResolution;
  /** The user's text-to-image override, or null when the default applies. */
  readonly textToImage: RenderResolution | null;
  /** The reference-picture render size; null when the row takes no reference pictures. */
  readonly defaultReference: RenderResolution | null;
  /** The user's reference override, or null when the default applies or the row has none. */
  readonly reference: RenderResolution | null;
  /**
   * Long edge in pixels the row reduces its render to on delivery; null when
   * it delivers at render size (no "Downsize to 2K" switch).
   */
  readonly outputLongEdge: number | null;
  /** Effective "Downsize to 2K": true unless the user turned it off; false when `outputLongEdge` is null. */
  readonly downscale: boolean;
}

export interface ModelResolutionSettingsResponse {
  readonly options: readonly RenderResolution[];
  readonly models: readonly ModelResolutionSetting[];
}

export interface ModelResolutionPutRequest {
  /** null (or the default value) resets that mode; an absent key leaves it unchanged. */
  readonly textToImage?: RenderResolution | null;
  readonly reference?: RenderResolution | null;
  /** false delivers the rendered size; true (the default) reduces to `outputLongEdge`. */
  readonly downscale?: boolean;
}

/** Advisory leading ai-fill frame naming the text model serving the fill. */
export type AiFillBackendFrame = AiFillBackendFrameWire;

export type AiFillSseEvent =
  | { event: 'backend'; data: AiFillBackendFrame }
  | { event: 'result'; data: AiFillResultWire }
  | { event: 'error'; data: { message: string; code?: string } };

export type AiFillBatchSseEvent =
  | { event: 'backend'; data: AiFillBackendFrame }
  | { event: 'result'; data: AiFillBatchResultWire }
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
  /** Optional 32-bit entropy source for a meaningfully different take of the same brief. */
  readonly variationSeed?: number;
}

export type BrainstormSseEvent =
  | { event: 'prompt'; data: BrainstormPromptWire }
  | { event: 'done'; data: BrainstormDoneWire }
  | { event: 'error'; data: { message: string } };

export interface DraftVariableListRequest {
  readonly modelId?: string;
  name: string;
  existing: string[];
  description?: string;
}

export type DraftVariableListResponse = DraftVariableListResponseWire;

export interface DraftTemplateRequest {
  readonly modelId?: string;
  /** Template name. */
  name: string;
  /**
   * The editor body exactly as it stands, untrimmed, so rework offsets point
   * into it; empty string when the body is empty or whitespace-only.
   */
  existingBody: string;
  /**
   * Empty `existingBody`: what to draft (seed prompt and clarify answers).
   * Non-empty `existingBody`: the change instructions for the rework, required;
   * the answer is then placed changes against `existingBody`, not a body.
   */
  description?: string;
}

export type DraftTemplateResponse = DraftTemplateResponseWire;

/** A rework's placed changes (`existingBody` non-blank), reviewed before anything is written. */
export type DraftTemplateChanges = Extract<DraftTemplateResponse, { kind: 'changes' }>;

export type TemplateChange = TemplateChangeWire;

export type UnplacedTemplateChange = UnplacedTemplateChangeWire;

export type BundleCommon = BundleCommonWire;

export type DimensionBundle = DimensionBundleWire;

export type RescueBundle = RescueBundleWire;

export type DimensionChangeBundle = DimensionBundle | RescueBundle;

export interface RescueDimensionsRequest {
  readonly modelId?: string;
  readonly proposalId: string;
  readonly templateName: string;
}

export type RescueFailedPayload = RescueFailedPayloadWire;
/** `done` terminal frame of POST /api/prompts/dimensions/rescue. */
export type RescueDonePayload = RescueDonePayloadWire;

export type RejectedOp = RejectedOpWire;

export type TemplateConflict = TemplateConflictWire;

export type CoherenceWarning = CoherenceWarningWire;

export type CoverageWarning = CoverageWarningWire;

export type DimensionProposal = DimensionProposalWire;

export type InferDimensionsResponse = InferDimensionsResponseWire;


// Live SAT recheck of a dimension proposal against the user's current bundle
// selection. Server validator: api/src/routes/prompts.schema.ts::DiagnoseSelection
// (kept in parity by the trap battery below + the route's response `satisfies`).
export interface DiagnoseSelectionRequest {
  readonly proposalId: string;
  readonly acceptedBundleKeys: readonly string[];
}

export type DiagnoseSelectionResponse = DiagnoseSelectionResponseWire;

export type InferPhaseEvent = InferPhaseEventWire;

export type InferProgressEvent = InferProgressEventWire;

export interface ApplyDimensionsRequest {
  readonly proposalId: string;
  readonly acceptedBundleKeys: readonly string[];
  readonly acceptUnsatisfiableTemplates?: readonly string[];
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
type _NoUserIdOnCharacterCardResult = _Assert<_NoUserIdOn<CharacterCardResult>>;
type _NoUserIdOnCancelStoryResponse = _Assert<_NoUserIdOn<CancelStoryResponse>>;
type _NoUserIdOnSessionResponse = _Assert<_NoUserIdOn<SessionResponse>>;
type _NoUserIdOnHandoffFrameResponse = _Assert<_NoUserIdOn<HandoffFrameResponse>>;
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
type _NoUserIdOnTextRouting = _Assert<_NoUserIdOn<TextRoutingResponse>>;
type _NoUserIdOnModelStepsSettings = _Assert<_NoUserIdOn<ModelStepsSettingsResponse>>;
type _NoUserIdOnModelStepsSetting = _Assert<_NoUserIdOn<ModelStepsSetting>>;
type _NoUserIdOnModelResolutionSettings = _Assert<_NoUserIdOn<ModelResolutionSettingsResponse>>;
type _NoUserIdOnModelResolutionSetting = _Assert<_NoUserIdOn<ModelResolutionSetting>>;
type _NoUserIdOnModelResolutionPut = _Assert<_NoUserIdOn<ModelResolutionPutRequest>>;
type _NoUserIdOnBrainstormCharactersRequest = _Assert<_NoUserIdOn<BrainstormCharactersRequest>>;
type _NoUserIdOnDraftListRequest = _Assert<_NoUserIdOn<DraftVariableListRequest>>;
type _NoUserIdOnDraftVariableListResponse = _Assert<_NoUserIdOn<DraftVariableListResponse>>;
type _NoUserIdOnDraftTemplateRequest = _Assert<_NoUserIdOn<DraftTemplateRequest>>;
type _NoUserIdOnDraftTemplateResponse = _Assert<_NoUserIdOn<DraftTemplateResponse>>;
type _NoUserIdOnTemplateChange = _Assert<_NoUserIdOn<TemplateChange>>;
type _NoUserIdOnUnplacedTemplateChange = _Assert<_NoUserIdOn<UnplacedTemplateChange>>;
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
type _NoUserIdOnRescueDonePayload = _Assert<_NoUserIdOn<RescueDonePayload>>;
type _NoUserIdOnRescueFailedPayload = _Assert<_NoUserIdOn<RescueFailedPayload>>;

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
    _NoUserIdOnRescueDonePayload,
    _NoUserIdOnRescueFailedPayload,
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
    _NoUserIdOnCharacterCardResult,
    _NoUserIdOnCancelStoryResponse,
    _NoUserIdOnSessionResponse,
    _NoUserIdOnHandoffFrameResponse,
  ];
  // Nested items of the rework `changes` payload; `_NoUserIdOn` is top-level only.
  readonly __templateReworkTraps: [
    _NoUserIdOnTemplateChange,
    _NoUserIdOnUnplacedTemplateChange,
  ];
};

type _CanceledIsInTileEventUnion = _Assert<
  Extract<TileEvent, { status: 'canceled' }> extends never ? false : true
>;
type _NoUserIdOnTileEventCanceled = _Assert<
  _NoUserIdOn<Extract<TileEvent, { status: 'canceled' }>>
>;
export type _CanceledWireSanity = [_CanceledIsInTileEventUnion, _NoUserIdOnTileEventCanceled];

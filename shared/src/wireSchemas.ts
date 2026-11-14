// Public response schemas. Import this subpath explicitly so the wire-type
// barrel remains cheap for consumers that only need constants or types.
import * as z from 'zod/mini';
import { BACKEND_VALUES, HISTORY_REFRESH_MAX_IDS, LATENCY_VALUES, MAX_HISTORY_Q_LEN, MEDIA_EXT_MIME, MEDIA_EXTS, MEDIA_MIMES, MODEL_AVAILABILITY_REASONS, POOL_VALUES, RATIO_VALUES, TILE_ERROR_CATEGORIES, TILE_EXTS, TILE_MIMES, VIDEO_DURATION_FRAMES } from './index';
import type { MediaExt, MediaMime } from './index';
import { GptModerationNoticeSchema, type GptModerationNotice } from './moderation';

// JSON omits undefined fields. Preserve the project's exact optional-property
// contract while deriving DTOs from Zod's `field?: T | undefined` inference.
export type JsonFields<T> = T extends GptModerationNotice ? T : T extends object
  ? { [K in keyof T]: JsonFields<Exclude<T[K], undefined>> }
  : T;

// A finished artifact's mime must be the one its extension names.
const mediaPairMatches = (media: { readonly ext: MediaExt; readonly mime: MediaMime }): boolean => MEDIA_EXT_MIME[media.ext] === media.mime;

const tileBase = {
  id: z.string(),
  seed: z.number(),
  refImageIds: z.optional(z.readonly(z.array(z.string()))),
};
const DoneTileSchema = z.object({
  ...tileBase,
  status: z.literal('done'),
  url: z.string(),
  thumbUrl: z.optional(z.string()),
  ext: z.enum(MEDIA_EXTS),
  mime: z.enum(MEDIA_MIMES),
  completedAt: z.number(),
}).check(z.refine(mediaPairMatches));

export const TileSchema = z.union([
  z.object({ ...tileBase, status: z.literal('loading') }),
  DoneTileSchema,
  z.object({
    ...tileBase,
    status: z.literal('failed'),
    error: z.enum(TILE_ERROR_CATEGORIES),
    moderation: z.optional(GptModerationNoticeSchema),
    completedAt: z.number(),
  }),
]);
export type TileWire = JsonFields<z.infer<typeof TileSchema>>;

export const VideoSequenceSummarySchema = z.object({
  id: z.string(),
  segmentCount: z.number(),
  totalDurationFrames: z.number(),
  masterStatus: z.enum(['idle', 'stitching', 'ready', 'failed']),
  masterUpdatedAt: z.optional(z.number()),
});
export type VideoSequenceSummaryWire = JsonFields<z.infer<typeof VideoSequenceSummarySchema>>;

export const StorySummarySchema = z.readonly(z.object({
  id: z.string(),
  status: z.enum(['rendering', 'done', 'failed', 'canceled']),
  segmentIndex: z.number(),
  segmentCount: z.number(),
  logline: z.string(),
  etaMs: z.number(),
}));
export type StorySummaryWire = JsonFields<z.infer<typeof StorySummarySchema>>;

export const BatchSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  ratio: z.enum(RATIO_VALUES),
  durationFrames: z.optional(z.literal(VIDEO_DURATION_FRAMES)),
  sequenceId: z.optional(z.string()),
  sequenceIndex: z.optional(z.number()),
  sequence: z.optional(VideoSequenceSummarySchema),
  modelId: z.string(),
  modelLabel: z.string(),
  createdAt: z.number(),
  startedAt: z.optional(z.number()),
  collectionId: z.nullable(z.string()),
  pinned: z.boolean(),
  status: z.enum(['queued', 'running', 'done']),
  provenance: z.optional(z.readonly(z.object({
    templateId: z.nullable(z.string()),
    templateName: z.nullable(z.string()),
    rollSeed: z.number(),
    pins: z.readonly(z.record(z.string(), z.string())),
  }))),
  queueLengthAhead: z.optional(z.number()),
  i2vSourceUploadId: z.optional(z.string()),
  motionPrompt: z.optional(z.string()),
  story: z.optional(StorySummarySchema),
  tiles: z.readonly(z.array(TileSchema)),
});
export type BatchWire = JsonFields<z.infer<typeof BatchSchema>>;

export const BatchHistoryPageSchema = z.object({
  items: z.readonly(z.array(BatchSchema)),
  nextCursor: z.nullable(z.string()),
});

/** Existing history scope grammar, with bounded identities instead of cursors. */
export const HistoryRefreshRequestSchema = z.strictObject({
  batchIds: z.array(z.uuid()).check(z.maxLength(HISTORY_REFRESH_MAX_IDS)),
  storyIds: z.array(z.uuid()).check(z.maxLength(HISTORY_REFRESH_MAX_IDS)),
  collectionId: z.optional(z.union([z.literal('null'), z.uuid()])),
  pinned: z.optional(z.literal(true)),
  q: z.optional(z.string().check(z.refine((value) => value.length <= MAX_HISTORY_Q_LEN))),
});
export type HistoryRefreshRequest = JsonFields<z.infer<typeof HistoryRefreshRequestSchema>>;

export const HistoryRefreshResponseSchema = z.object({
  items: z.readonly(z.array(BatchSchema)),
  missingBatchIds: z.readonly(z.array(z.string())),
});
export type HistoryRefreshResponse = JsonFields<z.infer<typeof HistoryRefreshResponseSchema>>;

export const VariableOptionSchema = z.readonly(z.object({
  id: z.string(), listId: z.string(), value: z.string(),
  tagIds: z.readonly(z.array(z.string())),
  excludeTagIds: z.optional(z.readonly(z.array(z.string()))),
  sortOrder: z.number(), weight: z.number(),
}));
export type VariableOptionWire = JsonFields<z.infer<typeof VariableOptionSchema>>;

export const VariableListSchema = z.readonly(z.object({
  id: z.string(), name: z.string(),
  options: z.readonly(z.array(VariableOptionSchema)),
  sortOrder: z.number(), createdAt: z.number(), updatedAt: z.number(),
}));
export type VariableListWire = JsonFields<z.infer<typeof VariableListSchema>>;

export const DimensionTagSchema = z.readonly(z.object({
  id: z.string(), dimensionId: z.string(), label: z.string(), sortOrder: z.number(),
  parentId: z.optional(z.nullable(z.string())),
}));
export type DimensionTagWire = JsonFields<z.infer<typeof DimensionTagSchema>>;

export const TagDimensionSchema = z.readonly(z.object({
  id: z.string(), name: z.string(), description: z.optional(z.string()),
  tags: z.readonly(z.array(DimensionTagSchema)),
}));
export type TagDimensionWire = JsonFields<z.infer<typeof TagDimensionSchema>>;

export const PromptTemplateSchema = z.readonly(z.object({
  id: z.string(), name: z.string(), body: z.string(), notes: z.optional(z.string()),
  sortOrder: z.number(), createdAt: z.number(), updatedAt: z.number(),
}));
export type PromptTemplateWire = JsonFields<z.infer<typeof PromptTemplateSchema>>;

export const PromptLibraryResponseSchema = z.readonly(z.object({
  templates: z.readonly(z.array(PromptTemplateSchema)),
  variableLists: z.readonly(z.array(VariableListSchema)),
  dimensions: z.readonly(z.array(TagDimensionSchema)),
}));
export type PromptLibraryResponseWire = JsonFields<z.infer<typeof PromptLibraryResponseSchema>>;

// ─── Model registry ─────────────────────────────────────────────────────

export const ModelAvailabilitySchema = z.object({
  ok: z.boolean(),
  /** Epoch ms — when the snapshot value was recorded. */
  checkedAt: z.number(),
  /**
   * Operational category when `ok: false`; absent when `ok: true` and also
   * absent before the first probe round completes after boot. Closed union
   * so a future addition forces an api + web change in lockstep.
   */
  reason: z.optional(z.enum(MODEL_AVAILABILITY_REASONS)),
});
export type ModelAvailabilityWire = JsonFields<z.infer<typeof ModelAvailabilitySchema>>;

export const ModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  backend: z.enum(BACKEND_VALUES),
  /**
   * Free-form locator for the chip's tag. Cloud models carry a provider/region
   * hint ("google", "us-central1"); local models carry their host tag
   * ("comfyui"), which the client maps to a display name.
   */
  tag: z.string(),
  latency: z.enum(LATENCY_VALUES),
  /** Optional tooltip metadata such as "SDXL 1.0" or "9:16 max 2K". */
  size: z.optional(z.string()),
  /** Per-model — composer's ratio chip filters from this. */
  supportedRatios: z.readonly(z.array(z.enum(RATIO_VALUES))),
  /** Preferred initial ratio. The Composer resolves to it whenever the draft
   * carries no explicit ratio choice. Must be a member of `supportedRatios`. */
  defaultRatio: z.optional(z.enum(RATIO_VALUES)),
  supportsReferenceImages: z.optional(z.boolean()),
  /**
   * Server-defined upper bound on reference images per generation, when
   * `supportsReferenceImages` is true. Authoritative for the client's
   * composer cap; the server re-checks against the resolved registry entry.
   */
  maxRefImages: z.optional(z.number()),
  /**
   * Effective raw on-disk reference-image byte budget for one generation
   * batch. Present when `supportsReferenceImages` is true; derived from the
   * frozen API config so client preflight matches route-side enforcement.
   */
  maxRefBytesPerBatch: z.optional(z.number()),
  /**
   * Server-defined per-user concurrent tile cap that applies to this model.
   * Authoritative — the client reads this for display, never enforces it.
   * The server's per-pool semaphore is the only gate.
   */
  concurrencyCapPerUser: z.number(),
  /**
   * Maximum tile count the server can ever acquire for one batch in this
   * model's pool. The Composer uses it to keep the count chip within a
   * dequeue-able range; the route still validates authoritatively.
   */
  maxCountPerBatch: z.number(),
  /**
   * When true, the provider supports multi-image batch generation natively
   * (e.g. ComfyUI `batch_size`). The orchestrator issues a single
   * `generate(count=N)` call instead of N individual calls.
   */
  batched: z.optional(z.boolean()),
  /**
   * Suggested initial count for batched models. The Composer snaps to this
   * value when the user selects a batched model that has a preferred count.
   */
  defaultCount: z.optional(z.number()),
  /**
   * Clip lengths this model can render, in frames. Present only on video
   * models; the composer's duration chip filters from it and the server
   * re-validates the submitted value against this same set.
   */
  supportedDurations: z.optional(z.readonly(z.array(z.literal(VIDEO_DURATION_FRAMES)))),
  /**
   * Preferred initial clip length. The Composer resolves to it whenever the
   * draft carries no explicit duration. Must be a member of
   * `supportedDurations`.
   */
  defaultDuration: z.optional(z.literal(VIDEO_DURATION_FRAMES)),
  /** True when this model animates a still image into a video artifact. */
  supportsI2V: z.optional(z.boolean()),
  /**
   * True when this model's artifact is a video (mp4). Broader than
   * `supportsI2V`: a text-to-video model outputs video without requiring a
   * source still. Drives video loading chrome and the shared per-user
   * in-flight video cap.
   */
  outputsVideo: z.optional(z.boolean()),
  /**
   * Which server-side semaphore charges this model. The client attributes its
   * own in-flight observations to the right pool when displaying counts.
   * Survives the `requiresKey` strip in `publicModelsForUser` — Composer
   * gating uses `requiresKey`, but pool identity is needed even after a key
   * is configured.
   */
  pool: z.enum(POOL_VALUES),
  /**
   * Server-declared prompt format this model is trained on. When set, the
   * client auto-formats the FINAL resolved prompt (post {{var}}/{{random}}/
   * ai-fill) through `/enhance-prompt` at the submit chokepoint before firing
   * `/api/generate`. Absent → prompts fire as-is.
   */
  promptFormat: z.optional(z.literal('h3-motion')),
  requiresKey: z.optional(z.object({ provider: z.literal('google') })),
  /**
   * Last known liveness of the upstream host. Populated only for entries the
   * server probes (currently `pool: 'local'`); omitted for entries we treat
   * as always-available (cloud + mock). When present and `ok: false`, the
   * Composer renders the chip disabled with the reason in the tooltip, and
   * `/api/generate` returns 503 if the user races a stale snapshot.
   */
  availability: z.optional(ModelAvailabilitySchema),
}).check(z.refine((model) => (
  // A default outside its own set (a ratio or duration this bundle cannot
  // offer) would reach the composer chips and take the composer out.
  (model.defaultRatio === undefined || model.supportedRatios.includes(model.defaultRatio))
  && (model.defaultDuration === undefined || model.supportedDurations?.includes(model.defaultDuration) === true)
)));
export type ModelWire = JsonFields<z.infer<typeof ModelSchema>>;

export const ModelListSchema = z.readonly(z.array(ModelSchema));

// ─── Collections and archive ────────────────────────────────────────────

export const CollectionSchema = z.readonly(z.object({
  id: z.string(),
  name: z.string(),
  /** Batches in this collection; server-computed and excludes archived. */
  count: z.number(),
  /**
   * Archived **tiles** (not batches) currently surfaced in the Archive view
   * whose parent batch belongs to this collection. Mirrors the visibility
   * predicate of `/api/archive` (done/ext/mime/completed_at) so a row's count
   * matches what the Archive view actually shows.
   */
  archivedCount: z.number(),
  createdAt: z.number(),
}));
export type CollectionWire = JsonFields<z.infer<typeof CollectionSchema>>;

export const LibrarySummarySchema = z.readonly(z.object({
  totalCount: z.number(),
  pinnedCount: z.number(),
  unsortedCount: z.number(),
  archivedTotalCount: z.number(),
  archivedPinnedCount: z.number(),
  archivedUnsortedCount: z.number(),
}));
export type LibrarySummaryWire = JsonFields<z.infer<typeof LibrarySummarySchema>>;

export const CollectionsResponseSchema = z.readonly(z.object({
  items: z.readonly(z.array(CollectionSchema)),
  summary: LibrarySummarySchema,
}));
export type CollectionsResponseWire = JsonFields<z.infer<typeof CollectionsResponseSchema>>;

export const ArchivedTileSchema = z.object({
  id: z.string(),
  batchId: z.string(),
  prompt: z.string(),
  modelLabel: z.string(),
  seed: z.number(),
  status: z.literal('done'),
  refImageIds: z.optional(z.readonly(z.array(z.string()))),
  url: z.string(),
  thumbUrl: z.optional(z.string()),
  ext: z.enum(MEDIA_EXTS),
  mime: z.enum(MEDIA_MIMES),
  ratio: z.enum(RATIO_VALUES),
  completedAt: z.number(),
  archivedAt: z.number(),
}).check(z.refine(mediaPairMatches));
export type ArchivedTileWire = JsonFields<z.infer<typeof ArchivedTileSchema>>;

export const ArchivePageSchema = z.object({
  items: z.readonly(z.array(ArchivedTileSchema)),
  nextCursor: z.nullable(z.string()),
  // Total archived done tiles for the current scope filter (collectionId /
  // pinned), regardless of pagination. Present (a number) ONLY on the first
  // page (request without a cursor); `null` on every subsequent page so the
  // server skips a redundant COUNT(*) per scroll. The client carries the
  // freshest non-null value forward (see web useArchiveQuery).
  total: z.nullable(z.number()),
});
export type ArchivePageWire = JsonFields<z.infer<typeof ArchivePageSchema>>;

// ─── Generate stream events ─────────────────────────────────────────────

/**
 * Per-tile descriptor inside the initial `batch` event. `tileIndex` is the
 * grid display order; `tileId` is the persistence key used for downstream
 * DELETE / GET /api/img/* calls.
 */
export const BatchTileDescriptorSchema = z.object({
  tileId: z.string(),
  tileIndex: z.number(),
  seed: z.number(),
});
export type BatchTileDescriptorWire = JsonFields<z.infer<typeof BatchTileDescriptorSchema>>;

export const BatchEventSchema = z.object({
  batchId: z.string(),
  /**
   * Server-authoritative createdAt in ms. The client uses this for the
   * optimistic batch's createdAt so the cache stays in canonical
   * `created_at DESC` order — without it, an SSE arrival order that
   * diverges from server creation order causes a visible reorder when
   * any refetch lands.
   */
  createdAt: z.number(),
  /** Dispatch time, present once the batch is running (see Batch.startedAt). */
  startedAt: z.optional(z.number()),
  status: z.optional(BatchSchema.shape.status),
  /** Projected dispatch position (0 = next). Not monotonic: on the local pool it can rise when later same-model work is scheduled ahead. */
  queueLengthAhead: z.optional(z.number()),
  tiles: z.readonly(z.array(BatchTileDescriptorSchema)),
  refImageIds: z.optional(z.readonly(z.array(z.string()))),
});
export type BatchEventWire = JsonFields<z.infer<typeof BatchEventSchema>>;

export const QueueEventSchema = z.object({
  batchId: z.string(),
  status: z.literal('running'),
  /** Dispatch time (see Batch.startedAt). */
  startedAt: z.optional(z.number()),
});
export type QueueEventWire = JsonFields<z.infer<typeof QueueEventSchema>>;

const tileEventBase = { tileId: z.string(), tileIndex: z.number() };

// Partial previews must be a non-empty base64 data URL of a tile format. The
// api enforces the same rule at egress; this is the client's second line of
// defence. Derived from TILE_MIMES, so a new tile mime is a preview format too.
const previewPrefixes = TILE_MIMES.map((mime) => `data:${mime};base64,`);
const isPreviewDataUrl = (value: string): boolean =>
  previewPrefixes.some((prefix) => value.startsWith(prefix) && value.length > prefix.length);

/**
 * Emitted as the tile progresses. `partial` may fire 0..N times (based on
 * `partial_images` request param + upstream behavior); the tile finally
 * reaches a terminal state with one `done`, `failed`, or `canceled`. Consumers MUST
 * tolerate a tile that never sees a `partial` (when upstream skips them or
 * `partial_images=0`) and MUST treat a later terminal event as authoritative
 * over any preview already shown. `canceled` is wire-only and is never
 * persisted in the public Tile union.
 */
export const TileEventSchema = z.union([
  z.object({
    ...tileEventBase,
    status: z.literal('done'),
    url: z.string(),
    thumbUrl: z.optional(z.string()),
    ext: z.enum(MEDIA_EXTS),
    mime: z.enum(MEDIA_MIMES),
    completedAt: z.number(),
  }).check(z.refine(mediaPairMatches)),
  z.object({
    ...tileEventBase,
    status: z.literal('failed'),
    error: z.enum(TILE_ERROR_CATEGORIES),
    moderation: z.optional(GptModerationNoticeSchema),
    completedAt: z.number(),
  }),
  z.object({
    ...tileEventBase,
    status: z.literal('partial'),
    /** `data:` URL of the in-flight preview frame. */
    preview: z.string().check(z.refine(isPreviewDataUrl)),
    /** Monotonic ordinal of this partial within the tile (cliproxy `partial_image_index`). */
    index: z.number(),
  }),
  z.object({
    ...tileEventBase,
    status: z.literal('progress'),
    /** Overall weighted 0..1 fraction across every sampler pass; monotonic within a tile. */
    progress: z.number().check(z.gte(0), z.lte(1)),
    /** Raw graph node id of the sampler (or other node) that reported progress. */
    phase: z.optional(z.string()),
    /** 1-based current step within the active sampler pass (≤ `totalSteps`). */
    step: z.optional(z.number()),
    /** Step count of the active sampler pass, as reported at run time. */
    totalSteps: z.optional(z.number()),
    /** 1-based sampler pass in execution order (≤ `passCount`). */
    pass: z.optional(z.number()),
    /** Number of sampler passes in the submitted graph. */
    passCount: z.optional(z.number()),
  }),
  z.object({
    ...tileEventBase,
    status: z.literal('canceled'),
    completedAt: z.number(),
  }),
]);
export type TileEventWire = JsonFields<z.infer<typeof TileEventSchema>>;

export const DoneEventSchema = z.object({ batchId: z.string() });
export type DoneEventWire = JsonFields<z.infer<typeof DoneEventSchema>>;

// ─── Uploads, session and sequences ─────────────────────────────────────

export const UploadRefSchema = z.object({
  id: z.string(),
  mime: z.enum(TILE_MIMES),
  ext: z.enum(TILE_EXTS),
  sizeBytes: z.number(),
  width: z.number(),
  height: z.number(),
  createdAt: z.number(),
});
export type UploadRefWire = JsonFields<z.infer<typeof UploadRefSchema>>;

/** `GET /api/session`: the account's opaque cache scope. */
export const SessionResponseSchema = z.readonly(z.object({ cacheScope: z.string() }));
export type SessionResponseWire = JsonFields<z.infer<typeof SessionResponseSchema>>;

/** `POST /api/tiles/:tileId/handoff-frame`: the upload holding the clip's last frame. */
export const HandoffFrameResponseSchema = z.readonly(z.object({ uploadId: z.string() }));
export type HandoffFrameResponseWire = JsonFields<z.infer<typeof HandoffFrameResponseSchema>>;

// ─── Stories and character cards ────────────────────────────────────────

/** Plan-time shape of one story segment (also the POST /api/stories `plan` frame). */
export const StorySegmentPlanSchema = z.readonly(z.object({
  beat: z.string(),
  durationFrames: z.literal(VIDEO_DURATION_FRAMES),
}));
export type StorySegmentPlanWire = JsonFields<z.infer<typeof StorySegmentPlanSchema>>;

/** `POST /api/stories/:id/cancel` answer; the segment batch still rendering, if any. */
export const CancelStoryResponseSchema = z.readonly(z.object({ inflightBatchId: z.nullable(z.string()) }));
export type CancelStoryResponseWire = JsonFields<z.infer<typeof CancelStoryResponseSchema>>;

/** `GET /api/ephemera` body; the route is a leak-safe 404 when disabled. */
export const EphemeraStatusSchema = z.object({
  origin: z.string(),
  /** The server's character-card SSE lifetime (`EPHEMERA_CARD_TIMEOUT_MS`). */
  timeoutMs: z.number(),
});
export type EphemeraStatusWire = JsonFields<z.infer<typeof EphemeraStatusSchema>>;

/** `result` frame of the character-card stream: the character Ephemera kept. */
export const CharacterCardResultSchema = z.readonly(z.object({
  characterId: z.string(),
  name: z.string(),
  url: z.string(),
}));
export type CharacterCardResultWire = JsonFields<z.infer<typeof CharacterCardResultSchema>>;

// ─── AI fill results ────────────────────────────────────────────────────

/** `result` frame of `POST /api/prompts/ai-fill`. */
export const AiFillResultSchema = z.object({
  prompt: z.string(),
  fills: z.readonly(z.array(z.string())),
});
export type AiFillResultWire = JsonFields<z.infer<typeof AiFillResultSchema>>;

/** `result` frame of `POST /api/prompts/ai-fill/batch`; a failed item carries nothing else. */
export const AiFillBatchResultSchema = z.object({
  items: z.readonly(z.array(z.union([
    z.readonly(z.object({ ok: z.literal(true), prompt: z.string(), fills: z.readonly(z.array(z.string())) })),
    z.readonly(z.object({ ok: z.literal(false) })),
  ]))),
});
export type AiFillBatchResultWire = JsonFields<z.infer<typeof AiFillBatchResultSchema>>;

// ─── Library diagnosis and coverage ─────────────────────────────────────

export const ConflictingPairSchema = z.readonly(z.object({
  listA: z.string(),
  listB: z.string(),
  dimensionName: z.string(),
}));
export type ConflictingPairWire = JsonFields<z.infer<typeof ConflictingPairSchema>>;

export const LibraryDiagnosisEntrySchema = z.readonly(z.object({
  templateName: z.string(),
  /** null means the bounded solver could not establish a verdict. */
  satisfiable: z.nullable(z.boolean()),
  reason: z.optional(z.string()),
  conflictingPairs: z.optional(z.readonly(z.array(ConflictingPairSchema))),
}));
export type LibraryDiagnosisEntryWire = JsonFields<z.infer<typeof LibraryDiagnosisEntrySchema>>;

export const LibraryDiagnosisResponseSchema = z.readonly(z.object({
  templates: z.readonly(z.array(LibraryDiagnosisEntrySchema)),
  librarySnapshotHash: z.string(),
  templatesDigest: z.string(),
  /** Legacy boolean-only responses name every omitted inconclusive template. */
  incompleteTemplateNames: z.optional(z.readonly(z.array(z.string()))),
}));
export type LibraryDiagnosisResponseWire = JsonFields<z.infer<typeof LibraryDiagnosisResponseSchema>>;

export const CoverageUntaggedGroupSchema = z.readonly(z.object({
  listId: z.string(),
  listName: z.string(),
  dim: z.string(),
  untaggedCount: z.number(),
}));
export type CoverageUntaggedGroupWire = JsonFields<z.infer<typeof CoverageUntaggedGroupSchema>>;

export const CoverageLowListSchema = z.readonly(z.object({
  listName: z.string(),
  dim: z.string(),
  coverage: z.number(),
  taggedCount: z.number(),
  totalCount: z.number(),
}));
export type CoverageLowListWire = JsonFields<z.infer<typeof CoverageLowListSchema>>;

export const CoverageOrphanTagSchema = z.readonly(z.object({ dim: z.string(), label: z.string() }));
export type CoverageOrphanTagWire = JsonFields<z.infer<typeof CoverageOrphanTagSchema>>;

export const CoverageMissingDimensionSchema = z.readonly(z.object({ listName: z.string(), dim: z.string() }));
export type CoverageMissingDimensionWire = JsonFields<z.infer<typeof CoverageMissingDimensionSchema>>;

export const LibraryCoverageResponseSchema = z.readonly(z.object({
  untaggedByList: z.readonly(z.array(CoverageUntaggedGroupSchema)),
  lowCoverageLists: z.readonly(z.array(CoverageLowListSchema)),
  orphanTags: z.readonly(z.array(CoverageOrphanTagSchema)),
  missingDimensions: z.readonly(z.array(CoverageMissingDimensionSchema)),
  librarySnapshotHash: z.string(),
  templatesDigest: z.string(),
}));
export type LibraryCoverageResponseWire = JsonFields<z.infer<typeof LibraryCoverageResponseSchema>>;

// ─── Other stream frames ────────────────────────────────────────────────

/** `delta` frame of the enhance-prompt stream: the next slice of the rewrite. */
export const EnhanceDeltaSchema = z.object({ text: z.string() });
export type EnhanceDeltaWire = JsonFields<z.infer<typeof EnhanceDeltaSchema>>;

/** `prompt` frame of the brainstorm stream. */
export const BrainstormPromptSchema = z.object({ index: z.number(), text: z.string() });
export type BrainstormPromptWire = JsonFields<z.infer<typeof BrainstormPromptSchema>>;

/** `done` frame of the brainstorm stream. */
export const BrainstormDoneSchema = z.object({ count: z.number() });
export type BrainstormDoneWire = JsonFields<z.infer<typeof BrainstormDoneSchema>>;

/** `status` frame of POST /api/stories while the planner runs. */
export const StoryPlanStatusSchema = z.object({ phase: z.literal('planning') });
export type StoryPlanStatusWire = JsonFields<z.infer<typeof StoryPlanStatusSchema>>;

/** `plan` frame of POST /api/stories. */
export const StoryPlanSchema = z.object({
  storyId: z.string(),
  logline: z.string(),
  segments: z.readonly(z.array(StorySegmentPlanSchema)),
  /** Estimated render time; never negative. */
  etaMs: z.number().check(z.gte(0)),
});
export type StoryPlanWire = JsonFields<z.infer<typeof StoryPlanSchema>>;

/** `status` frame of the character-card stream. */
export const CharacterCardStatusSchema = z.object({
  phase: z.enum(['reading', 'writing', 'rewriting', 'saving']),
});
export type CharacterCardStatusWire = JsonFields<z.infer<typeof CharacterCardStatusSchema>>;

/** Advisory leading ai-fill frame naming the text model serving the fill. */
export const AiFillBackendFrameSchema = z.readonly(z.object({
  modelId: z.string().check(z.minLength(1)),
  label: z.string(),
}));
export type AiFillBackendFrameWire = JsonFields<z.infer<typeof AiFillBackendFrameSchema>>;

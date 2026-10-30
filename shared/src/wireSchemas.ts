// Public response schemas. Import this subpath explicitly so the wire-type
// barrel remains cheap for consumers that only need constants or types.
import * as z from 'zod/mini';
import { HISTORY_REFRESH_MAX_IDS, MAX_HISTORY_Q_LEN, MEDIA_EXT_MIME, MEDIA_EXTS, MEDIA_MIMES, RATIO_VALUES, TILE_ERROR_CATEGORIES, VIDEO_DURATION_FRAMES } from './index';
import { GptModerationNoticeSchema, type GptModerationNotice } from './moderation';

// JSON omits undefined fields. Preserve the project's exact optional-property
// contract while deriving DTOs from Zod's `field?: T | undefined` inference.
type JsonFields<T> = T extends GptModerationNotice ? T : T extends object
  ? { [K in keyof T]: JsonFields<Exclude<T[K], undefined>> }
  : T;

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
}).check(z.refine((tile) => MEDIA_EXT_MIME[tile.ext] === tile.mime));

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

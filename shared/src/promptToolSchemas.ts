// Response schemas of the prompt-library tooling (AI drafts, dimension
// inference, rescue, selection diagnosis). Only lazily loaded web modules use
// them, so they live behind their own subpath and stay out of the entry chunk.
import * as z from 'zod/mini';
import { GptModerationNoticeSchema } from './moderation';
import type { JsonFields } from './wireSchemas';

const bundleCommonShape = {
  key: z.string(),
  title: z.string(),
  detail: z.string(),
  impact: z.optional(z.string()),
  destructive: z.boolean(),
  defaultChecked: z.boolean(),
  dependsOn: z.readonly(z.array(z.string())),
};

export const BundleCommonSchema = z.readonly(z.object(bundleCommonShape));
export type BundleCommonWire = JsonFields<z.infer<typeof BundleCommonSchema>>;

export const DimensionBundleSchema = z.readonly(z.object({
  ...bundleCommonShape,
  kind: z.enum(['create', 'extend', 'merge', 'rename']),
  dimensionName: z.string(),
  optionCount: z.number(),
  listCount: z.number(),
}));
export type DimensionBundleWire = JsonFields<z.infer<typeof DimensionBundleSchema>>;

export const RescueBundleSchema = z.readonly(z.object({
  ...bundleCommonShape,
  kind: z.literal('rescue'),
  listName: z.string(),
  optionValue: z.string(),
  templateName: z.string(),
}));
export type RescueBundleWire = JsonFields<z.infer<typeof RescueBundleSchema>>;

export const DimensionChangeBundleSchema = z.union([DimensionBundleSchema, RescueBundleSchema]);

export const TemplateConflictSchema = z.readonly(z.object({
  templateName: z.string(),
  reason: z.string(),
  culpritBundleKeys: z.readonly(z.array(z.string())),
  rescueAttempted: z.boolean(),
  culpritKind: z.enum(['local', 'non-local']),
  inBranch: z.optional(z.number()),
  totalBranches: z.optional(z.number()),
}));
export type TemplateConflictWire = JsonFields<z.infer<typeof TemplateConflictSchema>>;

/** `done` terminal frame of POST /api/prompts/dimensions/rescue. */
export const RescueDonePayloadSchema = z.readonly(z.object({
  rescueBundle: RescueBundleSchema,
  conflicts: z.readonly(z.array(TemplateConflictSchema)),
}));
export type RescueDonePayloadWire = JsonFields<z.infer<typeof RescueDonePayloadSchema>>;

/**
 * `rescue-failed` terminal frame of POST /api/prompts/dimensions/rescue. A
 * provider failure or crash also carries the shared terminal error's `code`
 * and `retryAfterSeconds` (see SseTerminalError); older servers omit them and
 * `conflicts`.
 */
const rescueFailedPayloadObject = z.object({
  reason: z.string(),
  conflicts: z.optional(z.readonly(z.array(TemplateConflictSchema))),
  code: z.optional(z.string()),
  retryAfterSeconds: z.optional(z.number()),
  moderation: z.optional(GptModerationNoticeSchema),
});
export const RescueFailedPayloadSchema = z.readonly(rescueFailedPayloadObject);
export type RescueFailedPayloadWire = JsonFields<z.infer<typeof RescueFailedPayloadSchema>>;

/**
 * The part of a `rescue-failed` frame the client acts on. The optional
 * terminal-error detail is advisory there, so a reader that validates only
 * these fields lets it pass unchecked.
 */
export const RescueFailedPayloadCoreSchema = z.pick(rescueFailedPayloadObject, { reason: true, conflicts: true });

export const RejectedOpSchema = z.readonly(z.object({ reason: z.string(), count: z.number() }));
export type RejectedOpWire = JsonFields<z.infer<typeof RejectedOpSchema>>;

export const CoherenceWarningSchema = z.readonly(z.object({ templateName: z.string(), detail: z.string() }));
export type CoherenceWarningWire = JsonFields<z.infer<typeof CoherenceWarningSchema>>;

// Coverage warnings surfaced by the AI inference review. These are
// non-blocking — the user can still apply the proposal — but they flag the
// two failure modes that produce silent wildcards in production: tags
// created without any option assignment, and name-implied lists where the
// post-proposal coverage on the implied dimension stays below the prompt's
// ≥90% target. A third kind, `missingDimension`, fires when a list's name
// strongly implies a dimension that simply doesn't exist after the
// proposal.
export const CoverageWarningSchema = z.union([
  z.readonly(z.object({
    kind: z.literal('orphanTag'),
    dim: z.string(),
    label: z.string(),
    detail: z.string(),
  })),
  z.readonly(z.object({
    kind: z.literal('lowCoverage'),
    listName: z.string(),
    dim: z.string(),
    coverage: z.number(),
    taggedCount: z.number(),
    totalCount: z.number(),
    detail: z.string(),
  })),
  z.readonly(z.object({
    kind: z.literal('missingDimension'),
    listName: z.string(),
    dim: z.string(),
    detail: z.string(),
  })),
]);
export type CoverageWarningWire = JsonFields<z.infer<typeof CoverageWarningSchema>>;

export const DimensionProposalSchema = z.readonly(z.object({
  bundles: z.readonly(z.array(DimensionChangeBundleSchema)),
}));
export type DimensionProposalWire = JsonFields<z.infer<typeof DimensionProposalSchema>>;

export const InferDimensionsResponseSchema = z.readonly(z.object({
  proposalId: z.string(),
  proposal: DimensionProposalSchema,
  baseSnapshotHash: z.string(),
  warnings: z.readonly(z.array(CoherenceWarningSchema)),
  coverage: z.readonly(z.array(CoverageWarningSchema)),
  rejected: z.readonly(z.array(RejectedOpSchema)),
  conflicts: z.readonly(z.array(TemplateConflictSchema)),
  // Non-fatal coverage notices (e.g. "N lists couldn't be fully analyzed —
  // re-run to fill the gaps") surfaced when the run finalized with partial
  // coverage after some chunks failed. Optional for wire back/forward compat.
  notices: z.optional(z.readonly(z.array(z.string()))),
}));
export type InferDimensionsResponseWire = JsonFields<z.infer<typeof InferDimensionsResponseSchema>>;

export const InferPhaseEventSchema = z.readonly(z.object({
  phase: z.enum(['taxonomy', 'chunks', 'retry-gaps', 'finalize']),
}));
export type InferPhaseEventWire = JsonFields<z.infer<typeof InferPhaseEventSchema>>;

export const InferProgressEventSchema = z.readonly(z.object({
  done: z.number(),
  total: z.number(),
  wave: z.literal([1, 2]),
}));
export type InferProgressEventWire = JsonFields<z.infer<typeof InferProgressEventSchema>>;

export const DiagnoseSelectionResponseSchema = z.readonly(z.object({
  conflicts: z.readonly(z.array(TemplateConflictSchema)),
}));
export type DiagnoseSelectionResponseWire = JsonFields<z.infer<typeof DiagnoseSelectionResponseSchema>>;

export const DraftVariableListResponseSchema = z.union([
  z.object({ kind: z.literal('entries'), entries: z.array(z.string()) }),
  z.object({ kind: z.literal('clarify'), question: z.string() }),
]);
export type DraftVariableListResponseWire = JsonFields<z.infer<typeof DraftVariableListResponseSchema>>;

export const DraftTemplateResponseSchema = z.union([
  z.object({ kind: z.literal('body'), body: z.string(), warnings: z.readonly(z.array(z.string())) }),
  z.object({ kind: z.literal('clarify'), question: z.string() }),
]);
export type DraftTemplateResponseWire = JsonFields<z.infer<typeof DraftTemplateResponseSchema>>;

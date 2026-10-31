// zod/mini: the web validates these two wire shapes too, and the mini build
// keeps that client bundle small; the api consumes the same schemas.
import * as z from 'zod/mini';

export const GPT_MODERATION_REASONS = [
  'sexual-age', 'graphic-violence', 'sexual-age-and-violence', 'unavailable',
] as const;
export type GptModerationReason = (typeof GPT_MODERATION_REASONS)[number];

export const GptModerationCategoriesSchema = z.array(z.enum(['nudity', 'sexual-age', 'graphic-violence']))
  .check(z.minLength(1), z.maxLength(3), z.refine((categories) => new Set(categories).size === categories.length));
export type GptModerationCategory = z.infer<typeof GptModerationCategoriesSchema>[number];

/** Curated classifications only. Never contains prompts, scores or provider prose. */
export const GptModerationNoticeSchema = z.object({
  reason: z.enum(GPT_MODERATION_REASONS),
  target: z.enum(['text', 'image']),
  /** Absent on historical decisions that did not distinguish nudity from age. */
  categories: z.optional(GptModerationCategoriesSchema),
  /** Display name of the screened text model ("Not sent to <model>"). Absent on image targets and older decisions. */
  modelLabel: z.optional(z.string().check(z.minLength(1), z.maxLength(60))),
});
export type GptModerationNotice = z.infer<typeof GptModerationNoticeSchema>;

import { z } from 'zod';
import { RENDER_RESOLUTIONS, type ModelResolutionPutRequest } from '@atelier/shared';
import type { AssertWire, MatchesWire } from '../validation/wireBinding';

export const ModelResolutionModelParam = z.object({
  modelId: z.string().min(1).max(200),
});

const resolution = z.enum(RENDER_RESOLUTIONS).nullable().optional();

// null resets a mode to the model default; so does a value equal to it.
// `downscale: true` is the default ("Downsize to 2K" on). An absent key leaves
// that setting unchanged.
export const ModelResolutionPutBody = z.object({
  textToImage: resolution,
  reference: resolution,
  downscale: z.boolean().optional(),
}).strict()
  .refine((body) => body.textToImage !== undefined || body.reference !== undefined || body.downscale !== undefined, {
    error: 'at least one of textToImage, reference or downscale required',
  });
type _ModelResolutionPutWire = AssertWire<MatchesWire<typeof ModelResolutionPutBody, ModelResolutionPutRequest>>;

import { z } from 'zod';
import { RENDER_RESOLUTIONS } from '@atelier/shared';

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
    message: 'at least one of textToImage, reference or downscale required',
  });

import { z } from 'zod';
import { RENDER_RESOLUTIONS } from '@atelier/shared';

export const ModelResolutionModelParam = z.object({
  modelId: z.string().min(1).max(200),
});

const resolution = z.enum(RENDER_RESOLUTIONS).nullable().optional();

// null resets a mode to the model default; so does a value equal to it. An
// absent key leaves that mode unchanged.
export const ModelResolutionPutBody = z.object({
  textToImage: resolution,
  reference: resolution,
}).strict()
  .refine((body) => body.textToImage !== undefined || body.reference !== undefined, {
    message: 'at least one of textToImage or reference required',
  });

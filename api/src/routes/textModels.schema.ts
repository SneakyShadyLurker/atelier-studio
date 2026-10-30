import { z } from 'zod';
import { TEXT_REASONING_EFFORT_VALUES, TEXT_TASKS } from '@atelier/shared';

export const TextModelTaskParam = z.object({
  task: z.enum(TEXT_TASKS),
});

// `modelId` is a text model row id; null clears the pick and its effort. An
// omitted effort stores none (the model's default applies).
export const TextModelTaskPutBody = z.object({
  modelId: z.string().min(1).max(64).nullable(),
  effort: z.enum(TEXT_REASONING_EFFORT_VALUES).nullable().optional(),
});

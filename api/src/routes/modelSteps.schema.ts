import { z } from 'zod';
import { MODEL_STEPS_MAX, MODEL_STEPS_MIN, type ModelStepsPutRequest } from '@atelier/shared';
import type { AssertWire, MatchesWire } from '../validation/wireBinding';

export const ModelStepsModelParam = z.object({
  modelId: z.string().min(1).max(200),
});

// null resets to the model default; so does a value equal to it.
export const ModelStepsPutBody = z.object({
  steps: z.number().int().min(MODEL_STEPS_MIN).max(MODEL_STEPS_MAX).nullable(),
}).strict();
type _ModelStepsPutWire = AssertWire<MatchesWire<typeof ModelStepsPutBody, ModelStepsPutRequest>>;

import type { EnhancePromptRequest } from '@atelier/shared';
import type { AssertWire, MatchesWire } from '../validation/wireBinding';
import { z } from 'zod';
import { maxUtf16Length } from '../validation/stringLength';
import { refImageIdsSchema } from './_schema';
import { MAX_PROMPT_CHARS, RATIO_VALUES, VIDEO_DURATION_FRAMES } from '@atelier/shared';

// Pure shape validation only; no config-derived state. The prompt cap is the
// shared MAX_PROMPT_CHARS — the same bound GenerateRequestSchema.prompt uses.
export const EnhancePromptRequestSchema = z.object({
  prompt: z.string().trim().min(1).check(maxUtf16Length(MAX_PROMPT_CHARS)),
  refImageIds: refImageIdsSchema.optional(),
  modelId: z.string().trim().min(1).check(maxUtf16Length(128)).optional(),
  ratio: z.enum(RATIO_VALUES).optional(),
  durationFrames: z.literal(VIDEO_DURATION_FRAMES).optional(),
  sourcePrompt: z.string().trim().min(1).check(maxUtf16Length(MAX_PROMPT_CHARS)).optional(),
  extendContext: z.object({
    previousMotionPrompt: z.string().trim().min(1).check(maxUtf16Length(MAX_PROMPT_CHARS)),
    handoffUploadId: z.uuid(),
  }).optional(),
});

type _EnhancePromptRequestWire = AssertWire<MatchesWire<typeof EnhancePromptRequestSchema, EnhancePromptRequest>>;

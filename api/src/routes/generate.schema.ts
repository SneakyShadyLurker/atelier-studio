import type { GenerateRequest } from '@atelier/shared';
import type { AssertWire, MatchesWire } from '../validation/wireBinding';
import { z } from 'zod';
import { maxUtf16Length } from '../validation/stringLength';
import { refImageIdsSchema } from './_schema';
import { MAX_PROMPT_CHARS, MAX_TILE_COUNT, RATIO_VALUES, VIDEO_DURATION_FRAMES } from '@atelier/shared';

// Pure shape validation. Model existence and ratio support are checked in
// the route handler against the live Config-derived registry — the schema
// stays config-free so it isn't tempted to reach for module-scope state.
export const GenerateRequestSchema = z.object({
  prompt: z.string().trim().min(1).check(maxUtf16Length(MAX_PROMPT_CHARS)),
  modelId: z.string().min(1),
  ratio: z.enum(RATIO_VALUES),
  count: z.number().int().min(1).max(MAX_TILE_COUNT),
  seed: z.number().int().nonnegative().optional(),
  refImageIds: refImageIdsSchema.min(1).optional(),
  i2vSourceUploadId: z.uuid().optional(),
  extendsTileId: z.string().min(1).optional(),
  motionPrompt: z.string().check(maxUtf16Length(MAX_PROMPT_CHARS)).optional(),
  // Shape-only: membership in the SELECTED model's supportedDurations is
  // re-checked in the route, same split as ratio.
  durationFrames: z.literal(VIDEO_DURATION_FRAMES).optional(),
  provenance: z.object({
    templateId: z.string().min(1),
    rollSeed: z.number().int().nonnegative(),
    pins: z.record(z.string(), z.string()),
  }).optional(),
  // Identity of one logical roll per user, not a payload fingerprint.
  idempotencyKey: z.string().min(1).max(64).optional(),
});

type _GenerateRequestWire = AssertWire<MatchesWire<typeof GenerateRequestSchema, GenerateRequest>>;

import type { AiFillBatchRequest, AiFillRequest } from '@atelier/shared';
import type { AssertWire, MatchesWire } from '../../validation/wireBinding';
import { z } from 'zod';
import { maxUtf16Length } from '../../validation/stringLength';
import { MAX_PROMPT_CHARS } from '@atelier/shared';
import {
  AI_FILL_BATCH_MAX,
  AI_FILL_MAX_INPUT_CHARS,
  AI_FILL_MAX_INSTRUCTION_CHARS,
  AI_FILL_MAX_SLOTS,
  staticSegmentsLength,
} from '@atelier/shared/ai-fill';

const AiFillItemSchema = z
  .object({
    staticSegments: z.array(z.string()).min(2),
    // An instruction is a throwaway compile directive — it never reaches the
    // image model (only the spliced final prompt does, capped below). So it is
    // bounded NOT by the image-prompt cap but by the text backend's input budget - see
    // AI_FILL_MAX_INSTRUCTION_CHARS. The total-input refine below is the real
    // ceiling; this per-item bound is the anti-abuse guard on a single field.
    instructions: z.array(z.string().trim().min(1).check(maxUtf16Length(AI_FILL_MAX_INSTRUCTION_CHARS))).min(1).max(AI_FILL_MAX_SLOTS),
  })
  .refine((v) => v.instructions.length === v.staticSegments.length - 1, {
    message: 'instructions.length must equal staticSegments.length - 1',
    path: ['instructions'],
  })
  .refine((v) => staticSegmentsLength(v.staticSegments) < MAX_PROMPT_CHARS, {
    message: 'prompt already exceeds the maximum length before filling',
    path: ['staticSegments'],
  })
  .refine(
    (v) =>
      staticSegmentsLength(v.staticSegments)
        + v.instructions.reduce((n, s) => n + s.length, 0)
        < AI_FILL_MAX_INPUT_CHARS,
    { message: 'total ai-fill input (static + instructions) is too large', path: ['instructions'] },
  );

export const AiFillRequestSchema = AiFillItemSchema.and(
  z.object({
    modelId: z.string().min(1),
    // Simulate-only preview flag — same path as Generate. Optional; absent =
    // Generate path.
    simulate: z.boolean().optional(),
  }),
);

export const AiFillBatchRequestSchema = z
  .object({
    items: z.array(AiFillItemSchema).min(1).max(AI_FILL_BATCH_MAX),
    modelId: z.string().min(1),
  })
  .refine(
    (value) => value.items.reduce(
      (batchTotal, item) => batchTotal
        + staticSegmentsLength(item.staticSegments)
        + item.instructions.reduce((total, instruction) => total + instruction.length, 0),
      0,
    ) < AI_FILL_MAX_INPUT_CHARS,
    {
      message: 'total ai-fill batch input (static + instructions across all items) is too large',
      path: ['items'],
    },
  );

export type AiFillRequestParsed = z.infer<typeof AiFillRequestSchema>;
export type AiFillBatchRequestParsed = z.infer<typeof AiFillBatchRequestSchema>;

type _AiFillRequestWire = AssertWire<MatchesWire<typeof AiFillRequestSchema, AiFillRequest>>;
type _AiFillBatchRequestWire = AssertWire<MatchesWire<typeof AiFillBatchRequestSchema, AiFillBatchRequest>>;

import type { BrainstormCharactersRequest } from '@atelier/shared';
import type { AssertWire, MatchesWire } from '../validation/wireBinding';
import { z } from 'zod';
import { maxUtf16Length } from '../validation/stringLength';
import {
  BRAINSTORM_LAYOUTS,
  BRAINSTORM_MEDIA,
  BRAINSTORM_MIN_COUNT,
  BRAINSTORM_MAX_COUNT_CEILING,
  BRAINSTORM_VARIATION_SEED_MAX,
} from '@atelier/shared';
import { CHARACTER_SOURCE_TEXT_MAX_CHARS } from '@atelier/shared/character-source-text';

export const BrainstormCharactersRequestSchema = z.object({
  brief: z.string().trim().check(maxUtf16Length(CHARACTER_SOURCE_TEXT_MAX_CHARS)).optional(),
  count: z.number().int().min(BRAINSTORM_MIN_COUNT).max(BRAINSTORM_MAX_COUNT_CEILING),
  layout: z.enum(BRAINSTORM_LAYOUTS).optional(),
  medium: z.enum(BRAINSTORM_MEDIA).optional(),
  modelId: z.string().trim().min(1).check(maxUtf16Length(200)),
  textModelId: z.string().trim().min(1).check(maxUtf16Length(200)).optional(),
  variationSeed: z.number().int().nonnegative().max(BRAINSTORM_VARIATION_SEED_MAX).optional(),
});

type _BrainstormCharactersRequestWire = AssertWire<MatchesWire<typeof BrainstormCharactersRequestSchema, BrainstormCharactersRequest>>;

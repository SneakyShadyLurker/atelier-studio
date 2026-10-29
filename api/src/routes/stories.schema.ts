import { z } from 'zod';
import { maxUtf16Length } from '../validation/stringLength';
import { uuidParam } from './_schema';
import { RATIO_VALUES, STORY_OUTLINE_MAX_CHARS } from '@atelier/shared';

export const StoryCreateBodySchema = z.object({
  outline: z.string().trim().min(1).check(maxUtf16Length(STORY_OUTLINE_MAX_CHARS)),
  sourceUploadId: z.uuid().optional(),
  extendsTileId: z.string().min(1).optional(),
  sourcePrompt: z.string().check(maxUtf16Length(8000)).optional(),
  ratio: z.enum(RATIO_VALUES).optional(),
});

export const StoryIdParamSchema = uuidParam('id');

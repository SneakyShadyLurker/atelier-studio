import { z } from 'zod';
import type { PromptCondensePutRequest } from '@atelier/shared';
import type { AssertWire, MatchesWire } from '../validation/wireBinding';

export const PromptCondensePutBody = z.object({
  enabled: z.boolean(),
}).strict();
type _PromptCondensePutWire = AssertWire<MatchesWire<typeof PromptCondensePutBody, PromptCondensePutRequest>>;

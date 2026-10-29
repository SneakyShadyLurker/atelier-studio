import { z } from 'zod';
import { AI_FILL_BACKEND_VALUES, TEXT_BACKEND_WORKLOADS, TEXT_REASONING_EFFORT_VALUES } from '@atelier/shared';

export const TextBackendWorkloadParam = z.object({
  workload: z.enum(TEXT_BACKEND_WORKLOADS),
});

// `effort` omitted keeps a stored effort the backend still accepts; null resets it.
export const TextBackendPutBody = z.object({
  backend: z.enum(AI_FILL_BACKEND_VALUES).nullable(),
  effort: z.enum(TEXT_REASONING_EFFORT_VALUES).nullable().optional(),
});

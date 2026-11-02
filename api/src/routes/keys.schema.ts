import { z } from 'zod';
import { maxUtf16Length } from '../validation/stringLength';

export const PutKeyBody = z.object({
  key: z
    .string()
    .trim()
    .min(20)
    .check(maxUtf16Length(256))
    .regex(/^[A-Za-z0-9_\-.]+$/, 'invalid key shape'),
});

export type PutKeyBody = z.infer<typeof PutKeyBody>;

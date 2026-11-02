import * as z from 'zod/mini';
import { GptModerationNoticeSchema } from './moderation';

// `code` stays an open string on the wire. Only `quota-exhausted` carries
// client behaviour (QuotaExhaustedError + a retry); other codes (e.g. the
// ai-fill route's `count-mismatch` / `over-length`) just surface `message`. A
// closed enum here would FAIL the whole parse on an unknown code and collapse
// the server's helpful message into a generic "request failed". Matches
// AiFillSseEvent.code?: string.
export const SseTerminalErrorSchema = z.object({
  message: z.string(),
  code: z.optional(z.string()),
  retryAfterSeconds: z.optional(z.int().check(z.nonnegative())),
  moderation: z.optional(GptModerationNoticeSchema),
});
export type SseTerminalError = z.infer<typeof SseTerminalErrorSchema>;

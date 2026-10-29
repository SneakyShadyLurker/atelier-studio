// Generic base64url JSON cursor codec used by history and archive paginated
// reads. Each route brings its own Zod schema validating the decoded payload
// shape — `decodeCursor` returns `null` on malformed input so the route can
// translate that into the documented 400 "invalid cursor" response.
import type { ZodType } from 'zod';

// 4 KB is two orders of magnitude beyond any real cursor (~100 bytes for our
// schemas) — bounds the base64 decode + JSON.parse against an unbounded query
// param hitting Bun's allocator before Zod runs.
const MAX_CURSOR_RAW_LENGTH = 4096;

export function encodeCursor(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor<T>(
  raw: string | undefined,
  schema: ZodType<T>,
): T | null {
  if (!raw) return null;
  if (raw.length > MAX_CURSOR_RAW_LENGTH) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    const parsed = schema.safeParse(value);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

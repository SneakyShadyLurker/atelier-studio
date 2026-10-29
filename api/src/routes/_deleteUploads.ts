import { MAX_DELETE_KEEP_UPLOADS } from '@atelier/shared';
import type { Context } from 'hono';
import type { AppEnv } from '../server-env';
import { invalidFieldResponse, parseBody, type ParseResult } from './_http';
import { DeleteUploadsBodySchema } from './_schema';

// Call after query validation and before any mutation or cancellation lookup.
// No-body clients retain their query-only contract. Never truncate holds.
export async function parseDeleteKeepUploads(
  c: Context<AppEnv>,
  queryKeepUploads: readonly string[],
): Promise<ParseResult<string[]>> {
  let bodyKeepUploads: string[] = [];
  if (c.req.raw.body !== null) {
    const body = await parseBody(c, DeleteUploadsBodySchema);
    if (!body.ok) return body;
    bodyKeepUploads = body.value.keepUploads;
  }
  const keepUploads = [...new Set([...queryKeepUploads, ...bodyKeepUploads])];
  if (keepUploads.length > MAX_DELETE_KEEP_UPLOADS) {
    return {
      ok: false,
      response: invalidFieldResponse(c, 'keepUploads', `at most ${MAX_DELETE_KEEP_UPLOADS} upload holds are allowed`),
    };
  }
  return { ok: true, value: keepUploads };
}

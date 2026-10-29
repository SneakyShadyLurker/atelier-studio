import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../server-env';

export const MAX_JSON_REQUEST_BYTES = 1024 * 1024;
// OptionsReplaceV2 allows 2,000 options, each with 2,000 UTF-16 code units
// (up to 24 MB when JSON-escaped), 50 required + 50 excluded UUID tags
// (~7.8 MB in conventional UUID encoding), and bounded metadata. 48 MiB
// accommodates these maxima, plus the smaller template/ai-fill schemas.
// This is a finite transport budget, not a promise to accept arbitrarily
// padded JSON or every possible spelling of escaped keys/UUIDs/numbers.
export const MAX_PROMPT_LIBRARY_JSON_REQUEST_BYTES = 48 * 1024 * 1024;

export const jsonBodyLimit = () => createMiddleware<AppEnv>(async (c, next) => {
  const raw = c.req.raw;
  // Multipart admission and its 53 MiB envelope remain owned by uploads.ts.
  if (!raw.body || ['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) || c.req.path === '/api/uploads') {
    return next();
  }
  const library = c.req.path === '/api/prompts' || c.req.path.startsWith('/api/prompts/');
  const maxSize = library ? MAX_PROMPT_LIBRARY_JSON_REQUEST_BYTES : MAX_JSON_REQUEST_BYTES;
  const tooLarge = () => c.json({ error: 'request body too large' }, 413);
  if (Number(c.req.header('Content-Length')) > maxSize) {
    void raw.body.cancel().catch(() => undefined);
    return tooLarge();
  }

  // Count actual bytes even when Content-Length is absent or dishonest. The
  // installed Hono bodyLimit skips its reader for a supplied Content-Length.
  const reader = raw.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const onAbort = () => { void reader.cancel(raw.signal.reason).catch(() => undefined); };
  raw.signal.addEventListener('abort', onAbort, { once: true });
  try {
    raw.signal.throwIfAborted();
    for (;;) {
      const result = await reader.read();
      raw.signal.throwIfAborted();
      if (result.done) break;
      const value: unknown = result.value;
      if (!(value instanceof Uint8Array)) return c.json({ error: 'invalid JSON' }, 400);
      size += value.byteLength;
      if (size > maxSize) return tooLarge();
      chunks.push(value);
    }
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  } finally {
    raw.signal.removeEventListener('abort', onAbort);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  c.req.raw = new Request(raw, {
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
  });
  return next();
});

import { createMiddleware } from 'hono/factory';
import { RETRY_AFTER_FIELD, type ApiErrorCode } from '@atelier/shared';
import type { AppEnv } from '../server-env';
import { JsonBodyQueueFullError, withJsonBodySlot } from './json-body-runtime';

export const MAX_JSON_REQUEST_BYTES = 1024 * 1024;
// OptionsReplaceV2 allows 2,000 options, each with 2,000 UTF-16 code units
// (up to 24 MB when JSON-escaped), 50 required + 50 excluded UUID tags
// (~7.8 MB in conventional UUID encoding), and bounded metadata. 48 MiB
// accommodates these maxima, plus the smaller template/ai-fill schemas.
// This is a finite transport budget, not a promise to accept arbitrarily
// padded JSON or every possible spelling of escaped keys/UUIDs/numbers.
export const MAX_PROMPT_LIBRARY_JSON_REQUEST_BYTES = 48 * 1024 * 1024;
const DEFAULT_BODY_READ_TIMEOUT_MS = 60_000;
const DEFAULT_LARGE_BODY_READ_TIMEOUT_MS = 600_000;
const DEFAULT_QUEUE_WAIT_TIMEOUT_MS = 60_000;
let bodyReadTimeoutMs = DEFAULT_BODY_READ_TIMEOUT_MS;
let largeBodyReadTimeoutMs = DEFAULT_LARGE_BODY_READ_TIMEOUT_MS;
let queueWaitTimeoutMs = DEFAULT_QUEUE_WAIT_TIMEOUT_MS;

export function setJsonBodyReadTimeoutForTests(ms: number | null, options?: { queueWaitMs?: number; largeReadMs?: number }): void {
  bodyReadTimeoutMs = ms ?? DEFAULT_BODY_READ_TIMEOUT_MS;
  largeBodyReadTimeoutMs = options?.largeReadMs ?? DEFAULT_LARGE_BODY_READ_TIMEOUT_MS;
  queueWaitTimeoutMs = options?.queueWaitMs ?? DEFAULT_QUEUE_WAIT_TIMEOUT_MS;
}

export const jsonBodyLimit = () => createMiddleware<AppEnv>(async (c, next) => {
  const raw = c.req.raw;
  // Multipart admission and its 53 MiB envelope remain owned by uploads.ts.
  if (!raw.body || ['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) || c.req.path === '/api/uploads') {
    return next();
  }
  const body = raw.body;
  if (c.req.method === 'POST' && /^\/api\/tiles\/[^/]+\/handoff-frame$/.test(c.req.path)) {
    void body.cancel().catch(() => undefined);
    // The gated route rejects the still-present, cancelled body before looking
    // up an artifact. Bypass JSON admission while preserving its feature gate.
    return next();
  }
  const library = c.req.path === '/api/prompts' || c.req.path.startsWith('/api/prompts/');
  if (library && !c.var.config.PROMPT_LIBRARY_USERS.has(c.var.userId)) {
    void raw.body.cancel().catch(() => undefined);
    return c.json({ error: 'not found' }, 404);
  }
  const declaredLength = c.req.header('Content-Length');
  const smallLength = declaredLength !== undefined && /^\d+$/.test(declaredLength)
    && Number.isSafeInteger(Number(declaredLength)) && Number(declaredLength) <= MAX_JSON_REQUEST_BYTES;
  const large = library && !smallLength;
  const credentials = c.req.method === 'PUT' && c.req.path.startsWith('/api/keys/');
  const maxSize = large ? MAX_PROMPT_LIBRARY_JSON_REQUEST_BYTES : MAX_JSON_REQUEST_BYTES;
  const tooLarge = () => c.json({ error: 'request body too large' }, 413);
  if (Number(c.req.header('Content-Length')) > maxSize) {
    void raw.body.cancel().catch(() => undefined);
    return tooLarge();
  }

  // JSON has its own bounded admission so slow media work cannot block control
  // requests. Queue wait and admitted reads have independent deadlines; an old
  // queue signal can never cancel an active read or mask a downstream error.
  const queueDeadline = AbortSignal.timeout(queueWaitTimeoutMs);
  const queueSignal = AbortSignal.any([raw.signal, queueDeadline]);
  const admission = { entered: false };
  try {
    await withJsonBodySlot(c.var.userId, async () => {
      admission.entered = true;
      const readDeadline = AbortSignal.timeout(large ? largeBodyReadTimeoutMs : bodyReadTimeoutMs);
      const signal = AbortSignal.any([raw.signal, readDeadline]);
      // Count actual bytes even when Content-Length is absent or dishonest. The
      // installed Hono bodyLimit skips its reader for a supplied Content-Length.
      const reader = body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      const onAbort = () => { void reader.cancel(signal.reason).catch(() => undefined); };
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        signal.throwIfAborted();
        for (;;) {
          const result = await reader.read();
          signal.throwIfAborted();
          if (result.done) break;
          const value: unknown = result.value;
          if (!(value instanceof Uint8Array)) { c.res = c.json({ error: 'invalid JSON' }, 400); return; }
          size += value.byteLength;
          if (size > maxSize) { c.res = tooLarge(); return; }
          chunks.push(value);
        }
      } catch {
        c.res = readDeadline.aborted
          ? c.json({ error: 'request body timed out' }, 408, { 'Retry-After': '5' })
          : c.json({ error: 'invalid JSON' }, 400);
        return;
      } finally {
        signal.removeEventListener('abort', onAbort);
        await reader.cancel().catch(() => undefined);
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
      // Admission stays held through downstream parsing, where Hono
      // materializes the JSON/string representation. Only reading observes the
      // read deadline; completed reads and downstream work cannot time out here.
      await next();
    }, queueSignal, credentials ? 'credentials' : large ? 'large' : 'small');
  } catch (error) {
    if (admission.entered) throw error;
    await raw.body.cancel().catch(() => undefined);
    if (queueDeadline.aborted) return c.json({ error: 'request body timed out' }, 408, { 'Retry-After': '5' });
    if (raw.signal.aborted) return c.json({ error: 'invalid JSON' }, 400);
    if (error instanceof JsonBodyQueueFullError) return c.json({
      error: error.message,
      code: 'QUEUE_FULL' satisfies ApiErrorCode,
      [RETRY_AFTER_FIELD]: 5,
    }, 429, { 'Retry-After': '5' });
    throw error;
  }
});

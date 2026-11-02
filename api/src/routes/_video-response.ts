import parseRange from 'range-parser';
import { VIDEO_MIME } from '@atelier/shared';
import { VIDEO_CACHE_IDLE_TTL_MS, type DecryptedVideoLease } from '../storage/decryptedVideoCache';
import { artifactResponseHeaders } from './_artifact-response';

// Bun's native sendfile Range response does not expose reader completion.
// Slice the leased file and stream with backpressure so eviction cannot refund
// a file still held by a slow response. range-parser owns the HTTP grammar.
export function videoResponse(lease: DecryptedVideoLease, request: Request, idleTimeoutMs = VIDEO_CACHE_IDLE_TTL_MS): Response {
  try {
    const size = lease.file.size;
    const headers = new Headers({ ...artifactResponseHeaders(VIDEO_MIME), 'Accept-Ranges': 'bytes' });
    let start = 0;
    let end = size - 1;
    let status = 200;
    const range = request.headers.get('Range');
    // These private/no-store responses publish no validator. If-Range therefore
    // cannot match, and the representation must be sent in full.
    if (request.method === 'GET' && range !== null && /^bytes=/i.test(range) && !request.headers.has('If-Range')) {
      const parsed = parseRange(size, range, { combine: true });
      if (parsed === -1) {
        lease.release();
        headers.set('Content-Range', `bytes */${size}`);
        headers.set('Content-Length', '0');
        return new Response(null, { status: 416, headers });
      }
      if (parsed !== -2 && parsed.type.toLowerCase() === 'bytes' && parsed.length === 1) {
        const selected = parsed[0];
        if (selected) {
          ({ start, end } = selected);
          status = 206;
          headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
        }
      }
    }
    headers.set('Content-Length', String(Math.max(0, end - start + 1)));
    if (request.method === 'HEAD' || size === 0) {
      lease.release();
      return new Response(null, { status, headers });
    }

    const reader = lease.file.slice(start, end + 1).stream().getReader();
    let closing: Promise<void> | undefined;
    let stopped = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let output: ReadableStreamDefaultController<Uint8Array>;
    const close = (reason?: unknown): Promise<void> => {
      stopped = true;
      clearTimeout(idleTimer);
      request.signal.removeEventListener('abort', onAbort);
      closing ??= (async () => {
        try { await reader.cancel(reason); }
        finally { reader.releaseLock(); lease.release(); }
      })();
      return closing;
    };
    const fail = async (error: unknown): Promise<void> => {
      await close(error).catch(() => undefined);
      // Error rather than close: a truncated response must not look like EOF
      // while retaining its original Content-Length. error() is safe after cancel.
      output.error(error);
    };
    const onAbort = (): void => { void fail(request.signal.reason).catch(() => undefined); };
    const refreshIdleTimer = (): void => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { void fail(new Error('video playback idle timeout')).catch(() => undefined); }, idleTimeoutMs);
      idleTimer.unref();
    };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        output = controller;
        // An abandoned response may never be pulled, so start its deadline now.
        refreshIdleTimer();
      },
      async pull(controller) {
        try {
          if (stopped) return;
          request.signal.throwIfAborted();
          const { done, value } = await reader.read();
          if (closing) return;
          if (done) { await close(); controller.close(); }
          else {
            if (value.byteLength > 0) refreshIdleTimer();
            controller.enqueue(value);
          }
        } catch (error) {
          await fail(error);
        }
      },
      cancel: close,
    }, { highWaterMark: 0 });
    request.signal.addEventListener('abort', onAbort, { once: true });
    if (request.signal.aborted) onAbort();
    return new Response(body, { status, headers });
  } catch (error) {
    lease.release();
    throw error;
  }
}

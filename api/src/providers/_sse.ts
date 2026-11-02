import { nextSseFrame, parseSseFrame, SSE_TERMINATOR_REWIND } from '@atelier/shared/sse';
import type { SseFrame } from '@atelier/shared/sse';
import { tryParseJson } from './_http';

// The api's name for a parsed SSE frame. The parser primitive itself is
// shared with the web client (shared/src/sse.ts) so both sides of the wire
// agree on the frame grammar; this module only adds the streaming +
// byte-limit wrapper the provider adapters need. `raw` carries the frame's
// unparsed text so adapters can recover payloads a spec-compliant parse
// drops (CLIProxyAPI pretty-prints JSON across lines without per-line
// `data:` prefixes — see frameDataText in cliproxy.ts).
export type ParsedSseFrame = SseFrame & { raw: string };

// The oversize callback MUST throw — the `: never` return makes a
// normally-returning implementation a compile error. Each adapter supplies
// its own typed error (mirrors _http.ts BoundedReadOptions.onOversize).
export type OnSseOversize = (limit: number, total: number) => never;

// CLIProxyAPI (7.2.50) pretty-prints JSON payloads inside SSE frames: only
// the first line carries the `data:` prefix, so the spec-compliant parser
// keeps `{` and drops the continuation lines (they read as unknown SSE
// fields). This mangled every in-stream image error — output-stage moderation
// surfaced as a generic `raw: "{"` provider failure. Recover by
// re-reading the raw frame from its first data line onward, prefix stripped,
// continuation lines kept verbatim — used only when that text parses as JSON
// while the spec-parsed data does not. Every readSseFrames consumer should
// read payloads through this accessor rather than frame.data directly.
export function frameDataText(frame: ParsedSseFrame): string {
  if (typeof tryParseJson(frame.data) !== 'string') return frame.data;
  const match = /^data:[ ]?/m.exec(frame.raw);
  if (!match) return frame.data;
  const candidate = frame.raw.slice(match.index + match[0].length);
  return typeof tryParseJson(candidate) !== 'string' ? candidate : frame.data;
}

export async function* readSseFrames(
  body: ReadableStream<Uint8Array>,
  byteLimit: number,
  onOversize: OnSseOversize,
  signal?: AbortSignal,
): AsyncGenerator<ParsedSseFrame> {
  // Fail fast on an already-aborted signal. Without this, the first
  // `reader.read()` would still issue against the socket and only abort
  // once the cancel below fired.
  if (signal?.aborted) throw signal.reason;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let searchFrom = 0;
  let total = 0;
  // Bridge external abort onto the underlying body so a stalled chunk
  // read returns promptly. `cancel(reason)` propagates the typed reason
  // rather than an unspecified AbortError.
  const onExternalAbort = (): void => {
    void reader.cancel(signal?.reason);
  };
  if (signal) {
    signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  try {
    for (;;) {
      const result = await reader.read();
      // Between-chunks guard: an abort that lands while we were buffered
      // in `reader.read()` must surface as the signal's reason, not as
      // silent termination of the generator. The check runs BEFORE
      // inspecting `result.done` because `reader.cancel()` resolves the
      // next read as {done: true}, which would otherwise silently end
      // the loop.
      if (signal?.aborted) throw signal.reason;
      if (result.done) break;
      const chunk: Uint8Array = result.value;
      total += chunk.byteLength;
      if (total > byteLimit) onOversize(byteLimit, total);
      buffer += decoder.decode(chunk, { stream: true });
      for (;;) {
        const next = nextSseFrame(buffer, searchFrom);
        if (!next) {
          // No full frame yet; the next chunk resumes scanning near the end,
          // rewound so a terminator straddling the chunk boundary still matches.
          searchFrom = Math.max(0, buffer.length - SSE_TERMINATOR_REWIND);
          break;
        }
        buffer = next.rest;
        searchFrom = 0;
        const parsed = parseSseFrame(next.raw);
        if (parsed) yield { ...parsed, raw: next.raw };
      }
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onExternalAbort);
    // cancel() (not releaseLock()) propagates to the body so the underlying
    // socket releases promptly on normal early-return.
    try {
      await reader.cancel();
    } catch {
      // best-effort; reader may already be cancelled/released
    }
  }
}

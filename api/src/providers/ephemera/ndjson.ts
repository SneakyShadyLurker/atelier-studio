// Bounded NDJSON line reader for the Ephemera character-card stream. Yields
// each non-blank line (Ephemera's keepalives are blank lines) and refuses a
// body past `maxBytes`, so a hostile or runaway peer cannot grow memory.

export class NdjsonOversizeError extends Error {
  constructor(maxBytes: number) {
    super(`ndjson body exceeded ${maxBytes} bytes`);
    this.name = 'NdjsonOversizeError';
  }
}

export interface NdjsonReadOptions {
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
}

export async function* readNdjsonLines(
  body: ReadableStream<Uint8Array>,
  options: NdjsonReadOptions,
): AsyncGenerator<string, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let buffered = '';
  try {
    for (;;) {
      options.signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > options.maxBytes) throw new NdjsonOversizeError(options.maxBytes);
      buffered += decoder.decode(value, { stream: true });
      let newline = buffered.indexOf('\n');
      while (newline !== -1) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line.length > 0) yield line;
        newline = buffered.indexOf('\n');
      }
    }
    const last = (buffered + decoder.decode()).trim();
    if (last.length > 0) yield last;
  } finally {
    // Releases the connection when the caller stops early (terminal event,
    // oversize, abort); a no-op once the body is fully read.
    await reader.cancel().catch(() => undefined);
  }
}

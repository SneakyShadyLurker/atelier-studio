import { MAX_STREAM_RESERVATION_BYTES } from '../storage/ffmpeg';

export interface BoundedReadOptions {
  // Called when the cumulative byte count exceeds `limit`. The callback MUST
  // throw — the `: never` return type makes this a compile-time error to
  // violate (a function that returns normally cannot satisfy `=> never`).
  // The surrounding finally releases the reader before the throw propagates.
  // Adapters supply this so the thrown error carries adapter-specific metadata
  // (`CliproxyResponseTooLargeError`, `ComfyuiResponseTooLargeError`,
  // `GoogleResponseTooLargeError`) without coupling this helper to either.
  // `prefix` contains at most `limit` bytes from the start of the response.
  // It lets an adapter retain cleanup metadata (for example an accepted
  // upstream job id) without buffering the oversized remainder.
  onOversize: (limit: number, total: number, prefix: Uint8Array) => never;
  // Optional caller-owned abort signal. Checked between every reader.read()
  // so a parent abort (orchestrator tile timeout, route teardown) interrupts
  // the loop deterministically instead of relying on Bun's fetch
  // signal-to-body propagation (a runtime internal that may decouple in a
  // future version). On abort the reader is cancelled in the finally and the
  // function throws an AbortError.
  signal?: AbortSignal;
  // Exact body length when the caller already knows it (for example from an
  // authoritative status read). The read then allocates once and fails on a
  // body that runs past it (through `onOversize`) or ends short of it.
  expectedBytes?: number;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const reason: unknown = signal.reason;
  if (reason instanceof Error) throw reason;
  const err = new Error('aborted');
  err.name = 'AbortError';
  throw err;
}

// Thrown when a body ends before the length the caller expected. Overflow
// past that length goes through `onOversize` like any other byte cap.
export class ResponseLengthMismatchError extends Error {
  readonly expected: number;
  readonly received: number;
  constructor(expected: number, received: number) {
    super(`response ended after ${received} of ${expected} expected bytes`);
    this.name = 'ResponseLengthMismatchError';
    this.expected = expected;
    this.received = received;
  }
}

// Reads the body into one buffer so a large output never sits in the heap
// twice as a chunk list plus its concatenated copy. With `expectedBytes` the
// buffer is allocated once at `min(expectedBytes, limit)`, so an untrusted
// length never sizes an allocation past the cap. Without it the buffer is a
// resizable reservation grown geometrically, as `readStreamWithCap` does.
export async function readBytesBounded(
  body: ReadableStream<Uint8Array>,
  limit: number,
  opts: BoundedReadOptions,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const expected = opts.expectedBytes;
  const cap = expected === undefined ? limit : Math.min(expected, limit);
  const buffer = expected === undefined
    ? new ArrayBuffer(0, { maxByteLength: Math.min(limit, MAX_STREAM_RESERVATION_BYTES) })
    : new ArrayBuffer(cap);
  let total = 0;
  // Audit T2-003: a between-chunks throwIfAborted is invisible during a
  // pending reader.read() — a stalled upstream could pin the call past the
  // abort budget. Wire an abort listener to cancel() the reader so the
  // in-flight read rejects promptly with the signal's reason.
  const signal = opts.signal;
  const onAbort = (): void => {
    void reader.cancel(signal?.reason).catch(() => { /* best-effort */ });
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    throwIfAborted(signal);
    for (let result = await reader.read(); !result.done; result = await reader.read()) {
      // Check AFTER the read returns so a signal that fires while a chunk was
      // in flight doesn't process that chunk and short-circuits the next
      // read. Bun's fetch implementation already rejects an in-flight read
      // when the request signal aborts, but this guard keeps the loop
      // correct if a caller passes a signal unrelated to the originating
      // fetch (e.g., a composed AbortSignal.any([...])).
      throwIfAborted(signal);
      const chunk: Uint8Array = result.value;
      const next = total + chunk.byteLength;
      if (next > cap || next > buffer.maxByteLength) {
        opts.onOversize(cap, next, boundedPrefix(new Uint8Array(buffer, 0, total), chunk, cap));
      }
      if (next > buffer.byteLength) buffer.resize(Math.min(buffer.maxByteLength, Math.max(next, buffer.byteLength * 2)));
      new Uint8Array(buffer, total, chunk.byteLength).set(chunk);
      total = next;
    }
    // The reader returned done — if abort fired during the final read, the
    // cancel() short-circuits the stream but a normal-looking done can mask
    // it. Re-check.
    throwIfAborted(signal);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    // cancel() (not releaseLock) propagates to the body so the underlying
    // socket releases on abort / oversize / network-error paths. Idempotent
    // on success.
    try { await reader.cancel(); } catch { /* best-effort */ }
  }
  if (expected !== undefined && total !== expected) throw new ResponseLengthMismatchError(expected, total);
  if (total === 0) return new Uint8Array(0);
  // Hand back a fixed-length buffer: WebCrypto and some native consumers
  // reject a view over a resizable one.
  return new Uint8Array(buffer.resizable ? buffer.transferToFixedLength(total) : buffer, 0, total);
}

function boundedPrefix(stored: Uint8Array, finalChunk: Uint8Array, limit: number): Uint8Array {
  const prefix = new Uint8Array(Math.min(limit, stored.byteLength + finalChunk.byteLength));
  prefix.set(stored.subarray(0, prefix.byteLength));
  if (stored.byteLength < prefix.byteLength) prefix.set(finalChunk.subarray(0, prefix.byteLength - stored.byteLength), stored.byteLength);
  return prefix;
}

export async function readBodyBounded(
  response: Response,
  limit: number,
  opts: BoundedReadOptions,
): Promise<string> {
  if (!response.body) return response.statusText;
  const bytes = await readBytesBounded(response.body as ReadableStream<Uint8Array>, limit, opts);
  return bytes.byteLength === 0 ? '' : new TextDecoder().decode(bytes);
}

export function tryParseJson(text: unknown): unknown {
  if (typeof text !== 'string') return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

// Coerce an unknown upstream error into a loggable string. Shared by the
// CLIProxyAPI image adapter and the text feature provider.
export function errorToRawString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

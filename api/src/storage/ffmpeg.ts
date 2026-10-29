const MAX_STDERR_TAIL_BYTES = 4096;

export class FfmpegOutputTooLargeError extends Error {
  constructor(message = 'ffmpeg output too large') {
    super(message);
    this.name = 'FfmpegOutputTooLargeError';
  }
}

export class FfmpegCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FfmpegCommandError';
  }
}

/** Runs an ffmpeg argv writing to `pipe:1` and returns stdout, capped. `stdin`
 * feeds `pipe:0` when the argv reads from it. */
export type FfmpegRunner = (
  args: readonly string[],
  signal: AbortSignal,
  maxOutputBytes: number,
) => Promise<Uint8Array>;

export async function runFfmpeg(
  args: readonly string[],
  signal: AbortSignal,
  maxOutputBytes: number,
  stdin?: Uint8Array,
): Promise<Uint8Array> {
  if (signal.aborted) throw abortReason(signal);
  const proc = Bun.spawn([...args], { ...(stdin ? { stdin } : {}), stdout: 'pipe', stderr: 'pipe' });
  const onAbort = (): void => { proc.kill('SIGKILL'); };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const [stdout, stderr, code] = await Promise.all([
      readStreamWithCap(proc.stdout, maxOutputBytes),
      readStreamTail(proc.stderr, MAX_STDERR_TAIL_BYTES),
      proc.exited,
    ]);
    if (code !== 0) throw new FfmpegCommandError(`ffmpeg failed: ${stderr.slice(-200)}`);
    return stdout;
  } catch (error) {
    proc.kill('SIGKILL');
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export function withTimeout(
  externalSignal: AbortSignal | undefined,
  durationMs: number,
  timeoutError: () => Error,
): { readonly signal: AbortSignal; readonly cleanup: () => void } {
  const controller = new AbortController();
  if (externalSignal?.aborted) {
    controller.abort(abortReason(externalSignal));
    return { signal: controller.signal, cleanup: () => undefined };
  }
  const timer = setTimeout(() => {
    controller.abort(timeoutError());
  }, durationMs);
  const onExternalAbort = (): void => {
    if (externalSignal) controller.abort(abortReason(externalSignal));
  };
  const cleanup = (): void => {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  };
  controller.signal.addEventListener('abort', cleanup, { once: true });
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
  return { signal: controller.signal, cleanup };
}

export function rejectOnAbort(signal: AbortSignal): Promise<never> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { reject(abortReason(signal)); }, { once: true });
  });
}

export function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('aborted', 'AbortError');
}

// Accumulates stdout in place inside one resizable buffer whose capacity is
// only a virtual reservation up to the cap, so a large output (a sequence
// master can reach SEQUENCE_MASTER_MAX_BYTES) never sits in the heap twice as
// a chunk list plus its concatenated copy. Capacity grows geometrically to
// keep resize calls logarithmic in the output size. The reservation is
// clamped to 4 GiB, the largest Bun accepts, so an oversized cap override
// degrades to that ceiling instead of failing every read.
export const MAX_STREAM_RESERVATION_BYTES = 4 * 1024 * 1024 * 1024;

export async function readStreamWithCap(
  stream: ReadableStream<Uint8Array>,
  requestedMaxBytes: number,
): Promise<Uint8Array> {
  const maxBytes = Math.min(requestedMaxBytes, MAX_STREAM_RESERVATION_BYTES);
  const reader = stream.getReader();
  const buffer = new ArrayBuffer(0, { maxByteLength: maxBytes });
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const next = total + value.byteLength;
      if (next > maxBytes) throw new FfmpegOutputTooLargeError();
      if (next > buffer.byteLength) buffer.resize(Math.min(maxBytes, Math.max(next, buffer.byteLength * 2)));
      new Uint8Array(buffer, total, value.byteLength).set(value);
      total = next;
    }
  } finally {
    reader.releaseLock();
  }
  return new Uint8Array(buffer, 0, total);
}

export async function readStreamTail(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<string> {
  const reader = stream.getReader();
  let tail = new Uint8Array(0);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const combined = new Uint8Array(Math.min(maxBytes, tail.byteLength + value.byteLength));
      const fromTail = Math.max(0, combined.byteLength - value.byteLength);
      if (fromTail > 0) combined.set(tail.slice(tail.byteLength - fromTail));
      combined.set(value.slice(value.byteLength - (combined.byteLength - fromTail)), fromTail);
      tail = combined;
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(tail);
}

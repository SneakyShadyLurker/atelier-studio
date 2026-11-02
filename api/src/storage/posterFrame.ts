import {
  FfmpegOutputTooLargeError,
  rejectOnAbort,
  runFfmpeg,
  withTimeout,
} from './ffmpeg';
import { generateThumb } from './thumbGen';

const POSTER_TIMEOUT_MS = 20_000;
const MAX_FRAME_OUTPUT_BYTES = 384 * 1024 * 1024;

export const FFMPEG_FRAME_ARGS = [
  'ffmpeg',
  '-i',
  'pipe:0',
  '-frames:v',
  '1',
  '-f',
  'image2pipe',
  '-vcodec',
  'png',
  'pipe:1',
] as const;

export class PosterFrameTimeoutError extends Error {
  constructor(message = 'poster frame extraction timed out') {
    super(message);
    this.name = 'PosterFrameTimeoutError';
  }
}

export class PosterFrameTooLargeError extends FfmpegOutputTooLargeError {
  constructor(message = 'poster frame output too large') {
    super(message);
    this.name = 'PosterFrameTooLargeError';
  }
}

export interface PosterFrameOptions {
  signal?: AbortSignal;
  maxOutputBytes?: number;
}

export type PosterFrameRunner = (
  args: readonly string[],
  input: Uint8Array,
  signal: AbortSignal,
  maxOutputBytes: number,
) => Promise<Uint8Array>;

const systemFfmpegRunner: PosterFrameRunner = (args, input, signal, maxOutputBytes) =>
  runFfmpeg(args, signal, maxOutputBytes, input);

let currentRunner: PosterFrameRunner = systemFfmpegRunner;
let posterTimeoutMs = POSTER_TIMEOUT_MS;

export function setFfmpegRunnerForTests(runner: PosterFrameRunner | null): void {
  currentRunner = runner ?? systemFfmpegRunner;
}

export function setPosterTimeoutForTests(timeoutMs: number | null): void {
  posterTimeoutMs = timeoutMs ?? POSTER_TIMEOUT_MS;
}

export async function extractPosterWebp(
  mp4: Uint8Array,
  opts: PosterFrameOptions = {},
): Promise<Uint8Array> {
  const maxOutputBytes = opts.maxOutputBytes ?? MAX_FRAME_OUTPUT_BYTES;
  const timedSignal = withTimeout(opts.signal, posterTimeoutMs, () => new PosterFrameTimeoutError());
  try {
    const runnerPromise = currentRunner(FFMPEG_FRAME_ARGS, mp4, timedSignal.signal, maxOutputBytes);
    void runnerPromise.catch(() => undefined);
    const png = await Promise.race([runnerPromise, rejectOnAbort(timedSignal.signal)]);
    if (png.byteLength > maxOutputBytes) throw new PosterFrameTooLargeError();
    return await generateThumb(png, timedSignal.signal);
  } finally {
    timedSignal.cleanup();
  }
}

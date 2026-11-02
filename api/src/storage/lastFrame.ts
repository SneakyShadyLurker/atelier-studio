import { MAX_UPLOAD_FILE_BYTES } from '@atelier/shared';
import {
  FfmpegCommandError,
  FfmpegOutputTooLargeError,
  rejectOnAbort,
  runFfmpeg,
  withTimeout,
} from './ffmpeg';

const LAST_FRAME_TIMEOUT_MS = 30_000;
const MAX_LAST_FRAME_BYTES = MAX_UPLOAD_FILE_BYTES;

// -sseof -1 decodes only the final second; `reverse` inside that window makes
// the LAST frame come out first so -frames:v 1 keeps it. `-update 1` is NOT
// equivalent here: it only has overwrite semantics when writing a real image2
// file — on pipe:1 it is inert and -frames:v 1 keeps the FIRST frame of the
// window (~1s early), which silently breaks seam continuity.
export const FFMPEG_LAST_FRAME_ARGS = (inputPath: string): readonly string[] => [
  'ffmpeg',
  '-nostdin',
  '-sseof',
  '-1',
  '-i',
  inputPath,
  '-vf',
  'reverse',
  '-frames:v',
  '1',
  '-f',
  'image2pipe',
  '-vcodec',
  'png',
  'pipe:1',
];

export const FFMPEG_LAST_FRAME_FALLBACK_ARGS = (inputPath: string): readonly string[] => [
  'ffmpeg',
  '-nostdin',
  '-i',
  inputPath,
  '-vf',
  'reverse',
  '-frames:v',
  '1',
  '-f',
  'image2pipe',
  '-vcodec',
  'png',
  'pipe:1',
];

export class LastFrameTimeoutError extends Error {
  constructor() {
    super('last frame extraction timed out');
    this.name = 'LastFrameTimeoutError';
  }
}

export class LastFrameTooLargeError extends FfmpegOutputTooLargeError {
  constructor() {
    super('last frame output too large');
    this.name = 'LastFrameTooLargeError';
  }
}

export class LastFrameCommandError extends FfmpegCommandError {
  constructor(message: string) {
    super(message);
    this.name = 'LastFrameCommandError';
  }
}

export interface LastFrameOptions {
  readonly signal?: AbortSignal;
  readonly maxOutputBytes?: number;
}

export type LastFrameRunner = (
  args: readonly string[],
  signal: AbortSignal,
  maxOutputBytes: number,
) => Promise<Uint8Array>;

let currentRunner: LastFrameRunner = runFfmpeg;
let timeoutMs = LAST_FRAME_TIMEOUT_MS;

export function setLastFrameRunnerForTests(runner: LastFrameRunner | null): void {
  currentRunner = runner ?? runFfmpeg;
}

export function setLastFrameTimeoutForTests(next: number | null): void {
  timeoutMs = next ?? LAST_FRAME_TIMEOUT_MS;
}

export async function extractLastFramePng(
  inputPath: string,
  options: LastFrameOptions = {},
): Promise<Uint8Array> {
  const maxOutputBytes = options.maxOutputBytes ?? MAX_LAST_FRAME_BYTES;
  const timed = withTimeout(options.signal, timeoutMs, () => new LastFrameTimeoutError());
  try {
    const run = currentRunner(FFMPEG_LAST_FRAME_ARGS(inputPath), timed.signal, maxOutputBytes);
    void run.catch(() => undefined);
    let png = await Promise.race([run, rejectOnAbort(timed.signal)]);
    if (png.byteLength === 0) {
      const fallback = currentRunner(
        FFMPEG_LAST_FRAME_FALLBACK_ARGS(inputPath),
        timed.signal,
        maxOutputBytes,
      );
      void fallback.catch(() => undefined);
      png = await Promise.race([fallback, rejectOnAbort(timed.signal)]);
    }
    if (png.byteLength === 0) throw new LastFrameCommandError('ffmpeg produced no frame');
    if (png.byteLength > maxOutputBytes) throw new LastFrameTooLargeError();
    return png;
  } finally {
    timed.cleanup();
  }
}

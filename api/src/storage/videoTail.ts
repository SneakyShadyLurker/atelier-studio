import { VIDEO_FPS } from '@atelier/shared';
import {
  FfmpegCommandError,
  FfmpegOutputTooLargeError,
  rejectOnAbort,
  runFfmpeg,
  withTimeout,
} from './ffmpeg';

export class VideoTailTimeoutError extends Error {
  constructor() {
    super('video tail extraction timed out');
    this.name = 'VideoTailTimeoutError';
  }
}

export class VideoTailTooLargeError extends FfmpegOutputTooLargeError {
  constructor() {
    super('video tail output too large');
    this.name = 'VideoTailTooLargeError';
  }
}

export class VideoTailCommandError extends FfmpegCommandError {}

export interface VideoTailOptions {
  /**
   * Frame index one past the segment's DELIVERED end (`context + duration`) —
   * the tail is cut backwards from here, not from the end of the file, because
   * a guided segment renders past this point and the stitcher drops the excess.
   */
  readonly sourceEndFrame: number;
  /** Frames to take off the end; must be a valid H3 guide clip length. */
  readonly contextFrames: number;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
}

export type VideoTailRunner = (
  args: readonly string[],
  signal: AbortSignal,
  maxOutputBytes: number,
) => Promise<Uint8Array>;

let currentRunner: VideoTailRunner = runFfmpeg;

export function setVideoTailRunnerForTests(runner: VideoTailRunner | null): void {
  currentRunner = runner ?? runFfmpeg;
}

export function buildVideoTailArgs(
  path: string,
  sourceEndFrame: number,
  contextFrames: number,
): readonly string[] {
  if (contextFrames < 1) throw new Error('video tail requires a positive context length');
  // Clamped rather than asserted: the frame count comes from the batch row, so
  // a segment shorter than the requested head (a legacy row, or a clip ComfyUI
  // snapped differently) yields the whole clip instead of an ffmpeg failure.
  const startFrame = Math.max(0, sourceEndFrame - contextFrames);
  return [
    'ffmpeg',
    '-nostdin',
    '-i',
    path,
    '-filter_complex',
    [
      `[0:v]trim=start_frame=${startFrame},setpts=PTS-STARTPTS[v]`,
      `[0:a]atrim=start=${(startFrame / VIDEO_FPS).toFixed(9)},asetpts=PTS-STARTPTS[a]`,
    ].join(';'),
    '-map',
    '[v]',
    '-map',
    '[a]',
    // Hard cap: AddGuide crops a guide to the model's clip grid, so handing it
    // more frames than asked for would silently move the anchor window.
    '-frames:v',
    String(contextFrames),
    '-c:v',
    'libx264',
    // This clip is conditioning signal, not a deliverable — it is worth
    // spending bitrate on, and it is only ~22 frames.
    '-crf',
    '12',
    '-preset',
    'veryfast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-movflags',
    '+faststart+frag_keyframe+empty_moov',
    '-f',
    'mp4',
    'pipe:1',
  ];
}

/** Cuts the last `contextFrames` frames (video + audio) out of a segment mp4. */
export async function extractVideoTail(
  path: string,
  options: VideoTailOptions,
): Promise<Uint8Array> {
  const timed = withTimeout(options.signal, options.timeoutMs, () => new VideoTailTimeoutError());
  try {
    const run = currentRunner(
      buildVideoTailArgs(path, options.sourceEndFrame, options.contextFrames),
      timed.signal,
      options.maxOutputBytes,
    );
    void run.catch(() => undefined);
    const bytes = await Promise.race([run, rejectOnAbort(timed.signal)]);
    if (bytes.byteLength > options.maxOutputBytes) throw new VideoTailTooLargeError();
    if (bytes.byteLength === 0) throw new VideoTailCommandError('ffmpeg produced an empty video tail');
    return bytes;
  } finally {
    timed.cleanup();
  }
}

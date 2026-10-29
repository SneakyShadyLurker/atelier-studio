import { VIDEO_DURATION_FRAMES, VIDEO_FPS } from '@atelier/shared';
import {
  FfmpegCommandError,
  FfmpegOutputTooLargeError,
  rejectOnAbort,
  runFfmpeg,
  withTimeout,
} from './ffmpeg';

const BASELINE_FRAMES = VIDEO_DURATION_FRAMES[0];
const SEAM_FRAMES = 1;
const CROSSFADE_SECONDS = 0.06;

export class SequenceStitchTimeoutError extends Error {
  constructor() {
    super('sequence stitch timed out');
    this.name = 'SequenceStitchTimeoutError';
  }
}

export class SequenceStitchTooLargeError extends FfmpegOutputTooLargeError {
  constructor() {
    super('sequence master output too large');
    this.name = 'SequenceStitchTooLargeError';
  }
}

export class SequenceStitchCommandError extends FfmpegCommandError {}

/**
 * One rendered segment as the stitcher sees it.
 *
 * `contextFrames` is what the segment was RENDERED with, not what was
 * requested: a native `MiniMaxH3AddGuide` continuation carries a context head
 * of the previous segment's tail that has to come off the front, while a
 * still-frame handoff (first segment, or a continuation whose tail extraction
 * failed)
 * carries none and instead needs the legacy one-frame seam drop plus an audio
 * crossfade, because its soundtrack genuinely restarts at the join.
 */
export interface SequenceStitchSegment {
  readonly path: string;
  readonly durationFrames: number;
  readonly contextFrames: number;
}

export interface StitchSequenceOptions {
  readonly timeoutBaselineMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
}

export type SequenceStitchRunner = (
  args: readonly string[],
  signal: AbortSignal,
  maxOutputBytes: number,
) => Promise<Uint8Array>;

let currentRunner: SequenceStitchRunner = runFfmpeg;

export function setSequenceStitchRunnerForTests(runner: SequenceStitchRunner | null): void {
  currentRunner = runner ?? runFfmpeg;
}

/** Frames dropped from the front of segment `index`. */
function leadingTrimFrames(segment: SequenceStitchSegment, index: number): number {
  if (index === 0) return 0;
  return segment.contextFrames > 0 ? segment.contextFrames : SEAM_FRAMES;
}

/**
 * Input frame index one past the last frame a segment contributes.
 *
 * A guided segment is rendered at `grid-snap(duration + context)`, which
 * overshoots `context + duration` by up to 16 frames because H3's clip grid
 * has no point at the exact sum. Those extra frames are real content, but
 * keeping them would make the master longer than the duration the user picked
 * and would drift from `batches.duration_frames`, which the sequence summaries
 * add up. They are dropped so the delivered length is exact; the same endpoint
 * is what the NEXT segment's handoff tail is cut backwards from, so the chain
 * continues from content the viewer actually sees.
 *
 * For a still-frame segment `contextFrames` is 0 and this is just the rendered
 * length, making the end trim a no-op — legacy sequences stitch unchanged.
 */
function endFrame(segment: SequenceStitchSegment): number {
  return segment.contextFrames + segment.durationFrames;
}

/** Frames segment `index` contributes to the master after both trims. */
function deliveredFrames(segment: SequenceStitchSegment, index: number): number {
  return endFrame(segment) - leadingTrimFrames(segment, index);
}

export function sequenceMasterFrames(segments: readonly SequenceStitchSegment[]): number {
  return segments.reduce((sum, segment, index) => sum + deliveredFrames(segment, index), 0);
}

export function buildSequenceStitchArgs(segments: readonly SequenceStitchSegment[]): readonly string[] {
  if (segments.length < 2) throw new Error('sequence stitch requires at least two segments');
  const outputFrames = sequenceMasterFrames(segments);
  if (outputFrames < 1) throw new Error('sequence stitch requires a positive video timeline');
  const inputs = segments.flatMap((segment) => ['-i', segment.path]);
  const filters: string[] = [];
  for (const [index, segment] of segments.entries()) {
    const trim = leadingTrimFrames(segment, index);
    const end = endFrame(segment);
    const vTrim = `trim=start_frame=${trim}:end_frame=${end},`;
    if (index === 0) {
      filters.push(
        `[0:v]${vTrim}setpts=PTS-STARTPTS,scale=ceil(iw/2)*2:ceil(ih/2)*2:flags=lanczos,setsar=1,format=yuv420p[vref0]`,
      );
    } else {
      filters.push(
        `[${index}:v]${vTrim}setpts=PTS-STARTPTS,format=yuv420p[vraw${index}]`,
        `[vraw${index}][vref${index - 1}]scale2ref=flags=lanczos[vscaled${index}][vref${index}]`,
        `[vscaled${index}]setsar=1,format=yuv420p[v${index}]`,
      );
    }
    const aTrim = `atrim=start=${(trim / VIDEO_FPS).toFixed(9)}:end=${(end / VIDEO_FPS).toFixed(9)},`;
    filters.push(
      `[${index}:a]${aTrim}asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${index}]`,
    );
  }
  const videoInputs = `[vref${segments.length - 1}]${segments
    .slice(1)
    .map((_segment, index) => `[v${index + 1}]`)
    .join('')}`;
  filters.push(`${videoInputs}concat=n=${segments.length}:v=1:a=0[vout]`);
  let audioLabel = 'a0';
  for (const [index, segment] of segments.entries()) {
    if (index === 0) continue;
    const next = `ajoin${index}`;
    // A native continuation's audio was denoised as one stream with the
    // previous segment's tail, so butt-joining it is the whole point; only a
    // still-frame handoff restarts the soundtrack and needs the crossfade.
    filters.push(
      segment.contextFrames > 0
        ? `[${audioLabel}][a${index}]concat=n=2:v=0:a=1[${next}]`
        : `[${audioLabel}][a${index}]acrossfade=d=${CROSSFADE_SECONDS}:c1=tri:c2=tri[${next}]`,
    );
    audioLabel = next;
  }
  const videoDurationSeconds = (outputFrames / VIDEO_FPS).toFixed(9);
  filters.push(`[${audioLabel}]apad=whole_dur=${videoDurationSeconds}[aout]`);
  return [
    'ffmpeg',
    '-nostdin',
    ...inputs,
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[vout]',
    '-map',
    '[aout]',
    '-c:v',
    'libx264',
    // The master is a re-encode of segments ComfyUI already encoded once, so
    // x264's CRF 23 / preset medium defaults would stack a second visible
    // generation loss onto H3's fine detail. CRF 16 at preset slow is
    // near-transparent for this material; the encode stays far inside
    // SEQUENCE_STITCH_TIMEOUT_MS, which scales with the sequence's frame count.
    '-crf',
    '16',
    '-preset',
    'slow',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    // ffmpeg's native AAC defaults to ~128k for stereo; H3's soundtrack is
    // generated alongside the video and is the half a seam is most audible in.
    '-b:a',
    '192k',
    '-movflags',
    '+faststart+frag_keyframe+empty_moov',
    '-shortest',
    '-f',
    'mp4',
    'pipe:1',
  ];
}

export async function stitchSequence(
  segments: readonly SequenceStitchSegment[],
  options: StitchSequenceOptions,
): Promise<Uint8Array> {
  const scaledTimeoutMs = Math.ceil(
    options.timeoutBaselineMs * Math.max(1, sequenceMasterFrames(segments) / BASELINE_FRAMES),
  );
  const timed = withTimeout(options.signal, scaledTimeoutMs, () => new SequenceStitchTimeoutError());
  try {
    const run = currentRunner(buildSequenceStitchArgs(segments), timed.signal, options.maxOutputBytes);
    void run.catch(() => undefined);
    const bytes = await Promise.race([run, rejectOnAbort(timed.signal)]);
    if (bytes.byteLength > options.maxOutputBytes) throw new SequenceStitchTooLargeError();
    return bytes;
  } finally {
    timed.cleanup();
  }
}

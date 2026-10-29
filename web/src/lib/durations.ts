import { VIDEO_DURATION_FRAMES, VIDEO_FPS, type VideoDurationFrames } from '@atelier/shared';

export interface DurationDefinition {
  id: VideoDurationFrames;
  /** Rounded whole-second label — H3's frame grid never lands on exact seconds. */
  label: string;
}

export const durationDefinitions = [
  { id: 124, label: '5s' },
  { id: 243, label: '10s' },
  { id: 362, label: '15s' },
] as const satisfies readonly DurationDefinition[];

// Compile-time exhaustiveness: every grid point must have a definition above.
// Add a length to VIDEO_DURATION_FRAMES and this stops compiling until covered.
type _DurationsCovered = VideoDurationFrames extends (typeof durationDefinitions)[number]['id'] ? true : never;
const _durationCoverage: _DurationsCovered = true;

/** Precise clip length for the hover title — the chip label is rounded. */
export function durationTitle(frames: VideoDurationFrames): string {
  return `Clip length — ${(frames / VIDEO_FPS).toFixed(1)} s at ${String(VIDEO_FPS)} fps (${String(frames)} frames)`;
}

/**
 * Resolves the duration a video model should start on. Falls back through the
 * model's own default to the first supported length, so a model that ships a
 * default outside its supported set can never seed an unsubmittable draft.
 */
export function resolveDuration(
  supported: readonly VideoDurationFrames[],
  draft: VideoDurationFrames | undefined,
  preferred: VideoDurationFrames | undefined,
): VideoDurationFrames {
  if (draft !== undefined && supported.includes(draft)) return draft;
  if (preferred !== undefined && supported.includes(preferred)) return preferred;
  return supported[0] ?? VIDEO_DURATION_FRAMES[0];
}

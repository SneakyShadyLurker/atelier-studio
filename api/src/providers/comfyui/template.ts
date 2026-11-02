// Workflow templates ship as API-format JSON with these placeholders:
//   "text":         "{{prompt}}"
//   "motion text":  "{{motionPrompt}}"
//   "seed":         "{{seed}}"
//   "width":        "{{width}}"
//   "height":       "{{height}}"
//   "resolution":   "{{upscaleShort}}"
//   "source image": "{{sourceImage}}"
//   "reference":    "{{referenceImage}}"
//   "context clip": "{{contextVideo}}"
//   "batch size":   "{{count}}"
//   "clip length":  "{{videoFrames}}"
//   "steps":        "{{steps}}"   (base sampler only)
// The string placeholders (quoted in the JSON source) are replaced with
// JSON-encoded values, then the whole document is parsed. Numbers lose their
// outer quotes that way; the prompt becomes a properly-escaped JSON string,
// so user input containing `"`, `\`, or control chars is safe.
//
// {{upscaleShort}} is derived, not supplied: it is the SeedVR2 single-pass
// target shortest-edge = SEEDVR2_UPSCALE_FACTOR x min(width, height). SeedVR2
// maintains aspect ratio from the shortest edge, so scaling the short edge by
// the factor scales the whole frame by it (final long edge = base x factor,
// e.g. 2048 -> 4096). This replaces the prior tiled chain's per-tile literal.
//
// Replace quoted tokens in one pass with a callback. Inserted strings stay
// opaque, including literal placeholders and String.replace dollar tokens.

import { SEEDVR2_UPSCALE_FACTOR } from '../comfyui.config';

export interface ComfyuiTemplateParams {
  prompt: string;
  seed: number;
  width: number;
  height: number;
  /** Number of images to generate in this ComfyUI batch (maps to `batch_size`). */
  count: number;
  motionPrompt?: string;
  sourceImage?: string;
  /** ComfyUI input-dir filename of the uploaded face reference (LoadImage). */
  referenceImage?: string;
  /** ComfyUI input-dir filename of a continuation's context clip (LoadVideo). */
  contextVideo?: string;
  /**
   * Clip length in frames for video workflows (maps to the H3 node's
   * `length`). Required whenever the template declares `{{videoFrames}}`.
   */
  videoFrames?: number;
  /**
   * Base-sampler step count (the model's default or the user's override).
   * Required whenever the template declares `{{steps}}`.
   */
  steps?: number;
}

const KNOWN_PLACEHOLDERS = ['{{prompt}}', '{{seed}}', '{{width}}', '{{height}}', '{{upscaleShort}}', '{{count}}', '{{motionPrompt}}', '{{sourceImage}}', '{{referenceImage}}', '{{contextVideo}}', '{{videoFrames}}', '{{steps}}'] as const;
const DEFAULT_REQUIRED_PLACEHOLDERS = ['{{prompt}}', '{{seed}}', '{{width}}', '{{height}}', '{{upscaleShort}}', '{{count}}'] as const;

export function buildWorkflow(
  workflowText: string,
  params: ComfyuiTemplateParams,
  requiredPlaceholders: readonly string[] = DEFAULT_REQUIRED_PLACEHOLDERS,
): Record<string, unknown> {
  const templateText = stripLeadingJsonComments(workflowText);
  // Pre-validate the template before any substitution. `String.replace` was
  // first-match-only and silently no-op on absence, so a workflow that
  // dropped `{{seed}}` would ship every generation with the JSON literal
  // default (0). A workflow that introduced a new placeholder (typo, rename)
  // would silently send literal text to ComfyUI. Validate against the known
  // set up front — failing here surfaces the bug at the provider boundary,
  // not as silent semantic corruption downstream.
  //
  // Pre-substitution validation also avoids false positives: a user prompt
  // containing literal `{{name}}` text would otherwise trip a post-
  // substitution stray-token check.
  const present = new Set<string>(templateText.match(/\{\{[a-zA-Z_][a-zA-Z0-9_]*\}\}/g) ?? []);
  for (const token of present) {
    if (!(KNOWN_PLACEHOLDERS as readonly string[]).includes(token)) {
      throw new Error(`comfyui workflow template: unknown placeholder ${token}`);
    }
  }
  for (const expected of requiredPlaceholders) {
    if (!present.has(expected)) {
      throw new Error(`comfyui workflow template: missing placeholder ${expected}`);
    }
  }

  const width = integer(params.width, 'width');
  const height = integer(params.height, 'height');
  const count = integer(params.count, 'count');
  if (present.has('{{sourceImage}}') && params.sourceImage === undefined) {
    throw new Error('comfyui workflow template: sourceImage is required');
  }
  if (present.has('{{referenceImage}}') && params.referenceImage === undefined) {
    throw new Error('comfyui workflow template: referenceImage is required');
  }
  if (present.has('{{contextVideo}}') && params.contextVideo === undefined) {
    throw new Error('comfyui workflow template: contextVideo is required');
  }
  // Guarded like sourceImage rather than defaulted: a silent fallback would
  // ship every clip at one length while the UI claimed another.
  if (present.has('{{videoFrames}}') && params.videoFrames === undefined) {
    throw new Error('comfyui workflow template: videoFrames is required');
  }
  const videoFrames = params.videoFrames === undefined ? 0 : integer(params.videoFrames, 'videoFrames');
  // Same guard: a silent default would sample at a count the user never chose.
  if (present.has('{{steps}}') && params.steps === undefined) {
    throw new Error('comfyui workflow template: steps is required');
  }
  const steps = params.steps === undefined ? 0 : integer(params.steps, 'steps');
  const sourceImage = params.sourceImage === undefined ? '"{{sourceImage}}"' : JSON.stringify(params.sourceImage);
  const referenceImage = params.referenceImage === undefined ? '"{{referenceImage}}"' : JSON.stringify(params.referenceImage);
  const contextVideo = params.contextVideo === undefined ? '"{{contextVideo}}"' : JSON.stringify(params.contextVideo);
  const upscaleShort = SEEDVR2_UPSCALE_FACTOR * Math.min(width, height);
  const replacements: Record<(typeof KNOWN_PLACEHOLDERS)[number], string> = {
    '{{seed}}': String(integer(params.seed, 'seed')),
    '{{width}}': String(width),
    '{{height}}': String(height),
    '{{count}}': String(count),
    '{{upscaleShort}}': String(upscaleShort),
    '{{videoFrames}}': String(videoFrames),
    '{{steps}}': String(steps),
    '{{sourceImage}}': sourceImage,
    '{{referenceImage}}': referenceImage,
    '{{contextVideo}}': contextVideo,
    '{{motionPrompt}}': JSON.stringify(params.motionPrompt ?? params.prompt),
    '{{prompt}}': JSON.stringify(params.prompt),
  };
  const filled = templateText.replace(/"(\{\{[a-zA-Z_][a-zA-Z0-9_]*\}\})"/g,
    (quoted: string, token: string) => Object.hasOwn(replacements, token)
      ? replacements[token as keyof typeof replacements] : quoted);
  const parsed = JSON.parse(filled) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('comfyui workflow template did not parse to an object');
  }
  return parsed as Record<string, unknown>;
}

function stripLeadingJsonComments(text: string): string {
  return text.replace(/^\s*(?:(?:\/\/[^\n]*(?:\n|$))|(?:\/\*[\s\S]*?\*\/\s*))+/u, '');
}

function integer(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`comfyui template: ${name} must be a non-negative integer, got ${value}`);
  }
  return value;
}

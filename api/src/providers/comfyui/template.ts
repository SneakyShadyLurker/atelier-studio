// Workflow templates ship as API-format JSON with these placeholders:
//   "text":         "{{prompt}}"
//   "motion text":  "{{motionPrompt}}"
//   "seed":         "{{seed}}"
//   "width":        "{{width}}"
//   "height":       "{{height}}"
//   "resolution":   "{{upscaleShort}}"
//   "source image": "{{sourceImage}}"
//   "reference":    "{{referenceImage}}", then "{{referenceImage2}}" and
//                   "{{referenceImage3}}" for a graph with more slots
//   "context clip": "{{contextVideo}}"
//   "batch size":   "{{count}}"
//   "clip length":  "{{videoFrames}}"
//   "steps":        "{{steps}}"   (base sampler only)
//   "output scale": "{{outputScale}}"  (final ImageScaleBy factor)
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

import { REFERENCE_IMAGE_PLACEHOLDERS, SEEDVR2_UPSCALE_FACTOR } from '../comfyui.config';

export interface ComfyuiTemplateParams {
  prompt: string;
  seed: number;
  width: number;
  height: number;
  /** Number of images to generate in this ComfyUI batch (maps to `batch_size`). */
  count: number;
  motionPrompt?: string;
  sourceImage?: string;
  /**
   * Uploaded reference images in slot order (LoadImage). The first fills
   * `{{referenceImage}}`, which is required when declared; a later slot the
   * request leaves empty is pruned from the graph.
   */
  referenceImages?: readonly string[];
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
  /**
   * Factor of the graph's final downscale (`ImageScaleBy.scale_by`), the
   * model's output long edge over the rendered long edge. Required whenever
   * the template declares `{{outputScale}}`.
   */
  outputScale?: number;
}

const KNOWN_PLACEHOLDERS = ['{{prompt}}', '{{seed}}', '{{width}}', '{{height}}', '{{upscaleShort}}', '{{count}}', '{{motionPrompt}}', '{{sourceImage}}', ...REFERENCE_IMAGE_PLACEHOLDERS, '{{contextVideo}}', '{{videoFrames}}', '{{steps}}', '{{outputScale}}'] as const;
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
  const referenceImages = params.referenceImages ?? [];
  if (present.has('{{referenceImage}}') && referenceImages[0] === undefined) {
    throw new Error('comfyui workflow template: referenceImage is required');
  }
  const referenceSlots = REFERENCE_IMAGE_PLACEHOLDERS.filter((token) => present.has(token)).length;
  if (referenceImages.length > referenceSlots) {
    throw new Error('comfyui workflow template: more reference images than reference slots');
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
  // Guarded too: a silent 1.0 would ship the full render the row says it downscales.
  if (present.has('{{outputScale}}') && params.outputScale === undefined) {
    throw new Error('comfyui workflow template: outputScale is required');
  }
  const outputScale = params.outputScale ?? 1;
  if (!Number.isFinite(outputScale) || outputScale <= 0 || outputScale > 1) {
    throw new Error(`comfyui template: outputScale must be in (0, 1], got ${outputScale}`);
  }
  const sourceImage = params.sourceImage === undefined ? '"{{sourceImage}}"' : JSON.stringify(params.sourceImage);
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
    '{{outputScale}}': String(outputScale),
    '{{sourceImage}}': sourceImage,
    ...referenceReplacements(referenceImages),
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
  const workflow = parsed as Record<string, unknown>;
  pruneNodes(workflow, emptyReferenceSlotNodes(templateText, referenceImages.length));
  return workflow;
}

function referenceReplacements(images: readonly string[]): Record<(typeof REFERENCE_IMAGE_PLACEHOLDERS)[number], string> {
  const [first, second, third] = REFERENCE_IMAGE_PLACEHOLDERS.map((token, slot) => {
    const image = images[slot];
    return image === undefined ? `"${token}"` : JSON.stringify(image);
  }) as [string, string, string];
  return { '{{referenceImage}}': first, '{{referenceImage2}}': second, '{{referenceImage3}}': third };
}

// A reference graph declares every slot the model takes. The loader of a slot
// the request left empty is removed, along with each link that read from it,
// so the consuming node sees fewer images instead of a dangling input. The
// loaders are found in the template itself, before user text is substituted.
function emptyReferenceSlotNodes(templateText: string, supplied: number): Set<string> {
  const empty: readonly string[] = REFERENCE_IMAGE_PLACEHOLDERS.slice(Math.max(1, supplied));
  const nodes = new Set<string>();
  if (!empty.some((token) => templateText.includes(token))) return nodes;
  for (const [id, node] of Object.entries(JSON.parse(templateText) as Record<string, unknown>)) {
    const inputs = nodeInputs(node);
    if (inputs !== undefined && Object.values(inputs).some((value) => typeof value === 'string' && empty.includes(value))) {
      nodes.add(id);
    }
  }
  return nodes;
}

function pruneNodes(workflow: Record<string, unknown>, removed: ReadonlySet<string>): void {
  for (const id of removed) Reflect.deleteProperty(workflow, id);
  for (const node of Object.values(workflow)) {
    const inputs = nodeInputs(node);
    if (inputs === undefined) continue;
    for (const [name, value] of Object.entries(inputs)) {
      if (Array.isArray(value) && typeof value[0] === 'string' && removed.has(value[0])) Reflect.deleteProperty(inputs, name);
    }
  }
}

function nodeInputs(node: unknown): Record<string, unknown> | undefined {
  if (node === null || typeof node !== 'object') return undefined;
  const inputs = (node as { inputs?: unknown }).inputs;
  return inputs !== null && typeof inputs === 'object' && !Array.isArray(inputs) ? inputs as Record<string, unknown> : undefined;
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

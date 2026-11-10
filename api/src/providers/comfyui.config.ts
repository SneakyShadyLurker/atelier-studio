export const PLACEHOLDER_VALUES = [
  '{{prompt}}',
  '{{seed}}',
  '{{width}}',
  '{{height}}',
  '{{count}}',
  '{{upscaleShort}}',
  '{{motionPrompt}}',
  '{{sourceImage}}',
  '{{referenceImage}}',
  '{{referenceImage2}}',
  '{{referenceImage3}}',
  '{{contextVideo}}',
  '{{videoFrames}}',
  '{{steps}}',
  '{{outputScale}}',
] as const;

export type Placeholder = (typeof PLACEHOLDER_VALUES)[number];

// Reference slots of a reference graph, in order: the first is required, the
// later ones are pruned from the submitted graph when the request carries
// fewer images. Three is the private worker's per-job input cap
// (infra/comfyui/atelier_private/store.py `reserve_input`).
export const REFERENCE_IMAGE_PLACEHOLDERS = [
  '{{referenceImage}}',
  '{{referenceImage2}}',
  '{{referenceImage3}}',
] as const satisfies readonly Placeholder[];
export const MAX_LOCAL_REFERENCE_IMAGES = REFERENCE_IMAGE_PLACEHOLDERS.length;

export const COMFYUI_PROMPT_PATH = '/prompt';
export const COMFYUI_WS_PATH = '/ws';
export const COMFYUI_FREE_PATH = '/free';
export const COMFYUI_SYSTEM_STATS_PATH = '/system_stats';

// Local model rows are manifests under comfyui/models (see comfyui/catalog.ts).

// Dormant scaffolding for the removed SeedVR2 upscale stage. No current model
// declares {{upscaleShort}} (Krea never used it),
// so this factor is computed but unused; it is kept so the upscale path can be
// re-wired later without re-deriving the math. If re-enabled, SeedVR2 sizes from
// the shortest edge — the provider would inject {{upscaleShort}} = factor ×
// min(width, height) (see comfyui/template.ts), scaling the whole frame so the
// final long edge = base long edge × factor (2048 × 2 = 4096, true ~4K). ×3 would
// yield 6144px / up to 37.7 MP, exceeding the 24 MP MAX_IMAGE_PIXELS guard in
// storage/imageSniff.ts; ×2 keeps every ratio ≤ 16.8 MP.
export const SEEDVR2_UPSCALE_FACTOR = 2;

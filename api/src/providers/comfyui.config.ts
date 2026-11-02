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
  '{{contextVideo}}',
  '{{videoFrames}}',
  '{{steps}}',
] as const;

export type Placeholder = (typeof PLACEHOLDER_VALUES)[number];

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

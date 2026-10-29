import type { Ratio } from '@atelier/shared';

export type CliproxyQuality = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto';
export type CliproxyOutputFormat = 'png' | 'jpeg' | 'webp';

export const CLIPROXY_MODEL_ID = 'gpt-image-2.5-sunburst';
export const CLIPROXY_GENERATIONS_PATH = '/v1/images/generations';
export const CLIPROXY_EDITS_PATH = '/v1/images/edits';
export const CLIPROXY_AUTHORIZATION_HEADER = 'Authorization';

// Each entry MUST preserve Atelier's existing image request constraints
// (asserted in cliproxy.test.ts — any tweak here is forced to comply):
//   - both edges are multiples of 16
//   - longest edge ≤ 3840
//   - 655_360 ≤ total_pixels ≤ 8_294_400
//   - aspect ratio ≤ 3:1
// AND the W/H of the chosen size MUST equal the user-facing ratio exactly.
// Each entry is the largest exact-ratio size inside those limits (OpenAI's
// documented Sunburst maximums). Everything above 2560x1440 is labelled
// experimental upstream. These are request dimensions, not a guarantee of the
// upstream output size.
export const CLIPROXY_RATIO_SIZES: Record<Ratio, string> = {
  '1:1': '2880x2880',  // 1.000, 8_294_400 px (pixel cap), W/H = 1/1
  '4:5': '2560x3200',  // 0.800, 8_192_000 px (pixel cap), W/H = 4/5
  '3:4': '2448x3264',  // 0.750, 7_990_272 px (pixel cap), W/H = 3/4
  '16:9': '3840x2160', // 1.778, 8_294_400 px (edge + pixel cap), W/H = 16/9
  '9:16': '2160x3840', // 0.5625, 8_294_400 px (edge + pixel cap), W/H = 9/16
};

export const CLIPROXY_DEFAULTS = {
  quality: 'xhigh',
  outputFormat: 'png',
  moderation: 'low',
  // The proxy accepts 0..3 previews. Upstream may skip them; a terminal
  // image remains valid when no partials arrive.
  partialImages: 3,
} as const satisfies {
  quality: CliproxyQuality;
  outputFormat: CliproxyOutputFormat;
  moderation: 'low';
  partialImages: number;
};

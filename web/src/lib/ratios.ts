import type { Ratio } from '@atelier/shared';

export interface RatioDefinition {
  id: Ratio;
  w: number;
  h: number;
  label: string;
}

export const ratioDefinitions = [
  { id: '1:1', w: 1536, h: 1536, label: 'Square' },
  { id: '4:5', w: 1088, h: 1360, label: 'IG Feed' },
  { id: '3:4', w: 1344, h: 1792, label: 'Portrait' },
  { id: '16:9', w: 2048, h: 1152, label: 'Wide' },
  { id: '9:16', w: 1152, h: 2048, label: 'IG Story' },
] as const satisfies readonly RatioDefinition[];

// Compile-time exhaustiveness: every Ratio must have a definition above. Add
// a ratio to RATIO_VALUES and this stops compiling until it is covered here.
type _RatiosCovered = Ratio extends (typeof ratioDefinitions)[number]['id'] ? true : never;
const _ratioCoverage: _RatiosCovered = true;

export function getRatioDefinition(ratio: Ratio): RatioDefinition {
  const match = ratioDefinitions.find((item) => item.id === ratio);
  if (!match) {
    throw new Error(`Unknown ratio: ${ratio}`);
  }
  return match;
}

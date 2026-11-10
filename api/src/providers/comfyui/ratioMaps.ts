import type { Ratio } from '@atelier/shared';

export type RatioDims = Readonly<Record<Ratio, { width: number; height: number }>>;

// Named render-size maps. A model manifest selects one by name (`ratioMap`);
// the dimensions stay code so every row on a map shares one definition.
export const RATIO_MAPS = {
  // Krea 2: 2048px long-edge ceiling, every edge a multiple of 16 (Qwen-Image
  // latent grid), W/H matching the requested ratio.
  'krea-2048': {
    '1:1': { width: 2048, height: 2048 },  // 4.19 MP
    '4:5': { width: 1600, height: 2000 },  // exact 4:5, both /16, ≤2048
    '3:4': { width: 1536, height: 2048 },  // long edge 2048
    '16:9': { width: 2048, height: 1152 }, // long edge 2048
    '9:16': { width: 1152, height: 2048 }, // long edge 2048
  },
  // MOSS Image: ~2 MP, the top of the recommended 1 / 1.5 / 2 MP band, every
  // side a multiple of 16. The model is not trained at 4 MP, so it does not
  // share the Krea map.
  'moss-2mp': {
    '1:1': { width: 1408, height: 1408 },  // 1.98 MP
    '4:5': { width: 1264, height: 1584 },  // 2.00 MP
    '3:4': { width: 1216, height: 1632 },  // 1.98 MP
    '16:9': { width: 1888, height: 1056 }, // 1.99 MP
    '9:16': { width: 1056, height: 1888 }, // 1.99 MP
  },
  // MOSS turbo: ~1.5 MP, every side a multiple of 16.
  'moss-turbo-1.5mp': {
    '1:1': { width: 1216, height: 1216 },  // 1.48 MP
    '4:5': { width: 1088, height: 1360 },  // 1.48 MP
    '3:4': { width: 1056, height: 1408 },  // 1.49 MP
    '16:9': { width: 1632, height: 912 },  // 1.49 MP
    '9:16': { width: 912, height: 1632 },  // 1.49 MP
  },
  // MOSS with a 1.5x hires pass: a ~1.66 MP base whose sides are multiples of
  // 32, so the upscaled side stays a multiple of 16. Output is ~3.7 MP.
  'moss-hires-1.66mp': {
    '1:1': { width: 1280, height: 1280 }, // 1.64 MP -> 1920x1920
    '4:5': { width: 1152, height: 1440 }, // 1.66 MP -> 1728x2160
    '3:4': { width: 1120, height: 1504 }, // 1.68 MP -> 1680x2256
    '16:9': { width: 1696, height: 960 }, // 1.63 MP -> 2544x1440
    '9:16': { width: 960, height: 1696 }, // 1.63 MP -> 1440x2544
  },
  // MiniMax H3 Image: ~16 MP, the size the model card recommends, every side a
  // multiple of 32 (the latent is 16x downsampled and patched 2x2). The 1:1,
  // 3:4, 16:9 and 9:16 sizes are the card's own. Every map stays under 16.9 MP,
  // so an 8-bit RGB PNG cannot exceed the worker's 50 MiB image cap.
  'h3image-16mp': {
    '1:1': { width: 4096, height: 4096 },  // 16.78 MP
    '4:5': { width: 3584, height: 4480 },  // 16.06 MP, exact 4:5
    '3:4': { width: 3552, height: 4736 },  // 16.82 MP
    '16:9': { width: 5472, height: 3072 }, // 16.81 MP
    '9:16': { width: 3072, height: 5472 }, // 16.81 MP
  },
  // MiniMax H3 Image with reference pictures: ~4 MP, the area the model is
  // tuned for and the size of its official edit workflow. At 16 MP a
  // reference render takes four times as long and comes out over-sharpened,
  // and a new scene around a referenced subject fails. 1:1, 4:5 and 3:4 match
  // the 16 MP map's aspect exactly, so editing a tile does not reframe it.
  'h3image-4mp': {
    '1:1': { width: 2048, height: 2048 },  // 4.19 MP
    '4:5': { width: 1792, height: 2240 },  // 4.01 MP, exact 4:5
    '3:4': { width: 1728, height: 2304 },  // 3.98 MP, exact 3:4
    '16:9': { width: 2720, height: 1536 }, // 4.18 MP
    '9:16': { width: 1536, height: 2720 }, // 4.18 MP
  },
  // MiniMax H3 video: 768p.
  'h3-768p': {
    '1:1': { width: 768, height: 768 },
    '4:5': { width: 768, height: 960 },
    '3:4': { width: 768, height: 1024 },
    '16:9': { width: 1344, height: 768 },
    '9:16': { width: 768, height: 1344 },
  },
} as const satisfies Record<string, RatioDims>;

export type RatioMapName = keyof typeof RATIO_MAPS;

export function isRatioMapName(name: string): name is RatioMapName {
  return Object.hasOwn(RATIO_MAPS, name);
}

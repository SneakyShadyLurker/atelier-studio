import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { RATIO_VALUES } from '@atelier/shared';
import { buildWorkflow } from './template';
import { loadBuiltinCatalog } from './catalog';
import { RATIO_MAPS } from './ratioMaps';

const { kreaModels: KREA_MODELS, models: LOCAL_MODELS } = loadBuiltinCatalog();

const _h3 = LOCAL_MODELS.find((m) => m.id === 'minimax-h3-image');
if (!_h3) throw new Error('minimax-h3-image row missing from LOCAL_MODELS');
const h3 = _h3;
const workflowText = readFileSync(h3.workflowPath, 'utf8');
if (h3.referenceWorkflowPath === undefined) throw new Error('minimax-h3-image has no reference graph');
const referenceText = readFileSync(h3.referenceWorkflowPath, 'utf8');
const referencePlaceholders = [...h3.requiredPlaceholders, '{{referenceImage}}'];

interface Node {
  class_type: string;
  inputs: Record<string, unknown>;
}

type Link = [string, number];

const params = { prompt: 'A poster reading "OPEN LATE" above a neon diner', seed: 2026, width: 2496, height: 3328, count: 1, steps: h3.defaultSteps, outputScale: 2048 / 3328 };

function build(): Record<string, Node> {
  return buildWorkflow(workflowText, params, h3.requiredPlaceholders) as Record<string, Node>;
}

function nodeOf(graph: Record<string, Node>, id: string): Node {
  const value = graph[id];
  if (!value) throw new Error(`missing node ${id}`);
  return value;
}

function linked(graph: Record<string, Node>, from: Node, input: string, output = 0): Node {
  const link = from.inputs[input] as Link;
  expect(Array.isArray(link)).toBe(true);
  expect(link[1]).toBe(output);
  return nodeOf(graph, link[0]);
}

function single(graph: Record<string, Node>, classType: string): Node {
  const matches = Object.values(graph).filter((n) => n.class_type === classType);
  expect(matches).toHaveLength(1);
  const [match] = matches;
  if (!match) throw new Error(`missing ${classType}`);
  return match;
}

function ratioValue(ratio: string): number {
  const [w, h] = ratio.split(':').map(Number);
  if (w === undefined || h === undefined) throw new Error(`bad ratio ${ratio}`);
  return w / h;
}

describe('MiniMax H3 Image workflow', () => {
  test('row is an enabled, unbatched local image model outside the Krea family', () => {
    expect(KREA_MODELS.map((m) => m.id)).not.toContain('minimax-h3-image');
    expect(h3.name).toBe('MiniMax H3 Image');
    expect(h3.family).toBe('h3image');
    expect(h3.order).toBe(95);
    expect(h3.residencyKey).toBeUndefined();
    expect(h3.outputKind).toBeUndefined();
    expect(h3.promptFormat).toBeUndefined();
    expect(h3.saveImageNodeId).toBe('9');
    expect(h3.requiredPlaceholders).toEqual(['{{prompt}}', '{{seed}}', '{{width}}', '{{height}}', '{{steps}}', '{{outputScale}}']);
    expect(h3.outputLongEdge).toBe(2048);
    expect(h3.size).toBe('≤16MP → 2K · INT8 ConvRot');
    expect(h3.defaultSteps).toBe(6);
    expect(h3.batched).toBe(false);
    expect(h3.defaultCount).toBe(1);
    expect(h3.defaultRatio).toBe('3:4');
    expect(h3.ratioMap).toBe('h3image-16mp');
    expect(h3.referenceWorkflowPath).toEndWith('/minimax-h3-image/reference.json');
    expect(h3.maxReferenceImages).toBe(3);
    expect(h3.referenceRatioDims?.['3:4']).toEqual({ width: 1728, height: 2304 });
    expect(h3.referenceRequiredModelFiles).toBeUndefined();
    expect(h3.extendWorkflowPath).toBeUndefined();
    expect(h3.requiredClipType).toBe('minimax');
    expect(h3.requiredModelFiles).toEqual([
      'minimax_h3_image_pruned_int8_convrot.safetensors',
      'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
      'minimax_h3_image_vae_fp16.safetensors',
    ]);
    for (const token of h3.requiredPlaceholders) expect(workflowText).toContain(token);
    expect(workflowText).not.toContain('{{count}}');
  });

  test('ratio map stays at ~16 MP, under the worker PNG cap, with every edge a multiple of 32 and the nominal ratio', () => {
    expect(h3.supportedRatios).toEqual([...RATIO_VALUES]);
    for (const ratio of h3.supportedRatios) {
      const { width, height } = h3.ratioDims[ratio];
      expect(width % 32).toBe(0);
      expect(height % 32).toBe(0);
      const megapixels = (width * height) / 1_000_000;
      expect(megapixels).toBeGreaterThan(16);
      expect(megapixels).toBeLessThan(16.9);
      // An 8-bit RGB PNG is at most a few kilobytes larger than its raw pixels.
      expect(width * height * 3).toBeLessThan(50 * 1024 * 1024 - 1024 * 1024);
      expect(Math.abs(width / height / ratioValue(ratio) - 1)).toBeLessThan(0.02);
    }
    expect(h3.ratioDims['3:4']).toEqual({ width: 3552, height: 4736 });
  });

  test('reference renders use ~4 MP sizes on the 32 grid that keep the 16 MP aspect', () => {
    const reference = h3.referenceRatioDims;
    if (reference === undefined) throw new Error('minimax-h3-image has no reference ratio map');
    for (const ratio of h3.supportedRatios) {
      const { width, height } = reference[ratio];
      const full = h3.ratioDims[ratio];
      expect(width % 32).toBe(0);
      expect(height % 32).toBe(0);
      const megapixels = (width * height) / 1_000_000;
      expect(megapixels).toBeGreaterThan(3.9);
      expect(megapixels).toBeLessThan(4.3);
      // Editing a 16 MP tile must not reframe it.
      expect(Math.abs(width / height / (full.width / full.height) - 1)).toBeLessThan(0.007);
    }
    for (const ratio of ['1:1', '4:5', '3:4'] as const) {
      expect(reference[ratio].width * h3.ratioDims[ratio].height).toBe(reference[ratio].height * h3.ratioDims[ratio].width);
    }
  });

  test('offers 4, 8 and 16 MP, defaulting to 16 MP for text to image and 4 MP with reference pictures', () => {
    expect(h3.resolutionDims).toEqual({
      '4mp': RATIO_MAPS['h3image-4mp'],
      '8mp': RATIO_MAPS['h3image-8mp'],
      '16mp': RATIO_MAPS['h3image-16mp'],
    });
    expect(h3.defaultResolution).toBe('16mp');
    expect(h3.defaultReferenceResolution).toBe('4mp');
  });

  test('the 8 MP map sits on the 32 grid, keeps the 16 MP aspect exactly and delivers a 2048 px long edge', () => {
    const eight = RATIO_MAPS['h3image-8mp'];
    for (const ratio of h3.supportedRatios) {
      const { width, height } = eight[ratio];
      const full = h3.ratioDims[ratio];
      expect(width % 32).toBe(0);
      expect(height % 32).toBe(0);
      const megapixels = (width * height) / 1_000_000;
      expect(megapixels).toBeGreaterThan(7.4);
      expect(megapixels).toBeLessThan(8.4);
      expect(width * full.height).toBe(height * full.width);
      const scale = 2048 / Math.max(width, height);
      expect(Math.max(Math.round(width * scale), Math.round(height * scale))).toBe(2048);
    }
  });

  test('every ratio is delivered at a 2048 px long edge, for text-to-image and reference renders alike', () => {
    // ImageScaleBy rounds each side of the rendered frame times the factor.
    const delivered = (dims: { width: number; height: number }) => {
      const scale = 2048 / Math.max(dims.width, dims.height);
      return { width: Math.round(dims.width * scale), height: Math.round(dims.height * scale) };
    };
    const reference = h3.referenceRatioDims;
    if (reference === undefined) throw new Error('minimax-h3-image has no reference ratio map');
    for (const ratio of h3.supportedRatios) {
      for (const dims of [h3.ratioDims[ratio], reference[ratio]]) {
        const out = delivered(dims);
        expect(Math.max(out.width, out.height)).toBe(2048);
        expect(Math.abs(out.width / out.height / ratioValue(ratio) - 1)).toBeLessThan(0.02);
      }
    }
    expect(delivered(h3.ratioDims['3:4'])).toEqual({ width: 1536, height: 2048 });
    expect(delivered(reference['3:4'])).toEqual({ width: 1536, height: 2048 });
    expect(delivered(h3.ratioDims['1:1'])).toEqual({ width: 2048, height: 2048 });
  });

  test('loaders bind the INT8 DiT, the Qwen3-VL encoder as minimax and the image VAE', () => {
    const graph = build();
    expect(single(graph, 'UNETLoader').inputs).toMatchObject({
      unet_name: 'minimax_h3_image_pruned_int8_convrot.safetensors',
      weight_dtype: 'default',
    });
    expect(single(graph, 'CLIPLoader').inputs).toMatchObject({
      clip_name: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
      type: 'minimax',
    });
    expect(single(graph, 'VAELoader').inputs.vae_name).toBe('minimax_h3_image_vae_fp16.safetensors');
  });

  test('samples euler / simple at CFG 1 with the substituted seed and steps through the attention patch', () => {
    const graph = build();
    const sampler = single(graph, 'KSampler');
    expect(sampler.inputs).toMatchObject({
      seed: params.seed,
      steps: 6,
      cfg: 1,
      sampler_name: 'euler',
      scheduler: 'simple',
      denoise: 1,
    });
    const attention = linked(graph, sampler, 'model');
    expect(attention.class_type).toBe('ModelAttentionBackend');
    expect(attention.inputs.attention).toBe('comfy kitchen attention');
    expect(linked(graph, attention, 'model').class_type).toBe('UNETLoader');
  });

  test('the conditioning node takes the prompt and size and feeds positive, zeroed negative and latent', () => {
    const graph = build();
    const sampler = single(graph, 'KSampler');
    const conditioning = single(graph, 'MiniMaxH3ImageConditioning');
    expect(conditioning.inputs).toMatchObject({ prompt: params.prompt, width: params.width, height: params.height });
    expect(linked(graph, conditioning, 'clip').class_type).toBe('CLIPLoader');
    expect(linked(graph, conditioning, 'vae').class_type).toBe('VAELoader');
    expect(linked(graph, sampler, 'positive')).toBe(conditioning);
    expect(linked(graph, sampler, 'latent_image', 1)).toBe(conditioning);
    const negative = linked(graph, sampler, 'negative');
    expect(negative.class_type).toBe('ConditioningZeroOut');
    expect(linked(graph, negative, 'conditioning')).toBe(conditioning);
    expect(Object.values(graph).some((n) => n.class_type === 'CLIPTextEncode')).toBe(false);
  });

  test('decodes into a single SaveImageWebsocket terminal with every link resolving', () => {
    const graph = build();
    const save = nodeOf(graph, h3.saveImageNodeId);
    expect(save.class_type).toBe('SaveImageWebsocket');
    expect(Object.values(graph).filter((n) => n.class_type === 'SaveImageWebsocket')).toHaveLength(1);
    // The 16 MP frame is reduced to a 2K long edge before it leaves the host.
    const downscale = linked(graph, save, 'images');
    expect(downscale).toMatchObject({ class_type: 'ImageScaleBy', inputs: { upscale_method: 'lanczos', scale_by: params.outputScale } });
    expect(Object.values(graph).filter((n) => n.class_type === 'ImageScaleBy')).toHaveLength(1);
    const decode = linked(graph, downscale, 'image');
    expect(decode.class_type).toBe('VAEDecode');
    expect(linked(graph, decode, 'samples').class_type).toBe('KSampler');
    expect(linked(graph, decode, 'vae').class_type).toBe('VAELoader');
    for (const node of Object.values(graph)) {
      for (const value of Object.values(node.inputs)) {
        if (Array.isArray(value)) {
          expect(value).toHaveLength(2);
          expect(graph[value[0] as string]).toBeDefined();
        }
      }
    }
    expect(workflowText).not.toMatch(/\{\{(?!prompt|seed|width|height|steps|outputScale)[^}]*\}\}/);
  });

  test('the reference graph is the base graph plus one loader per <Picture N> slot', () => {
    const base = build();
    for (const count of [1, 2, 3]) {
      const referenceImages = ['job:a', 'job:b', 'job:c'].slice(0, count);
      const graph = buildWorkflow(referenceText, { ...params, referenceImages }, referencePlaceholders) as Record<string, Node>;
      const conditioning = single(graph, 'MiniMaxH3ImageConditioning');
      const pictures = Object.keys(conditioning.inputs).filter((name) => name.startsWith('images.'));
      expect(pictures).toEqual(referenceImages.map((_, slot) => `images.image_${slot + 1}`));
      referenceImages.forEach((token, slot) => {
        const loader = linked(graph, conditioning, `images.image_${slot + 1}`);
        expect(loader).toEqual({ class_type: 'LoadImage', inputs: { image: token } });
      });
      expect(Object.values(graph).filter((n) => n.class_type === 'LoadImage')).toHaveLength(count);
      // The reference latents need the image VAE on the conditioning node.
      expect(linked(graph, conditioning, 'vae').class_type).toBe('VAELoader');
      // Everything else is the base graph: same weights, sampler, size and terminal.
      const stripped = structuredClone(graph);
      for (const [id, node] of Object.entries(stripped)) {
        if (node.class_type === 'LoadImage') Reflect.deleteProperty(stripped, id);
        for (const name of Object.keys(node.inputs)) if (name.startsWith('images.')) Reflect.deleteProperty(node.inputs, name);
      }
      expect(stripped).toEqual(base);
    }
  });
});

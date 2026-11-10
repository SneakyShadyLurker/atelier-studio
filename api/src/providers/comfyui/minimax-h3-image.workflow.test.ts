import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { RATIO_VALUES } from '@atelier/shared';
import { buildWorkflow } from './template';
import { loadBuiltinCatalog } from './catalog';

const { kreaModels: KREA_MODELS, models: LOCAL_MODELS } = loadBuiltinCatalog();

const _h3 = LOCAL_MODELS.find((m) => m.id === 'minimax-h3-image');
if (!_h3) throw new Error('minimax-h3-image row missing from LOCAL_MODELS');
const h3 = _h3;
const workflowText = readFileSync(h3.workflowPath, 'utf8');

interface Node {
  class_type: string;
  inputs: Record<string, unknown>;
}

type Link = [string, number];

const params = { prompt: 'A poster reading "OPEN LATE" above a neon diner', seed: 2026, width: 2496, height: 3328, count: 1, steps: h3.defaultSteps };

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
    expect(h3.requiredPlaceholders).toEqual(['{{prompt}}', '{{seed}}', '{{width}}', '{{height}}', '{{steps}}']);
    expect(h3.defaultSteps).toBe(6);
    expect(h3.batched).toBe(false);
    expect(h3.defaultCount).toBe(1);
    expect(h3.defaultRatio).toBe('3:4');
    expect(h3.ratioMap).toBe('h3image-8mp');
    expect(h3.referenceWorkflowPath).toBeUndefined();
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

  test('ratio map stays at ~8 MP with every edge a multiple of 32 and the nominal ratio', () => {
    expect(h3.supportedRatios).toEqual([...RATIO_VALUES]);
    for (const ratio of h3.supportedRatios) {
      const { width, height } = h3.ratioDims[ratio];
      expect(width % 32).toBe(0);
      expect(height % 32).toBe(0);
      const megapixels = (width * height) / 1_000_000;
      expect(megapixels).toBeGreaterThan(7.8);
      expect(megapixels).toBeLessThan(8.6);
      expect(Math.abs(width / height / ratioValue(ratio) - 1)).toBeLessThan(0.02);
    }
    expect(h3.ratioDims['3:4']).toEqual({ width: 2496, height: 3328 });
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
    const decode = linked(graph, save, 'images');
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
    expect(workflowText).not.toMatch(/\{\{(?!prompt|seed|width|height|steps)[^}]*\}\}/);
  });
});

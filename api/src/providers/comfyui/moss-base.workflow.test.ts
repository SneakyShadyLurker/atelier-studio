import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildWorkflow } from './template';
import { loadBuiltinCatalog } from './catalog';

const { kreaModels: KREA_MODELS, models: LOCAL_MODELS } = loadBuiltinCatalog();

const _moss = LOCAL_MODELS.find((m) => m.id === 'moss-base');
if (!_moss) throw new Error('moss-base row missing from LOCAL_MODELS');
const moss = _moss;
const workflowText = readFileSync(moss.workflowPath, 'utf8');

interface Node {
  class_type: string;
  inputs: Record<string, unknown>;
}

type Link = [string, number];

const params = { prompt: 'Candid RAW photo of a woman on a balcony', seed: 1001, width: 1216, height: 1632, count: 4, steps: moss.defaultSteps };

function build(overrides: Partial<typeof params> = {}): Record<string, Node> {
  return buildWorkflow(workflowText, { ...params, ...overrides }, moss.requiredPlaceholders) as Record<string, Node>;
}

function nodeOf(graph: Record<string, Node>, id: string): Node {
  const value = graph[id];
  if (!value) throw new Error(`missing node ${id}`);
  return value;
}

function linked(graph: Record<string, Node>, from: Node, input: string): Node {
  const link = from.inputs[input] as Link;
  expect(Array.isArray(link)).toBe(true);
  expect(link[1]).toBe(0);
  return nodeOf(graph, link[0]);
}

function single(graph: Record<string, Node>, classType: string): Node {
  const matches = Object.values(graph).filter((n) => n.class_type === classType);
  expect(matches).toHaveLength(1);
  const [match] = matches;
  if (!match) throw new Error(`missing ${classType}`);
  return match;
}

describe('MOSS Base workflow', () => {
  test('row is a batched local image model outside the Krea family', () => {
    expect(LOCAL_MODELS.map((m) => m.id)).toContain('moss-base');
    expect(KREA_MODELS.map((m) => m.id)).not.toContain('moss-base');
    expect(moss.name).toBe('MOSS Base');
    expect(moss.saveImageNodeId).toBe('9');
    expect(moss.requiredPlaceholders).toEqual(['{{prompt}}', '{{seed}}', '{{width}}', '{{height}}', '{{count}}', '{{steps}}']);
    expect(moss.defaultSteps).toBe(50);
    expect(moss.batched).toBe(true);
    expect(moss.defaultCount).toBe(4);
    expect(moss.defaultRatio).toBe('3:4');
    expect(moss.referenceWorkflowPath).toBeUndefined();
    expect(moss.extendWorkflowPath).toBeUndefined();
    expect(moss.requiredClipType).toBe('moss_image');
    expect(moss.requiredModelFiles).toEqual([
      'moss_image_base_int8_convrot.safetensors',
      'qwen3.5_9b_int8_convrot.safetensors',
      'flux2-vae.safetensors',
    ]);
    for (const token of moss.requiredPlaceholders) expect(workflowText).toContain(token);
  });

  test('ratio map stays at ~2 MP (1.9-2.06) with every side a multiple of 32', () => {
    for (const { width, height } of Object.values(moss.ratioDims)) {
      expect(width % 32).toBe(0);
      expect(height % 32).toBe(0);
      const megapixels = (width * height) / 1_000_000;
      expect(megapixels).toBeGreaterThan(1.9);
      expect(megapixels).toBeLessThan(2.06);
    }
    expect(moss.ratioDims['4:5']).toEqual({ width: 1280, height: 1600 });
    expect(moss.ratioDims['3:4']).toEqual({ width: 1216, height: 1632 });
  });

  test('loaders bind the INT8 Base DiT, the Qwen3.5-9B encoder as moss_image and the full FLUX.2 VAE', () => {
    const graph = build();
    expect(single(graph, 'UNETLoader').inputs).toMatchObject({
      unet_name: 'moss_image_base_int8_convrot.safetensors',
      weight_dtype: 'default',
    });
    expect(single(graph, 'CLIPLoader').inputs).toMatchObject({
      clip_name: 'qwen3.5_9b_int8_convrot.safetensors',
      type: 'moss_image',
    });
    expect(single(graph, 'VAELoader').inputs.vae_name).toBe('flux2-vae.safetensors');
  });

  test('one SamplerCustom pass: ER-SDE at s_noise 1.1, simple schedule, CFG 3, real quality-only negative', () => {
    const graph = build();
    expect(Object.values(graph).some((n) => n.class_type === 'KSampler')).toBe(false);
    const sampler = single(graph, 'SamplerCustom');
    expect(sampler.inputs).toMatchObject({ add_noise: true, noise_seed: params.seed, cfg: 3 });
    expect(linked(graph, sampler, 'sampler').inputs).toMatchObject({
      solver_type: 'ER-SDE',
      max_stage: 3,
      eta: 1,
      s_noise: 1.1,
    });
    const schedule = linked(graph, sampler, 'sigmas');
    expect(schedule.class_type).toBe('BasicScheduler');
    expect(schedule.inputs).toMatchObject({ scheduler: 'simple', steps: 50, denoise: 1 });
    expect(schedule.inputs.model).toEqual(sampler.inputs.model);
    const positive = linked(graph, sampler, 'positive');
    expect(positive.class_type).toBe('CLIPTextEncode');
    expect(positive.inputs.text).toBe(params.prompt);
    const negative = linked(graph, sampler, 'negative');
    expect(negative.class_type).toBe('CLIPTextEncode');
    expect((negative.inputs.text as string).length).toBeGreaterThan(0);
    expect(negative.inputs.text).not.toMatch(/nsfw/i);
    for (const encoder of [positive, negative]) {
      expect(linked(graph, encoder, 'clip').class_type).toBe('CLIPLoader');
    }
  });

  test('a step override reaches the scheduler', () => {
    expect(single(build({ steps: 30 }), 'BasicScheduler').inputs.steps).toBe(30);
  });

  test('skip-layer guidance on single blocks 22 and 24 over 0-1 feeds the attention patch, which feeds the sampler', () => {
    const graph = build();
    const attention = linked(graph, single(graph, 'SamplerCustom'), 'model');
    expect(attention.class_type).toBe('ModelAttentionBackend');
    expect(attention.inputs.attention).toBe('comfy kitchen attention');
    const slg = linked(graph, attention, 'model');
    expect(slg.class_type).toBe('SkipLayerGuidanceDiTSimple');
    expect(slg.inputs).toMatchObject({ single_layers: '22, 24', double_layers: '', start_percent: 0, end_percent: 1 });
    expect(linked(graph, slg, 'model').class_type).toBe('UNETLoader');
  });

  test('EmptyFlux2LatentImage takes the substituted size and batch count', () => {
    const graph = build();
    const latent = linked(graph, single(graph, 'SamplerCustom'), 'latent_image');
    expect(latent.class_type).toBe('EmptyFlux2LatentImage');
    expect(latent.inputs).toEqual({ width: params.width, height: params.height, batch_size: params.count });
  });

  test('decodes the single pass into one SaveImageWebsocket terminal with every link resolving', () => {
    const graph = build();
    expect(Object.values(graph).some((n) => n.class_type === 'ImageScaleBy' || n.class_type === 'VAEEncode')).toBe(false);
    const save = nodeOf(graph, moss.saveImageNodeId);
    expect(save.class_type).toBe('SaveImageWebsocket');
    expect(Object.values(graph).filter((n) => n.class_type === 'SaveImageWebsocket')).toHaveLength(1);
    const decode = linked(graph, save, 'images');
    expect(decode.class_type).toBe('VAEDecode');
    expect(linked(graph, decode, 'samples')).toBe(single(graph, 'SamplerCustom'));
    expect(linked(graph, decode, 'vae').class_type).toBe('VAELoader');
    for (const node of Object.values(graph)) {
      for (const value of Object.values(node.inputs)) {
        if (Array.isArray(value)) {
          expect(value).toHaveLength(2);
          expect(graph[value[0] as string]).toBeDefined();
          expect(value[1]).toBe(0);
        }
      }
    }
    expect(workflowText).not.toMatch(/\{\{(?!prompt|seed|width|height|count|steps)[^}]*\}\}/);
  });

  test('is deliberately LoRA-free', () => {
    expect(Object.values(build()).some((n) => n.class_type === 'LoraLoaderModelOnly')).toBe(false);
  });
});

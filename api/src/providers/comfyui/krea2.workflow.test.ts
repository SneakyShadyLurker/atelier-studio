import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadBuiltinCatalog } from './catalog';
import { kreaSampling, type WorkflowNode as Node } from '../../test/kreaSampling';
import { buildWorkflow } from './template';

const { kreaModels: KREA_MODELS } = loadBuiltinCatalog();

// euler / 8 steps / CFG 1.0 with the `simple` scheduler (the official
// Krea 2 template setting).
const SAMPLING = { steps: 8, cfg: 1, sampler_name: 'euler' };
const KREA_SAMPLING: Record<string, typeof SAMPLING> = {
  'krea-2-gonzalomo': SAMPLING,
};
const KREA_SCHEDULER: Record<string, string> = {
  'krea-2-gonzalomo': 'simple',
};

describe('shipped Krea 2 workflows', () => {
  test.each([...KREA_MODELS])('$id reference graph preserves its finetune and sampler with the ReID chain', (model) => {
    if (!model.referenceWorkflowPath) throw new Error('missing reference graph');
    expect(model.referenceWorkflowPath).toBe(join(dirname(model.workflowPath), 'reference.json'));
    const params = { prompt: 'face reference test', seed: 7, width: 1536, height: 2048, count: 2, steps: model.defaultSteps };
    const base = buildWorkflow(readFileSync(model.workflowPath, 'utf8'), params, model.requiredPlaceholders) as Record<string, Node>;
    const graph = buildWorkflow(
      readFileSync(model.referenceWorkflowPath, 'utf8'),
      { ...params, referenceImage: 'reference.png' },
      [...model.requiredPlaceholders, '{{referenceImage}}'],
    ) as Record<string, Node>;
    const node = (id: string): Node => {
      const value = graph[id];
      if (!value) throw new Error(`missing node ${id}`);
      return value;
    };
    const linked = (from: Node, input: string): Node => {
      const link = from.inputs[input] as [string, number];
      expect(link[1]).toBe(0);
      return node(link[0]);
    };
    expect(node(model.saveImageNodeId).class_type).toBe('SaveImageWebsocket');
    expect(Object.values(graph).filter((n) => n.class_type === 'SaveImageWebsocket')).toHaveLength(1);
    const sampling = kreaSampling(graph);
    expect(sampling.nodeId).toBe('15');
    expect(sampling.seed).toBe(params.seed);
    expect(sampling.steps).toBe(KREA_SAMPLING[model.id]?.steps);
    const baseSampling = kreaSampling(base);
    for (const key of ['steps', 'cfg', 'sampler_name', 'scheduler', 'denoise'] as const) {
      expect(sampling[key]).toEqual(baseSampling[key]);
    }
    const patch = node(sampling.model[0]);
    expect(patch.class_type).toBe('Krea2OstrisEditModelPatch');
    expect(patch.inputs.kv_cache).toBe(true);
    const lora = linked(patch, 'model');
    expect(lora.class_type).toBe('LoraLoaderModelOnly');
    expect(lora.inputs).toMatchObject({ lora_name: 'krea2_reid_rank32.safetensors', strength_model: 1 });
    const attention = linked(lora, 'model');
    expect(attention.class_type).toBe('ModelAttentionBackend');
    expect(attention.inputs.attention).toBe('comfy kitchen attention');
    const unet = linked(attention, 'model');
    expect(unet.class_type).toBe('UNETLoader');
    expect(unet.inputs.unet_name).toBe(Object.values(base).find((n) => n.class_type === 'UNETLoader')?.inputs.unet_name);
    expect(Object.values(graph).filter((n) => n.class_type === 'TextEncodeKrea2OstrisEdit')).toHaveLength(2);
    for (const branch of ['positive', 'negative'] as const) {
      const method = node(sampling[branch][0]);
      expect(method.class_type).toBe('FluxKontextMultiReferenceLatentMethod');
      expect(method.inputs.reference_latents_method).toBe('index_timestep_zero');
      const encoder = linked(method, 'conditioning');
      expect(encoder.class_type).toBe('TextEncodeKrea2OstrisEdit');
      expect(encoder.inputs.prompt).toBe(branch === 'positive' ? params.prompt : '');
      expect(linked(encoder, 'clip').class_type).toBe('CLIPLoader');
      expect(linked(encoder, 'vae').class_type).toBe('VAELoader');
      const scale = linked(encoder, 'image1');
      expect(scale.class_type).toBe('ImageScaleToTotalPixels');
      expect(scale.inputs).toMatchObject({ megapixels: 0.140625, upscale_method: 'area', resolution_steps: 16 });
      expect(linked(scale, 'image')).toEqual({ class_type: 'LoadImage', inputs: { image: 'reference.png' } });
    }
    const latent = node(sampling.latent[0]);
    expect(latent.class_type).toBe('EmptySD3LatentImage');
    expect(latent.inputs.batch_size).toBe(params.count);
    const decode = linked(node(model.saveImageNodeId), 'images');
    expect(decode.class_type).toBe('VAEDecode');
    expect(decode.inputs.samples).toEqual([sampling.nodeId, 0]);
    expect(JSON.stringify(graph)).not.toContain('{{');
  });

  test('every Krea row requires ReID for its reference graph', () => {
    for (const model of KREA_MODELS) {
      expect(model.referenceRequiredModelFiles).toEqual(['krea2_reid_rank32.safetensors']);
    }
  });

  for (const model of KREA_MODELS) {
    test(`${model.id} uses its websocket/attention-patched graph`, () => {
      const text = readFileSync(model.workflowPath, 'utf8');
      const workflow = buildWorkflow(
        text,
        { prompt: 'workflow test', seed: 7, width: 1536, height: 2048, count: 4, steps: model.defaultSteps },
        model.requiredPlaceholders,
      ) as Record<string, Node>;
      expect(workflow[model.saveImageNodeId]?.class_type).toBe('SaveImageWebsocket');
      expect(Object.values(workflow).filter((node) => node.class_type === 'SaveImageWebsocket')).toHaveLength(1);
      const attn = Object.values(workflow).find((node) => node.class_type === 'ModelAttentionBackend');
      expect(attn?.inputs.attention).toBe('comfy kitchen attention');
      const sampling = kreaSampling(workflow);
      expect(sampling).toMatchObject({
        ...KREA_SAMPLING[model.id],
        scheduler: KREA_SCHEDULER[model.id],
        denoise: 1,
      });
      expect(workflow[sampling.model[0]]?.class_type).toBe('ModelAttentionBackend');
      const decode = Object.values(workflow).find((node) => node.class_type === 'VAEDecode');
      expect(decode?.inputs.samples).toEqual([sampling.nodeId, 0]);
      expect(JSON.stringify(workflow)).not.toContain('{{');
    });
  }

  test.each([...KREA_MODELS])('$id uses a single-pass Krea sampler', (model) => {

    const workflow = buildWorkflow(
      readFileSync(model.workflowPath, 'utf8'),
      { prompt: 'single pass', seed: 7, width: 1536, height: 2048, count: 4, steps: model.defaultSteps },
      model.requiredPlaceholders,
    ) as Record<string, Node>;

    const samplerEntries = Object.entries(workflow).filter(([, node]) => node.class_type.includes('Sampler'));
    expect(samplerEntries).toHaveLength(1);
    const samplerEntry = samplerEntries[0];
    expect(samplerEntry).toBeDefined();
    if (!samplerEntry) return;
    const [samplerId, sampler] = samplerEntry;
    expect(sampler.class_type).toBe('KSampler');
    expect(sampler.inputs).toMatchObject({
      ...KREA_SAMPLING[model.id],
      scheduler: KREA_SCHEDULER[model.id],
      denoise: 1,
      seed: 7,
    });
    const modelRef = sampler.inputs.model as [string, number] | undefined;
    const negativeRef = sampler.inputs.negative as [string, number] | undefined;
    const latentRef = sampler.inputs.latent_image as [string, number] | undefined;
    expect(modelRef ? workflow[modelRef[0]]?.class_type : undefined).toBe('ModelAttentionBackend');
    // At CFG 1.0 the negative is inert, so it is the zeroed placeholder; a
    // real empty-prompt encode is only required above CFG 1.0.
    expect(negativeRef ? workflow[negativeRef[0]]?.class_type : undefined).toBe('ConditioningZeroOut');
    expect(latentRef ? workflow[latentRef[0]]?.class_type : undefined).toBe('EmptySD3LatentImage');
    const decode = Object.values(workflow).find((node) => node.class_type === 'VAEDecode');
    expect(decode?.inputs.samples).toEqual([samplerId, 0]);
    expect(Object.values(workflow).some((node) => node.class_type.includes('FaceDetailer'))).toBe(false);
  });
});

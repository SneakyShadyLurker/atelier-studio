import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_MODELS_DIR, loadBuiltinCatalog } from './catalog';
import { kreaSampling, type WorkflowNode as Node } from '../../test/kreaSampling';
import { buildWorkflow } from './template';

const { kreaModels: KREA_MODELS } = loadBuiltinCatalog();

const MODEL_FILES = new Map<string, string>([
  ['krea-2-gonzalomo', 'gonzalomo_krea2_v4_int8_convrot.safetensors'],
]);

// Krea rows run euler at CFG 1.0. Steps and scheduler are per row; a row
// without a published setting follows the official Krea 2 template
// (8 steps, `simple`).
const euler8 = (scheduler: string) => ({ steps: 8, cfg: 1, sampler_name: 'euler', scheduler });
const SAMPLING = new Map<string, ReturnType<typeof euler8>>([
  ['krea-2-gonzalomo', euler8('simple')],
]);

const load = (workflowPath: string, placeholders: readonly string[], steps: number, count = 4) =>
  buildWorkflow(
    readFileSync(workflowPath, 'utf8'),
    { prompt: 'a "quoted" prompt', seed: 999, width: 1536, height: 2048, count, steps },
    placeholders,
  ) as Record<string, Node>;

describe('shipped direct-host Krea 2 workflows', () => {
  test('the active registry contains the bundled Krea rows on their graphs', () => {
    expect(KREA_MODELS.map((model) => model.id)).toEqual([...MODEL_FILES.keys()]);
    for (const model of KREA_MODELS) {
      expect(model.workflowPath).toBe(join(BUILTIN_MODELS_DIR, model.id, 'workflow.json'));
    }
  });

  for (const model of KREA_MODELS) {
    test(`${model.id} pins the direct WebSocket/Sage graph`, () => {
      const workflow = load(model.workflowPath, model.requiredPlaceholders, model.defaultSteps);
      const expectedModel = MODEL_FILES.get(model.id);
      if (!expectedModel) throw new Error(`${model.id} expected model file missing`);
      const unet = Object.values(workflow).find((node) => node.class_type === 'UNETLoader');
      const clip = Object.values(workflow).find((node) => node.class_type === 'CLIPLoader');
      const vae = Object.values(workflow).find((node) => node.class_type === 'VAELoader');
      const sampling = kreaSampling(workflow);
      const sage = Object.values(workflow).find((node) => node.class_type === 'ModelAttentionBackend');

      expect(unet?.inputs.unet_name).toBe(expectedModel);
      expect(clip?.inputs).toMatchObject({
        clip_name: 'qwen3vl_4b_bf16.safetensors',
        type: 'krea2',
      });
      expect(vae?.inputs.vae_name).toBe('qwen_image_vae.safetensors');
      expect(sage?.inputs.attention).toBe('comfy kitchen attention');
      expect(workflow[sampling.model[0]]?.class_type).toBe('ModelAttentionBackend');
      const expectedSampling = SAMPLING.get(model.id);
      if (!expectedSampling) throw new Error(`${model.id} expected sampling missing`);
      // The configured default is what reaches the sampler when no override is set.
      expect(model.defaultSteps).toBe(expectedSampling.steps);
      const negativeNode = workflow[sampling.negative[0]];
      // CFG 1.0 rows zero the negative (inert). Any row above CFG 1.0 must
      // encode a real empty prompt instead: guiding away from a zero tensor
      // crosshatches the frame. No current row runs above CFG 1.0; the
      // branch guards the rule for a future one.
      if (expectedSampling.cfg > 1) {
        expect(negativeNode).toEqual({ class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: '' } });
      } else {
        expect(negativeNode?.class_type).toBe('ConditioningZeroOut');
      }
      expect(sampling).toMatchObject({
        ...expectedSampling,
        denoise: 1,
      });
      expect(workflow[model.saveImageNodeId]?.class_type).toBe('SaveImageWebsocket');
      expect(Object.values(workflow).filter((node) => node.class_type === 'SaveImageWebsocket')).toHaveLength(1);
      expect(model.requiredModelFiles).toEqual([
        expectedModel,
        'qwen3vl_4b_bf16.safetensors',
        'qwen_image_vae.safetensors',
      ]);
      expect(JSON.stringify(workflow)).not.toContain('{{');
    });

    test(`${model.id} samples a user step override on the base sampler`, () => {
      const workflow = load(model.workflowPath, model.requiredPlaceholders, 23);
      expect(kreaSampling(workflow).steps).toBe(23);
    });

    test(`${model.id} preserves batch substitution and graph integrity`, () => {
      const workflow = load(model.workflowPath, model.requiredPlaceholders, model.defaultSteps, 3);
      const latent = Object.values(workflow).find((node) => node.class_type === 'EmptySD3LatentImage');
      expect(latent?.inputs.batch_size).toBe(3);

      const isRef = (value: unknown): value is [string, number] =>
        Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'number';
      for (const [id, node] of Object.entries(workflow)) {
        for (const value of Object.values(node.inputs)) {
          if (isRef(value)) expect(workflow[value[0]], `node ${id} references ${value[0]}`).toBeDefined();
        }
      }
    });
  }
});

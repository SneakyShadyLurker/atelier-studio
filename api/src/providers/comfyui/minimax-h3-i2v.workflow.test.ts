import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildWorkflow } from './template';
import { BUILTIN_MODELS_DIR, loadLocalModelCatalog } from './catalog';

// The H3 rows are disabled templates; enable them as a deployment would.
const { models: LOCAL_MODELS } = loadLocalModelCatalog({
  builtinDir: BUILTIN_MODELS_DIR,
  enableModels: ['minimax-h3-i2v', 'minimax-h3-t2v'],
});

const _h3 = LOCAL_MODELS.find((m) => m.id === 'minimax-h3-i2v');
if (!_h3) throw new Error('minimax-h3-i2v row missing from LOCAL_MODELS');
const h3 = _h3;
const workflowText = readFileSync(h3.workflowPath, 'utf8');

interface Node {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

// Stock template derived from the official ComfyUI H3 graph: the pruned INT8
// transformer through the official 8-step turbo LoRA, euler/simple/8 with
// shift 12/7, the NVFP4 encoder and the INT8 video VAE.
const BUILD = {
  transformer: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors',
  turboLora: 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors',
  encoder: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
  videoVae: 'minimax_h3_video_vae_int8_convrot.safetensors',
  sampler: 'euler',
  steps: 8,
  sigmaShift: { video: 12, audio: 7 },
} as const;

describe('MiniMax H3 I2V workflow', () => {
  const build = (videoFrames = 124, steps: number = h3.defaultSteps): Record<string, Node> =>
    buildWorkflow(
      workflowText,
      {
        prompt: 'fallback prompt',
        motionPrompt: 'slow cinematic push in',
        sourceImage: 'atelier-source.png',
        seed: 123,
        width: 1344,
        height: 768,
        count: 1,
        videoFrames,
        steps,
      },
      h3.requiredPlaceholders,
    ) as Record<string, Node>;

  test('is plain JSON (no leading comment) and parses', () => {
    expect(workflowText.trimStart().startsWith('{')).toBe(true);
    expect(() => build()).not.toThrow();
  });

  test('declares a video LocalModelDef with all required placeholders present', () => {
    expect(h3.outputKind).toBe('video');
    expect(h3.requiredPlaceholders).toEqual([
      '{{motionPrompt}}',
      '{{seed}}',
      '{{width}}',
      '{{height}}',
      '{{sourceImage}}',
      '{{videoFrames}}',
      '{{steps}}',
    ]);
    expect(h3.defaultSteps).toBe(BUILD.steps);
    for (const token of h3.requiredPlaceholders) {
      expect(workflowText).toContain(token);
    }
  });

  test('terminal chain is VAEDecode -> CreateVideo(24fps, muxed audio) -> native SaveVideo(mp4/h264)', () => {
    const wf = build();
    const saves = Object.values(wf).filter((n) => n.class_type === 'SaveVideo');
    expect(saves).toHaveLength(1);
    expect(wf[h3.saveImageNodeId]?.class_type).toBe('SaveVideo');
    expect(Object.values(wf).some((n) => n.class_type.startsWith('VHS_'))).toBe(false);
    const save = wf[h3.saveImageNodeId];
    expect(save?.inputs.format).toBe('mp4');
    expect(save?.inputs.codec).toBe('h264');
    // SaveVideo consumes a VIDEO from CreateVideo, which carries the fps and
    // muxes in the stereo audio decoded from the joint AV latent.
    const videoRef = save?.inputs.video as [string, number];
    expect(wf[videoRef[0]]?.class_type).toBe('CreateVideo');
    expect(wf[videoRef[0]]?.inputs.fps).toBe(24);
    const imagesRef = wf[videoRef[0]]?.inputs.images as [string, number];
    expect(wf[imagesRef[0]]?.class_type).toBe('VAEDecode');
    const audioRef = wf[videoRef[0]]?.inputs.audio as [string, number];
    expect(wf[audioRef[0]]?.class_type).toBe('VAEDecodeAudio');
  });

  test('uses the official H3 guidance-free sampler chain on the 17k+5 frame grid', () => {
    const wf = build();
    const types = new Set(Object.values(wf).map((n) => n.class_type));
    expect(types.has('MiniMaxH3ImageToVideo')).toBe(true);
    expect(types.has('BasicGuider')).toBe(true);
    expect(types.has('SamplerCustomAdvanced')).toBe(true);
    expect(types.has('CFGGuider')).toBe(false);
    expect(types.has('KSampler')).toBe(false);
    expect(types.has('KSamplerAdvanced')).toBe(false);
    expect([...Object.values(wf)].filter((n) => n.class_type === 'UNETLoader')).toHaveLength(1);
    // The template's euler/simple/8 recipe.
    const sampler = Object.values(wf).find((n) => n.class_type === 'KSamplerSelect');
    expect(sampler?.inputs.sampler_name).toBe(BUILD.sampler);
    const sched = Object.values(wf).find((n) => n.class_type === 'BasicScheduler');
    expect(sched?.inputs.scheduler).toBe('simple');
    expect(sched?.inputs.steps).toBe(BUILD.steps);
    expect(Object.values(build(124, 14)).find((n) => n.class_type === 'BasicScheduler')?.inputs.steps).toBe(14);
    // Length is fixed on the model's 17k+5 frame grid (124 ≈ 5 s at 24 fps).
    const i2v = Object.values(wf).find((n) => n.class_type === 'MiniMaxH3ImageToVideo');
    expect(i2v?.inputs.length).toBe(124);
    // Clip length is user-selected: every grid point must reach the node as a
    // NUMBER, never the quoted placeholder.
    for (const frames of [124, 243, 362]) {
      const node = Object.values(build(frames)).find((n) => n.class_type === 'MiniMaxH3ImageToVideo');
      expect(node?.inputs.length).toBe(frames);
    }
  });

  test('routes the sampler model through the core attention patch, with no step cache', () => {
    const wf = build();
    const patches = Object.entries(wf).filter(([, n]) => n.class_type === 'ModelAttentionBackend');
    expect(patches).toHaveLength(1);
    const [patchId, patch] = patches[0] ?? [];
    expect(patch?.inputs.attention).toBe('comfy kitchen attention');
    // The patch sits between the sigma shift and BasicGuider, so every forward
    // pass runs through it. It stays OUT of the scheduler's edge because it only
    // swaps the attention kernel and cannot change the sigmas — where the shift
    // does exactly that, so BasicScheduler must consume the SHIFTED model.
    const shifts = Object.entries(wf).filter(([, n]) => n.class_type === 'MiniMaxH3SigmaShift');
    expect(shifts).toHaveLength(1);
    const [shiftId, shift] = shifts[0] ?? [];
    expect(shift?.inputs.shift_video).toBe(BUILD.sigmaShift.video);
    expect(shift?.inputs.shift_audio).toBe(BUILD.sigmaShift.audio);
    const lora = wf[(shift?.inputs.model as [string, number])[0]];
    expect(lora?.class_type).toBe('LoraLoaderModelOnly');
    expect(lora?.inputs).toMatchObject({ lora_name: BUILD.turboLora, strength_model: 1 });
    const unet = wf[(lora?.inputs.model as [string, number])[0]];
    expect(unet?.class_type).toBe('UNETLoader');
    expect(unet?.inputs).toMatchObject({ unet_name: BUILD.transformer, weight_dtype: 'default' });
    expect(patch?.inputs.model).toEqual([shiftId, 0]);
    const sched = Object.values(wf).find((n) => n.class_type === 'BasicScheduler');
    expect(sched?.inputs.model).toEqual([shiftId, 0]);
    const guider = Object.values(wf).find((n) => n.class_type === 'BasicGuider');
    expect(guider?.inputs.model).toEqual([patchId, 0]);
  });

  // Regression guard, measured not theoretical: EasyCache at its stock
  // thresholds skipped 11 of 20 steps on a real 124-frame job and wrecked the
  // output — waxy smeared texture, illegible background detail, chroma speckle.
  // H3's 20-step guidance-free schedule has too little step-to-step redundancy
  // for a reuse cache. Re-adding one needs a real side-by-side render first.
  test('carries no step-reuse cache', () => {
    expect(workflowText).not.toContain('EasyCache');
    expect(workflowText).not.toContain('LazyCache');
  });

  test('loads one source image as the first frame', () => {
    const wf = build();
    const loadImages = Object.values(wf).filter((n) => n.class_type === 'LoadImage');
    expect(loadImages).toHaveLength(1);
    expect(loadImages[0]?.inputs.image).toBe('atelier-source.png');
    const i2v = Object.values(wf).find((n) => n.class_type === 'MiniMaxH3ImageToVideo');
    const firstFrame = i2v?.inputs.first_frame as [string, number];
    expect(wf[firstFrame[0]]?.class_type).toBe('LoadImage');
  });

  test('both video rows and all three graphs agree on the template assets, full VAE and sampler chain', () => {
    const rows = LOCAL_MODELS.filter((model) => model.id === 'minimax-h3-i2v' || model.id === 'minimax-h3-t2v');
    expect(rows).toHaveLength(2);
    expect(h3.requiredModelFiles).toEqual([
      BUILD.transformer, BUILD.turboLora,
      BUILD.encoder, BUILD.videoVae, 'minimax_h3_audio_vae_fp32.safetensors',
    ]);
    for (const row of rows) {
      expect(row.requiredModelFiles).toEqual(h3.requiredModelFiles);
      expect(row.requiredClipType).toBe('minimax');
    }
    const paths = new Set(rows.flatMap((row) => [row.workflowPath, ...(row.extendWorkflowPath ? [row.extendWorkflowPath] : [])]));
    expect(paths.size).toBe(3);
    const sharedClasses = new Set(['UNETLoader', 'LoraLoaderModelOnly', 'CLIPLoader', 'VAELoader', 'KSamplerSelect',
      'BasicScheduler', 'MiniMaxH3SigmaShift', 'ModelAttentionBackend', 'VAEDecode', 'VAEDecodeAudio', 'CreateVideo']);
    const sharedNodes = (graph: Record<string, Node>) =>
      Object.entries(graph).filter(([, node]) => sharedClasses.has(node.class_type));
    const base = JSON.parse(workflowText) as Record<string, Node>;
    for (const path of paths) {
      const graph = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Node>;
      const loaded = Object.values(graph).flatMap((node) => ['unet_name', 'lora_name', 'clip_name', 'vae_name'].flatMap((key) => {
        const asset = node.inputs[key];
        return typeof asset === 'string' ? [asset] : [];
      }));
      expect(loaded.sort()).toEqual([...h3.requiredModelFiles].sort());
      expect(sharedNodes(graph)).toEqual(sharedNodes(base));
    }
  });

  test('substitutes motion, seed, dimensions and source placeholder without dangling refs', () => {
    const wf = build();
    const body = JSON.stringify(wf);
    expect(body).toContain('slow cinematic push in');
    expect(body).not.toContain('{{motionPrompt}}');
    expect(body).not.toContain('{{seed}}');
    expect(body).not.toContain('{{width}}');
    expect(body).not.toContain('{{height}}');
    expect(body).not.toContain('{{sourceImage}}');

    const isRef = (v: unknown): v is [string, number] =>
      Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'number';
    for (const [id, node] of Object.entries(wf)) {
      for (const value of Object.values(node.inputs)) {
        if (isRef(value)) expect(wf[value[0]], `node ${id} references missing node ${value[0]}`).toBeDefined();
      }
    }
  });
});

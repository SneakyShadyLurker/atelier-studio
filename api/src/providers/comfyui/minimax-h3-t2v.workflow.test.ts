import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildWorkflow } from './template';
import { BUILTIN_MODELS_DIR, loadLocalModelCatalog } from './catalog';

// The H3 rows are disabled templates; enable them as a deployment would.
const { models: LOCAL_MODELS } = loadLocalModelCatalog({
  builtinDir: BUILTIN_MODELS_DIR,
  enableModels: ['minimax-h3-i2v', 'minimax-h3-t2v'],
});

const _t2v = LOCAL_MODELS.find((m) => m.id === 'minimax-h3-t2v');
if (!_t2v) throw new Error('minimax-h3-t2v row missing from LOCAL_MODELS');
const t2v = _t2v;
const workflowText = readFileSync(t2v.workflowPath, 'utf8');

interface Node {
  class_type: string;
  inputs: Record<string, unknown>;
}

// Stock template derived from the official ComfyUI H3 graph: euler/simple/8
// with shift 12/7 (see the i2v suite for the transformer and turbo LoRA).
const BUILD = {
  sampler: 'euler',
  steps: 8,
  sigmaShift: { video: 12, audio: 7 },
} as const;

describe('MiniMax H3 T2V workflow', () => {
  const build = (videoFrames = 124): Record<string, Node> =>
    buildWorkflow(
      workflowText,
      { prompt: 'a slow pan over a foggy harbor at dawn', seed: 123, width: 1344, height: 768, count: 1, videoFrames, steps: t2v.defaultSteps },
      t2v.requiredPlaceholders,
    ) as Record<string, Node>;

  test('declares a video LocalModelDef conditioned on the plain prompt — no source image', () => {
    expect(t2v.outputKind).toBe('video');
    expect(t2v.requiredPlaceholders).toEqual(['{{prompt}}', '{{seed}}', '{{width}}', '{{height}}', '{{videoFrames}}', '{{steps}}']);
    expect(t2v.defaultSteps).toBe(BUILD.steps);
    expect(workflowText).not.toContain('{{sourceImage}}');
    expect(workflowText).not.toContain('{{motionPrompt}}');
    for (const token of t2v.requiredPlaceholders) expect(workflowText).toContain(token);
  });

  test('t2va graph: H3 node without first_frame, same guidance-free chain, AV mux at 24fps', () => {
    const wf = build();
    const i2v = Object.values(wf).find((n) => n.class_type === 'MiniMaxH3ImageToVideo');
    expect(i2v).toBeDefined();
    expect(i2v?.inputs.first_frame).toBeUndefined();
    expect(i2v?.inputs.length).toBe(124);
    // Clip length is user-selected: every grid point must reach the node as a
    // NUMBER, never the quoted placeholder.
    for (const frames of [124, 243, 362]) {
      const node = Object.values(build(frames)).find((n) => n.class_type === 'MiniMaxH3ImageToVideo');
      expect(node?.inputs.length).toBe(frames);
    }
    expect(Object.values(wf).some((n) => n.class_type === 'LoadImage')).toBe(false);
    const sampler = Object.values(wf).find((n) => n.class_type === 'KSamplerSelect');
    expect(sampler?.inputs.sampler_name).toBe(BUILD.sampler);
    const save = wf[t2v.saveImageNodeId];
    expect(save?.class_type).toBe('SaveVideo');
    expect(save?.inputs.format).toBe('mp4');
    const videoRef = save?.inputs.video as [string, number];
    expect(wf[videoRef[0]]?.class_type).toBe('CreateVideo');
    expect(wf[videoRef[0]]?.inputs.fps).toBe(24);
    const audioRef = wf[videoRef[0]]?.inputs.audio as [string, number];
    expect(wf[audioRef[0]]?.class_type).toBe('VAEDecodeAudio');
  });

  test('routes the sampler model through the core attention patch, with no step cache', () => {
    const wf = build();
    const patches = Object.entries(wf).filter(([, n]) => n.class_type === 'ModelAttentionBackend');
    expect(patches).toHaveLength(1);
    const [patchId, patch] = patches[0] ?? [];
    expect(patch?.inputs.attention).toBe('comfy kitchen attention');
    // Same edge discipline as the i2v suite: the Sage patch feeds the guider,
    // and BasicScheduler consumes the sigma-shifted model because the shift is
    // what sets the sigmas.
    const shifts = Object.entries(wf).filter(([, n]) => n.class_type === 'MiniMaxH3SigmaShift');
    expect(shifts).toHaveLength(1);
    const [shiftId, shift] = shifts[0] ?? [];
    expect(shift?.inputs.shift_video).toBe(BUILD.sigmaShift.video);
    expect(shift?.inputs.shift_audio).toBe(BUILD.sigmaShift.audio);
    const lora = wf[(shift?.inputs.model as [string, number])[0]];
    expect(lora?.class_type).toBe('LoraLoaderModelOnly');
    expect(wf[(lora?.inputs.model as [string, number])[0]]?.class_type).toBe('UNETLoader');
    expect(patch?.inputs.model).toEqual([shiftId, 0]);
    const sched = Object.values(wf).find((n) => n.class_type === 'BasicScheduler');
    expect(sched?.inputs.model).toEqual([shiftId, 0]);
    expect(sched?.inputs.steps).toBe(BUILD.steps);
    const guider = Object.values(wf).find((n) => n.class_type === 'BasicGuider');
    expect(guider?.inputs.model).toEqual([patchId, 0]);
  });

  // See the i2v suite for the measured reason a step-reuse cache is banned here.
  test('carries no step-reuse cache', () => {
    expect(workflowText).not.toContain('EasyCache');
    expect(workflowText).not.toContain('LazyCache');
  });

  test('loads the template encoder build and sampler recipe', () => {
    expect(t2v.workflowPath).toBe(join(BUILTIN_MODELS_DIR, 'minimax-h3-t2v', 'workflow.json'));
    expect(t2v.requiredClipType).toBe('minimax');
    for (const file of t2v.requiredModelFiles) expect(workflowText).toContain(file);

    const wf = build();
    expect(Object.values(wf).find((n) => n.class_type === 'KSamplerSelect')?.inputs.sampler_name).toBe(BUILD.sampler);
    expect(Object.values(wf).find((n) => n.class_type === 'BasicScheduler')?.inputs.steps).toBe(BUILD.steps);
    const shift = Object.values(wf).find((n) => n.class_type === 'MiniMaxH3SigmaShift');
    expect(shift?.inputs.shift_video).toBe(BUILD.sigmaShift.video);
    expect(shift?.inputs.shift_audio).toBe(BUILD.sigmaShift.audio);
  });

  test('substitutes prompt, seed and dimensions without dangling refs', () => {
    const wf = build();
    const body = JSON.stringify(wf);
    expect(body).toContain('a slow pan over a foggy harbor at dawn');
    expect(body).not.toContain('{{prompt}}');
    expect(body).not.toContain('{{seed}}');
    expect(body).not.toContain('{{width}}');
    expect(body).not.toContain('{{height}}');
    const isRef = (v: unknown): v is [string, number] =>
      Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'number';
    for (const [id, node] of Object.entries(wf)) {
      for (const value of Object.values(node.inputs)) {
        if (isRef(value)) expect(wf[value[0]], `node ${id} references missing node ${value[0]}`).toBeDefined();
      }
    }
  });
});

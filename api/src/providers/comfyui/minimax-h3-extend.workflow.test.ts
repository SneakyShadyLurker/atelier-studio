import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { VIDEO_CONTEXT_FRAMES, snapVideoFrameGrid } from '@atelier/shared';
import { buildWorkflow } from './template';
import { BUILTIN_MODELS_DIR, loadLocalModelCatalog } from './catalog';

// The H3 rows are disabled templates; enable them as a deployment would.
const { models: LOCAL_MODELS } = loadLocalModelCatalog({
  builtinDir: BUILTIN_MODELS_DIR,
  enableModels: ['minimax-h3-i2v', 'minimax-h3-t2v'],
});

const _h3 = LOCAL_MODELS.find((model) => model.id === 'minimax-h3-i2v');
if (!_h3) throw new Error('minimax-h3-i2v row missing from LOCAL_MODELS');
const h3 = _h3;
const extendPath = h3.extendWorkflowPath;
if (extendPath === undefined) throw new Error('minimax-h3-i2v is missing its extend workflow');
const baseText = readFileSync(h3.workflowPath, 'utf8');
const extendText = readFileSync(extendPath, 'utf8');

interface Node {
  class_type: string;
  inputs: Record<string, unknown>;
}

function build(
  text: string,
  extra: Record<string, unknown> = {},
  required: readonly string[] = h3.extendRequiredPlaceholders ?? h3.requiredPlaceholders,
): Record<string, Node> {
  return buildWorkflow(
    text,
    {
      prompt: 'p',
      motionPrompt: 'm',
      seed: 7,
      width: 1344,
      height: 768,
      count: 1,
      videoFrames: 158,
      sourceImage: 'source.png',
      contextVideo: 'context.mp4',
      steps: h3.defaultSteps,
      ...extra,
    },
    required,
  ) as Record<string, Node>;
}

describe('minimax-h3 extend workflow', () => {
  const graph = build(extendText);
  const byClass = (name: string): [string, Node][] =>
    Object.entries(graph).filter(([, node]) => node.class_type === name);
  const only = (name: string): [string, Node] => {
    const [found] = byClass(name);
    if (!found) throw new Error(`extend workflow is missing a ${name} node`);
    return found;
  };

  test('anchors the previous segment through MiniMaxH3AddGuide at frame 0', () => {
    expect(byClass('MiniMaxH3AddGuide').length).toBe(1);
    const [guideId, guide] = only('MiniMaxH3AddGuide');
    expect(guide.inputs.frame_idx).toBe(0);
    // Both halves of the handoff: the guide gets the clip AND its soundtrack,
    // which is the entire reason a continuation beats a still frame.
    expect(guide.inputs.image).toBeDefined();
    expect(guide.inputs.audio).toBeDefined();
    expect(guide.inputs.vae).toBeDefined();
    expect(guide.inputs.audio_vae).toBeDefined();
    // The guide must sit between the H3 node and the guider, or it is inert.
    const guider = byClass('BasicGuider')[0]?.[1];
    expect(guider?.inputs.conditioning).toEqual([guideId, 0]);
  });

  test('feeds the guide from an uploaded clip, not a still', () => {
    const [loadId] = only('LoadVideo');
    const [componentsId, components] = only('GetVideoComponents');
    expect(components.inputs.video).toEqual([loadId, 0]);
    const [, guide] = only('MiniMaxH3AddGuide');
    expect(guide.inputs.image).toEqual([componentsId, 0]);
    expect(guide.inputs.audio).toEqual([componentsId, 1]);
    expect(byClass('LoadImage').length).toBe(0);
    // first_frame would fight the guide for the opening frames.
    const h3Node = byClass('MiniMaxH3ImageToVideo')[0]?.[1];
    expect(h3Node?.inputs.first_frame).toBeUndefined();
  });

  test('keeps the host sampler recipe identical to the still-frame graph', () => {
    const base = build(baseText, {}, h3.requiredPlaceholders);
    const recipe = (g: Record<string, Node>): unknown[] => {
      const pick = (name: string): Node | undefined =>
        Object.values(g).find((node) => node.class_type === name);
      return [
        pick('UNETLoader')?.inputs.unet_name,
        pick('LoraLoaderModelOnly')?.inputs.lora_name,
        pick('CLIPLoader')?.inputs.clip_name,
        pick('KSamplerSelect')?.inputs.sampler_name,
        pick('BasicScheduler')?.inputs.steps,
        pick('BasicScheduler')?.inputs.scheduler,
        pick('MiniMaxH3SigmaShift')?.inputs.shift_video,
        pick('MiniMaxH3SigmaShift')?.inputs.shift_audio,
        pick('CreateVideo')?.inputs.fps,
      ];
    };
    expect(recipe(graph)).toEqual(recipe(base));
    expect(h3.extendRequiredPlaceholders).toContain('{{steps}}');
    expect(byClass('BasicScheduler')[0]?.[1].inputs.steps).toBe(h3.defaultSteps);
    const overridden = build(extendText, { steps: 17 });
    expect(Object.values(overridden).find((node) => node.class_type === 'BasicScheduler')?.inputs.steps).toBe(17);
  });

  test('renders the context head on top of the requested clip length', () => {
    const frames = snapVideoFrameGrid(124 + VIDEO_CONTEXT_FRAMES);
    const withFrames = build(extendText, { videoFrames: frames });
    const h3Node = Object.values(withFrames).find((n) => n.class_type === 'MiniMaxH3ImageToVideo');
    expect(h3Node?.inputs.length).toBe(158);
    // 158 rendered minus the 22-frame head still delivers the requested 124.
    expect(158 - VIDEO_CONTEXT_FRAMES).toBeGreaterThanOrEqual(124);
  });

  test('bans step-reuse caches, as on every other H3 graph', () => {
    for (const node of Object.values(graph)) {
      expect(node.class_type).not.toBe('EasyCache');
      expect(node.class_type).not.toBe('LazyCache');
    }
  });

  test('terminates on the row\'s declared save node', () => {
    expect(graph[h3.saveImageNodeId]?.class_type).toBe('SaveVideo');
  });
});

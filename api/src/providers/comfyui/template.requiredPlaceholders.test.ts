import { describe, expect, test } from 'bun:test';
import { buildWorkflow } from './template';

const KREA_REQUIRED = ['{{prompt}}', '{{seed}}', '{{width}}', '{{height}}', '{{count}}'] as const;

// A KREA-shaped template: 5 placeholders, NO {{upscaleShort}}.
const KREA_SHAPED = JSON.stringify({
  '1': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } },
  '2': { class_type: 'EmptySD3LatentImage', inputs: { width: '{{width}}', height: '{{height}}', batch_size: '{{count}}' } },
  '3': { class_type: 'KSampler', inputs: { seed: '{{seed}}', steps: 8 } },
});

describe('buildWorkflow per-workflow required placeholders', () => {
  test('all string substitutions preserve dollar tokens, quotes and literal placeholders', () => {
    const opaque = '$& $$ $` $\' "quoted" \\ newline\n{{prompt}} {{seed}} {{motionPrompt}}';
    const workflow = buildWorkflow(JSON.stringify({
      prompt: '{{prompt}}', duplicate: '{{prompt}}', motion: '{{motionPrompt}}',
      source: '{{sourceImage}}', reference: '{{referenceImage}}', context: '{{contextVideo}}',
      seed: '{{seed}}', width: '{{width}}', height: '{{height}}', count: '{{count}}',
    }), {
      prompt: opaque, motionPrompt: `motion ${opaque}`, sourceImage: opaque,
      referenceImage: opaque, contextVideo: opaque, seed: 7, width: 32, height: 64, count: 2,
    }, KREA_REQUIRED);
    expect(workflow).toEqual({
      prompt: opaque, duplicate: opaque, motion: `motion ${opaque}`, source: opaque,
      reference: opaque, context: opaque, seed: 7, width: 32, height: 64, count: 2,
    });
    expect(buildWorkflow('{"motion":"{{motionPrompt}}"}', {
      prompt: opaque, seed: 7, width: 32, height: 64, count: 2,
    }, ['{{motionPrompt}}'])).toEqual({ motion: opaque });
  });

  test('referenceImage substitutes a JSON-encoded filename', () => {
    const referenceImage = 'face "one"\\crop\n.png';
    const workflow = buildWorkflow(
      '{"image":"{{referenceImage}}"}',
      { prompt: 'p', seed: 1, width: 1024, height: 1024, count: 1, referenceImage },
      ['{{referenceImage}}'],
    );
    expect(workflow).toEqual({ image: referenceImage });
  });

  test('referenceImage is required when declared', () => {
    expect(() => buildWorkflow(
      '{"image":"{{referenceImage}}"}',
      { prompt: 'p', seed: 1, width: 1024, height: 1024, count: 1 },
      ['{{referenceImage}}'],
    )).toThrow('referenceImage is required');
  });

  test('steps substitutes as a number', () => {
    const workflow = buildWorkflow(
      '{"sampler":{"steps":"{{steps}}"}}',
      { prompt: 'p', seed: 1, width: 1024, height: 1024, count: 1, steps: 23 },
      ['{{steps}}'],
    );
    expect(workflow).toEqual({ sampler: { steps: 23 } });
  });

  test('steps is required when declared', () => {
    expect(() => buildWorkflow(
      '{"sampler":{"steps":"{{steps}}"}}',
      { prompt: 'p', seed: 1, width: 1024, height: 1024, count: 1 },
      [],
    )).toThrow('steps is required');
  });

  test('KREA-shaped build (5 placeholders, no upscaleShort) succeeds', () => {
    const wf = buildWorkflow(
      KREA_SHAPED,
      { prompt: 'a teapot', seed: 5, width: 1536, height: 1536, count: 4 },
      KREA_REQUIRED,
    ) as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
    expect(wf['1']?.inputs.text).toBe('a teapot');
    expect(wf['2']?.inputs.batch_size).toBe(4);
    expect(wf['3']?.inputs.seed).toBe(5);
    // {{upscaleShort}} never appears, so no leftover token and no injected literal.
    expect(JSON.stringify(wf)).not.toContain('upscaleShort');
  });

  test('a workflow missing a required placeholder still throws', () => {
    const missingSeed = JSON.stringify({
      '1': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } },
      '2': { class_type: 'EmptySD3LatentImage', inputs: { width: '{{width}}', height: '{{height}}', batch_size: '{{count}}' } },
    });
    expect(() =>
      buildWorkflow(missingSeed, { prompt: 'p', seed: 1, width: 1024, height: 1024, count: 1 }, KREA_REQUIRED),
    ).toThrow(/missing placeholder \{\{seed\}\}/);
  });

  test('genuinely unknown tokens are still rejected regardless of required set', () => {
    const bogus = JSON.stringify({ '1': { class_type: 'X', inputs: { v: '{{bogus}}', text: '{{prompt}}' } } });
    expect(() =>
      buildWorkflow(bogus, { prompt: 'p', seed: 1, width: 1024, height: 1024, count: 1 }, ['{{prompt}}']),
    ).toThrow(/unknown placeholder \{\{bogus\}\}/);
  });
});

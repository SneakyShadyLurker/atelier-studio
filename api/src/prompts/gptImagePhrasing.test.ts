import { describe, expect, it } from 'bun:test';
import {
  classifyImageModelTarget,
  GPT_IMAGE_PHRASING_RULES,
  isGptImageModelId,
  isLocalOpenWeightsTarget,
} from './gptImagePhrasing';

describe('isGptImageModelId', () => {
  it('matches OpenAI gpt-image models only', () => {
    expect(isGptImageModelId('gpt-image-2.5-sunburst')).toBe(true);
    expect(isGptImageModelId('gpt-image-1.5')).toBe(true);
    expect(isGptImageModelId('gemini-3-pro-image-preview')).toBe(false);
    expect(isGptImageModelId('krea-2-gonzalomo')).toBe(false);
  });
});

describe('classifyImageModelTarget', () => {
  it('classifies the registry models', () => {
    expect(classifyImageModelTarget('gemini-3-pro-image-preview')).toBe('gemini');
    expect(classifyImageModelTarget('gpt-image-2.5-sunburst')).toBe('gpt');
    expect(classifyImageModelTarget('krea-2-gonzalomo')).toBe('krea');
    expect(classifyImageModelTarget('krea-2-test-alpha')).toBe('krea');
    expect(classifyImageModelTarget('moss-image-sft')).toBe('moss');
    expect(classifyImageModelTarget('moss-test-turbo')).toBe('moss');
  });

  it('groups only Krea and MOSS as local open-weights targets', () => {
    expect(isLocalOpenWeightsTarget('krea')).toBe(true);
    expect(isLocalOpenWeightsTarget('moss')).toBe(true);
    for (const target of ['gemini', 'gpt', 'other', null] as const) {
      expect(isLocalOpenWeightsTarget(target)).toBe(false);
    }
  });

  it('is mutually exclusive on composite ids (first match wins, no hybrids)', () => {
    expect(classifyImageModelTarget('gemini-gpt-image-x')).toBe('gemini');
    expect(classifyImageModelTarget('gemini-gpt-image-krea')).toBe('gemini');
    expect(classifyImageModelTarget('gpt-image-krea')).toBe('gpt');
    expect(classifyImageModelTarget('krea-moss')).toBe('krea');
    expect(classifyImageModelTarget('gpt-image-moss')).toBe('gpt');
  });
});

describe('GPT_IMAGE_PHRASING_RULES', () => {
  // The rules embed into the brainstorm meta-prompt, which must stay free of
  // these tokens (age/clothing boundaries are operator-steered via the brief).
  it('carries no policy tokens', () => {
    const lower = GPT_IMAGE_PHRASING_RULES.toLowerCase();
    expect(lower).not.toContain('nude');
    expect(lower).not.toContain('adult');
    expect(GPT_IMAGE_PHRASING_RULES).not.toContain('18');
  });

  it('encodes the register pillars: garment-carried exposure, grown age, willing subject, plain language', () => {
    expect(GPT_IMAGE_PHRASING_RULES).toContain('Exposure is carried by the named garment');
    expect(GPT_IMAGE_PHRASING_RULES).toContain('silhouette and tailoring vocabulary');
    expect(GPT_IMAGE_PHRASING_RULES).toContain('unmistakably grown');
    expect(GPT_IMAGE_PHRASING_RULES).toContain('willing participant');
    expect(GPT_IMAGE_PHRASING_RULES).toContain('No euphemism');
  });

  // The output classifier scans the rendered image (A/B-verified:
  // from-behind composition over a cheeky-cut bottom refused 2/2; full seat
  // coverage passed). The rules must keep the rendered-content rule and must
  // not endorse mid-exposure garment states, which render what the scan blocks.
  it('encodes the rendered-content rule and endorses no mid-exposure states', () => {
    expect(GPT_IMAGE_PHRASING_RULES).toContain('fully cover her seat');
    expect(GPT_IMAGE_PHRASING_RULES).toContain('fully contain her');
    const lower = GPT_IMAGE_PHRASING_RULES.toLowerCase();
    expect(lower).not.toContain('straps slipping');
    expect(lower).not.toContain('clinging cloth');
  });

  // Observed failure anchors: the rules must override
  // conflicting template directives (the fills reproduced "most daring"
  // wardrobe floors and verbatim anatomy vars), must ban the specific input
  // triggers observed (exposure inventories, augmentation vocabulary,
  // intimate-adjacent skin marks, context-mismatched swimwear), and must
  // calibrate outfit composition for the output scanner.
  it('takes precedence over conflicting instructions and calibrates for the output scanner', () => {
    expect(GPT_IMAGE_PHRASING_RULES).toContain('take precedence');
    expect(GPT_IMAGE_PHRASING_RULES).toContain('ONE hero daring element');
    expect(GPT_IMAGE_PHRASING_RULES).toContain('Never combine a micro top with a micro bottom');
    expect(GPT_IMAGE_PHRASING_RULES).toContain('Never inventory bared skin');
    expect(GPT_IMAGE_PHRASING_RULES).toContain('No augmentation vocabulary');
    expect(GPT_IMAGE_PHRASING_RULES).toContain('plausible for the place, hour, weather');
    expect(GPT_IMAGE_PHRASING_RULES).toContain('never on or near the inner thigh');
  });
});

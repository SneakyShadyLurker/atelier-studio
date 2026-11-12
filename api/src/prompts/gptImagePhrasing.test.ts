import { describe, expect, it } from 'bun:test';
import {
  classifyImageModelTarget,
  isGptImageModelId,
  isLocalOpenWeightsTarget,
} from './gptImagePhrasing';

describe('isGptImageModelId', () => {
  it('matches OpenAI gpt-image models only', () => {
    expect(isGptImageModelId('gpt-image-2.6-sunburst')).toBe(true);
    expect(isGptImageModelId('gpt-image-1.5')).toBe(true);
    expect(isGptImageModelId('gemini-3-pro-image-preview')).toBe(false);
    expect(isGptImageModelId('krea-2-gonzalomo')).toBe(false);
  });
});

describe('classifyImageModelTarget', () => {
  it('classifies the registry models', () => {
    expect(classifyImageModelTarget('gemini-3-pro-image-preview')).toBe('gemini');
    expect(classifyImageModelTarget('gpt-image-2.6-sunburst')).toBe('gpt');
    expect(classifyImageModelTarget('krea-2-gonzalomo')).toBe('krea');
    expect(classifyImageModelTarget('krea-2-test-alpha')).toBe('krea');
    expect(classifyImageModelTarget('moss-base')).toBe('moss');
    expect(classifyImageModelTarget('moss-test-turbo')).toBe('moss');
    expect(classifyImageModelTarget('minimax-h3-image')).toBe('h3image');
  });

  it('keeps the MiniMax H3 video rows out of the image family', () => {
    expect(classifyImageModelTarget('minimax-h3-i2v')).toBe('other');
    expect(classifyImageModelTarget('minimax-h3-t2v')).toBe('other');
  });

  it('groups only Krea, MOSS and MiniMax H3 Image as local open-weights targets', () => {
    expect(isLocalOpenWeightsTarget('krea')).toBe(true);
    expect(isLocalOpenWeightsTarget('moss')).toBe(true);
    expect(isLocalOpenWeightsTarget('h3image')).toBe(true);
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
    expect(classifyImageModelTarget('krea-h3-image')).toBe('krea');
    expect(classifyImageModelTarget('moss-h3-image')).toBe('moss');
    expect(classifyImageModelTarget('gpt-image-h3-image')).toBe('gpt');
  });
});

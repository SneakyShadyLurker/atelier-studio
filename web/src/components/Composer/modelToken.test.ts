import { describe, expect, test } from 'bun:test';
import type { Model } from '@atelier/shared';
import { hostLabel, shortModelToken } from './modelToken';

const base = {
  tag: 'cloud',
  latency: 'fast',
  supportedRatios: ['1:1'],
  pool: 'shared',
    concurrencyCapPerUser: 4,
    maxCountPerBatch: 4,
} satisfies Omit<Model, 'id' | 'name' | 'backend'>;

describe('hostLabel', () => {
  test('maps the comfyui tag to its display name', () => {
    expect(hostLabel('comfyui')).toBe('ComfyUI');
  });

  test('capitalizes any other host id', () => {
    expect(hostLabel('studio')).toBe('Studio');
    expect(hostLabel('cloud')).toBe('Cloud');
  });
});

describe('shortModelToken', () => {
  test('local backend → variant identity', () => {
    expect(shortModelToken({ ...base, id: 'krea-2-gonzalomo', name: 'Krea 2 GonzaLomo', backend: 'local', tag: 'comfyui' })).toBe('GonzaLomo');
    expect(shortModelToken({ ...base, id: 'krea-2-test-alpha', name: 'Krea 2 TEST-ALPHA', backend: 'local', tag: 'comfyui' })).toBe('TEST-ALPHA');
    expect(shortModelToken({ ...base, id: 'krea-2-test-beta', name: 'Krea 2 Test Beta', backend: 'local', tag: 'comfyui' })).toBe('Test Beta');
    expect(shortModelToken({ ...base, id: 'krea-2-test-gamma', name: 'Krea 2 TestGamma', backend: 'local', tag: 'comfyui' })).toBe('TestGamma');
  });

  test('local name without a Krea 2 prefix falls back to its first word', () => {
    expect(shortModelToken({ ...base, id: 'krea-2', name: 'KREA 2', backend: 'local', tag: 'comfyui' })).toBe('KREA');
    expect(shortModelToken({ ...base, id: 'minimax-h3-i2v', name: 'MiniMax H3 I2V', backend: 'local', tag: 'comfyui' })).toBe('MiniMax');
  });

  test('google tag → Banana (both Gemini variants collapse)', () => {
    expect(shortModelToken({ ...base, id: 'gemini-3-pro-image-preview', name: 'Nano Banana Pro', backend: 'cloud', tag: 'google' })).toBe('Banana');
    expect(shortModelToken({ ...base, id: 'gemini-3.1-flash-image-preview', name: 'Nano Banana 2', backend: 'cloud', tag: 'google' })).toBe('Banana');
  });

  test('gpt id prefix → GPT', () => {
    expect(shortModelToken({ ...base, id: 'gpt-image-2.5-sunburst', name: 'GPT Image 2.5 Sunburst', backend: 'cloud' })).toBe('GPT');
    expect(shortModelToken({ ...base, id: 'gpt-image-2.5-sunburst-cloud', name: 'GPT Image 2.5 Sunburst', backend: 'cloud' })).toBe('GPT');
  });

  test('fallback → first whitespace word of name', () => {
    expect(shortModelToken({ ...base, id: 'sdxl-1', name: 'SDXL Turbo', backend: 'cloud' })).toBe('SDXL');
  });
});

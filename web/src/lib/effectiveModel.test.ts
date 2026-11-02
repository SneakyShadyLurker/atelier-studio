import { describe, expect, it } from 'bun:test';
import type { Model } from '@atelier/shared';
import { isModelAvailable, resolveEffectiveModel } from './effectiveModel';

function model(o: Partial<Model> & Pick<Model, 'id' | 'backend'>): Model {
  return {
    id: o.id,
    name: o.name ?? o.id,
    backend: o.backend,
    tag: o.tag ?? 'test',
    latency: o.latency ?? 'medium',
    supportedRatios: o.supportedRatios ?? ['1:1'],
    concurrencyCapPerUser: o.concurrencyCapPerUser ?? 1,
    maxCountPerBatch: o.maxCountPerBatch ?? 4,
    pool: o.pool ?? (o.backend === 'cloud' ? 'shared' : 'local'),
    ...(o.availability ? { availability: o.availability } : {}),
    ...(o.requiresKey ? { requiresKey: o.requiresKey } : {}),
    ...(o.supportsI2V ? { supportsI2V: o.supportsI2V } : {}),
    ...(o.outputsVideo ? { outputsVideo: o.outputsVideo } : {}),
  };
}

const gpt = model({ id: 'gpt-image-2.5-sunburst', backend: 'cloud' });
const cloud2 = model({ id: 'cloud-2', backend: 'cloud', pool: 'shared' });
const comfyOnline = model({ id: 'zib-distilled', backend: 'local', pool: 'local' });
const comfyOffline = model({
  id: 'zib-distilled',
  backend: 'local',
  pool: 'local',
  availability: { ok: false, checkedAt: 1, reason: 'unavailable' },
});
const geminiKeyGated = model({ id: 'gemini', backend: 'cloud', pool: 'byok', requiresKey: { provider: 'google' } });

describe('isModelAvailable', () => {
  it('treats cloud models (no availability snapshot) as available', () => {
    expect(isModelAvailable(gpt)).toBe(true);
  });
  it('treats an ok:false probe as unavailable', () => {
    expect(isModelAvailable(comfyOffline)).toBe(false);
  });
  it('treats an ok:true probe as available', () => {
    expect(isModelAvailable(model({ id: 'x', backend: 'local', availability: { ok: true, checkedAt: 1 } }))).toBe(true);
  });
});

describe('resolveEffectiveModel', () => {
  it('honors an available selection', () => {
    expect(resolveEffectiveModel([gpt, cloud2, comfyOnline], 'cloud-2')).toBe(cloud2);
  });

  it('honors an available local selection', () => {
    expect(resolveEffectiveModel([gpt, cloud2, comfyOnline], 'zib-distilled')).toBe(comfyOnline);
  });

  it('falls back to the first usable cloud model for an empty selection', () => {
    expect(resolveEffectiveModel([gpt, cloud2, comfyOnline], '')).toBe(gpt);
  });

  it('falls back to a cloud model when the selected local model is offline', () => {
    expect(resolveEffectiveModel([gpt, cloud2, comfyOffline], 'zib-distilled')).toBe(gpt);
  });

  it('falls back to a cloud model when the selection no longer exists', () => {
    expect(resolveEffectiveModel([gpt, cloud2], 'deregistered-model')).toBe(gpt);
  });

  it('keeps a key-gated cloud selection (it is available; Composer handles BYOK)', () => {
    expect(resolveEffectiveModel([gpt, geminiKeyGated], 'gemini')).toBe(geminiKeyGated);
  });

  it('prefers a non-key cloud model over a key-gated one when falling back', () => {
    expect(resolveEffectiveModel([geminiKeyGated, gpt, comfyOffline], 'zib-distilled')).toBe(gpt);
  });

  it('falls back to a key-gated cloud model when it is the only cloud option', () => {
    expect(resolveEffectiveModel([geminiKeyGated, comfyOffline], 'zib-distilled')).toBe(geminiKeyGated);
  });

  it('picks the first ungated model on a mock-only install, skipping key-gated cloud rows listed first', () => {
    // Registry order: google (key-gated BYOK) rows precede the mock rows.
    const nanoBanana = model({ id: 'nano-banana-pro', backend: 'cloud', pool: 'byok', requiresKey: { provider: 'google' } });
    const mockFast = model({ id: 'mock-fast', backend: 'local', pool: 'shared' });
    const mockSlow = model({ id: 'mock-slow', backend: 'local', pool: 'shared' });
    expect(resolveEffectiveModel([nanoBanana, geminiKeyGated, mockFast, mockSlow], '')).toBe(mockFast);
  });

  it('prefers an available ungated local model over a key-gated cloud one', () => {
    expect(resolveEffectiveModel([geminiKeyGated, comfyOffline, comfyOnline], '')).toBe(comfyOnline);
  });

  it('never falls back to a video row: image-to-video needs a source still, text-to-video is not an image model', () => {
    // Bundled manifests list image-to-video before text-to-video, and local
    // rows precede Mock; with the local image rows offline only video is up.
    const i2v = model({ id: 'minimax-h3-i2v', backend: 'local', pool: 'local', supportsI2V: true, outputsVideo: true });
    const t2v = model({ id: 'minimax-h3-t2v', backend: 'local', pool: 'local', outputsVideo: true });
    const mockFast = model({ id: 'mock-fast', backend: 'local', pool: 'shared' });
    expect(resolveEffectiveModel([geminiKeyGated, comfyOffline, i2v, t2v, mockFast], '')).toBe(mockFast);
    expect(resolveEffectiveModel([geminiKeyGated, comfyOffline, i2v, t2v], '')).toBe(geminiKeyGated);
  });

  it('still prefers ungated cloud over an ungated local model', () => {
    const mockFast = model({ id: 'mock-fast', backend: 'local', pool: 'shared' });
    expect(resolveEffectiveModel([geminiKeyGated, mockFast, gpt], '')).toBe(gpt);
  });

  it('returns undefined when there are no models', () => {
    expect(resolveEffectiveModel([], 'anything')).toBeUndefined();
  });

  it('returns the first entry when nothing is available (no better option)', () => {
    expect(resolveEffectiveModel([comfyOffline], 'zib-distilled')).toBe(comfyOffline);
  });
});

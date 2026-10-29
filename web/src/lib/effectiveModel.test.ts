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

  it('returns undefined when there are no models', () => {
    expect(resolveEffectiveModel([], 'anything')).toBeUndefined();
  });

  it('returns the first entry when nothing is available (no better option)', () => {
    expect(resolveEffectiveModel([comfyOffline], 'zib-distilled')).toBe(comfyOffline);
  });
});

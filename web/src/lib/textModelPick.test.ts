import { describe, expect, test } from 'bun:test';
import type { PublicTextModel, TextModelsResponse } from '@atelier/shared';
import { defaultModelId, groupModelsByProvider, rowPick } from './textModelPick';

function model(id: string, providerName: string, extra: Partial<PublicTextModel> = {}): PublicTextModel {
  return { id, displayName: id.toUpperCase(), providerName, vision: false, reasoningLevels: [], status: 'available', ...extra };
}

const models = [
  model('a', 'P1'),
  model('b', 'P2', { reasoningLevels: ['low', 'high'] }),
  model('c', 'P1'),
  model('off', 'P2', { status: 'offline' }),
];
const byId = new Map(models.map((m) => [m.id, m]));

function listing(over: Partial<TextModelsResponse> = {}): TextModelsResponse {
  return {
    models,
    tasks: [],
    defaults: { default: 'a', byTask: {} },
    writers: { 'img-w': 'c', 'img-off': 'off', 'img-gone': 'missing' },
    lockedWriters: [],
    ...over,
  };
}

describe('groupModelsByProvider', () => {
  test('groups in first-appearance order', () => {
    expect(groupModelsByProvider(models).map((g) => [g.providerName, g.models.map((m) => m.id)])).toEqual([
      ['P1', ['a', 'c']],
      ['P2', ['b', 'off']],
    ]);
  });
});

describe('defaultModelId', () => {
  const row = { task: 'template-draft' as const, effectiveModelId: 'a' };

  test('without an image model, the server-resolved default', () => {
    expect(defaultModelId(listing(), row, byId)).toBe('a');
  });

  test("an image model's online writer comes before the task and global defaults", () => {
    expect(defaultModelId(listing(), row, byId, 'img-w')).toBe('c');
  });

  test('an offline or unlisted writer is skipped', () => {
    expect(defaultModelId(listing(), row, byId, 'img-off')).toBe('a');
    expect(defaultModelId(listing(), row, byId, 'img-gone')).toBe('a');
    expect(defaultModelId(listing(), row, byId, 'img-none')).toBe('a');
  });

  test('with a usable pick, the first online configured default', () => {
    const picked = { task: 'template-draft' as const, pick: 'b', effectiveModelId: 'b', pickState: 'active' as const };
    expect(defaultModelId(listing({ defaults: { default: 'a', byTask: { 'template-draft': 'off' } } }), picked, byId)).toBe('a');
  });
});

describe('rowPick', () => {
  test('an effort counts only while the active pick offers it', () => {
    expect(rowPick({ task: 'template-draft', pick: 'b', effort: 'high', pickState: 'active' }, byId).effort).toBe('high');
    expect(rowPick({ task: 'template-draft', pick: 'b', effort: 'max', pickState: 'active' }, byId).effort).toBe('default');
  });

  test('an offline pick is not active', () => {
    const pick = rowPick({ task: 'template-draft', pick: 'b', effort: 'high', pickState: 'offline' }, byId);
    expect(pick.offlinePick).toBe(true);
    expect(pick.activePick).toBeUndefined();
    expect(pick.effort).toBe('default');
  });
});

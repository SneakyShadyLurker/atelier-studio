import { describe, expect, test } from 'bun:test';
import type { ModelStepsSettingsResponse } from '@atelier/shared';
import { MODEL_STEPS_MAX, MODEL_STEPS_MIN } from '@atelier/shared';
import { catalogForConfig } from '../providers/comfyui/catalog';
import { testConfig, testRuntime } from '../test/helpers';

// The test config enables the bundled H3 templates.
const { models: LOCAL_MODELS } = catalogForConfig(testConfig());

const LOCAL_ON = {
  COMFYUI_BASE_URL: 'http://127.0.0.1:1',
  VIDEO_MODELS_ENABLED: 'true',
  LOCAL_MODELS_USERS: 'alice,bob',
};

function headers(user = 'alice') {
  return { 'Content-Type': 'application/json', 'Remote-User': user };
}

function put(rt: ReturnType<typeof testRuntime>, modelId: string, body: unknown, user = 'alice') {
  return rt.fetch(`/api/settings/model-steps/${modelId}`, {
    method: 'PUT',
    headers: headers(user),
    body: JSON.stringify(body),
  });
}

async function settings(rt: ReturnType<typeof testRuntime>, user = 'alice'): Promise<ModelStepsSettingsResponse> {
  const res = await rt.fetch('/api/settings/model-steps', { headers: headers(user) });
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('private, no-store');
  return await res.json() as ModelStepsSettingsResponse;
}

describe('model steps settings routes', () => {
  test('GET lists every local model with its configured default and no override', async () => {
    const rt = testRuntime(LOCAL_ON);
    const body = await settings(rt);
    expect(body.min).toBe(MODEL_STEPS_MIN);
    expect(body.max).toBe(MODEL_STEPS_MAX);
    expect(body.models).toEqual(LOCAL_MODELS.map((model) => ({
      modelId: model.id,
      name: model.name,
      defaultSteps: model.defaultSteps,
      steps: null,
    })));
    expect(body.models.find((m) => m.modelId === 'moss-image-sft')?.defaultSteps).toBe(50);
  });

  test('PUT sets an override, null resets it, and the default value deletes it', async () => {
    const rt = testRuntime(LOCAL_ON);
    const set = await put(rt, 'moss-image-sft', { steps: 20 });
    expect(set.status).toBe(200);
    expect(set.headers.get('cache-control')).toBe('private, no-store');
    const after = await set.json() as ModelStepsSettingsResponse;
    expect(after.models.find((m) => m.modelId === 'moss-image-sft')).toEqual({
      modelId: 'moss-image-sft', name: 'MOSS Image', defaultSteps: 50, steps: 20,
    });

    const reset = await put(rt, 'moss-image-sft', { steps: null });
    expect((await reset.json() as ModelStepsSettingsResponse).models.find((m) => m.modelId === 'moss-image-sft')?.steps).toBeNull();

    await put(rt, 'moss-image-sft', { steps: 30 });
    const asDefault = await put(rt, 'moss-image-sft', { steps: 50 });
    expect((await asDefault.json() as ModelStepsSettingsResponse).models.every((m) => m.steps === null)).toBe(true);
  });

  test('PUT rejects out-of-range and non-integer values', async () => {
    const rt = testRuntime(LOCAL_ON);
    for (const steps of [0, MODEL_STEPS_MAX + 1, 8.5, '8']) {
      expect((await put(rt, 'krea-2-gonzalomo', { steps })).status).toBe(400);
    }
    expect((await put(rt, 'krea-2-gonzalomo', {})).status).toBe(400);
    expect((await settings(rt)).models.every((m) => m.steps === null)).toBe(true);
  });

  test('PUT 404s for unknown and step-less models', async () => {
    const rt = testRuntime(LOCAL_ON);
    for (const modelId of ['no-such-model', 'gpt-image-2.5-sunburst']) {
      const res = await put(rt, modelId, { steps: 10 });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not found' });
    }
  });

  test('a user without local access sees an empty list and 404s on local models', async () => {
    const rt = testRuntime(LOCAL_ON);
    expect((await settings(rt, 'mallory')).models).toEqual([]);
    const res = await put(rt, 'krea-2-gonzalomo', { steps: 10 }, 'mallory');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });

  test("another user's overrides are not visible", async () => {
    const rt = testRuntime(LOCAL_ON);
    await put(rt, 'krea-2-gonzalomo', { steps: 12 }, 'alice');
    expect((await settings(rt, 'bob')).models.every((m) => m.steps === null)).toBe(true);
    expect((await settings(rt, 'alice')).models.find((m) => m.modelId === 'krea-2-gonzalomo')?.steps).toBe(12);
  });
});

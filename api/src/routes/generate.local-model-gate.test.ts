import { describe, expect, test } from 'bun:test';
import type { ModelAvailability } from '@atelier/shared';
import { catalogForConfig } from '../providers/comfyui/catalog';
import { testConfig, testRuntime } from '../test/helpers';

const VIDEO_ON = {
  COMFYUI_BASE_URL: 'http://127.0.0.1:1',
  VIDEO_MODELS_ENABLED: 'true',
  LOCAL_MODELS_USERS: 'alice',
};
// The runtime catalog for this config: the test config enables the bundled
// H3 templates, so the video rows are covered too.
const { models: LOCAL_MODELS } = catalogForConfig(testConfig(VIDEO_ON));
const UNKNOWN_MODEL = {
  error: 'validation failed',
  issues: [{ path: ['modelId'], message: 'unknown modelId' }],
};

function postGenerate(
  app: ReturnType<typeof testRuntime>['app'],
  userId: string,
  modelId: string,
): Promise<Response> {
  return Promise.resolve(app.fetch(new Request('http://local/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Remote-User': userId },
    body: JSON.stringify({
      prompt: 'a test image',
      modelId,
      ratio: '1:1',
      count: 1,
    }),
  })));
}

describe('POST /api/generate local-model allowlist', () => {
  test('every local model is indistinguishable from an unknown id for a non-listed user', async () => {
    const ids = LOCAL_MODELS.map((model) => model.id);
    for (const id of ['krea-2-gonzalomo', 'moss-image-sft', 'minimax-h3-i2v', 'minimax-h3-t2v']) {
      expect(ids).toContain(id);
    }
    const availability = new Map<string, ModelAvailability>(
      LOCAL_MODELS.map((model, index) => [
        model.id,
        index === 0
          ? { ok: false, checkedAt: 1, reason: 'unavailable' }
          : { ok: true, checkedAt: 1 },
      ]),
    );
    const { app } = testRuntime({ ...VIDEO_ON, availability });

    for (const model of LOCAL_MODELS) {
      const response = await postGenerate(app, 'bob', model.id);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(UNKNOWN_MODEL);
    }
  });

  test('a listed user still reaches the existing availability guard', async () => {
    const availability = new Map<string, ModelAvailability>([
      ['krea-2-gonzalomo', { ok: false, checkedAt: 1, reason: 'unavailable' }],
    ]);
    const { app } = testRuntime({ ...VIDEO_ON, availability });

    const response = await postGenerate(app, 'alice', 'krea-2-gonzalomo');

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'model offline', code: 'MODEL_OFFLINE' });
  });
});

import { describe, expect, test } from 'bun:test';
import { RETRY_AFTER_FIELD, type Model, type ModelAvailability } from '@atelier/shared';
import { startHealthProbe } from '../lifecycle/health-probe';
import { catalogForConfig } from '../providers/comfyui/catalog';
import { findModel } from '../providers/registry';
import type { Provider } from '../providers/types';
import { createApp } from '../server';
import { testConfig, testRuntime } from '../test/helpers';

// The test config enables the bundled H3 templates.
const { models: LOCAL_MODELS } = catalogForConfig(testConfig());

const VIDEO_ON = {
  COMFYUI_BASE_URL: 'http://127.0.0.1:1',
  VIDEO_MODELS_ENABLED: 'true',
  LOCAL_MODELS_USERS: 'alice',
};

async function getModels(userId: string): Promise<{ response: Response; models: Model[] }> {
  const { app } = testRuntime(VIDEO_ON);
  const response = await app.fetch(new Request('http://local/api/models', {
    headers: { 'Remote-User': userId },
  }));
  return { response, models: await response.json() as Model[] };
}

describe('GET /api/models local-model allowlist', () => {
  test('a listed user receives every local model', async () => {
    const { response, models } = await getModels('alice');
    const localIds = models
      .filter((model) => model.pool === 'local')
      .map((model) => model.id)
      .sort();

    expect(response.status).toBe(200);
    expect(localIds).toEqual(LOCAL_MODELS.map((model) => model.id).sort());
  });

  test('a non-listed user receives only cloud models with the private cache policy', async () => {
    const { response, models } = await getModels('bob');

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, max-age=15');
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((model) => model.pool !== 'local')).toBe(true);
  });
});

describe('POST /api/models/:modelId/probe', () => {
  test('returns 404 for an unknown model id', async () => {
    const runtime = testRuntime(VIDEO_ON);
    let probeCalls = 0;
    const app = createApp({
      config: runtime.config,
      db: runtime.db,
      logger: runtime.logger,
      keyStore: runtime.keyStore,
      healthProbe: {
        snapshot: () => new Map<string, ModelAvailability>(),
        probeNow: () => {
          probeCalls += 1;
          return Promise.resolve(undefined);
        },
        stop: () => undefined,
        drain: () => Promise.resolve(),
      },
    });

    const response = await app.fetch(new Request('http://local/api/models/not-a-model/probe', {
      method: 'POST',
      headers: { 'Remote-User': 'alice' },
    }));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not found' });
    expect(probeCalls).toBe(0);
  });

  test('returns the identical 404 for a gated local model without probing it', async () => {
    const runtime = testRuntime(VIDEO_ON);
    let probeCalls = 0;
    const app = createApp({
      config: runtime.config,
      db: runtime.db,
      logger: runtime.logger,
      keyStore: runtime.keyStore,
      healthProbe: {
        snapshot: () => new Map<string, ModelAvailability>(),
        probeNow: () => {
          probeCalls += 1;
          return Promise.resolve(undefined);
        },
        stop: () => undefined,
        drain: () => Promise.resolve(),
      },
    });

    const response = await app.fetch(new Request('http://local/api/models/moss-image-sft/probe', {
      method: 'POST',
      headers: { 'Remote-User': 'bob' },
    }));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not found' });
    expect(probeCalls).toBe(0);
  });

  test('returns the refreshed model list for an allowed user', async () => {
    const runtime = testRuntime(VIDEO_ON);
    const availability = new Map<string, ModelAvailability>([
      ['moss-image-sft', { ok: false, checkedAt: 1, reason: 'unavailable' }],
    ]);
    let probeCalls = 0;
    const app = createApp({
      config: runtime.config,
      db: runtime.db,
      logger: runtime.logger,
      keyStore: runtime.keyStore,
      healthProbe: {
        snapshot: () => availability,
        probeNow: (modelId) => {
          probeCalls += 1;
          const refreshed: ModelAvailability = { ok: true, checkedAt: 2 };
          availability.set(modelId, refreshed);
          return Promise.resolve(refreshed);
        },
        stop: () => undefined,
        drain: () => Promise.resolve(),
      },
    });

    const response = await app.fetch(new Request('http://local/api/models/moss-image-sft/probe', {
      method: 'POST',
      headers: { 'Remote-User': 'alice' },
    }));
    const refreshed = await response.json() as Model[];

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(probeCalls).toBe(1);
    expect(refreshed.find((model) => model.id === 'moss-image-sft')?.availability).toEqual({
      ok: true,
      checkedAt: 2,
    });
  });

  test('uses the real startHealthProbe handle through the server wiring', async () => {
    const userId = 'real-probe-user';
    const runtime = testRuntime({ ...VIDEO_ON, LOCAL_MODELS_USERS: userId });
    const registryEntry = findModel('moss-image-sft', runtime.config);
    if (registryEntry === null) throw new Error('expected local model fixture');
    let healthCalls = 0;
    const provider: Provider = {
      id: 'stub-local',
      backend: 'local',
      healthCheck: () => {
        healthCalls += 1;
        return Promise.resolve({ ok: true });
      },
      async *generate() {
        await Promise.resolve();
        yield { status: 'failed', error: 'unused', seed: 0, index: 0 };
      },
    };
    const healthProbe = startHealthProbe({
      registry: [{ ...registryEntry, bind: () => provider }],
      logger: runtime.logger,
      intervalMs: 60_000,
      probeTimeoutMs: 1_000,
    });
    const app = createApp({
      config: runtime.config,
      db: runtime.db,
      logger: runtime.logger,
      keyStore: runtime.keyStore,
      healthProbe,
    });

    try {
      const callsBeforeProbe = healthCalls;
      const response = await app.fetch(new Request('http://local/api/models/moss-image-sft/probe', {
        method: 'POST',
        headers: { 'Remote-User': userId },
      }));
      const models = await response.json() as Model[];

      expect(response.status).toBe(200);
      expect(healthCalls).toBe(callsBeforeProbe + 1);
      expect(models.find((model) => model.id === 'moss-image-sft')?.availability?.ok).toBe(true);
    } finally {
      healthProbe.stop();
      await healthProbe.drain();
    }
  });

  test('sanitizes a rejected probe through the global request error boundary', async () => {
    const userId = 'rejecting-probe-user';
    const runtime = testRuntime({ ...VIDEO_ON, LOCAL_MODELS_USERS: userId });
    const raw = 'connect ECONNREFUSED 127.0.0.1:8189';
    const app = createApp({
      config: runtime.config,
      db: runtime.db,
      logger: runtime.logger,
      keyStore: runtime.keyStore,
      healthProbe: {
        snapshot: () => new Map<string, ModelAvailability>(),
        probeNow: () => Promise.reject(new Error(raw)),
        stop: () => undefined,
        drain: () => Promise.resolve(),
      },
    });

    const response = await app.fetch(new Request('http://local/api/models/moss-image-sft/probe', {
      method: 'POST',
      headers: { 'Remote-User': userId },
    }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: 'internal error' });
    expect(JSON.stringify(body)).not.toContain(raw);
  });

  test('limits each user to ten probes per thirty seconds', async () => {
    const userId = 'probe-budget-user';
    const runtime = testRuntime({ ...VIDEO_ON, LOCAL_MODELS_USERS: userId });
    let probeCalls = 0;
    const app = createApp({
      config: runtime.config,
      db: runtime.db,
      logger: runtime.logger,
      keyStore: runtime.keyStore,
      healthProbe: {
        snapshot: () => new Map<string, ModelAvailability>(),
        probeNow: () => {
          probeCalls += 1;
          return Promise.resolve({ ok: true, checkedAt: Date.now() });
        },
        stop: () => undefined,
        drain: () => Promise.resolve(),
      },
    });
    const request = () => app.fetch(new Request('http://local/api/models/moss-image-sft/probe', {
      method: 'POST',
      headers: { 'Remote-User': userId },
    }));

    for (let i = 0; i < 10; i += 1) {
      expect((await request()).status).toBe(200);
    }
    const blocked = await request();
    const body = await blocked.json() as Record<string, unknown>;

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBe('3');
    expect(body).toMatchObject({
      error: 'queue full',
      code: 'QUEUE_FULL',
      reason: 'user',
      [RETRY_AFTER_FIELD]: 3,
    });
    const retryAfterMs = body.retryAfterMs;
    expect(typeof retryAfterMs).toBe('number');
    if (typeof retryAfterMs !== 'number') throw new Error('expected numeric retryAfterMs');
    expect(retryAfterMs).toBeGreaterThan(0);
    expect(retryAfterMs).toBeLessThanOrEqual(3_000);
    expect(probeCalls).toBe(10);
  });
});

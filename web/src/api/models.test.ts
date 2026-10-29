import { describe, expect, test } from 'bun:test';
import type { Model } from '@atelier/shared';
import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './client';
import { fetchModels, mergeModelsByAvailabilityFreshness, modelKeys, modelsOpts } from './models';

function model(overrides: Partial<Model> = {}): Model {
  return {
    id: 'gpt-image-2.5-sunburst',
    name: 'GPT Image 2.5 Sunburst',
    backend: 'cloud',
    tag: 'cloud',
    latency: 'medium',
    supportedRatios: ['1:1', '4:5'],
    concurrencyCapPerUser: 4,
    maxCountPerBatch: 4,
    pool: 'shared',
    ...overrides,
  };
}

function createClient(): QueryClient {
  const structuralSharing = modelsOpts().structuralSharing;
  if (typeof structuralSharing !== 'function') throw new Error('modelsOpts structuralSharing is not configured');
  return new QueryClient({ defaultOptions: { queries: { retry: false, structuralSharing } } });
}

function setModels(client: QueryClient, input: readonly Model[]): readonly Model[] {
  client.setQueryData(modelKeys.list(), input);
  const models = client.getQueryData<readonly Model[]>(modelKeys.list());
  if (models === undefined) throw new Error('models cache was not written');
  return models;
}

describe('modelsOpts structuralSharing', () => {
  test('keeps the previous array when an identical snapshot arrives', () => {
    const client = createClient();
    const first = setModels(client, [model({ availability: { ok: false, checkedAt: 91_000, reason: 'unavailable' } })]);
    const second = setModels(client, [model({ availability: { ok: false, checkedAt: 91_000, reason: 'unavailable' } })]);

    expect(second).toBe(first);
    expect(second[0]).toBe(first[0]);
  });

  test('retains the exact newest checkedAt when availability advances with the same status', () => {
    const client = createClient();
    setModels(client, [model({ availability: { ok: false, checkedAt: 91_000, reason: 'unavailable' } })]);
    const advanced = setModels(client, [model({ availability: { ok: false, checkedAt: 91_400, reason: 'unavailable' } })]);

    expect(advanced[0]?.availability).toEqual({ ok: false, checkedAt: 91_400, reason: 'unavailable' });
  });

  test('rejects an intermediate stale status after a same-status timestamp advance', () => {
    const client = createClient();
    setModels(client, [model({ availability: { ok: true, checkedAt: 300 } })]);
    const advanced = setModels(client, [model({ availability: { ok: true, checkedAt: 330 } })]);
    // Checked after the first sample but before the retained one: a lossy
    // fence that had kept 300 would accept this offline snapshot.
    const afterStale = setModels(client, [model({ availability: { ok: false, checkedAt: 310, reason: 'unavailable' } })]);

    expect(afterStale).toBe(advanced);
    expect(afterStale[0]?.availability).toEqual({ ok: true, checkedAt: 330 });
  });

  test('a stale poll landing after a newer probe cannot regress availability', () => {
    const client = createClient();
    setModels(client, [model({ availability: { ok: false, checkedAt: 100, reason: 'unavailable' } })]);
    const probed = mergeModelsByAvailabilityFreshness(
      client.getQueryData<readonly Model[]>(modelKeys.list()),
      [model({ availability: { ok: true, checkedAt: 200 } })],
    );
    const afterProbe = setModels(client, probed);
    const afterPoll = setModels(client, [model({ availability: { ok: false, checkedAt: 150, reason: 'unavailable' } })]);

    expect(afterPoll).toBe(afterProbe);
    expect(afterPoll[0]?.availability).toEqual({ ok: true, checkedAt: 200 });
  });

  test('follows incoming registry membership and order while keeping fresher availability', () => {
    const client = createClient();
    const local = model({ id: 'local-a', backend: 'local', tag: 'comfyui', pool: 'local', availability: { ok: true, checkedAt: 500 } });
    const cloud = model();
    const first = setModels(client, [cloud, local]);
    const next = setModels(client, [
      model({ id: 'local-a', backend: 'local', tag: 'comfyui', pool: 'local', availability: { ok: false, checkedAt: 400, reason: 'unavailable' } }),
      model({ id: 'added', name: 'Added' }),
    ]);

    expect(next.map((entry) => entry.id)).toEqual(['local-a', 'added']);
    expect(next[0]).toBe(first[1]);
    expect(next[0]?.availability).toEqual({ ok: true, checkedAt: 500 });
  });

  test('returns the new array when rendered model fields change', () => {
    const client = createClient();
    const first = setModels(client, [model({ availability: { ok: false, checkedAt: 1000, reason: 'unavailable' } })]);
    const second = setModels(client, [model({ availability: { ok: true, checkedAt: 2000 } })]);

    expect(second).not.toBe(first);
    expect(second[0]).not.toBe(first[0]);
  });

  test('returns the new array when batching metadata changes', () => {
    const client = createClient();
    const first = setModels(client, [model({ batched: false, defaultCount: 1 })]);
    const second = setModels(client, [model({ batched: true, defaultCount: 4 })]);

    expect(second).not.toBe(first);
    expect(second[0]).not.toBe(first[0]);
  });

  test('returns the new array when the default ratio changes', () => {
    const client = createClient();
    const first = setModels(client, [model({ defaultRatio: '1:1' })]);
    const second = setModels(client, [model({ defaultRatio: '4:5' })]);

    expect(second).not.toBe(first);
    expect(second[0]).not.toBe(first[0]);
  });

  test('keeps the previous array when only an older checkedAt arrives', () => {
    const client = createClient();
    const first = setModels(client, [model({ availability: { ok: false, checkedAt: 95_000, reason: 'unavailable' } })]);
    const second = setModels(client, [model({ availability: { ok: false, checkedAt: 85_000, reason: 'unavailable' } })]);

    expect(second).toBe(first);
    expect(second[0]).toBe(first[0]);
  });

  test('returns the new array when array length changes', () => {
    const client = createClient();
    const first = setModels(client, [model()]);
    const second = setModels(client, [model(), model({ id: 'zib-distilled', name: 'ZIB Distilled', backend: 'local', tag: 'comfyui', pool: 'local' })]);

    expect(second).not.toBe(first);
    expect(second[0]).toBe(first[0]);
  });

  test('drops a model removed from the registry', () => {
    const client = createClient();
    const first = setModels(client, [model(), model({ id: 'retired', name: 'Retired' })]);
    const second = setModels(client, [model()]);

    expect(second.map((entry) => entry.id)).toEqual(['gpt-image-2.5-sunburst']);
    expect(second[0]).toBe(first[0]);
  });
});

describe('mergeModelsByAvailabilityFreshness', () => {
  test('rejects out-of-order availability while preserving untouched identities', () => {
    const first = model({
      id: 'first',
      availability: { ok: false, checkedAt: 100, reason: 'unavailable' },
    });
    const untouched = model({
      id: 'untouched',
      availability: { ok: true, checkedAt: 500 },
    });
    const cached = [first, untouched] as const;
    const newest = mergeModelsByAvailabilityFreshness(cached, [
      model({ id: 'first', availability: { ok: true, checkedAt: 300 } }),
      model({ id: 'untouched', availability: { ok: false, checkedAt: 400, reason: 'unavailable' } }),
    ]);

    expect(newest).not.toBe(cached);
    expect(newest[0]?.availability).toEqual({ ok: true, checkedAt: 300 });
    expect(newest[1]).toBe(untouched);

    const stale = mergeModelsByAvailabilityFreshness(newest, [
      model({ id: 'first', availability: { ok: false, checkedAt: 200, reason: 'unavailable' } }),
      model({ id: 'untouched', availability: { ok: false, checkedAt: 450, reason: 'unavailable' } }),
    ]);

    expect(stale).toBe(newest);
    expect(stale[0]).toBe(newest[0]);
    expect(stale[1]).toBe(untouched);
  });

  test('uses the incoming list when the cache is empty', () => {
    const incoming = [model({ availability: { ok: true, checkedAt: 1 } })];
    expect(mergeModelsByAvailabilityFreshness(undefined, incoming)).toBe(incoming);
  });
});

describe('fetchModels', () => {
  test('rejects malformed model responses', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify([{ id: 'gpt-image-2.5-sunburst' }]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))) as unknown as typeof fetch;
    try {
      let caught: unknown;
      try {
        await fetchModels();
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ApiError);
      expect(caught).toMatchObject({
        status: 200,
        body: { code: 'invalid-response-shape' },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('rejects invalid batching metadata', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify([
      model({ batched: true, defaultCount: 4 }),
      { ...model(), id: 'bad-model', batched: 'yes' },
    ]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))) as unknown as typeof fetch;
    try {
      let caught: unknown;
      try {
        await fetchModels();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect(caught).toMatchObject({
        status: 200,
        body: { code: 'invalid-response-shape' },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('rejects a default ratio outside the model supported ratios', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify([
      { ...model(), defaultRatio: '3:4' },
    ]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))) as unknown as typeof fetch;
    try {
      let caught: unknown;
      try {
        await fetchModels();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect(caught).toMatchObject({
        status: 200,
        body: { code: 'invalid-response-shape' },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('accepts a default ratio included in the model supported ratios', async () => {
    const originalFetch = globalThis.fetch;
    const expected = [model({ defaultRatio: '4:5' })];
    globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify(expected), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))) as unknown as typeof fetch;
    try {
      expect(await fetchModels()).toEqual(expected);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('rejects invalid availability metadata', async () => {
    const originalFetch = globalThis.fetch;
    try {
      for (const availability of [
        { ok: 'yes', checkedAt: 1 },
        { ok: false, checkedAt: 1, reason: 'ECONNREFUSED 10.0.0.5:8189' },
      ]) {
        globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify([
          { ...model(), availability },
        ]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }))) as unknown as typeof fetch;

        let caught: unknown;
        try {
          await fetchModels();
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(ApiError);
        expect(caught).toMatchObject({
          status: 200,
          body: { code: 'invalid-response-shape' },
        });
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

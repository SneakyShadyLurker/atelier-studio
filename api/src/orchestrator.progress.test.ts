import { describe, expect, test } from 'bun:test';
import type { Provider, ProviderProgress, ProviderResult } from './providers/types';
import type { RegistryEntry } from './providers/registry';
import { createGenerationStream } from './test/streamHarness';
import { parseSseText, testRuntime } from './test/helpers';
import { pngBytes } from './test/image-fixtures';

function localImageEntry(provider: Provider, batched: boolean): RegistryEntry {
  return {
    model: {
      id: 'krea-2-gonzalomo',
      name: 'Krea 2 GonzaLomo',
      backend: 'local',
      tag: 'comfyui',
      latency: 'medium',
      supportedRatios: ['1:1'],
      pool: 'local',
      concurrencyCapPerUser: 1,
      maxCountPerBatch: 3,
      ...(batched ? { batched: true } : {}),
    },
    bind: () => provider,
    timeoutMs: ({ local }) => local,
  };
}

function progressProvider(frames: ProviderProgress[], batched: boolean): Provider {
  return {
    id: 'mock-local', backend: 'local',
    async *generate(req, _signal, options): AsyncIterable<ProviderResult> {
      for (const frame of frames) options?.onProgress?.(frame);
      await Promise.resolve();
      const count = batched ? req.count ?? 1 : 1;
      for (let index = 0; index < count; index += 1) {
        yield { status: 'ready', bytes: pngBytes(), ext: 'png', mime: 'image/png', seed: req.seed, index };
      }
    },
  };
}

async function progressEvents(frames: ProviderProgress[], count: number, batched: boolean) {
  const { db, config, logger } = testRuntime();
  const provider = progressProvider(frames, batched);
  const stream = createGenerationStream({
    db, config, logger, userId: 'alice',
    request: { prompt: 'a lighthouse', modelId: 'krea-2-gonzalomo', ratio: '1:1', count },
    registryEntry: localImageEntry(provider, batched), boundProvider: provider,
    disconnectSignal: new AbortController().signal,
    onTileSettled: () => undefined, onSyncFailure: () => undefined,
  });
  const events = parseSseText(await new Response(stream).text());
  return events
    .map((event) => event.data)
    .filter((data): data is Record<string, unknown> => typeof data === 'object' && data !== null
      && (data as Record<string, unknown>).status === 'progress');
}

const STEP = { progress: 12 / 33, phase: '20', step: 12, totalSteps: 25, pass: 1, passCount: 2 };

describe('orchestrator progress', () => {
  test('a local image row emits step progress tile events', async () => {
    const events = await progressEvents([STEP], 1, false);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: 'progress', ...STEP });
  });

  test('a batched local row fans progress out to every tile', async () => {
    const events = await progressEvents([STEP], 3, true);
    expect(events).toHaveLength(3);
    expect(new Set(events.map((event) => event.tileId)).size).toBe(3);
    expect(events.map((event) => event.tileIndex).sort()).toEqual([0, 1, 2]);
    for (const event of events) expect(event).toMatchObject(STEP);
  });

  test('malformed step fields fall back to the fraction alone', async () => {
    const events = await progressEvents([
      { progress: 0.5, step: 30, totalSteps: 25, pass: 1, passCount: 1 },
      { progress: 0.6, step: 2.5, totalSteps: 25, pass: 1, passCount: 1 },
      { progress: 0.7, step: 3, totalSteps: 25, pass: 3, passCount: 2 },
      { progress: 0.8, step: 0, totalSteps: 25, pass: 1, passCount: 1 },
    ], 1, false);
    expect(events.map((event) => event.progress)).toEqual([0.5, 0.6, 0.7, 0.8]);
    for (const event of events) {
      expect(event.step).toBeUndefined();
      expect(event.totalSteps).toBeUndefined();
      expect(event.pass).toBeUndefined();
      expect(event.passCount).toBeUndefined();
    }
  });
});

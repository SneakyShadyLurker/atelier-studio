import { describe, expect, test } from 'bun:test';
import type { Provider, ProviderRequest, ProviderResult } from './providers/types';
import type { RegistryEntry } from './providers/registry';
import { testRuntime, testTextServices } from './test/helpers';
import { pngBytes } from './test/image-fixtures';
import { runBatchPipeline } from './orchestrator';
import { createBatch } from './orchestrator/createBatch';
import { writeModelStepsOverride } from './routing/modelStepsPreference';

const DEFAULT_STEPS = 8;

function localEntry(provider: Provider): RegistryEntry {
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
      maxCountPerBatch: 1,
    },
    bind: () => provider,
    timeoutMs: ({ local }) => local,
    defaultSteps: DEFAULT_STEPS,
  };
}

async function runOne(
  runtime: ReturnType<typeof testRuntime>,
  provider: Provider,
  beforeDispatch: () => void = () => undefined,
): Promise<string> {
  const { db, config, logger } = runtime;
  const registryEntry = localEntry(provider);
  const request = { prompt: 'a lighthouse', modelId: 'krea-2-gonzalomo', ratio: '1:1' as const, count: 1 };
  const prepared = createBatch(db, 'alice', request, registryEntry);
  db.query("UPDATE batches SET status = 'running' WHERE id = ?").run(prepared.batch.id);
  beforeDispatch();
  await runBatchPipeline(prepared, {
    db, config, logger, text: testTextServices(db, config), userId: 'alice', request, registryEntry, boundProvider: provider,
    disconnectSignal: new AbortController().signal,
    onTileSettled: () => undefined, onSyncFailure: () => undefined,
    promptPrepared: true,
  });
  return db.query<{ status: string }, [string]>('SELECT status FROM tiles WHERE batch_id = ?').get(prepared.batch.id)?.status ?? 'missing';
}

function capturingProvider(requests: ProviderRequest[], delayMs = 0, budgets?: (number | undefined)[]): Provider {
  return {
    id: 'mock-local', backend: 'local',
    async *generate(req, signal, options): AsyncIterable<ProviderResult> {
      requests.push(req);
      budgets?.push(options?.executionTimeoutMs);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason as Error); }, { once: true });
      });
      yield { status: 'ready', bytes: pngBytes(), ext: 'png', mime: 'image/png', seed: req.seed, index: 0 };
    },
  };
}

describe('per-model steps at dispatch', () => {
  test('no override leaves the provider on the model default', async () => {
    const requests: ProviderRequest[] = [];
    expect(await runOne(testRuntime(), capturingProvider(requests))).toBe('done');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.steps).toBeUndefined();
  });

  test('an override stored before dispatch reaches the provider request', async () => {
    const runtime = testRuntime();
    const requests: ProviderRequest[] = [];
    const budgets: (number | undefined)[] = [];
    // Written after submit: the value is read at dispatch, not at submit.
    const status = await runOne(runtime, capturingProvider(requests, 0, budgets), () => {
      writeModelStepsOverride(runtime.db, 'alice', 'krea-2-gonzalomo', 14, DEFAULT_STEPS);
    });
    expect(status).toBe('done');
    expect(requests[0]?.steps).toBe(14);
    expect(budgets).toEqual([Math.ceil(runtime.config.LOCAL_TIMEOUT_MS * 14 / DEFAULT_STEPS)]);
  });

  test("another user's override does not apply", async () => {
    const runtime = testRuntime();
    writeModelStepsOverride(runtime.db, 'bob', 'krea-2-gonzalomo', 14, DEFAULT_STEPS);
    const requests: ProviderRequest[] = [];
    await runOne(runtime, capturingProvider(requests));
    expect(requests[0]?.steps).toBeUndefined();
  });

  test('the local timeout scales with an override above the default', async () => {
    const slow = { LOCAL_TIMEOUT_MS: '200' };
    const withDefault = testRuntime(slow);
    expect(await runOne(withDefault, capturingProvider([], 500))).toBe('failed');

    const lower = testRuntime(slow);
    writeModelStepsOverride(lower.db, 'alice', 'krea-2-gonzalomo', 4, DEFAULT_STEPS);
    expect(await runOne(lower, capturingProvider([], 500))).toBe('failed');

    const higher = testRuntime(slow);
    // 32 / 8 = 4x the 200 ms budget, comfortably above the 500 ms render.
    writeModelStepsOverride(higher.db, 'alice', 'krea-2-gonzalomo', 32, DEFAULT_STEPS);
    expect(await runOne(higher, capturingProvider([], 500))).toBe('done');
  });
});

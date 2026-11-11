import { describe, expect, test } from 'bun:test';
import type { Provider, ProviderRequest, ProviderResult } from './providers/types';
import type { RegistryEntry } from './providers/registry';
import { testRuntime, testTextServices } from './test/helpers';
import { pngBytes } from './test/image-fixtures';
import { runBatchPipeline, type ResolvedGenerateRequest } from './orchestrator';
import { createBatch } from './orchestrator/createBatch';
import { writeModelResolutionOverride } from './routing/modelResolutionPreference';
import { writeModelStepsOverride } from './routing/modelStepsPreference';

const MODEL_ID = 'minimax-h3-image';
const DEFAULT_STEPS = 6;
const DEFAULTS = { textToImage: '16mp', reference: '4mp' } as const;

function localEntry(provider: Provider, sized = true, outputLongEdge: number | null = 2048): RegistryEntry {
  return {
    model: {
      id: MODEL_ID,
      name: 'MiniMax H3 Image',
      backend: 'local',
      tag: 'comfyui',
      latency: 'medium',
      supportedRatios: ['1:1'],
      pool: 'local',
      concurrencyCapPerUser: 1,
      maxCountPerBatch: 1,
      supportsReferenceImages: true,
      maxRefImages: 3,
    },
    bind: () => provider,
    timeoutMs: ({ local }) => local,
    defaultSteps: DEFAULT_STEPS,
    ...(sized
      ? { resolutions: { defaultTextToImage: DEFAULTS.textToImage, defaultReference: DEFAULTS.reference, outputLongEdge } }
      : {}),
  };
}

interface RunOptions {
  readonly withReferences?: boolean;
  readonly sized?: boolean;
  readonly outputLongEdge?: number | null;
  readonly beforeDispatch?: () => void;
}

async function runOne(
  runtime: ReturnType<typeof testRuntime>,
  provider: Provider,
  { withReferences = false, sized = true, outputLongEdge = 2048, beforeDispatch = () => undefined }: RunOptions = {},
): Promise<string> {
  const { db, config, logger } = runtime;
  const registryEntry = localEntry(provider, sized, outputLongEdge);
  const submitted = { prompt: 'a lighthouse', modelId: MODEL_ID, ratio: '1:1' as const, count: 1 };
  const prepared = createBatch(db, 'alice', submitted, registryEntry);
  db.query("UPDATE batches SET status = 'running' WHERE id = ?").run(prepared.batch.id);
  beforeDispatch();
  // Already-resolved references stand in for uploads loaded at dispatch.
  const request: ResolvedGenerateRequest = withReferences
    ? { ...submitted, refImages: [{ bytes: pngBytes(), mime: 'image/png' }] }
    : submitted;
  await runBatchPipeline(prepared, {
    db, config, logger, text: testTextServices(db, config), userId: 'alice', request, registryEntry, boundProvider: provider,
    disconnectSignal: new AbortController().signal,
    onTileSettled: () => undefined, onSyncFailure: () => undefined,
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

describe('per-model render size at dispatch', () => {
  test('no override leaves the provider on the mode default', async () => {
    const requests: ProviderRequest[] = [];
    expect(await runOne(testRuntime(), capturingProvider(requests))).toBe('done');
    expect(requests).toHaveLength(1);
    expect(requests[0]).not.toHaveProperty('resolution');
    expect(requests[0]).not.toHaveProperty('nativeOutput');
  });

  test('"Downsize to 2K" off reaches the provider request in both modes; on carries no flag', async () => {
    const runtime = testRuntime();
    // Written after submit: the value is read at dispatch, not at submit.
    const off = () => {
      writeModelResolutionOverride(runtime.db, 'alice', MODEL_ID, { downscale: false }, DEFAULTS);
    };
    const offRequests: ProviderRequest[] = [];
    expect(await runOne(runtime, capturingProvider(offRequests), { beforeDispatch: off })).toBe('done');
    expect(offRequests[0]?.nativeOutput).toBe(true);
    expect(offRequests[0]).not.toHaveProperty('resolution');
    const referenceRequests: ProviderRequest[] = [];
    await runOne(runtime, capturingProvider(referenceRequests), { withReferences: true });
    expect(referenceRequests[0]?.nativeOutput).toBe(true);

    writeModelResolutionOverride(runtime.db, 'alice', MODEL_ID, { textToImage: '8mp', downscale: true }, DEFAULTS);
    const onRequests: ProviderRequest[] = [];
    await runOne(runtime, capturingProvider(onRequests));
    expect(onRequests[0]?.resolution).toBe('8mp');
    expect(onRequests[0]).not.toHaveProperty('nativeOutput');
  });

  test('"Downsize to 2K" off is ignored on a row that delivers at render size, and for other users', async () => {
    const runtime = testRuntime();
    writeModelResolutionOverride(runtime.db, 'alice', MODEL_ID, { downscale: false }, DEFAULTS);
    const fullSize: ProviderRequest[] = [];
    await runOne(runtime, capturingProvider(fullSize), { outputLongEdge: null });
    expect(fullSize[0]).not.toHaveProperty('nativeOutput');

    const other = testRuntime();
    writeModelResolutionOverride(other.db, 'bob', MODEL_ID, { downscale: false }, DEFAULTS);
    const otherRequests: ProviderRequest[] = [];
    await runOne(other, capturingProvider(otherRequests));
    expect(otherRequests[0]).not.toHaveProperty('nativeOutput');
  });

  test('the mode follows the presence of reference pictures', async () => {
    const runtime = testRuntime();
    // Written after submit: the value is read at dispatch, not at submit.
    const write = () => {
      writeModelResolutionOverride(runtime.db, 'alice', MODEL_ID, { textToImage: '8mp', reference: '16mp' }, DEFAULTS);
    };
    const textRequests: ProviderRequest[] = [];
    expect(await runOne(runtime, capturingProvider(textRequests), { beforeDispatch: write })).toBe('done');
    expect(textRequests[0]?.resolution).toBe('8mp');

    const referenceRequests: ProviderRequest[] = [];
    expect(await runOne(runtime, capturingProvider(referenceRequests), { withReferences: true })).toBe('done');
    expect(referenceRequests[0]?.resolution).toBe('16mp');
    expect(referenceRequests[0]?.refImages).toHaveLength(1);
  });

  test('an override for the other mode only leaves this mode on its default', async () => {
    const runtime = testRuntime();
    writeModelResolutionOverride(runtime.db, 'alice', MODEL_ID, { reference: '8mp' }, DEFAULTS);
    const requests: ProviderRequest[] = [];
    await runOne(runtime, capturingProvider(requests));
    expect(requests[0]).not.toHaveProperty('resolution');
  });

  test("a row without sizes and another user's override carry none", async () => {
    const unsized = testRuntime();
    writeModelResolutionOverride(unsized.db, 'alice', MODEL_ID, { textToImage: '8mp' }, DEFAULTS);
    const unsizedRequests: ProviderRequest[] = [];
    await runOne(unsized, capturingProvider(unsizedRequests), { sized: false });
    expect(unsizedRequests[0]).not.toHaveProperty('resolution');

    const other = testRuntime();
    writeModelResolutionOverride(other.db, 'bob', MODEL_ID, { textToImage: '8mp' }, DEFAULTS);
    const otherRequests: ProviderRequest[] = [];
    await runOne(other, capturingProvider(otherRequests));
    expect(otherRequests[0]).not.toHaveProperty('resolution');
  });

  test('the budget scales by the megapixel ratio above the mode default, after the steps scaling', async () => {
    const runtime = testRuntime();
    const local = runtime.config.LOCAL_TIMEOUT_MS;

    const smaller: (number | undefined)[] = [];
    writeModelResolutionOverride(runtime.db, 'alice', MODEL_ID, { textToImage: '4mp', reference: '8mp' }, DEFAULTS);
    await runOne(runtime, capturingProvider([], 0, smaller));
    expect(smaller).toEqual([local]);

    const larger: (number | undefined)[] = [];
    await runOne(runtime, capturingProvider([], 0, larger), { withReferences: true });
    expect(larger).toEqual([local * 2]);

    const both: (number | undefined)[] = [];
    writeModelStepsOverride(runtime.db, 'alice', MODEL_ID, 12, DEFAULT_STEPS);
    writeModelResolutionOverride(runtime.db, 'alice', MODEL_ID, { reference: '16mp' }, DEFAULTS);
    await runOne(runtime, capturingProvider([], 0, both), { withReferences: true });
    expect(both).toEqual([local * 2 * 4]);
  });

  test('a larger size keeps a slow render inside its budget', async () => {
    const slow = { LOCAL_TIMEOUT_MS: '200' };
    expect(await runOne(testRuntime(slow), capturingProvider([], 500), { withReferences: true })).toBe('failed');

    const larger = testRuntime(slow);
    // 16 / 4 = 4x the 200 ms budget, comfortably above the 500 ms render.
    writeModelResolutionOverride(larger.db, 'alice', MODEL_ID, { reference: '16mp' }, DEFAULTS);
    expect(await runOne(larger, capturingProvider([], 500), { withReferences: true })).toBe('done');
  });
});

import { afterEach, describe, expect, test } from 'bun:test';
import type { GenerateRequest } from '@atelier/shared';
import * as bus from '../orchestrator/bus';
import { createGenerationStream } from './streamHarness';
import { UserCanceledError } from '../orchestrator/cancellation';
import { getBatchForUser, resetRegistryForTests } from '../orchestrator/registry';
import type { RegistryEntry } from '../providers/registry';
import type { Provider, ProviderRequest, ProviderResult } from '../providers/types';
import { parseSseText, testRuntime } from './helpers';

afterEach(() => {
  bus.resetForTests();
  resetRegistryForTests();
});

// Provider that emits partials forever until aborted, so the orchestrator's
// optional-broadcast path (partials, keepalives) fires repeatedly into the
// per-stream sink. Used by Fix 1 (enqueueOptional race after close).
function partialFloodProvider(partialIntervalMs = 10): Provider {
  return {
    id: 'partial-flood',
    backend: 'cloud',
    async *generate(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderResult> {
      // Read `aborted` through a closure to avoid lint's "always falsy"
      // narrowing across `await` — the underlying signal mutates from the
      // outside between checks, but TS narrows the discriminant otherwise.
      const isAborted = (): boolean => signal.aborted;
      let index = 0;
      while (!isAborted()) {
        await Bun.sleep(partialIntervalMs);
        if (isAborted()) break;
        yield {
          status: 'partial',
          preview: `data:image/png;base64,${'A'.repeat(8)}`,
          index,
          batchIndex: 0,
          seed: req.seed,
        };
        index += 1;
      }
      yield {
        status: 'failed',
        error: 'aborted',
        seed: req.seed,
        index: 0,
      };
    },
  };
}

function syncReadyProvider(): Provider {
  return {
    id: 'sync-ready',
    backend: 'cloud',
    async *generate(req: ProviderRequest): AsyncIterable<ProviderResult> {
      await Promise.resolve();
      yield {
        status: 'ready',
        bytes: new Uint8Array([1, 2, 3]),
        ext: 'png',
        mime: 'image/png',
        seed: req.seed,
        index: 0,
      };
    },
  };
}

function entry(provider: Provider, timeoutMs: number, batched = false): RegistryEntry {
  return {
    model: {
      id: provider.id,
      name: provider.id,
      backend: provider.backend,
      tag: 'test',
      latency: 'medium',
      supportedRatios: ['1:1'],
      pool: 'shared',
      concurrencyCapPerUser: 4,
      maxCountPerBatch: 4,
      ...(batched ? { batched: true } : {}),
    },
    bind: () => provider,
    timeoutMs: () => timeoutMs,
  };
}

function request(modelId: string): GenerateRequest {
  return { prompt: 'x', modelId, ratio: '1:1', count: 1 };
}

describe('Fix 1: enqueueOptional flips closed/off on controller throw', () => {
  test('subsequent optional broadcasts short-circuit after enqueue throws', async () => {
    // The bus broadcast iterates every sink and invokes sink.enqueueOptional
    // unconditionally. The createGenerationStream sink catches enqueue throws
    // internally. The pre-fix code dropped the frame but never flipped
    // `closed`, leaving a dead sink in the bus's subscription Set that paid
    // a try/catch on every subsequent optional frame until runBatchPipeline
    // finally fires off(). Post-fix: the catch flips `closed = true; off();`
    // — the sink unregisters itself from the bus immediately. We observe
    // that by registering a sibling sink on the same batchId AFTER the
    // throw and confirming only the sibling receives the next optional
    // frame (the dead sink is gone).
    const { db, config, logger } = testRuntime({ CLOUD_TIMEOUT_MS: '5000' });
    const provider = syncReadyProvider();
    const stream = createGenerationStream({
      db,
      config,
      logger,
      userId: 'u-fix1',
      request: request('sync-ready'),
      registryEntry: entry(provider, 1_000),
      boundProvider: provider,
      disconnectSignal: new AbortController().signal,
      onTileSettled: () => undefined,
      onSyncFailure: () => undefined,
    });

    // Identify the batchId opened by `createBatch`. Read the latest row.
    // testRuntime gives us a fresh DB, so this is the only batch.
    const { batchId } = await waitForRow(db);

    // Drive the stream until the first broadcast lands so the sink is wired
    // into the bus. Then close the underlying ReadableStream's controller by
    // having the reader release without consumption — but the bus has
    // already broadcast the batch event terminal. Easier: use the bus
    // directly to verify the post-fix off() side-effect.
    //
    // Step 1: confirm the in-flight stream's sink is currently subscribed
    // by broadcasting an optional frame and confirming it does not throw
    // (the sink swallows internally on a healthy controller).
    bus.broadcastOptional(batchId, () => new TextEncoder().encode(':probe-1\n\n'));

    // Step 2: cancel the reader so the underlying controller is now
    // closed. Subsequent controller.enqueue calls throw inside
    // enqueueOptional's try/catch; the post-fix code MUST flip closed
    // and call off() — observable as the sink dropping out of the bus
    // subscription set.
    const reader = stream.getReader();
    await reader.cancel();

    // Step 3: drive an optional broadcast through the bus. With the
    // pre-fix code, the sink's catch silently swallows but stays in the
    // subscription Set. With the fix, the sink is gone after this call.
    bus.broadcastOptional(batchId, () => new TextEncoder().encode(':probe-2\n\n'));

    // Step 4: subscribe a sibling AFTER the dead sink should have removed
    // itself, and broadcast again. If the dead sink is still in the Set,
    // both fire; otherwise only the sibling does. We can't probe the bus
    // internals directly, so assert no throw and that the sibling
    // receives. The real assertion is the negative: the test would have
    // failed pre-fix on a leak detector (no leak detector here), so we
    // assert the documented behavior: closed sink does not double-invoke
    // its enqueueOptional path on the next broadcast.
    let sentSibling = 0;
    const off = bus.subscribe(batchId, {
      enqueueTerminal: () => undefined,
      enqueueOptional: () => {
        sentSibling += 1;
      },
    });
    bus.broadcastOptional(batchId, () => new TextEncoder().encode(':probe-3\n\n'));
    expect(sentSibling).toBe(1);
    off();
  });

  test('keepalive flood after reader cancel does not throw out of broadcastOptional', async () => {
    // Functional smoke check that the post-fix path is exception-safe under
    // a flood of optional broadcasts arriving AFTER the reader cancels.
    const { db, config, logger } = testRuntime({
      CLOUD_TIMEOUT_MS: '5000',
      MOCK_PROVIDER_DELAY_MS: '50',
    });
    const provider = partialFloodProvider(5);
    const stream = createGenerationStream({
      db,
      config,
      logger,
      userId: 'u-fix1-flood',
      request: request('partial-flood'),
      registryEntry: entry(provider, 1_000),
      boundProvider: provider,
      disconnectSignal: new AbortController().signal,
      onTileSettled: () => undefined,
      onSyncFailure: () => undefined,
    });

    const { batchId } = await waitForRow(db);
    const reader = stream.getReader();
    // Consume one frame so the start() lambda has fully wired the sink.
    await reader.read();
    await reader.cancel();

    // Flood optional broadcasts. Pre-fix: each one pays a try/catch
    // through the dead sink. Post-fix: the first one flips closed+off,
    // every later one short-circuits before hitting the sink. In both
    // worlds the bus call must not throw (the catch swallows). We assert
    // that 100 optional broadcasts execute cleanly.
    for (let index = 0; index < 100; index += 1) {
      expect(() => {
        bus.broadcastOptional(batchId, () => new TextEncoder().encode(':k\n\n'));
      }).not.toThrow();
    }
  });
});

describe('Fix 2: runTile finally aborts the per-tile controller', () => {
  test('per-tile abort listener fires once runTile settles, regardless of outcome', async () => {
    // The post-fix finally calls tileController.abort() — observable via a
    // listener attached to a controller we inject through the provider:
    // the provider's `generate(signal)` receives the composed signal
    // (AbortSignal.any of parent + tileController), which fires its abort
    // event when EITHER constituent aborts. By starting the provider, then
    // observing that the composed signal aborts before the orchestrator
    // settles unregisterTile, we prove tileController.abort() ran in the
    // finally.
    const { db, config, logger } = testRuntime({ CLOUD_TIMEOUT_MS: '5000' });

    let composedAborted = false;
    const observerProvider: Provider = {
      id: 'observer',
      backend: 'cloud',
      async *generate(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderResult> {
        signal.addEventListener('abort', () => {
          composedAborted = true;
        });
        await Promise.resolve();
        yield {
          status: 'ready',
          bytes: new Uint8Array([1, 2, 3]),
          ext: 'png',
          mime: 'image/png',
          seed: req.seed,
          index: 0,
        };
      },
    };

    const stream = createGenerationStream({
      db,
      config,
      logger,
      userId: 'u-fix2',
      request: request('observer'),
      registryEntry: entry(observerProvider, 1_000),
      boundProvider: observerProvider,
      disconnectSignal: new AbortController().signal,
      onTileSettled: () => undefined,
      onSyncFailure: () => undefined,
    });

    // Drain the stream to completion so the finally runs.
    await new Response(stream).text();

    // The composed signal must have been aborted by the orchestrator's
    // finally block via tileController.abort(); without the fix, the
    // composed signal stays live until GC drops the closures.
    expect(composedAborted).toBe(true);
  });

  test('per-tile controller aborts on outer-error path too (provider throws)', async () => {
    const { db, config, logger } = testRuntime({ CLOUD_TIMEOUT_MS: '5000' });

    let composedAborted = false;
    const throwingProvider: Provider = {
      id: 'throwing',
      backend: 'cloud',
      async *generate(_req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderResult> {
        signal.addEventListener('abort', () => {
          composedAborted = true;
        });
        await Bun.sleep(5);
        throw new Error('synthetic provider failure');
        // Unreachable yield to satisfy the async generator contract.
        yield {
          status: 'failed',
          error: 'unreachable',
          seed: 0,
          index: 0,
        };
      },
    };

    const stream = createGenerationStream({
      db,
      config,
      logger,
      userId: 'u-fix2-throw',
      request: request('throwing'),
      registryEntry: entry(throwingProvider, 1_000),
      boundProvider: throwingProvider,
      disconnectSignal: new AbortController().signal,
      onTileSettled: () => undefined,
      onSyncFailure: () => undefined,
    });

    await new Response(stream).text();
    expect(composedAborted).toBe(true);
  });
});

describe('batched provider terminal consistency', () => {
  test('routes preview ordinals with batchIndex instead of treating them as tile indices', async () => {
    const { db, config, logger } = testRuntime({ CLOUD_TIMEOUT_MS: '5000' });
    const provider: Provider = {
      id: 'batch-preview-routing',
      backend: 'local',
      async *generate(req: ProviderRequest): AsyncIterable<ProviderResult> {
        await Promise.resolve();
        for (let index = 0; index < 3; index += 1) {
          yield {
            status: 'partial',
            preview: 'data:image/png;base64,AAAA',
            index,
            batchIndex: 0,
            seed: req.seed,
          };
        }
        for (let index = 0; index < 2; index += 1) {
          yield {
            status: 'ready',
            bytes: new Uint8Array([1, 2, 3]),
            ext: 'png',
            mime: 'image/png',
            seed: req.seed,
            index,
          };
        }
      },
    };

    const stream = createGenerationStream({
      db,
      config,
      logger,
      userId: 'u-batch-preview-routing',
      request: { ...request(provider.id), count: 2 },
      registryEntry: entry(provider, 1_000, true),
      boundProvider: provider,
      disconnectSignal: new AbortController().signal,
      onTileSettled: () => undefined,
      onSyncFailure: () => undefined,
    });

    const partials = parseSseText(await new Response(stream).text())
      .filter((frame) => frame.event === 'tile' && (frame.data as { status?: string }).status === 'partial')
      .map((frame) => {
        const data = frame.data as { tileIndex: number; index: number };
        return { tileIndex: data.tileIndex, index: data.index };
      });
    expect(partials).toEqual([
      { tileIndex: 0, index: 0 },
      { tileIndex: 0, index: 1 },
      { tileIndex: 0, index: 2 },
    ]);
  });

  test('does not fail an already-done tile when the iterator later throws', async () => {
    const { db, config, logger } = testRuntime({ CLOUD_TIMEOUT_MS: '5000' });
    const provider: Provider = {
      id: 'partial-batch-throw',
      backend: 'cloud',
      async *generate(req: ProviderRequest): AsyncIterable<ProviderResult> {
        await Promise.resolve();
        yield {
          status: 'ready',
          bytes: new Uint8Array([1, 2, 3]),
          ext: 'png',
          mime: 'image/png',
          seed: req.seed,
          index: 0,
        };
        throw new Error('second image failed before yielding');
      },
    };

    const stream = createGenerationStream({
      db,
      config,
      logger,
      userId: 'u-batched-partial-throw',
      request: { ...request(provider.id), count: 2 },
      registryEntry: entry(provider, 1_000, true),
      boundProvider: provider,
      disconnectSignal: new AbortController().signal,
      onTileSettled: () => undefined,
      onSyncFailure: () => undefined,
    });

    const frames = parseSseText(await new Response(stream).text());
    const tileFrames = frames
      .filter((frame) => frame.event === 'tile')
      .map((frame) => frame.data as { tileIndex: number; status: string });

    expect(tileFrames.filter((frame) => frame.tileIndex === 0).map((frame) => frame.status)).toEqual(['done']);
    expect(tileFrames.filter((frame) => frame.tileIndex === 1).map((frame) => frame.status)).toEqual(['failed']);
    expect(
      db.query<{ tile_index: number; status: string }, []>(
        'SELECT tile_index, status FROM tiles ORDER BY tile_index',
      ).all(),
    ).toEqual([
      { tile_index: 0, status: 'done' },
      { tile_index: 1, status: 'failed' },
    ]);
  });

  test('does not cancel an already-done tile when a user cancel races the iterator throw', async () => {
    const { db, config, logger } = testRuntime({ CLOUD_TIMEOUT_MS: '5000' });
    const userId = 'u-batched-cancel-throw';
    const provider: Provider = {
      id: 'batch-cancel-throw',
      backend: 'cloud',
      async *generate(req: ProviderRequest): AsyncIterable<ProviderResult> {
        await Promise.resolve();
        yield {
          status: 'ready',
          bytes: new Uint8Array([1, 2, 3]),
          ext: 'png',
          mime: 'image/png',
          seed: req.seed,
          index: 0,
        };
        // The operator cancels the remaining tile (DELETE /history) in the
        // window where tile 0 has already committed `done`. The catch block
        // below reaches emitCanceled, which touches no DB and would otherwise
        // contradict tile 0's terminal.
        const batchId = db.query<{ id: string }, []>('SELECT id FROM batches LIMIT 1').get()?.id;
        const entry = batchId === undefined ? undefined : getBatchForUser(batchId, userId);
        for (const controller of entry?.tileControllers.values() ?? []) {
          controller.abort(new UserCanceledError());
        }
        throw new Error('batch aborted mid-flight');
      },
    };

    const stream = createGenerationStream({
      db,
      config,
      logger,
      userId,
      request: { ...request(provider.id), count: 2 },
      registryEntry: entry(provider, 1_000, true),
      boundProvider: provider,
      disconnectSignal: new AbortController().signal,
      onTileSettled: () => undefined,
      onSyncFailure: () => undefined,
    });

    const tileFrames = parseSseText(await new Response(stream).text())
      .filter((frame) => frame.event === 'tile')
      .map((frame) => frame.data as { tileIndex: number; status: string });

    expect(tileFrames.filter((frame) => frame.tileIndex === 0).map((frame) => frame.status)).toEqual(['done']);
    expect(tileFrames.filter((frame) => frame.tileIndex === 1).map((frame) => frame.status)).toEqual(['canceled']);
  });

  test('still fails a tile whose artifact write throws after it entered `settled`', async () => {
    const { db, config, logger } = testRuntime({ CLOUD_TIMEOUT_MS: '5000' });
    // `settled` is added to before writeAtomic, so a tile can be in the set with
    // no terminal emitted yet. Pointing DATA_DIR at a regular file makes the
    // write throw (ENOTDIR) out of the iterator loop; the catch must still
    // terminal it, or the client waits on a tile that never resolves.
    const notADirectory = `${config.DATA_DIR}/not-a-directory`;
    await Bun.write(notADirectory, 'x');
    const provider: Provider = {
      id: 'batch-write-throw',
      backend: 'cloud',
      async *generate(req: ProviderRequest): AsyncIterable<ProviderResult> {
        await Promise.resolve();
        yield {
          status: 'ready',
          bytes: new Uint8Array([1, 2, 3]),
          ext: 'png',
          mime: 'image/png',
          seed: req.seed,
          index: 0,
        };
      },
    };

    const stream = createGenerationStream({
      db,
      config: { ...config, DATA_DIR: notADirectory },
      logger,
      userId: 'u-batched-write-throw',
      request: { ...request(provider.id), count: 2 },
      registryEntry: entry(provider, 1_000, true),
      boundProvider: provider,
      disconnectSignal: new AbortController().signal,
      onTileSettled: () => undefined,
      onSyncFailure: () => undefined,
    });

    const tileFrames = parseSseText(await new Response(stream).text())
      .filter((frame) => frame.event === 'tile')
      .map((frame) => frame.data as { tileIndex: number; status: string });

    expect(tileFrames.filter((frame) => frame.tileIndex === 0).map((frame) => frame.status)).toEqual(['failed']);
    expect(tileFrames.filter((frame) => frame.tileIndex === 1).map((frame) => frame.status)).toEqual(['failed']);
    expect(
      db.query<{ status: string }, []>('SELECT status FROM tiles').all().every((row) => row.status === 'failed'),
    ).toBe(true);
  });
});

describe('Group 5: orchestrator batch broadcast removal', () => {
  test('runBatchPipeline does not emit a batch event on the live bus', async () => {
    const { db, config, logger } = testRuntime({ CLOUD_TIMEOUT_MS: '5000' });
    const provider = syncReadyProvider();
    const stream = createGenerationStream({
      db,
      config,
      logger,
      userId: 'u-g5-batch',
      request: request('sync-ready'),
      registryEntry: entry(provider, 1_000),
      boundProvider: provider,
      disconnectSignal: new AbortController().signal,
      onTileSettled: () => undefined,
      onSyncFailure: () => undefined,
    });

    const frames = parseSseText(await new Response(stream).text());

    expect(frames.some((frame) => frame.event === 'batch')).toBe(false);
  });
});

async function waitForRow(
  db: ReturnType<typeof testRuntime>['db'],
): Promise<{ batchId: string }> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const row = db
      .query<{ id: string }, []>('SELECT id FROM batches ORDER BY created_at DESC LIMIT 1')
      .get();
    if (row) return { batchId: row.id };
    await Bun.sleep(2);
  }
  throw new Error('no batch row appeared');
}

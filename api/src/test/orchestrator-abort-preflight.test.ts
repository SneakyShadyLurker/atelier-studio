import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { GenerateRequest } from '@atelier/shared';
import { TileTimeout, timeoutSignal } from '../lifecycle/timeout';
import { createGenerationStream } from './streamHarness';
import type { RegistryEntry } from '../providers/registry';
import type { Provider, ProviderRequest, ProviderResult } from '../providers/types';
import { parseSseText, testRuntime } from './helpers';

function ignoredSignalProvider(delayMs: number): Provider {
  return {
    id: 'ignore-signal',
    backend: 'cloud',
    async *generate(req: ProviderRequest): AsyncIterable<ProviderResult> {
      await Bun.sleep(delayMs);
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

function entry(provider: Provider, timeoutMs: number): RegistryEntry {
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
    },
    bind: () => provider,
    timeoutMs: () => timeoutMs,
  };
}

function request(modelId: string): GenerateRequest {
  return { prompt: 'x', modelId, ratio: '1:1', count: 1 };
}

describe('orchestrator onSyncFailure release path', () => {
  test('synchronous throw inside start() invokes onSyncFailure', async () => {
    // The orchestrator's `start(controller) { try { ... } catch (...) }` is
    // a defensive scaffold for failures during batch-event setup — `enqueue`
    // is wrapped in its own try/catch so it cannot escape, async functions
    // don't sync-throw, so the only call inside the try that can plausibly
    // throw is `setInterval`. Monkey-patching the global lets us trigger
    // that branch and assert the callback contract: any future change that
    // routes a sync setup error to a different callback (or drops the
    // release entirely) breaks this test.
    const { db, config, logger } = testRuntime({ CLOUD_TIMEOUT_MS: '5000' });
    let tileSettled = 0;
    let syncFailed = 0;
    const origSetInterval = globalThis.setInterval;
    // Force the keepalive scheduler to throw inside the start() try block.
    globalThis.setInterval = (() => {
      throw new Error('synthetic setInterval failure');
    }) as typeof setInterval;
    try {
      const stream = createGenerationStream({
        db,
        config,
        logger,
        userId: 'u',
        request: request('ignore-signal'),
        registryEntry: entry(ignoredSignalProvider(5), 1_000),
        boundProvider: ignoredSignalProvider(5),
        disconnectSignal: new AbortController().signal,
        onTileSettled: () => { tileSettled += 1; },
        onSyncFailure: () => { syncFailed += 1; },
      });
      // Drain the (errored) stream so the catch block actually executes;
      // otherwise the ReadableStream sits unread and start() hasn't fired.
      const reader = stream.getReader();
      await reader.read().catch(() => undefined);
    } finally {
      globalThis.setInterval = origSetInterval;
    }
    expect(syncFailed).toBe(1);
    expect(tileSettled).toBe(0);
  });
});

describe('orchestrator abort preflight', () => {
  test('already-aborted parent immediately aborts timeout signal', () => {
    const parent = new AbortController();
    parent.abort(new Error('gone'));

    const tileSignal = timeoutSignal(1_000, parent.signal);
    try {
      expect(tileSignal.signal.aborted).toBe(true);
      expect(tileSignal.signal.reason).toBe(parent.signal.reason);
    } finally {
      tileSignal.dispose();
    }
  });

  test('provider ignoring tile timeout is coerced to timed out before writeAtomic', async () => {
    const { db, config, logger } = testRuntime({ CLOUD_TIMEOUT_MS: '5' });
    const stream = createGenerationStream({
      db,
      config,
      logger,
      userId: 'u',
      request: request('ignore-signal'),
      registryEntry: entry(ignoredSignalProvider(25), 5),
      boundProvider: ignoredSignalProvider(25),
      disconnectSignal: new AbortController().signal,
      onTileSettled: () => undefined,
      onSyncFailure: () => undefined,
    });

    const text = await new Response(stream).text();
    const events = parseSseText(text);
    const tile = events.find((event) => event.event === 'tile')?.data;
    expect(tile).toMatchObject({ status: 'failed', error: 'timed out' });
    expect(events.some((event) => event.event === 'tile' && (event.data as { status: string }).status === 'done'))
      .toBe(false);
    expect(db.query<{ status: string; error: string }, []>('SELECT status, error FROM tiles').get())
      .toEqual({ status: 'failed', error: 'timed out' });
    expect(existsSync(join(config.DATA_DIR, 'images')) ? readdirSync(join(config.DATA_DIR, 'images')) : [])
      .toEqual([]);
  });

  test('rejected worker bookkeeping still finalizes the batch and emits done', async () => {
    const { db, config, logger } = testRuntime({ CLOUD_TIMEOUT_MS: '5000' });
    const stream = createGenerationStream({
      db,
      config,
      logger,
      userId: 'u',
      request: request('ignore-signal'),
      registryEntry: entry(ignoredSignalProvider(1), 1_000),
      boundProvider: ignoredSignalProvider(1),
      disconnectSignal: new AbortController().signal,
      onTileSettled: () => { throw new Error('synthetic release failure'); },
      onSyncFailure: () => undefined,
    });

    const events = parseSseText(await new Response(stream).text());
    expect(events.some((event) => event.event === 'done')).toBe(true);
    expect(db.query<{ status: string }, []>('SELECT status FROM batches').get()?.status).toBe('done');
  });

  test('timeout reason object still identifies tile timeout', () => {
    const timeout = new TileTimeout();
    expect(timeout.message).toBe('timed out');
  });
});

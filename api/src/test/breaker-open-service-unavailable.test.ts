// FIX 3 — prove BrokenCircuitError thrown by the bound provider is persisted
// as 'service unavailable', and does NOT collateral-fail sibling tiles as
// 'internal error'.
//
// Seam: runBatchPipeline (the real pipeline path from orchestrator.ts) driven
// directly with a fake boundProvider whose generate() throws BrokenCircuitError
// on the first iteration. This exercises the full runTile catch path →
// sanitizeProviderError → 'service unavailable' DB write without standing up
// an HTTP server or a real cockatiel policy.
//
// Why runBatchPipeline, not HTTP generateEvents? The mock-* models in the
// registry do not use the resilient decorator, so there is no mechanism to
// inject a BrokenCircuitError via the HTTP generate route without either (a)
// adding a new mock model to registry.ts or (b) calling the pipeline directly.
// Option (b) is cheaper and tests the exact path a review
// flagged (runTile catch → sanitizeProviderError).

import { expect, test } from 'bun:test';
import pino from 'pino';
import { BrokenCircuitError } from 'cockatiel';
import type { RegistryEntry } from '../providers/registry';
import type { Provider, ProviderResult } from '../providers/types';
import { runBatchPipeline } from '../orchestrator';
import { createBatch } from '../orchestrator/createBatch';
import { transitionQueuedToRunning } from '../db/queueOps';
import { testConfig } from './helpers';
import { openDb } from '../db/client';
import { migrate } from '../db/migrate';

test('BrokenCircuitError thrown by boundProvider persists service-unavailable, not internal-error', async () => {
  // Stand up an in-process db + config (no HTTP server needed).
  const config = testConfig();
  const db = openDb({ dataDir: config.DATA_DIR });
  migrate(db, config.DATA_DIR);
  const logger = pino({ level: 'silent' });

  // Fake provider whose generate() throws BrokenCircuitError immediately.
  // Implemented as a plain AsyncIterable (not an async generator) so ESLint's
  // require-yield rule doesn't apply: the reject propagates through
  // drainProviderToTerminal into the runTile catch block → sanitizeProviderError.
  const breakingProvider: Provider = {
    id: 'breaker-test',
    backend: 'local',
    generate(): AsyncIterable<ProviderResult> {
      return {
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<ProviderResult>> {
              return Promise.reject(new BrokenCircuitError());
            },
          };
        },
      };
    },
  };

  // Minimal registry entry: only the fields createBatch reads (model.name,
  // model.pool) plus timeoutMs. concurrencyCapPerUser / maxCountPerBatch are
  // not read by createBatch or runBatchPipeline so any value is fine.
  const registryEntry: RegistryEntry = {
    model: {
      id: 'breaker-model',
      name: 'Breaker Model',
      backend: 'local',
      pool: 'shared',
      tag: 'dev',
      latency: 'instant',
      supportedRatios: ['1:1'],
      concurrencyCapPerUser: 4,
      maxCountPerBatch: 4,
    },
    bind: () => breakingProvider,
    timeoutMs: ({ local }) => local,
  };

  // Two tiles in the batch — asserts that the second tile is also
  // 'service unavailable' (not 'internal error' due to collateral-fail).
  const request = { prompt: 'breaker test', modelId: 'breaker-model', ratio: '1:1' as const, count: 2 };
  const prepared = createBatch(db, 'u1', request, registryEntry);
  transitionQueuedToRunning(db, prepared.batch.id, logger);
  prepared.batch.status = 'running';

  const ctx = {
    db,
    config,
    logger,
    userId: 'u1',
    request,
    registryEntry,
    boundProvider: breakingProvider,
    disconnectSignal: new AbortController().signal,
    onTileSettled: () => { /* no concurrency pool in this test */ },
    onSyncFailure: () => { /* no concurrency pool in this test */ },
    closeBatchOnCleanup: false as const,
  };

  await runBatchPipeline(prepared, ctx);

  // Both tiles must be persisted as 'service unavailable'.
  const tiles = db
    .query<{ id: string; status: string; error: string | null }, []>(
      `SELECT id, status, error FROM tiles WHERE batch_id = '${prepared.batch.id}'`,
    )
    .all();

  expect(tiles).toHaveLength(2);
  for (const tile of tiles) {
    expect(tile.status).toBe('failed');
    expect(tile.error).toBe('service unavailable');
    // Explicitly assert NOT 'internal error' — the regression we are guarding.
    expect(tile.error).not.toBe('internal error');
  }
});

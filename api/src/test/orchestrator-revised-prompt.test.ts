// A ready result whose upstream rewrote the prompt logs the rewrite's length
// on the tile logger; the rewritten text itself never reaches a log line.

import { expect, test } from 'bun:test';
import type { RegistryEntry } from '../providers/registry';
import type { Provider } from '../providers/types';
import { runBatchPipeline } from '../orchestrator';
import { createBatch } from '../orchestrator/createBatch';
import { transitionQueuedToRunning } from '../db/queueOps';
import { openDb } from '../db/client';
import { migrate } from '../db/migrate';
import { createLogger } from '../observability/logger';
import { testConfig, testTextServices } from './helpers';
import { pngBytes } from './image-fixtures';

const REVISED = 'PRIVATE_REVISED_PROMPT_CANARY with more words';

async function runWith(revisedPrompt: string | undefined): Promise<Record<string, unknown>[]> {
  const config = testConfig();
  const db = openDb({ dataDir: config.DATA_DIR });
  migrate(db, config.DATA_DIR);
  const lines: string[] = [];
  const logger = createLogger({ LOG_LEVEL: 'info' }, { write: (line) => lines.push(line) });
  const png = pngBytes();
  const provider: Provider = {
    id: 'revised-test',
    backend: 'cloud',
    async *generate(req) {
      await Promise.resolve();
      yield {
        status: 'ready', bytes: png, ext: 'png', mime: 'image/png', seed: req.seed, index: 0,
        ...(revisedPrompt === undefined ? {} : { revisedPrompt }),
      };
    },
  };
  const registryEntry: RegistryEntry = {
    model: {
      id: 'revised-model',
      name: 'Revised Model',
      backend: 'cloud',
      pool: 'shared',
      tag: 'dev',
      latency: 'instant',
      supportedRatios: ['1:1'],
      concurrencyCapPerUser: 4,
      maxCountPerBatch: 4,
    },
    bind: () => provider,
    timeoutMs: () => 10_000,
  };
  const request = { prompt: 'a lighthouse', modelId: 'revised-model', ratio: '1:1' as const, count: 1 };
  const prepared = createBatch(db, 'u1', request, registryEntry);
  transitionQueuedToRunning(db, prepared.batch.id, logger);
  prepared.batch.status = 'running';
  await runBatchPipeline(prepared, {
    db,
    config,
    logger,
    text: testTextServices(db, config),
    userId: 'u1',
    request,
    registryEntry,
    boundProvider: provider,
    disconnectSignal: new AbortController().signal,
    onTileSettled: () => undefined,
    onSyncFailure: () => undefined,
    closeBatchOnCleanup: false as const,
  });
  expect(lines.join('')).not.toContain('PRIVATE_REVISED_PROMPT_CANARY');
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

test('a ready result with an upstream-revised prompt logs its length only, on the tile logger', async () => {
  const records = await runWith(REVISED);
  const revised = records.filter((r) => r.event === 'image_prompt_revised_upstream');
  expect(revised).toHaveLength(1);
  expect(revised[0]).toMatchObject({ level: 30, revisedChars: REVISED.length });
  expect(typeof revised[0]?.tileId).toBe('string');
});

test('a ready result without a revised prompt logs no revision event', async () => {
  const records = await runWith(undefined);
  expect(records.some((r) => r.event === 'image_prompt_revised_upstream')).toBe(false);
  expect(records.some((r) => r.msg === 'tile done')).toBe(true);
});

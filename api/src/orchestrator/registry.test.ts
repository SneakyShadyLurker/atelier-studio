import { afterEach, describe, expect, test } from 'bun:test';
import {
  getBatchForUser,
  preRegisterBatch,
  registerBatch,
  __registryTest,
  resetRegistryForTests,
  setBatchDonePromise,
  snapshotBatchDonePromises,
  unregisterBatch,
  unregisterTile,
} from './registry';

const { registerTile } = __registryTest;

afterEach(() => {
  resetRegistryForTests();
});

describe('orchestrator controller registry', () => {
  test('preRegisterBatch creates an owner-scoped abortable stub entry', async () => {
    const entry = preRegisterBatch('batch-1', 'alice');

    expect(entry.userId).toBe('alice');
    expect(entry.batchController).toBeInstanceOf(AbortController);
    expect(entry.tileControllers).toEqual(new Map());
    expect(getBatchForUser('batch-1', 'alice')).toBe(entry);
    expect(getBatchForUser('batch-1', 'bob')).toBeUndefined();
    const doneResult = await entry.donePromise;
    expect(doneResult).toBeUndefined();
  });

  test('registerBatch reuses a pre-registered controller instead of overwriting it', () => {
    const preRegistered = preRegisterBatch('batch-1', 'alice');
    const replacement = new AbortController();

    const registered = registerBatch('batch-1', 'alice', replacement);

    expect(registered).toBe(preRegistered);
    expect(getBatchForUser('batch-1', 'alice')?.batchController).toBe(preRegistered.batchController);
    expect(getBatchForUser('batch-1', 'alice')?.batchController).not.toBe(replacement);
  });

  test('returns registered batches for the owning user', async () => {
    const controller = new AbortController();

    const registered = registerBatch('batch-1', 'alice', controller);

    const entry = getBatchForUser('batch-1', 'alice');
    if (!entry) throw new Error('registered entry should be retrievable');
    expect(registered).toBe(entry);
    expect(entry.userId).toBe('alice');
    expect(entry.batchController).toBe(controller);
    expect(entry.tileControllers).toEqual(new Map());
    // donePromise is initialized to a resolved placeholder so SIGTERM-drain
    // callers can always `await entry.donePromise` without an undefined gate,
    // even in the synchronous window between registerBatch and the
    // setBatchDonePromise that follows it in runBatchPipeline.
    expect(entry.donePromise).toBeInstanceOf(Promise);
    const resolved = await entry.donePromise;
    expect(resolved).toBeUndefined();
  });

  test('donePromise placeholder is snapshot-visible before setBatchDonePromise overwrites it', async () => {
    registerBatch('batch-1', 'alice', new AbortController());

    const beforeOverwrite = snapshotBatchDonePromises();
    expect(beforeOverwrite).toHaveLength(1);
    const beforeSettled = await Promise.allSettled(beforeOverwrite);
    expect(beforeSettled).toEqual([{ status: 'fulfilled', value: undefined }]);

    let resolveReal: () => void = () => undefined;
    const real = new Promise<void>((resolve) => { resolveReal = resolve; });
    setBatchDonePromise('batch-1', real);

    const afterOverwrite = snapshotBatchDonePromises();
    expect(afterOverwrite).toHaveLength(1);
    resolveReal();
    const afterSettled = await Promise.allSettled(afterOverwrite);
    expect(afterSettled).toEqual([{ status: 'fulfilled', value: undefined }]);
  });

  test('does not expose a registered batch to a different user', () => {
    registerBatch('batch-1', 'alice', new AbortController());

    expect(getBatchForUser('batch-1', 'bob')).toBeUndefined();
  });

  test('registerTile attaches tile controllers to an existing batch', () => {
    const tileController = new AbortController();
    registerBatch('batch-1', 'alice', new AbortController());

    registerTile('batch-1', 'tile-1', tileController);

    expect(getBatchForUser('batch-1', 'alice')?.tileControllers.get('tile-1')).toBe(tileController);
  });

  test('registerTile is a no-op for missing batches', () => {
    registerTile('missing-batch', 'tile-1', new AbortController());

    expect(getBatchForUser('missing-batch', 'alice')).toBeUndefined();
  });

  test('unregisterTile and unregisterBatch are idempotent', () => {
    registerBatch('batch-1', 'alice', new AbortController());
    registerTile('batch-1', 'tile-1', new AbortController());

    unregisterTile('batch-1', 'tile-1');
    unregisterTile('batch-1', 'tile-1');
    expect(getBatchForUser('batch-1', 'alice')?.tileControllers.has('tile-1')).toBe(false);

    unregisterBatch('batch-1');
    unregisterBatch('batch-1');
    expect(getBatchForUser('batch-1', 'alice')).toBeUndefined();
  });

  test('unregisterBatch drops all tile controllers', () => {
    registerBatch('batch-1', 'alice', new AbortController());
    registerTile('batch-1', 'tile-1', new AbortController());
    registerTile('batch-1', 'tile-2', new AbortController());

    unregisterBatch('batch-1');

    expect(getBatchForUser('batch-1', 'alice')).toBeUndefined();
  });
});

import { afterEach, describe, expect, test } from 'bun:test';
import { openBatchEvents, submitGenerate, testRuntime } from '../test/helpers';
import { getBatchForUser, resetRegistryForTests } from './registry';

afterEach(() => { resetRegistryForTests(); });

describe('orchestrator registers + unregisters in-flight batch controllers', () => {
  test('successful stream registers on start and unregisters on finally', async () => {
    const { app } = testRuntime();
    const { batchId } = await submitGenerate(app, { prompt: 'fast', modelId: 'mock-fast', ratio: '1:1', count: 1 });
    await (await openBatchEvents(app, batchId)).text();
    expect(getBatchForUser(batchId, 'test')).toBeUndefined();
  });

  test('registration mid-flight is observable', async () => {
    const { app, db } = testRuntime({ LOCAL_TIMEOUT_MS: '5000', MOCK_PROVIDER_DELAY_MS: '300' });
    const { batchId } = await submitGenerate(app, { prompt: 'slow', modelId: 'mock-slow', ratio: '1:1', count: 1 });
    const generation = openBatchEvents(app, batchId);
    await Bun.sleep(50);
    const batchRow = db.query<{ id: string }, []>('SELECT id FROM batches').get();
    expect(batchRow).not.toBeNull();
    if (!batchRow) throw new Error('expected batch row');
    const midFlight = getBatchForUser(batchRow.id, 'test');
    expect(midFlight).toBeDefined();
    expect(midFlight?.batchController.signal.aborted).toBe(false);
    await (await generation).text();
    expect(getBatchForUser(batchRow.id, 'test')).toBeUndefined();
  });
});

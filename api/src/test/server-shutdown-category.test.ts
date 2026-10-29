import { describe, expect, test } from 'bun:test';
import { openBatchEvents, parseSse, submitGenerate, testRuntime } from './helpers';
import { snapshotBatchControllers } from '../orchestrator/registry';
import { ServerShuttingDownError } from '../orchestrator/cancellation';

describe('graceful shutdown tile category', () => {
  test('SIGTERM-aborted in-flight tile is failed:interrupted, not client disconnected', async () => {
    const { app, db } = testRuntime({ MOCK_PROVIDER_DELAY_MS: '500' });
    const { batchId } = await submitGenerate(app, { prompt: 'slow', modelId: 'mock-slow', ratio: '1:1', count: 1 });
    const respPromise = openBatchEvents(app, batchId);
    await Bun.sleep(50);
    // Exactly what server.ts shutdown() does on SIGTERM/SIGINT.
    for (const controller of snapshotBatchControllers()) {
      if (!controller.signal.aborted) controller.abort(new ServerShuttingDownError());
    }
    const events = await parseSse(await respPromise);
    const terminal = events.find(
      (e) => e.event === 'tile' && (e.data as { status?: string }).status === 'failed',
    );
    expect(terminal?.data).toMatchObject({ status: 'failed', error: 'interrupted' });
    const row = db.query<{ status: string; error: string }, []>(
      'SELECT status, error FROM tiles LIMIT 1',
    ).get();
    expect(row).toEqual({ status: 'failed', error: 'interrupted' });
  });
});

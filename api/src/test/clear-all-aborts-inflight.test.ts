import { describe, expect, test } from 'bun:test';
import { openBatchEvents, parseSseText, submitGenerate, testRuntime } from './helpers';

// DELETE /history and DELETE /history/:batchId now ABORT in-flight
// generations and hard-delete loading tile rows. The user's intent on
// archive/clear is "stop and remove" -- billing them for a generation
// they no longer want is the wrong default. Done tiles still survive
// into the archive; failed tiles still hard-delete (existing dismiss
// behavior).

describe('clear-all aborts in-flight generations and hard-deletes loading rows', () => {
  test('DELETE /history aborts loading tile + emits canceled SSE + drops the row', async () => {
    const { app, db } = testRuntime({ LOCAL_TIMEOUT_MS: '5000', MOCK_PROVIDER_DELAY_MS: '300' });
    const { batchId } = await submitGenerate(app, { prompt: 'slow', modelId: 'mock-slow', ratio: '1:1', count: 1 });
    const generation = openBatchEvents(app, batchId);
    await Bun.sleep(40);
    const del = await app.fetch(
      new Request('http://local/api/history', { method: 'DELETE', headers: { 'Remote-User': 'test' } }),
    );
    expect(del.status).toBe(204);
    const response = await generation;
    const events = parseSseText(await response.text());

    const tile = events.find((e) => e.event === 'tile') as
      | { event: 'tile'; data: { status?: string } }
      | undefined;
    expect(tile?.data.status).toBe('canceled');
    expect(events.find((e) => e.event === 'done')).toBeDefined();

    expect(db.query('SELECT id FROM tiles').all()).toHaveLength(0);
    expect(db.query('SELECT id FROM batches').all()).toHaveLength(0);
  });

  test('per-batch DELETE /history/:batchId aborts loading tiles + drops an all-loading batch', async () => {
    const { app, db } = testRuntime({ LOCAL_TIMEOUT_MS: '5000', MOCK_PROVIDER_DELAY_MS: '300' });
    const { batchId } = await submitGenerate(app, { prompt: 'slow', modelId: 'mock-slow', ratio: '1:1', count: 2 });
    const generation = openBatchEvents(app, batchId);
    await Bun.sleep(40);
    const batch = db.query<{ id: string }, []>('SELECT id FROM batches LIMIT 1').get();
    if (!batch) throw new Error('expected a loading batch row by now');
    const del = await app.fetch(
      new Request(`http://local/api/history/${batch.id}`, {
        method: 'DELETE',
        headers: { 'Remote-User': 'test' },
      }),
    );
    expect(del.status).toBe(204);
    const response = await generation;
    const events = parseSseText(await response.text());
    const canceledTiles = events.filter((e) => e.event === 'tile' && (e.data as { status?: string }).status === 'canceled');
    expect(canceledTiles).toHaveLength(2);
    expect(events.find((e) => e.event === 'done')).toBeDefined();

    expect(db.query('SELECT id FROM tiles').all()).toHaveLength(0);
    expect(db.query('SELECT id FROM batches').all()).toHaveLength(0);
  });
});

import { describe, expect, test } from 'bun:test';
import { openBatchEvents, parseSseText, submitGenerate, testRuntime } from './helpers';

describe('DELETE cancel ownership', () => {
  test('cross-user per-batch DELETE cannot abort or delete another user generation', async () => {
    const { app, db } = testRuntime({ LOCAL_TIMEOUT_MS: '5000', MOCK_PROVIDER_DELAY_MS: '200' });
    const { batchId } = await submitGenerate(app, { prompt: 'owned', modelId: 'mock-slow', ratio: '1:1', count: 1 }, 'alice');
    const generation = openBatchEvents(app, batchId, 'alice');
    await Bun.sleep(40);
    const batch = db.query<{ id: string }, []>('SELECT id FROM batches LIMIT 1').get();
    if (!batch) throw new Error('expected a loading batch row by now');

    const del = await app.fetch(
      new Request(`http://local/api/history/${batch.id}`, {
        method: 'DELETE',
        headers: { 'Remote-User': 'bob' },
      }),
    );
    expect(del.status).toBe(204);
    const response = await generation;
    const events = parseSseText(await response.text());
    const tile = events.find((e) => e.event === 'tile') as
      | { event: 'tile'; data: { status?: string } }
      | undefined;
    expect(tile?.data.status).toBe('done');

    const row = db
      .query<{ status: string; archived_at: number | null }, [string]>('SELECT status, archived_at FROM tiles WHERE batch_id = ?')
      .get(batch.id);
    expect(row).toMatchObject({ status: 'done', archived_at: null });
  });
});

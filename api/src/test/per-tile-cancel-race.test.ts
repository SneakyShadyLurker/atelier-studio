import { describe, expect, test } from 'bun:test';
import { openBatchEvents, parseSseText, submitGenerate, testRuntime } from './helpers';

describe('per-tile cancel races', () => {
  test('canceling one loading tile does not disturb a sibling tile that already completed', async () => {
    const { app, db } = testRuntime({
      LOCAL_TIMEOUT_MS: '5000',
      MOCK_PROVIDER_DELAY_MS: '1000',
      MOCK_PROVIDER_TILE_DELAYS: '25,1000',
      MAX_CONCURRENT_TILES: '2',
      MAX_CONCURRENT_TILES_PER_USER: '2',
    });
    const { batchId } = await submitGenerate(app, { prompt: 'mixed', modelId: 'mock-slow', ratio: '1:1', count: 2 }, 'alice');
    const generation = openBatchEvents(app, batchId, 'alice');
    await Bun.sleep(100);
    const loading = db
      .query<{ batch_id: string; id: string }, []>("SELECT batch_id, id FROM tiles WHERE status = 'loading'")
      .get();
    if (!loading) throw new Error('expected one loading tile after staggered mock delay');

    const del = await app.fetch(
      new Request(`http://local/api/history/${loading.batch_id}/${loading.id}`, {
        method: 'DELETE',
        headers: { 'Remote-User': 'alice' },
      }),
    );
    expect(del.status).toBe(204);
    const response = await generation;
    const events = parseSseText(await response.text());
    const terminalStatuses = events
      .filter((e) => e.event === 'tile')
      .map((e) => (e.data as { status?: string }).status)
      .sort();
    expect(terminalStatuses).toEqual(['canceled', 'done']);

    const rows = db
      .query<{ id: string; status: string; archived_at: number | null }, []>('SELECT id, status, archived_at FROM tiles ORDER BY tile_index')
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).not.toBe(loading.id);
    expect(rows[0]).toMatchObject({ status: 'done', archived_at: null });
  });
});

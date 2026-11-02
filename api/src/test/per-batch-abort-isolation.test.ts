import { describe, expect, test } from 'bun:test';
import { openBatchEvents, parseSseText, submitGenerate, testRuntime } from './helpers';

// DELETE /history/:batchId aborts and removes that batch's loading tiles.
// Sibling batches sharing the global tile cap must keep running. Before the
// abort registry was keyed by (userId, batchId), an abort on batch A would
// also tear down B; that scoping is still required for the orchestrator.

describe('per-batch DELETE isolation under sibling in-flight batches', () => {
  test('DELETE /history/:batchId aborts the target batch only; sibling batch unaffected', async () => {
    const { app, db } = testRuntime({
      LOCAL_TIMEOUT_MS: '10000',
      MAX_CONCURRENT_TILES: '2', MAX_CONCURRENT_TILES_PER_USER: '2',
      MOCK_PROVIDER_DELAY_MS: '500',
    });
    const submittedA = await submitGenerate(app, { prompt: 'A', modelId: 'mock-slow', ratio: '1:1', count: 1 });
    const genA = openBatchEvents(app, submittedA.batchId);
    // Wait long enough for A to register its abort callback.
    await Bun.sleep(50);
    const submittedB = await submitGenerate(app, { prompt: 'B', modelId: 'mock-slow', ratio: '1:1', count: 1 });
    const genB = openBatchEvents(app, submittedB.batchId);
    await Bun.sleep(50);

    const batches = db
      .query<{ id: string; prompt: string }, []>('SELECT id, prompt FROM batches ORDER BY created_at ASC')
      .all();
    expect(batches.length).toBe(2);
    const batchA = batches.find((b) => b.prompt === 'A');
    const batchB = batches.find((b) => b.prompt === 'B');
    if (!batchA || !batchB) throw new Error('expected both batches');

    // DELETE A -- aborts A and never touches B.
    const del = await app.fetch(
      new Request(`http://local/api/history/${batchA.id}`, {
        method: 'DELETE',
        headers: { 'Remote-User': 'test' },
      }),
    );
    expect(del.status).toBe(204);

    const [respA, respB] = await Promise.all([genA, genB]);
    const eventsA = parseSseText(await respA.text());
    const eventsB = parseSseText(await respB.text());

    expect(eventsA.find((e) => e.event === 'done')).toBeDefined();
    expect(eventsB.find((e) => e.event === 'done')).toBeDefined();
    const tileA = eventsA.find((e) => e.event === 'tile') as
      | { event: 'tile'; data: { status?: string } }
      | undefined;
    const tileB = eventsB.find((e) => e.event === 'tile') as
      | { event: 'tile'; data: { status?: string } }
      | undefined;
    expect(tileA?.data.status).toBe('canceled');
    expect(tileB?.data.status).toBe('done');

    // A had only a loading tile, so it is hard-deleted. B remains live.
    const rowA = db.query<{ id: string }, [string]>('SELECT id FROM batches WHERE id = ?').get(batchA.id);
    const rowB = db.query<{ archived_at: number | null }, [string]>('SELECT archived_at FROM batches WHERE id = ?').get(batchB.id);
    expect(rowA).toBeNull();
    expect(rowB?.archived_at).toBeNull();

    expect(db.query('SELECT id FROM tiles WHERE batch_id = ?').get(batchA.id)).toBeNull();
  });
});

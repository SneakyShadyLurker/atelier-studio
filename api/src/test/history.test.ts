import { describe, expect, test } from 'bun:test';
import { refImageIdsByTile } from '../orchestrator/refImages';
import { __historyTest } from '../routes/history';
import { adoptStandaloneBatch, appendSegment } from '../db/sequences';
import { generateEvents, testRuntime } from './helpers';

describe('history route', () => {
  test('returns generated batch with public tile fields', async () => {
    const { app } = testRuntime();
    await generateEvents(app, { prompt: 'x', modelId: 'mock-fast', ratio: '1:1', count: 1 });
    const res = await app.fetch(new Request('http://local/api/history', { headers: { 'Remote-User': 'test' } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { prompt: string; tiles: { status: string; url?: string; thumbUrl?: string }[] }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.prompt).toBe('x');
    expect('sequenceId' in (body.items[0] ?? {})).toBe(false);
    expect('sequenceIndex' in (body.items[0] ?? {})).toBe(false);
    expect('sequence' in (body.items[0] ?? {})).toBe(false);
    const tile = body.items[0]?.tiles[0];
    expect(tile).toMatchObject({ status: 'done' });
    expect(tile?.thumbUrl).toBe(`${tile?.url}/thumb`);
  });

  test('embeds joined sequence summary on linked batches', async () => {
    const { app, db, logger } = testRuntime();
    await generateEvents(app, { prompt: 'segment-0', modelId: 'mock-fast', ratio: '1:1', count: 1 });
    await generateEvents(app, { prompt: 'segment-1', modelId: 'mock-fast', ratio: '1:1', count: 1 });
    const first = db.query<{ id: string }, []>("SELECT id FROM batches WHERE prompt = 'segment-0'").get();
    const second = db.query<{ id: string }, []>("SELECT id FROM batches WHERE prompt = 'segment-1'").get();
    if (!first || !second) throw new Error('expected generated batches');
    db.query('UPDATE batches SET duration_frames = 124 WHERE id = ?').run(first.id);
    db.query('UPDATE batches SET duration_frames = 243 WHERE id = ?').run(second.id);
    const adopted = adoptStandaloneBatch(db, 'test', first.id, 10);
    if (adopted.status !== 'ok') throw new Error('expected sequence adoption');
    const appended = appendSegment(
      db,
      logger,
      'test',
      adopted.sequenceId,
      first.id,
      second.id,
      20,
    );
    if (appended.status !== 'ok') throw new Error('expected sequence append');

    const res = await app.fetch(new Request('http://local/api/history', {
      headers: { 'Remote-User': 'test' },
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: {
        id: string;
        sequenceId?: string;
        sequenceIndex?: number;
        sequence?: {
          id: string;
          segmentCount: number;
          totalDurationFrames: number;
          masterStatus: string;
          masterUpdatedAt?: number;
        };
      }[];
    };
    const linked = body.items.filter((batch) => batch.sequenceId === adopted.sequenceId);
    expect(linked).toHaveLength(2);
    expect(linked.map((batch) => batch.sequenceIndex).sort()).toEqual([0, 1]);
    expect(linked[0]?.sequence).toEqual({
      id: adopted.sequenceId,
      segmentCount: 2,
      totalDurationFrames: 367,
      masterStatus: 'idle',
    });
    expect(linked[1]?.sequence).toEqual(linked[0]?.sequence);
  });

  test('fails loud on a corrupt terminal row; genuine loading stays loading', async () => {
    const { app, db } = testRuntime();
    await generateEvents(app, { prompt: 'x', modelId: 'mock-fast', ratio: '1:1', count: 2 });
    const rows = db
      .query<{ id: string }, []>('SELECT id FROM tiles ORDER BY tile_index')
      .all();
    const corrupt = rows[0];
    const loadingRow = rows[1];
    if (!corrupt || !loadingRow) throw new Error('expected two seeded tiles');
    // status='done' with NULL artifact columns: the schema CHECK only
    // constrains the status enum, nothing couples it to ext/mime/completed_at.
    db.query('UPDATE tiles SET ext = NULL, mime = NULL, completed_at = NULL WHERE id = ?').run(corrupt.id);
    db.query("UPDATE tiles SET status = 'loading', ext = NULL, mime = NULL, completed_at = NULL WHERE id = ?")
      .run(loadingRow.id);
    const res = await app.fetch(new Request('http://local/api/history', { headers: { 'Remote-User': 'test' } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { tiles: { id: string; status: string; error?: string }[] }[];
    };
    const tiles = body.items[0]?.tiles ?? [];
    expect(tiles.find((t) => t.id === corrupt.id)).toMatchObject({ status: 'failed', error: 'internal error' });
    expect(tiles.find((t) => t.id === loadingRow.id)).toMatchObject({ status: 'loading' });
  });

  test('bulk history helpers skip the query for empty input', () => {
    const throwingDb = {
      query() {
        throw new Error('query should not run for empty input');
      },
    };
    expect(__historyTest.fetchTilesForBatches(throwingDb as never, 'u1', []).size).toBe(0);
    expect(refImageIdsByTile(throwingDb as never, 'u1', []).size).toBe(0);
  });
});

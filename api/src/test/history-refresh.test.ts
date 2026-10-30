import { describe, expect, test } from 'bun:test';
import { HISTORY_REFRESH_MAX_IDS } from '@atelier/shared';
import type { HistoryRefreshResponse } from '@atelier/shared/wire-schemas';
import { generateEvents, testRuntime } from './helpers';

function refresh(runtime: ReturnType<typeof testRuntime>, body: unknown, user = 'test') {
  return runtime.fetch('/api/history/refresh', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Remote-User': user }, body: JSON.stringify(body),
  });
}

async function seed(runtime: ReturnType<typeof testRuntime>, prompt: string, user = 'test'): Promise<string> {
  await generateEvents(runtime.app, { prompt, modelId: 'mock-fast', ratio: '1:1', count: 1 }, user);
  const row = runtime.db.query<{ id: string }, [string, string]>('SELECT id FROM batches WHERE user_id = ? AND prompt = ?').get(user, prompt);
  if (!row) throw new Error('missing seeded batch');
  return row.id;
}

describe('POST /history/refresh', () => {
  test('returns current public batches and treats foreign, archived and nonexistent IDs identically', async () => {
    const runtime = testRuntime();
    const own = await seed(runtime, 'own');
    const archived = await seed(runtime, 'archived');
    const foreign = await seed(runtime, 'foreign', 'other');
    runtime.db.query('UPDATE batches SET archived_at = 1 WHERE id = ?').run(archived);
    const absent = crypto.randomUUID();
    const response = await refresh(runtime, { batchIds: [own, archived, foreign, absent], storyIds: [] });
    expect(response.status).toBe(200);
    const body = await response.json() as HistoryRefreshResponse;
    expect(body.items.map((batch) => batch.id)).toEqual([own]);
    expect(body.missingBatchIds).toEqual([archived, foreign, absent]);
    expect(JSON.stringify(body)).not.toContain('userId');
  });

  test('uses the same collection, pin and search filters as history', async () => {
    const runtime = testRuntime();
    const matching = await seed(runtime, 'red chair');
    const other = await seed(runtime, 'blue chair');
    const collection = crypto.randomUUID();
    runtime.db.query("INSERT INTO collections (id,user_id,name,sort_order,created_at) VALUES (?, 'test','C',0,1)").run(collection);
    runtime.db.query('UPDATE batches SET collection_id = ?, pinned = 1 WHERE id = ?').run(collection, matching);
    const body = await (await refresh(runtime, { batchIds: [matching, other], storyIds: [], collectionId: collection, pinned: true, q: 'red' })).json() as HistoryRefreshResponse;
    expect(body.items.map((batch) => batch.id)).toEqual([matching]);
    expect(body.missingBatchIds).toEqual([other]);
    const unsorted = await (await refresh(runtime, { batchIds: [matching, other], storyIds: [], collectionId: 'null' })).json() as HistoryRefreshResponse;
    expect(unsorted.items.map((batch) => batch.id)).toEqual([other]);
  });

  test('discovers later story segments, updates story state and owner-scopes every story join', async () => {
    const runtime = testRuntime();
    const first = await seed(runtime, 'first');
    const next = await seed(runtime, 'next');
    const story = crypto.randomUUID();
    runtime.db.query("INSERT INTO stories(id,user_id,status,outline,logline,continuity_bible,ratio,eta_ms,created_at,updated_at) VALUES (?,'test','rendering','outline','arc','same subject','1:1',100,1,1)").run(story);
    for (const [index, id] of [first, next].entries()) {
      runtime.db.query("INSERT INTO story_segments(story_id,user_id,idx,beat,duration_frames,batch_id,attempts) VALUES (?,'test',?,'beat',124,?,1)").run(story, index, id);
    }
    const response = await refresh(runtime, { batchIds: [first], storyIds: [story] });
    const body = await response.json() as HistoryRefreshResponse;
    expect(new Set(body.items.map((batch) => batch.id))).toEqual(new Set([first, next]));
    expect(body.items.every((batch) => batch.story?.segmentCount === 2)).toBe(true);
    runtime.db.query("UPDATE stories SET status='done' WHERE id=?").run(story);
    const terminal = await (await refresh(runtime, { batchIds: [first], storyIds: [story] })).json() as HistoryRefreshResponse;
    expect(terminal.items.every((batch) => batch.story?.status === 'done')).toBe(true);
    const foreign = await (await refresh(runtime, { batchIds: [first], storyIds: [story] }, 'other')).json() as HistoryRefreshResponse;
    expect(foreign).toEqual({ items: [], missingBatchIds: [first] });
    // Corrupt cross-owner segment links must not grant discovery through an
    // otherwise owned story or batch.
    runtime.db.query("UPDATE story_segments SET user_id='other' WHERE batch_id=?").run(next);
    const crossed = await (await refresh(runtime, { batchIds: [], storyIds: [story] })).json() as HistoryRefreshResponse;
    expect(crossed.items.map((batch) => batch.id)).toEqual([first]);
  });

  test('validates UUIDs, bounds, scope grammar, UTF-16 length and unsupported cursor fields', async () => {
    const runtime = testRuntime();
    const valid = { batchIds: [], storyIds: [] };
    for (const invalid of [
      { ...valid, batchIds: ['not-a-uuid'] }, { ...valid, storyIds: ['invalid'] },
      { ...valid, batchIds: Array.from({ length: HISTORY_REFRESH_MAX_IDS + 1 }, () => crypto.randomUUID()) },
      { ...valid, storyIds: Array.from({ length: HISTORY_REFRESH_MAX_IDS + 1 }, () => crypto.randomUUID()) },
      { ...valid, collectionId: 'invalid' }, { ...valid, pinned: 'true' },
      { ...valid, q: '😀'.repeat(101) }, { ...valid, cursor: 'old' },
    ]) expect((await refresh(runtime, invalid)).status).toBe(400);
    expect((await refresh(runtime, valid)).status).toBe(200);
    expect((await refresh(runtime, { ...valid, q: '😀'.repeat(100) })).status).toBe(200);
  });
});

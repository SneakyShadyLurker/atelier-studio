import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { testRuntime } from './helpers';

// The mock tile settles ~120 ms after dispatch; a fixed sleep raced it under
// full-suite load, so wait for the tile to leave 'loading' instead.
async function settledTile(db: Database): Promise<{ status: string; error: string | null } | null> {
  const deadline = Date.now() + 5_000;
  let row: { status: string; error: string | null } | null = null;
  while (Date.now() < deadline) {
    row = db.query<{ status: string; error: string | null }, []>('SELECT status, error FROM tiles LIMIT 1').get();
    if (row && row.status !== 'loading') break;
    await Bun.sleep(25);
  }
  return row;
}

describe('client disconnect', () => {
  test('disconnect does not abort the batch; tiles settle naturally and no rows carry "client disconnected"', async () => {
    const { app, db } = testRuntime({ LOCAL_TIMEOUT_MS: '2000', MOCK_PROVIDER_DELAY_MS: '120' });
    const abort = new AbortController();
    const first = app.fetch(
      new Request('http://local/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Remote-User': 'test' },
        body: JSON.stringify({ prompt: 'slow', modelId: 'mock-slow', ratio: '1:1', count: 1 }),
        signal: abort.signal,
      }),
    );
    await Bun.sleep(40);
    abort.abort();
    await Promise.resolve(first).catch(() => null);
    const row = await settledTile(db);
    expect(row?.status).toBe('done');
    expect(row?.error).toBeNull();
    const second = await app.fetch(
      new Request('http://local/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Remote-User': 'test' },
        body: JSON.stringify({ prompt: 'after', modelId: 'mock-fast', ratio: '1:1', count: 1 }),
      }),
    );
    expect(second.status).toBe(201);
  });

  test('no row is ever written with error="client disconnected" by new code paths', async () => {
    const { app, db } = testRuntime({ LOCAL_TIMEOUT_MS: '2000', MOCK_PROVIDER_DELAY_MS: '120' });
    const abort = new AbortController();
    const first = app.fetch(
      new Request('http://local/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Remote-User': 'test' },
        body: JSON.stringify({ prompt: 'slow', modelId: 'mock-slow', ratio: '1:1', count: 1 }),
        signal: abort.signal,
      }),
    );
    await Bun.sleep(40);
    abort.abort();
    await Promise.resolve(first).catch(() => null);
    expect((await settledTile(db))?.status).toBe('done');
    const offending = db.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM tiles WHERE error = 'client disconnected'",
    ).get();
    expect(offending?.count).toBe(0);
  });
});

import { describe, expect, test } from 'bun:test';
import { testRuntime } from './helpers';

describe('history pagination', () => {
  test('uses stable newest-first cursor traversal', async () => {
    const { app, db } = testRuntime();
    const now = Date.now();
    db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run('test', now);
    for (let i = 0; i < 3; i++) {
      db.query('INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(crypto.randomUUID(), 'test', `p${i}`, '1:1', 'mock-fast', 'Mock Fast', now + i);
    }
    const page1 = await app.fetch(new Request('http://local/api/history?limit=2', { headers: { 'Remote-User': 'test' } }));
    const body1 = (await page1.json()) as { items: { prompt: string }[]; nextCursor: string | null };
    expect(body1.items.map((item) => item.prompt)).toEqual(['p2', 'p1']);
    expect(body1.nextCursor).toBeTruthy();
    const page2 = await app.fetch(new Request(`http://local/api/history?limit=2&cursor=${body1.nextCursor}`, { headers: { 'Remote-User': 'test' } }));
    const body2 = (await page2.json()) as { items: { prompt: string }[]; nextCursor: string | null };
    expect(body2.items.map((item) => item.prompt)).toEqual(['p0']);
    expect(body2.nextCursor).toBeNull();
  });
});

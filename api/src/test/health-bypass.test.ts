import { describe, expect, test } from 'bun:test';
import { testRuntime } from './helpers';

describe('health auth bypass', () => {
  test('health is public but models is not', async () => {
    const { app } = testRuntime();
    const health = await app.fetch(new Request('http://local/api/health'));
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, version: '0.0.0' });

    const models = await app.fetch(new Request('http://local/api/models'));
    expect(models.status).toBe(401);
  });
});

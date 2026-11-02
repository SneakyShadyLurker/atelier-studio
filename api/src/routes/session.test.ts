import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { testRuntime } from '../test/helpers';
import { SESSION_SCOPE_HEADER } from '@atelier/shared';
import { sessionScopeGuard } from '../auth/sessionScope';
import type { AppEnv } from '../server-env';

describe('GET /api/session', () => {
  test('requires authentication', async () => {
    const rt = testRuntime();
    const response = await rt.fetch('/api/session');
    expect(response.status).toBe(401);
  });

  test('returns a stable opaque scope without exposing user identity', async () => {
    const rt = testRuntime();
    const get = (userId: string) => rt.fetch('/api/session', { headers: { 'Remote-User': userId } });

    const first = await get('alice');
    const second = await get('alice');
    const other = await get('bob');

    expect(first.status).toBe(200);
    const firstBody = await first.json() as Record<string, unknown>;
    const secondBody = await second.json() as Record<string, unknown>;
    const otherBody = await other.json() as Record<string, unknown>;
    expect(firstBody).toEqual({ cacheScope: expect.any(String) });
    expect(firstBody.cacheScope).toBe(secondBody.cacheScope);
    expect(firstBody.cacheScope).not.toBe(otherBody.cacheScope);
    expect(firstBody).not.toHaveProperty('userId');
    expect(firstBody.cacheScope).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(first.headers.get(SESSION_SCOPE_HEADER)).toBe(firstBody.cacheScope as string);
    expect(first.headers.get('Vary')?.toLowerCase()).toContain(SESSION_SCOPE_HEADER.toLowerCase());
  });

  test('accepts an optional matching scope and rejects a switched account before mutations', async () => {
    const rt = testRuntime();
    const session = await rt.fetch('/api/session', { headers: { 'Remote-User': 'alice' } });
    const { cacheScope } = await session.json() as { cacheScope: string };
    const create = (userId: string, expected?: string) => rt.fetch('/api/collections', {
      method: 'POST',
      headers: {
        'Remote-User': userId, 'Content-Type': 'application/json',
        ...(expected === undefined ? {} : { [SESSION_SCOPE_HEADER]: expected }),
      },
      body: JSON.stringify({ name: 'My collection' }),
    });

    expect((await create('alice', cacheScope)).status).toBe(201);
    const switched = await create('bob', cacheScope);
    expect(switched.status).toBe(409);
    expect(await switched.json()).toEqual({ error: 'session changed', code: 'SESSION_CHANGED' });
    expect(switched.headers.get(SESSION_SCOPE_HEADER)).not.toBe(cacheScope);
    expect(switched.headers.get('Cache-Control')).toBe('private, no-store');
    expect(switched.headers.get('Vary')?.toLowerCase()).toContain(SESSION_SCOPE_HEADER.toLowerCase());
    expect(rt.db.query('SELECT id FROM collections WHERE user_id = ?').all('bob')).toEqual([]);
    expect((await create('bob', 'malformed')).status).toBe(409);
    expect((await create('bob', '')).status).toBe(409);
    expect((await create('bob')).status).toBe(201);
  });

  test('partitions cacheable models responses by expected session scope', async () => {
    const rt = testRuntime();
    const session = await rt.fetch('/api/session', { headers: { 'Remote-User': 'alice' } });
    const { cacheScope } = await session.json() as { cacheScope: string };
    const models = await rt.fetch('/api/models', {
      headers: { 'Remote-User': 'alice', [SESSION_SCOPE_HEADER]: cacheScope },
    });
    expect(models.status).toBe(200);
    expect(models.headers.get('Cache-Control')).toBe('private, max-age=15');
    expect(models.headers.get('Vary')?.toLowerCase()).toContain(SESSION_SCOPE_HEADER.toLowerCase());
  });

  test('retains existing Vary fields from middleware and normal route responses', async () => {
    const { db } = testRuntime();
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('db', db);
      c.set('userId', 'alice');
      c.header('Vary', 'Accept-Encoding');
      await next();
    });
    app.use('*', sessionScopeGuard());
    app.get('/', (c) => {
      c.header('Vary', 'Accept-Encoding, Origin');
      return c.json({ ok: true });
    });
    const normal = await app.request('/');
    const mismatch = await app.request('/', { headers: { [SESSION_SCOPE_HEADER]: 'invalid' } });
    const fields = (response: Response) => response.headers.get('Vary')?.toLowerCase().split(/\s*,\s*/);
    expect(fields(normal)).toEqual(['accept-encoding', 'origin', SESSION_SCOPE_HEADER.toLowerCase()]);
    expect(mismatch.status).toBe(409);
    expect(fields(mismatch)).toEqual(['accept-encoding', SESSION_SCOPE_HEADER.toLowerCase()]);
  });

  test('preserves authentication, CSRF ordering and the health exemption', async () => {
    const rt = testRuntime({ CSRF_PROTECT: 'true' });
    const headers = { [SESSION_SCOPE_HEADER]: 'invalid' };
    expect((await rt.fetch('/api/health', { headers })).status).toBe(200);
    expect((await rt.fetch('/api/session', { headers })).status).toBe(401);
    expect((await rt.fetch('/api/collections', {
      method: 'POST', headers: { ...headers, 'Remote-User': 'alice' },
    })).status).toBe(403);
    expect((await rt.fetch('/api/session', { headers: { ...headers, 'Remote-User': 'alice' } })).status).toBe(409);
  });
});

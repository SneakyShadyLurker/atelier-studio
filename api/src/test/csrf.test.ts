import { describe, expect, test } from 'bun:test';
import { testRuntime } from './helpers';

describe('csrf guard', () => {
  test('disabled by default in test runtime — state-changing requests succeed without Origin/Referer', async () => {
    const { app } = testRuntime();
    const res = await app.fetch(
      new Request('http://local/api/history', {
        method: 'DELETE',
        headers: { 'Remote-User': 'test' },
      }),
    );
    expect(res.status).toBe(204);
  });

  test('enabled: missing Origin and Referer on POST is rejected', async () => {
    const { app } = testRuntime({ CSRF_PROTECT: 'true' });
    const res = await app.fetch(
      new Request('http://local/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Remote-User': 'test' },
        body: JSON.stringify({ prompt: 'x', modelId: 'mock-fast', ratio: '1:1', count: 1 }),
      }),
    );
    expect(res.status).toBe(403);
  });

  test('enabled: cross-origin Origin header is rejected', async () => {
    const { app } = testRuntime({ CSRF_PROTECT: 'true' });
    const res = await app.fetch(
      new Request('http://local/api/history', {
        method: 'DELETE',
        headers: { 'Remote-User': 'test', Origin: 'http://attacker.example' },
      }),
    );
    expect(res.status).toBe(403);
  });

  test('enabled: same-origin Origin header is accepted', async () => {
    const { app } = testRuntime({ CSRF_PROTECT: 'true' });
    const res = await app.fetch(
      new Request('http://local/api/history', {
        method: 'DELETE',
        headers: { 'Remote-User': 'test', Origin: 'http://local', Host: 'local' },
      }),
    );
    expect(res.status).toBe(204);
  });

  test('enabled: GET requests bypass the check (safe method)', async () => {
    const { app } = testRuntime({ CSRF_PROTECT: 'true' });
    const res = await app.fetch(
      new Request('http://local/api/history', {
        method: 'GET',
        headers: { 'Remote-User': 'test' },
      }),
    );
    expect(res.status).toBe(200);
  });

  test('enabled: Referer fallback works when Origin is absent', async () => {
    const { app } = testRuntime({ CSRF_PROTECT: 'true' });
    const res = await app.fetch(
      new Request('http://local/api/history', {
        method: 'DELETE',
        headers: { 'Remote-User': 'test', Referer: 'http://local/some/path', Host: 'local' },
      }),
    );
    expect(res.status).toBe(204);
  });
});

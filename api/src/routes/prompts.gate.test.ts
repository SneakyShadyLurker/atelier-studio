import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { AppEnv } from '../server-env';
import { testConfig, testRuntime } from '../test/helpers';
import { promptGate } from './prompts.gate';

function gateApp(userId: string, env: Partial<NodeJS.ProcessEnv> = {}): Hono<AppEnv> {
  return new Hono<AppEnv>()
    .use('*', async (c, next) => {
      c.set('config', testConfig(env));
      c.set('userId', userId);
      await next();
    })
    .use('*', promptGate)
    .get('/dummy', (c) => c.json({ ok: true }));
}

describe('promptGate', () => {
  test('allows an allowlisted user through to the route handler', async () => {
    const app = gateApp('alice', { PROMPT_LIBRARY_USERS: 'alice,bob' });

    const res = await app.fetch(new Request('http://local/dummy'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test('returns the app not-found 404 for a non-allowlisted user', async () => {
    const app = gateApp('mallory', { PROMPT_LIBRARY_USERS: 'alice,bob' });

    const res = await app.fetch(new Request('http://local/dummy'));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });

  test('returns the app not-found 404 for everyone when the allowlist is empty', async () => {
    const app = gateApp('alice', { PROMPT_LIBRARY_USERS: '' });

    const res = await app.fetch(new Request('http://local/dummy'));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });

  test('does not leak from prompts to sibling api routes at the real mount', async () => {
    const rt = testRuntime();

    const prompts = await rt.fetch('/api/prompts', {
      headers: { 'Remote-User': 'alice' },
    });
    const models = await rt.fetch('/api/models', {
      headers: { 'Remote-User': 'alice' },
    });
    const keys = await rt.fetch('/api/keys/google', {
      headers: { 'Remote-User': 'alice' },
    });

    expect(prompts.status).toBe(404);
    const missing = await rt.fetch(`/api/${crypto.randomUUID()}`, {
      headers: { 'Remote-User': 'alice' },
    });
    const promptsBody = await prompts.text();
    const missingBody = await missing.text();
    expect(missing.status).toBe(404);
    expect(promptsBody).toBe(missingBody);
    expect(JSON.parse(promptsBody)).toEqual({ error: 'not found' });
    expect(models.status).toBe(200);
    expect(keys.status).toBe(200);
  });
});

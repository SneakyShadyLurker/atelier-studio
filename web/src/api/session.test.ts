import { afterEach, describe, expect, mock, test } from 'bun:test';
import { bootstrapSession, fetchSession } from './session';
import { SESSION_SCOPE_HEADER } from '@atelier/shared';
import { resetSessionScopeForTests, sessionBinding } from '../lib/sessionScope';
import { apiFetch } from './client';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; resetSessionScopeForTests(); });

describe('fetchSession', () => {
  test('accepts only an opaque UUID scope', async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      cacheScope: '3d3a4748-9b9e-4b22-b72d-e6d4d95e47f8',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))) as unknown as typeof fetch;
    const session = await fetchSession();
    expect(session).toEqual({ cacheScope: '3d3a4748-9b9e-4b22-b72d-e6d4d95e47f8' });
  });

  test('rejects a malformed scope', async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({ cacheScope: 'alice' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))) as unknown as typeof fetch;
    let thrown: unknown;
    try {
      await fetchSession();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('invalid response shape');
  });

  test('bootstrap sends no expected scope until validated, then binds every request', async () => {
    const scope = '3d3a4748-9b9e-4b22-b72d-e6d4d95e47f8';
    const observed: (string | null)[] = [];
    globalThis.fetch = mock((_input: RequestInfo | URL, init?: RequestInit) => {
      observed.push(new Headers(init?.headers).get(SESSION_SCOPE_HEADER));
      return Promise.resolve(Response.json({ cacheScope: scope }, { headers: { [SESSION_SCOPE_HEADER]: scope } }));
    }) as unknown as typeof fetch;
    expect(await bootstrapSession(new AbortController().signal)).toEqual({ cacheScope: scope });
    await apiFetch('/uploads', { method: 'POST' });
    expect(observed).toEqual([null, scope]);
    expect(sessionBinding().cacheScope).toBe(scope);
  });

  test('an abandoned bootstrap cannot bind a late successful session', async () => {
    const controller = new AbortController();
    let finish: ((response: Response) => void) | undefined;
    globalThis.fetch = mock(() => new Promise<Response>((resolve) => { finish = resolve; })) as unknown as typeof fetch;
    const bootstrapping = bootstrapSession(controller.signal);
    controller.abort();
    finish?.(Response.json({ cacheScope: '3d3a4748-9b9e-4b22-b72d-e6d4d95e47f8' }));
    expect(await bootstrapping.catch((error: unknown) => error)).toHaveProperty('name', 'AbortError');
    expect(sessionBinding().cacheScope).toBeUndefined();
  });
});

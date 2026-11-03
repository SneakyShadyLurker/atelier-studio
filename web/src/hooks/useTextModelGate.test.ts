import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { useTextModelGate } from './useTextModelGate';

const realFetch = globalThis.fetch;

interface Routes {
  readonly textModels: () => Response | Promise<Response>;
  readonly textProviders: () => Response | Promise<Response>;
}

const emptyModels = { models: [], tasks: [], defaults: { byTask: {} }, writers: {} };
const oneModel = { ...emptyModels, models: [{ id: 'm1', displayName: 'Model one' }] };
const never = () => new Promise<Response>(() => undefined);

function serve(routes: Routes): void {
  globalThis.fetch = mock((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/text-models')) return Promise.resolve(routes.textModels());
    if (url.endsWith('/text-providers')) return Promise.resolve(routes.textProviders());
    return Promise.resolve(new Response('not found', { status: 404 }));
  }) as unknown as typeof fetch;
}

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
}

afterEach(() => { globalThis.fetch = realFetch; });

describe('useTextModelGate', () => {
  test('zero text models is the only conclusive "none"', async () => {
    serve({ textModels: () => Response.json(emptyModels), textProviders: never });
    const { result } = renderHook(() => useTextModelGate(), { wrapper: wrapper() });
    await waitFor(() => { expect(result.current.availability).toBe('none'); });
  });

  test('any configured model is "available", whatever its task routing', async () => {
    serve({ textModels: () => Response.json(oneModel), textProviders: never });
    const { result } = renderHook(() => useTextModelGate(), { wrapper: wrapper() });
    await waitFor(() => { expect(result.current.availability).toBe('available'); });
  });

  test('a pending query is "unknown"', () => {
    serve({ textModels: never, textProviders: never });
    const { result } = renderHook(() => useTextModelGate(), { wrapper: wrapper() });
    expect(result.current).toEqual({ availability: 'unknown', admin: 'unknown' });
  });

  test('an error without data stays "unknown", so the action runs', async () => {
    serve({ textModels: () => new Response('nope', { status: 400 }), textProviders: never });
    const { result } = renderHook(() => useTextModelGate(), { wrapper: wrapper() });
    // Let the failed request settle; availability must not flip to "none".
    await waitFor(() => { expect(globalThis.fetch).toHaveBeenCalled(); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current.availability).toBe('unknown');
  });

  test('admin is "yes" when the provider list loads and "no" when it 404s', async () => {
    serve({ textModels: never, textProviders: () => Response.json({ providers: [] }) });
    const admin = renderHook(() => useTextModelGate(), { wrapper: wrapper() });
    await waitFor(() => { expect(admin.result.current.admin).toBe('yes'); });

    serve({ textModels: never, textProviders: () => new Response('not found', { status: 404 }) });
    const member = renderHook(() => useTextModelGate(), { wrapper: wrapper() });
    await waitFor(() => { expect(member.result.current.admin).toBe('no'); });
  });

  test('admin is "unknown" while loading and on a non-404 error', async () => {
    serve({ textModels: never, textProviders: () => new Response('denied', { status: 403 }) });
    const { result } = renderHook(() => useTextModelGate(), { wrapper: wrapper() });
    expect(result.current.admin).toBe('unknown');
    await waitFor(() => { expect(globalThis.fetch).toHaveBeenCalledTimes(2); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current.admin).toBe('unknown');
  });
});

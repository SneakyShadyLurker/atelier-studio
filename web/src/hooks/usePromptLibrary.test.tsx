import type { PromptLibraryResponse } from '@atelier/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { ApiError } from '../api/client';
import { promptKeys } from '../api/prompts';
import { usePromptLibrary } from './usePromptLibrary';

function wrapper(client: QueryClient) {
  return function TestWrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

const emptyLibrary: PromptLibraryResponse = {
  templates: [],
  variableLists: [],
  dimensions: [],
};

afterEach(() => {
  cleanup();
  mock.restore();
});

describe('usePromptLibrary', () => {
  test('enabled is false while loading and false on 404', async () => {
    let rejectFetch: (error: Error) => void = () => undefined;
    globalThis.fetch = mock(() => new Promise<Response>((_resolve, reject) => {
      rejectFetch = reject;
    })) as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => usePromptLibrary(), { wrapper: wrapper(client) });

    expect(result.current.enabled).toBe(false);
    expect(result.current.gated).toBe(false);

    rejectFetch(new ApiError(404, 'not found'));

    await waitFor(() => { expect(result.current.gated).toBe(true); });
    expect(result.current.enabled).toBe(false);
    expect(result.current.isError).toBe(false);
  });

  test('enabled flips true only after a successful fetch', async () => {
    let resolveFetch: (response: Response) => void = () => undefined;
    globalThis.fetch = mock(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    })) as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => usePromptLibrary(), { wrapper: wrapper(client) });

    expect(result.current.enabled).toBe(false);

    resolveFetch(Response.json(emptyLibrary));

    await waitFor(() => { expect(result.current.enabled).toBe(true); });
    expect(result.current.data).toEqual(emptyLibrary);
    expect(result.current.gated).toBe(false);
  });

  test('cached prompt data enables immediately and gates off on 404 revalidation', async () => {
    // refetchOnMount: 'always' was removed from promptLibraryOpts once the
    // server started emitting ETags. Revocation is still detected — but on
    // TanStack's default revalidation triggers, not on every mount. This
    // test forces a revalidation via invalidateQueries to assert the gate
    // still trips when the server starts returning 404 for a previously
    // eligible user.
    let rejectFetch: (error: Error) => void = () => undefined;
    globalThis.fetch = mock(() => new Promise<Response>((_resolve, reject) => {
      rejectFetch = reject;
    })) as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(promptKeys.library(), emptyLibrary);

    const { result } = renderHook(() => usePromptLibrary(), { wrapper: wrapper(client) });

    expect(result.current.enabled).toBe(true);

    void client.invalidateQueries({ queryKey: promptKeys.library() });
    rejectFetch(new ApiError(404, 'not found'));

    await waitFor(() => { expect(result.current.gated).toBe(true); });
    expect(result.current.enabled).toBe(false);
  });
});

import { afterEach, expect, mock, test } from 'bun:test';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';
import { useArchiveQuery } from './useArchiveQuery';

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test('exposes native next-page failure and clears it after an explicit successful retry', async () => {
  let call = 0;
  globalThis.fetch = mock(() => {
    call += 1;
    return Promise.resolve(call === 1
      ? Response.json({ items: [], nextCursor: 'older', total: 0 })
      : call === 2
        ? Response.json({ error: 'invalid cursor' }, { status: 400 })
        : Response.json({ items: [], nextCursor: null, total: null }));
  }) as unknown as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const { result } = renderHook(() => useArchiveQuery(), { wrapper });
  await waitFor(() => { expect(result.current.hasNextPage).toBe(true); });
  expect(result.current.isFetchNextPageError).toBe(false);
  await act(async () => { await result.current.fetchNextPage(); });
  await waitFor(() => { expect(result.current.isFetchNextPageError).toBe(true); });
  expect(result.current.hasNextPage).toBe(true);
  await act(async () => { await result.current.fetchNextPage(); });
  await waitFor(() => { expect(result.current.isFetchNextPageError).toBe(false); });
  expect(result.current.hasNextPage).toBe(false);
  client.clear();
});

import type { HistoryPage, Batch } from '@atelier/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import type { AppView } from '../store/atelier';
import { useHistory } from './useHistory';

function wrapper(client: QueryClient) {
  return function TestWrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

const emptyPage: HistoryPage<Batch> = { items: [], nextCursor: null };

function mockFetchCapture(): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = mock((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    return Promise.resolve(Response.json(emptyPage));
  }) as unknown as typeof fetch;
  return { calls };
}

function historyCalls(calls: readonly string[]): string[] {
  return calls.filter((url) => url.includes('/history'));
}

afterEach(() => {
  cleanup();
  mock.restore();
});

describe('useHistory feed-view gating', () => {
  test('fetches /history for the Unsorted feed view', async () => {
    const { calls } = mockFetchCapture();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    renderHook(() => useHistory({ kind: 'unsorted' }, ''), { wrapper: wrapper(client) });

    await waitFor(() => { expect(historyCalls(calls).length).toBeGreaterThan(0); });
  });

  test('does NOT fetch /history while the Prompt Library view is active', async () => {
    const { calls } = mockFetchCapture();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const view: AppView = { kind: 'prompts' };
    const { result } = renderHook(() => useHistory(view, ''), { wrapper: wrapper(client) });

    // Let any enabled query flush a request.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(historyCalls(calls)).toEqual([]);
    expect(result.current.batches).toEqual([]);
  });

  test('does NOT fetch /history while an Archive view is active', async () => {
    const { calls } = mockFetchCapture();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const view: AppView = { kind: 'archive', scope: { kind: 'all' } };
    renderHook(() => useHistory(view, ''), { wrapper: wrapper(client) });

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(historyCalls(calls)).toEqual([]);
  });
});

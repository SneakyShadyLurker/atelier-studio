import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { libraryCoverageKeys } from '../api/libraryCoverage';
import { useReplaceTags, useUpdateOption } from './usePromptMutations';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function wrapperFor(client: QueryClient) {
  return function W({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

// Seed the coverage query with arbitrary cached data so we can assert the
// mutation marks it invalidated (the Dimensions-tab badge + CoverageCard read
// from this key).
function seedCoverage(client: QueryClient): void {
  client.setQueryData(libraryCoverageKeys.current(), {
    untaggedByList: [],
    lowCoverageLists: [],
    orphanTags: [],
    missingDimensions: [],
    librarySnapshotHash: 'h',
    templatesDigest: 'd',
  });
}

describe('Finding C — library mutations invalidate the coverage query', () => {
  test('useReplaceTags (retag) invalidates libraryCoverage', async () => {
    const client = makeClient();
    seedCoverage(client);
    globalThis.fetch = mock(() =>
      Promise.resolve(Response.json({ id: 'd1', name: 'epoch', tags: [] })),
    ) as unknown as typeof fetch;

    const { result } = renderHook(() => useReplaceTags(), { wrapper: wrapperFor(client) });
    await act(async () => {
      await result.current.mutateAsync({ dimId: 'd1', tags: [{ label: 'ancient', sortOrder: 0 }] });
    });

    await waitFor(() => {
      expect(client.getQueryState(libraryCoverageKeys.current())?.isInvalidated).toBe(true);
    });
  });

  test('useUpdateOption (option edit) invalidates libraryCoverage', async () => {
    const client = makeClient();
    seedCoverage(client);
    globalThis.fetch = mock(() => Promise.resolve(new Response(null, { status: 204 }))) as unknown as typeof fetch;

    const { result } = renderHook(() => useUpdateOption(), { wrapper: wrapperFor(client) });
    await act(async () => {
      await result.current.mutateAsync({ listId: 'l1', optionId: 'o1', patch: { weight: 5 } });
    });

    await waitFor(() => {
      expect(client.getQueryState(libraryCoverageKeys.current())?.isInvalidated).toBe(true);
    });
  });
});

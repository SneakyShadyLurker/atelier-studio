import { describe, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type React from 'react';
import { useKeyStatus } from './useKeyStatus';

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe('useKeyStatus', () => {
  test('returns present:false when api returns it', async () => {
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      expect(input).toBe('/api/keys/google');
      return Response.json({ present: false });
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useKeyStatus('google'), { wrapper: wrapper() });

    await waitFor(() => { expect(result.current.isSuccess).toBe(true); });
    expect(result.current.data).toEqual({ present: false });
  });
});

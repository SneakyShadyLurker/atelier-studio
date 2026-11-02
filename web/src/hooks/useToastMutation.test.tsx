import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, test } from 'bun:test';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useAtelierStore } from '../store/atelier';
import { useToastMutation } from './useToastMutation';

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

afterEach(() => { useAtelierStore.setState({ toasts: [] }); });

describe('useToastMutation', () => {
  test('shows the success toast and runs settle on success', async () => {
    let settled = 0;
    const { result } = renderHook(() => useToastMutation({
      mutationFn: () => Promise.resolve(),
      successToast: 'Done',
      errorFallback: 'fallback',
      onSettled: () => { settled += 1; },
    }), { wrapper });
    await result.current.mutateAsync();
    await waitFor(() => {
      expect(useAtelierStore.getState().toasts.some((t) => t.text === 'Done' && t.tone === 'success')).toBe(true);
    });
    expect(settled).toBe(1);
  });

  test('shows a describeError error toast on failure', async () => {
    const { result } = renderHook(() => useToastMutation({
      mutationFn: () => Promise.reject(new Error('boom')),
      errorFallback: 'Could not do it.',
      successToast: 'Done',
    }), { wrapper });
    await result.current.mutateAsync().catch(() => undefined);
    await waitFor(() => {
      const errs = useAtelierStore.getState().toasts.filter((t) => t.tone === 'error');
      expect(errs.length).toBe(1);
    });
    // The success toast must NOT fire on failure.
    expect(useAtelierStore.getState().toasts.some((t) => t.text === 'Done')).toBe(false);
  });

  test('omitting successToast shows no toast on success', async () => {
    const { result } = renderHook(() => useToastMutation({
      mutationFn: () => Promise.resolve(),
      errorFallback: 'fallback',
    }), { wrapper });
    await result.current.mutateAsync();
    await waitFor(() => { expect(result.current.isSuccess).toBe(true); });
    expect(useAtelierStore.getState().toasts.length).toBe(0);
  });
});

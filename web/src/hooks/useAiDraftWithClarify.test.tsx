import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ApiError } from '../api/client';
import { useAtelierStore } from '../store/atelier';
import { useAiDraftWithClarify } from './useAiDraftWithClarify';

afterEach(() => {
  useAtelierStore.setState({ toasts: [] });
});

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return function W({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

interface Resolved {
  kind: 'entries';
  entries: string[];
}

// An empty base opens the seed dialog; a non-empty one drafts immediately.
function harness(base: string[]) {
  const run = mock((): Promise<Resolved> => Promise.reject(new ApiError(502, 'upstream unavailable')));
  const view = renderHook(
    () => useAiDraftWithClarify<string[], Resolved>({
      captureBase: () => base,
      isEmptyBase: (value) => value.length === 0,
      run,
      onResolve: () => undefined,
      errorFallback: 'Could not draft.',
    }),
    { wrapper: wrapper() },
  );
  return { view, run };
}

describe('useAiDraftWithClarify error surface', () => {
  test('an immediate draft with no dialog open reports the failure as a toast', async () => {
    const { view, run } = harness(['red']);
    act(() => { view.result.current.draft(); });
    await waitFor(() => { expect(view.result.current.status).toBe('error'); });
    expect(run).toHaveBeenCalledTimes(1);
    expect(view.result.current.dialogMode).toBeNull();
    const toasts = useAtelierStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.text).toBe(view.result.current.error ?? '');
    expect(toasts[0]?.tone).toBe('error');
  });

  test('a failure inside the open seed dialog is shown inline only, with no duplicate toast', async () => {
    const { view, run } = harness([]);
    act(() => { view.result.current.draft(); });
    expect(view.result.current.dialogMode).toBe('seed');
    act(() => { view.result.current.submitDescription('cat breeds'); });
    await waitFor(() => { expect(view.result.current.status).toBe('error'); });
    expect(run).toHaveBeenCalledTimes(1);
    expect(view.result.current.dialogMode).toBe('seed');
    expect(view.result.current.error).not.toBeNull();
    expect(useAtelierStore.getState().toasts).toHaveLength(0);
  });
});

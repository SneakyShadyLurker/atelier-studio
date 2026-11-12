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

describe('useAiDraftWithClarify rework mode', () => {
  function reworkHarness(base: string[], run = mock((): Promise<Resolved> => Promise.reject(new ApiError(502, 'upstream unavailable')))) {
    const onResolve = mock((_result: Resolved) => undefined);
    const view = renderHook(
      () => useAiDraftWithClarify<string[], Resolved>({
        captureBase: () => base,
        isEmptyBase: (value) => value.length === 0,
        nonEmptyBase: 'rework',
        run,
        onResolve,
        errorFallback: 'Could not draft.',
      }),
      { wrapper: wrapper() },
    );
    return { view, run, onResolve };
  }

  test('a non-empty base opens the rework dialog instead of firing', () => {
    const { view, run } = reworkHarness(['red']);
    act(() => { view.result.current.draft(); });
    expect(view.result.current.dialogMode).toBe('rework');
    expect(view.result.current.status).toBe('rework-prompt');
    expect(run).not.toHaveBeenCalled();
  });

  test('an empty base still opens the seed dialog', () => {
    const { view } = reworkHarness([]);
    act(() => { view.result.current.draft(); });
    expect(view.result.current.dialogMode).toBe('seed');
    expect(view.result.current.status).toBe('seed-prompt');
  });

  test('a blank instruction is ignored; a real one fires with the captured base', async () => {
    const run = mock((): Promise<Resolved> => Promise.resolve({ kind: 'entries', entries: ['x'] }));
    const { view, onResolve } = reworkHarness(['red'], run);
    act(() => { view.result.current.draft(); });
    act(() => { view.result.current.submitDescription('   '); });
    expect(run).not.toHaveBeenCalled();
    act(() => { view.result.current.submitDescription('  bluer  '); });
    await waitFor(() => { expect(view.result.current.status).toBe('done'); });
    expect(run.mock.calls[0]?.slice(0, 2) as unknown).toEqual([['red'], 'bluer']);
    expect(onResolve).toHaveBeenCalledWith({ kind: 'entries', entries: ['x'] });
    expect(view.result.current.dialogMode).toBeNull();
  });

  test('a failure stays inline in the open rework dialog, with no toast', async () => {
    const { view } = reworkHarness(['red']);
    act(() => { view.result.current.draft(); });
    act(() => { view.result.current.submitDescription('bluer'); });
    await waitFor(() => { expect(view.result.current.status).toBe('error'); });
    expect(view.result.current.dialogMode).toBe('rework');
    expect(view.result.current.error).not.toBeNull();
    expect(useAtelierStore.getState().toasts).toHaveLength(0);
  });

  test('cancel during the request drops its late result', async () => {
    let resolveRun: (value: Resolved) => void = () => undefined;
    const run = mock((): Promise<Resolved> => new Promise<Resolved>((resolve) => { resolveRun = resolve; }));
    const { view, onResolve } = reworkHarness(['red'], run);
    act(() => { view.result.current.draft(); });
    act(() => { view.result.current.submitDescription('bluer'); });
    await waitFor(() => { expect(run).toHaveBeenCalledTimes(1); });
    act(() => { view.result.current.cancelDialog(); });
    expect(view.result.current.dialogMode).toBeNull();
    expect(view.result.current.status).toBe('idle');
    await act(async () => { resolveRun({ kind: 'entries', entries: ['late'] }); await Promise.resolve(); });
    expect(onResolve).not.toHaveBeenCalled();
    expect(view.result.current.status).toBe('idle');
  });
});

import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, test } from 'bun:test';
import type { PropsWithChildren } from 'react';
import { historyKeys } from '../api/history';
import { initialAtelierState, useAtelierStore } from '../store/atelier';
import { HISTORY_WRITE_MUTATION_KEY } from './historyWrites';
import { useDiscardSequenceTail } from './useDiscardSequenceTail';

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  useAtelierStore.setState(initialAtelierState, true);
});

const tick = () => new Promise((resolve) => { setTimeout(resolve, 0); });

test('the settle re-read of a discarded tail waits behind another pending history write', async () => {
  globalThis.fetch = (() => Promise.resolve(new Response(null, { status: 204 }))) as unknown as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  let reads = 0;
  const readHistory = () => { reads += 1; return Promise.resolve({ pages: [], pageParams: [] }); };
  const observer = new QueryObserver(client, {
    queryKey: historyKeys.list(),
    queryFn: readHistory,
    staleTime: Infinity,
  });
  const unsubscribe = observer.subscribe(() => undefined);
  await tick();
  expect(reads).toBe(1);

  const other = Promise.withResolvers<null>();
  const otherWrite = client.getMutationCache()
    .build(client, { mutationKey: HISTORY_WRITE_MUTATION_KEY, mutationFn: () => other.promise })
    .execute(undefined);

  const wrapper = ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const { result } = renderHook(() => useDiscardSequenceTail(), { wrapper });
  await act(async () => {
    await result.current.mutateAsync('sequence-1');
    await tick();
  });
  expect(useAtelierStore.getState().toasts.map((toast) => toast.text)).toContain('Tail discarded');
  expect(client.getQueryState(historyKeys.list())?.isInvalidated).toBe(true);
  expect(reads).toBe(1);

  await act(async () => {
    other.resolve(null);
    await otherWrite;
    await tick();
  });
  expect(reads).toBe(2);
  unsubscribe();
  client.clear();
});

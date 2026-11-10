import type { Batch } from '@atelier/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, test } from 'bun:test';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { flushQueryNotifications } from '../../test/fixtures/queryNotifications';
import { historyKeys } from '../api/history';
import type { HistoryData } from './historyCache';
import { useHistoryWorkRunning } from './useHistoryWorkRunning';

afterEach(cleanup);

function batch(id: string, createdAt: number, loading: boolean): Batch {
  return {
    id, prompt: 'p', ratio: '1:1', modelId: 'm', modelLabel: 'M', createdAt, collectionId: null, pinned: false,
    status: loading ? 'running' : 'done',
    tiles: [loading
      ? { id: `${id}-t`, seed: 1, status: 'loading' }
      : { id: `${id}-t`, seed: 1, status: 'done', url: '/img.png', ext: 'png', mime: 'image/png', completedAt: createdAt + 1 }],
  };
}

function history(items: Batch[]): HistoryData {
  return { pages: [{ items, nextCursor: null }], pageParams: [null] };
}

describe('useHistoryWorkRunning', () => {
  test('is true only while the Unsorted cache holds a loading tile, and re-renders only when that flips', async () => {
    const client = new QueryClient();
    const wrapper = ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    let renders = 0;
    const { result } = renderHook(() => { renders += 1; return useHistoryWorkRunning(); }, { wrapper });
    expect(result.current).toBe(false);

    await act(async () => { client.setQueryData(historyKeys.list(), history([batch('b', 2, true), batch('a', 1, false)])); await flushQueryNotifications(); });
    expect(result.current).toBe(true);
    const whileRunning = renders;

    // Another batch finishing or arriving changes the data, not the answer.
    await act(async () => { client.setQueryData(historyKeys.list(), history([batch('c', 3, false), batch('b', 2, true), batch('a', 1, false)])); await flushQueryNotifications(); });
    expect(result.current).toBe(true);
    expect(renders).toBe(whileRunning);

    await act(async () => { client.setQueryData(historyKeys.list(), history([batch('c', 3, false), batch('b', 2, false), batch('a', 1, false)])); await flushQueryNotifications(); });
    expect(result.current).toBe(false);
    client.clear();
  });
});

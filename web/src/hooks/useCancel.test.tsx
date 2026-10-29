import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';
import { resetBroadcastForTests } from './broadcastHistory';
import { useCancel } from './useCancel';

const originalFetch = globalThis.fetch;
const originalBroadcastChannel = window.BroadcastChannel;

afterEach(() => {
  cleanup();
  resetBroadcastForTests();
  globalThis.fetch = originalFetch;
  window.BroadcastChannel = originalBroadcastChannel;
});

describe('cross-tab cancel settlement', () => {
  for (const status of [204, 500]) {
    test(`broadcasts committed history after a delayed DELETE settles with ${status}`, async () => {
      const response = Promise.withResolvers<Response>();
      const started = Promise.withResolvers<undefined>();
      let settled = false;
      const messages: { type: string; batchId: string; afterSettlement: boolean }[] = [];
      class Channel {
        postMessage(message: { type: string; batchId: string }) {
          messages.push({ type: message.type, batchId: message.batchId, afterSettlement: settled });
        }
        addEventListener() { /* no local receiver */ }
        removeEventListener() { /* no local receiver */ }
        close() { /* no host resources */ }
      }
      window.BroadcastChannel = Channel as unknown as typeof BroadcastChannel;
      globalThis.fetch = mock(() => {
        started.resolve(undefined);
        return response.promise;
      }) as unknown as typeof fetch;
      const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
      const wrapper = ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
      const { result } = renderHook(() => useCancel(), { wrapper });
      let cancellation: Promise<void> | undefined;
      try {
        await act(async () => {
          cancellation = result.current.cancelTile('batch-1', 'tile-1').catch(() => undefined);
          await started.promise;
        });
        // A sibling's early refetch can still see the terminal pre-delete row.
        expect(messages).toEqual([
          { type: 'invalidate', batchId: 'batch-1', afterSettlement: false },
          { type: 'cancel', batchId: 'batch-1', afterSettlement: false },
        ]);
        await act(async () => {
          settled = true;
          response.resolve(new Response(status === 204 ? null : 'failed', { status }));
          await cancellation;
        });
        expect(messages.at(-1)).toEqual({ type: 'invalidate', batchId: 'batch-1', afterSettlement: true });
        expect(messages.filter((message) => message.type === 'invalidate')).toHaveLength(2);
      } finally {
        await act(async () => {
          response.resolve(new Response(status === 204 ? null : 'failed', { status }));
          await cancellation;
        });
        client.clear();
      }
    });
  }
});

import { afterEach, describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { createHistoryBroadcastMutationCache, emitHistoryInvalidate, onHistoryInvalidate, resetBroadcastForTests } from '../src/hooks/broadcastHistory';
import { HISTORY_WRITE_MUTATION_KEY } from '../src/hooks/historyWrites';

const originalBroadcastChannel = window.BroadcastChannel;

class MockChannel {
  static listeners = new Set<(event: MessageEvent) => void>();
  static messages: unknown[] = [];

  postMessage(message: unknown): void {
    MockChannel.messages.push(message);
    for (const listener of MockChannel.listeners) {
      listener({ data: message } as MessageEvent);
    }
  }

  addEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
    MockChannel.listeners.add(listener);
  }

  removeEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
    MockChannel.listeners.delete(listener);
  }

  close(): void {
    return undefined;
  }
}

function setBroadcastChannel(value: typeof BroadcastChannel | undefined): void {
  Object.defineProperty(window, 'BroadcastChannel', {
    configurable: true,
    writable: true,
    value,
  });
}

afterEach(() => {
  resetBroadcastForTests();
  MockChannel.listeners.clear();
  MockChannel.messages = [];
  setBroadcastChannel(originalBroadcastChannel);
});

describe('broadcastHistory', () => {
  test('emitHistoryInvalidate is a no-op when BroadcastChannel is unavailable', () => {
    setBroadcastChannel(undefined);
    expect(() => { emitHistoryInvalidate('batch-1'); }).not.toThrow();
  });

  test('emitHistoryInvalidate posts and registered listeners fire', () => {
    setBroadcastChannel(MockChannel as never);
    const received: string[] = [];

    const unsubscribe = onHistoryInvalidate((batchId) => {
      received.push(batchId);
    });
    emitHistoryInvalidate('batch-1');

    expect(MockChannel.messages).toEqual([{ type: 'invalidate', batchId: 'batch-1' }]);
    expect(received).toEqual(['batch-1']);
    unsubscribe();
  });

  test('onHistoryInvalidate returns an unsubscribe that removes the listener', () => {
    setBroadcastChannel(MockChannel as never);
    const received: string[] = [];

    const unsubscribe = onHistoryInvalidate((batchId) => {
      received.push(batchId);
    });
    unsubscribe();
    emitHistoryInvalidate('batch-1');

    expect(received).toEqual([]);
  });

  test('message shape mismatches are ignored', () => {
    setBroadcastChannel(MockChannel as never);
    const received: string[] = [];

    const unsubscribe = onHistoryInvalidate((batchId) => {
      received.push(batchId);
    });
    new MockChannel().postMessage({ type: 'other' });

    expect(received).toEqual([]);
    unsubscribe();
  });

  test('every settled history write tells sibling tabs, other mutations stay local', async () => {
    setBroadcastChannel(MockChannel as never);
    const client = new QueryClient({ mutationCache: createHistoryBroadcastMutationCache() });
    const run = (mutationKey: readonly unknown[], variables: unknown, fail = false) => client.getMutationCache()
      .build(client, { mutationKey, mutationFn: () => (fail ? Promise.reject(new Error('nope')) : Promise.resolve(null)) })
      .execute(variables)
      .catch(() => undefined);

    await run(['generate'], { batchId: 'b0' });
    expect(MockChannel.messages).toEqual([]);
    await run(HISTORY_WRITE_MUTATION_KEY, { batchId: 'b1' });
    // A failed write can still have changed server state (a cancel that lost
    // the race), so siblings re-read on failure too.
    await run(HISTORY_WRITE_MUTATION_KEY, { batchId: 'b2' }, true);
    // Writes without one batch still carry a string id: older bundles in other
    // tabs drop an invalidate whose batchId is not a string.
    await run(HISTORY_WRITE_MUTATION_KEY, { tileIds: ['t1'] });
    expect(MockChannel.messages).toEqual([
      { type: 'invalidate', batchId: 'b1' },
      { type: 'invalidate', batchId: 'b2' },
      { type: 'invalidate', batchId: '' },
    ]);
  });
});

import { afterEach, describe, expect, test } from 'bun:test';
import { emitHistoryInvalidate, onHistoryInvalidate, resetBroadcastForTests } from '../src/hooks/broadcastHistory';

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
});

import { describe, expect, test } from 'bun:test';
import { createCompletionTracker } from './pump';

describe('createCompletionTracker', () => {
  test('wakes a waiter on the next completion, rejected streams included, and swallows the rejection', async () => {
    const tracker = createCompletionTracker();
    const failing = Promise.withResolvers<undefined>();
    tracker.track(failing.promise);
    expect(tracker.running()).toBe(1);
    const woke = tracker.whenAnyCompletes(new AbortController().signal);
    failing.reject(new Error('stream lost'));
    expect(await woke).toBe(true);
    expect(tracker.running()).toBe(0);
    expect(tracker.waiting()).toBe(0);
  });

  test('an aborted wait resolves false and leaves no waiter behind', async () => {
    const tracker = createCompletionTracker();
    tracker.track(new Promise<never>(() => undefined));
    for (let index = 0; index < 5; index += 1) {
      const wait = new AbortController();
      const woke = tracker.whenAnyCompletes(wait.signal);
      expect(tracker.waiting()).toBe(1);
      wait.abort();
      expect(await woke).toBe(false);
      expect(tracker.waiting()).toBe(0);
    }
  });
});

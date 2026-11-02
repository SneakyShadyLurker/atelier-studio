import { describe, expect, test } from 'bun:test';
import { abortableDelay, abortReason, isAbortError } from './abort';

describe('abortReason', () => {
  test('returns an Error reason by identity', () => {
    const controller = new AbortController();
    const reason = new Error('caller left');
    controller.abort(reason);
    expect(abortReason(controller.signal)).toBe(reason);
  });

  test('wraps a non-Error reason as an AbortError carrying a string message', () => {
    const controller = new AbortController();
    controller.abort('gone');
    const error = abortReason(controller.signal);
    expect(isAbortError(error)).toBe(true);
    expect(error.message).toBe('gone');
  });
});

describe('abortableDelay', () => {
  test('resolves after the delay', async () => {
    await abortableDelay(1, new AbortController().signal);
  });

  test('rejects immediately when already aborted', async () => {
    const controller = new AbortController();
    const reason = new Error('early');
    controller.abort(reason);
    let caught: unknown;
    try { await abortableDelay(10_000, controller.signal); } catch (error) { caught = error; }
    expect(caught).toBe(reason);
  });

  test('rejects with the abort reason when aborted mid-wait', async () => {
    const controller = new AbortController();
    const pending = abortableDelay(10_000, controller.signal);
    const reason = new Error('mid');
    controller.abort(reason);
    let caught: unknown;
    try { await pending; } catch (error) { caught = error; }
    expect(caught).toBe(reason);
  });
});

import { describe, expect, test } from 'bun:test';
import { renderHook } from '@testing-library/react';
import { useAbortableMutation } from './useAbortableMutation';

describe('useAbortableMutation', () => {
  test('supersede aborts the prior signal and returns a fresh live one', () => {
    const { result } = renderHook(() => useAbortableMutation());
    const first = result.current.supersede();
    expect(first.aborted).toBe(false);
    const second = result.current.supersede();
    expect(first.aborted).toBe(true);
    expect(second.aborted).toBe(false);
    expect(second).not.toBe(first);
  });

  test('abort(reason) aborts the current signal with an AbortError reason', () => {
    const { result } = renderHook(() => useAbortableMutation());
    const signal = result.current.supersede();
    result.current.abort('reset');
    expect(signal.aborted).toBe(true);
    expect((signal.reason as DOMException).name).toBe('AbortError');
  });

  test('the returned object is stable across renders', () => {
    const { result, rerender } = renderHook(() => useAbortableMutation());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  test('unmount aborts the in-flight signal', () => {
    const { result, unmount } = renderHook(() => useAbortableMutation());
    const signal = result.current.supersede();
    unmount();
    expect(signal.aborted).toBe(true);
  });
});

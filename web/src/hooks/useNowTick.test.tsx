import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { useNowTick } from './useNowTick';

const originalSetInterval = window.setInterval.bind(window);
const originalClearInterval = window.clearInterval.bind(window);
const originalDateNow = Date.now;

afterEach(() => {
  cleanup();
  window.setInterval = originalSetInterval;
  window.clearInterval = originalClearInterval;
  Date.now = originalDateNow;
});

describe('useNowTick', () => {
  test('uses one-second cadence for elapsed-time consumers', () => {
    const delays: number[] = [];
    window.setInterval = mock((handler: TimerHandler, delay?: number) => {
      delays.push(delay ?? 0);
      return originalSetInterval(handler, delay);
    }) as unknown as typeof window.setInterval;
    window.clearInterval = mock((id: number | undefined) => {
      if (id !== undefined) originalClearInterval(id);
    }) as unknown as typeof window.clearInterval;

    const { unmount } = renderHook(() => useNowTick());

    expect(delays).toEqual([1000]);
    unmount();
  });

  test('uses requested cadence for minute-granularity consumers', () => {
    const delays: number[] = [];
    window.setInterval = mock((handler: TimerHandler, delay?: number) => {
      delays.push(delay ?? 0);
      return originalSetInterval(handler, delay);
    }) as unknown as typeof window.setInterval;
    window.clearInterval = mock((id: number | undefined) => {
      if (id !== undefined) originalClearInterval(id);
    }) as unknown as typeof window.clearInterval;

    const { unmount } = renderHook(() => useNowTick(30_000));

    expect(delays).toEqual([30_000]);
    unmount();
  });

  test('keeps independent timers per cadence and clears each when unused', () => {
    const delays: number[] = [];
    const active = new Set<number>();
    window.setInterval = mock((_handler: TimerHandler, delay?: number) => {
      const id = delays.length + 1;
      delays.push(delay ?? 0);
      active.add(id);
      return id;
    }) as unknown as typeof window.setInterval;
    window.clearInterval = mock((id: number | undefined) => {
      if (id !== undefined) active.delete(id);
    }) as unknown as typeof window.clearInterval;

    const seconds = renderHook(() => useNowTick());
    const halfMinute = renderHook(() => useNowTick(30_000));

    expect(delays).toEqual([1000, 30_000]);
    expect(active.size).toBe(2);

    seconds.unmount();
    expect(active.size).toBe(1);

    halfMinute.unmount();
    expect(active.size).toBe(0);
  });

  test('refreshes stale snapshots when the first consumer subscribes', async () => {
    Date.now = mock(() => 123_456);

    const { result, unmount } = renderHook(() => useNowTick());

    await waitFor(() => { expect(result.current).toBe(123_456); });
    unmount();
  });
});

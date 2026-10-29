import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { initialAtelierState, useAtelierStore } from './atelier';

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

describe('toast pause/resume timers', () => {
  beforeEach(() => { useAtelierStore.setState(initialAtelierState, true); });
  afterEach(() => { useAtelierStore.setState(initialAtelierState, true); });

  test('pauseToast keeps an actionable toast past its duration; resume re-arms dismissal', async () => {
    const store = useAtelierStore.getState();
    const id = store.addToast('Archived', 'success', 40, { label: 'Undo', onClick: () => undefined });
    // Pause synchronously, well within the 40ms window.
    useAtelierStore.getState().pauseToast(id);
    await sleep(90);
    // Paused: still present and not yet animating out.
    const paused = useAtelierStore.getState().toasts.find((t) => t.id === id);
    expect(paused).toBeDefined();
    expect(paused?.leaving).toBeFalsy();
    // Resume: the ~40ms remainder elapses and the toast flips to leaving.
    useAtelierStore.getState().resumeToast(id);
    await sleep(90);
    expect(useAtelierStore.getState().toasts.find((t) => t.id === id)?.leaving).toBe(true);
  });

  test('a non-paused toast dismisses on its own', async () => {
    const store = useAtelierStore.getState();
    store.addToast('Saved', 'success', 30);
    await sleep(70);
    const t = useAtelierStore.getState().toasts.find((x) => x.text === 'Saved');
    // Either flipped to leaving or already removed — definitely not still active.
    expect(t?.leaving ?? true).toBe(true);
  });

  test('defaults durations by tone while preserving an explicit override', () => {
    const originalSetTimeout = window.setTimeout.bind(window);
    const durations: number[] = [];
    const store = useAtelierStore.getState();
    window.setTimeout = ((_handler: TimerHandler, timeout?: number) => {
      durations.push(timeout ?? 0);
      return 1;
    }) as typeof window.setTimeout;
    try {
      store.addToast('Error', 'error');
      store.addToast('Soft', 'soft');
      store.addToast('Success', 'success');
      store.addToast('Explicit', 'error', 1234);
      expect(durations).toEqual([6000, 3500, 2000, 1234]);
    } finally {
      for (const toast of useAtelierStore.getState().toasts) store.removeToast(toast.id);
      window.setTimeout = originalSetTimeout;
    }
  });
});

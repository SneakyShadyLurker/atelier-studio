import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { initialAtelierState, useAtelierStore } from '../store/atelier';
import { createPreloadErrorHandler, registerUnsavedWork } from './preloadRecovery';

beforeEach(() => {
  window.sessionStorage.clear();
  useAtelierStore.setState(initialAtelierState, true);
});

describe('vite:preloadError recovery', () => {
  test('reloads when nothing unsaved exists, at most once inside the loop guard', () => {
    const reload = mock(() => undefined);
    const handle = createPreloadErrorHandler(reload);

    handle();
    handle();

    expect(reload).toHaveBeenCalledTimes(1);
    expect(useAtelierStore.getState().toasts).toHaveLength(0);
  });

  test('keeps the page and offers a reload while a draft exists off-view', () => {
    const reload = mock(() => undefined);
    const handle = createPreloadErrorHandler(reload);
    const unregister = registerUnsavedWork(() => true);
    try {
      handle();
      handle();

      expect(reload).not.toHaveBeenCalled();
      const toasts = useAtelierStore.getState().toasts;
      expect(toasts).toHaveLength(1);
      expect(toasts[0]?.action?.label).toBe('Reload');
      toasts[0]?.action?.onClick();
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      unregister();
      useAtelierStore.getState().toasts.forEach((toast) => { toast.onDismiss?.(); });
    }
  });

  test('a composer prompt counts as unsaved work', () => {
    const reload = mock(() => undefined);
    useAtelierStore.getState().setDraft({ prompt: 'a lighthouse at dusk' });

    createPreloadErrorHandler(reload)();

    expect(reload).not.toHaveBeenCalled();
    expect(useAtelierStore.getState().toasts).toHaveLength(1);
    useAtelierStore.getState().toasts.forEach((toast) => { toast.onDismiss?.(); });
  });
});

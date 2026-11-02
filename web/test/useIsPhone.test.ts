import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useIsPhone } from '../src/hooks/useIsPhone';

const originalMatchMedia = window.matchMedia.bind(window);

function installMatchMedia(initial: boolean) {
  let matches = initial;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const addEventListener = mock((type: string, listener: EventListenerOrEventListenerObject) => {
    if (type === 'change' && typeof listener === 'function') listeners.add(listener);
  });
  const removeEventListener = mock((type: string, listener: EventListenerOrEventListenerObject) => {
    if (type === 'change' && typeof listener === 'function') listeners.delete(listener);
  });
  const media: MediaQueryList = {
    get matches() { return matches; },
    media: '(width < 768px)',
    onchange: null,
    addEventListener,
    removeEventListener,
    addListener: mock((listener: (event: MediaQueryListEvent) => void) => { listeners.add(listener); }),
    removeListener: mock((listener: (event: MediaQueryListEvent) => void) => { listeners.delete(listener); }),
    dispatchEvent: mock(() => true),
  };
  const queryMock = mock((query: string) => {
    if (query === '(width < 768px)') return media;
    return {
      matches: false,
      media: query,
      onchange: null,
      addEventListener: mock(() => undefined),
      removeEventListener: mock(() => undefined),
      addListener: mock(() => undefined),
      removeListener: mock(() => undefined),
      dispatchEvent: mock(() => true),
    };
  });

  window.matchMedia = queryMock;

  return {
    queryMock,
    addEventListener,
    removeEventListener,
    setMatches(next: boolean) {
      matches = next;
      const event = Object.assign(new Event('change'), { matches, media: media.media });
      for (const listener of listeners) listener(event);
    },
  };
}

afterEach(() => {
  cleanup();
  window.matchMedia = originalMatchMedia;
  mock.restore();
});

describe('useIsPhone', () => {
  test('subscribes to max-width changes and unsubscribes on unmount', () => {
    const matchMedia = installMatchMedia(false);
    const { result, unmount } = renderHook(() => useIsPhone());

    expect(result.current).toBe(false);
    expect(matchMedia.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));

    act(() => { matchMedia.setMatches(true); });
    expect(result.current).toBe(true);

    unmount();
    expect(matchMedia.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  test('reuses the same MediaQueryList across snapshot reads', () => {
    const matchMedia = installMatchMedia(false);
    const { rerender, unmount } = renderHook(() => useIsPhone());

    rerender();
    rerender();

    expect(matchMedia.queryMock).toHaveBeenCalledTimes(1);
    expect(matchMedia.addEventListener).toHaveBeenCalledTimes(1);

    unmount();
  });
});

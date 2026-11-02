import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, renderHook } from '@testing-library/react';
import { useTheme } from '../src/hooks/useTheme';

const originalMatchMedia = window.matchMedia.bind(window);
const originalLocalStorage = window.localStorage;

function installMatchMedia(initial: boolean) {
  const matches = initial;
  const media: MediaQueryList = {
    get matches() { return matches; },
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: mock(() => undefined),
    removeEventListener: mock(() => undefined),
    addListener: mock(() => undefined),
    removeListener: mock(() => undefined),
    dispatchEvent: mock(() => true),
  };
  const queryMock = mock((query: string) => {
    if (query === '(prefers-color-scheme: dark)') return media;
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
  return queryMock;
}

afterEach(() => {
  cleanup();
  window.matchMedia = originalMatchMedia;
  Object.defineProperty(window, 'localStorage', { configurable: true, value: originalLocalStorage });
  mock.restore();
});

describe('useTheme', () => {
  test('reuses the same system color MediaQueryList across snapshot reads', () => {
    const queryMock = installMatchMedia(false);
    window.localStorage.clear();

    const { rerender } = renderHook(() => useTheme());

    rerender();
    rerender();

    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});

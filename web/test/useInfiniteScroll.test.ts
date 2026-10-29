import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render } from '@testing-library/react';
import { createElement, useEffect } from 'react';
import { useInfiniteScroll } from '../src/hooks/useInfiniteScroll';

// A controlled stand-in for IntersectionObserver: each instance exposes
// `.trigger(isIntersecting)` so tests can fire the callback deterministically.
// happy-dom ships a real IO but it never fires without an actual layout pass.
let lastObserver: MockObserver | null = null;
const noop = () => undefined;

function registerObserver(observer: MockObserver) {
  lastObserver = observer;
}

function expectObserver() {
  if (lastObserver === null) throw new Error('Expected observer to be created');
  return lastObserver;
}

class MockObserver {
  callback: IntersectionObserverCallback;
  options: IntersectionObserverInit | undefined;
  observed: Element[] = [];
  disconnected = false;
  constructor(cb: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.callback = cb;
    this.options = options;
    registerObserver(this);
  }
  observe(el: Element) { this.observed.push(el); }
  unobserve(el: Element) { this.observed = this.observed.filter((x) => x !== el); }
  disconnect() { this.disconnected = true; }
  trigger(isIntersecting: boolean) {
    const target = this.observed[0] ?? document.createElement('div');
    this.callback(
      [{ isIntersecting, target } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
  takeRecords() { return []; }
}

beforeEach(() => {
  lastObserver = null;
  (globalThis as unknown as { IntersectionObserver: typeof IntersectionObserver })
    .IntersectionObserver = MockObserver as unknown as typeof IntersectionObserver;
});

afterEach(() => {
  cleanup();
  mock.restore();
});

function Harness(props: Parameters<typeof useInfiniteScroll>[0]) {
  const { sentinelRef } = useInfiniteScroll(props);
  // useEffect lets the ref attach before the observer runs.
  useEffect(noop, []);
  return createElement('div', { ref: sentinelRef, 'data-testid': 'sentinel' });
}

describe('useInfiniteScroll', () => {
  test('defaults rootMargin to half the viewport height', () => {
    const fetchNextPage = mock(noop);
    render(createElement(Harness, { hasNextPage: true, isFetchingNextPage: false, fetchNextPage, itemCount: 0 }));
    expect(expectObserver().options?.rootMargin).toBe(`${String(Math.round(window.innerHeight * 0.5))}px 0px`);
  });

  test('observes the sentinel with the provided rootMargin', () => {
    const fetchNextPage = mock(noop);
    render(createElement(Harness, { hasNextPage: true, isFetchingNextPage: false, fetchNextPage, itemCount: 0, rootMargin: '400px 0px' }));
    expect(lastObserver).not.toBeNull();
    const observer = expectObserver();
    expect(observer.options?.rootMargin).toBe('400px 0px');
    expect(observer.observed.length).toBe(1);
  });

  test('calls fetchNextPage when the sentinel intersects', () => {
    const fetchNextPage = mock(noop);
    render(createElement(Harness, { hasNextPage: true, isFetchingNextPage: false, fetchNextPage, itemCount: 0 }));
    expectObserver().trigger(true);
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });

  test('does not call fetchNextPage when already fetching', () => {
    const fetchNextPage = mock(noop);
    render(createElement(Harness, { hasNextPage: true, isFetchingNextPage: true, fetchNextPage, itemCount: 0 }));
    expectObserver().trigger(true);
    expect(fetchNextPage).not.toHaveBeenCalled();
  });

  test('does not observe when hasNextPage is false', () => {
    const fetchNextPage = mock(noop);
    render(createElement(Harness, { hasNextPage: false, isFetchingNextPage: false, fetchNextPage, itemCount: 0 }));
    expect(lastObserver).toBeNull();
  });

  test('does not observe when enabled is false', () => {
    const fetchNextPage = mock(noop);
    render(createElement(Harness, { hasNextPage: true, isFetchingNextPage: false, fetchNextPage, itemCount: 0, enabled: false }));
    expect(lastObserver).toBeNull();
  });

  test('disconnects the observer on unmount', () => {
    const fetchNextPage = mock(noop);
    const { unmount } = render(createElement(Harness, { hasNextPage: true, isFetchingNextPage: false, fetchNextPage, itemCount: 0 }));
    const observer = expectObserver();
    unmount();
    expect(observer.disconnected).toBe(true);
  });
});

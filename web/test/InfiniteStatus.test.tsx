import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import { InfiniteStatus } from '../src/components/InfiniteStatus';

let lastObserver: MockObserver | null = null;
const noop = () => undefined;

function registerObserver(observer: MockObserver) {
  lastObserver = observer;
}

function expectObserver(): MockObserver {
  if (lastObserver === null) throw new Error('Expected observer to be created');
  return lastObserver;
}

class MockObserver {
  callback: IntersectionObserverCallback;
  observed: Element[] = [];
  constructor(cb: IntersectionObserverCallback) {
    this.callback = cb;
    registerObserver(this);
  }
  observe(el: Element) { this.observed.push(el); }
  unobserve(_el: Element) { /* This mock only delivers explicit intersections. */ }
  disconnect(): void { return; }
  takeRecords() { return []; }
  trigger(isIntersecting: boolean) {
    const target = this.observed[0] ?? document.createElement('div');
    this.callback([{ isIntersecting, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

beforeEach(() => {
  lastObserver = null;
  (globalThis as unknown as { IntersectionObserver: typeof IntersectionObserver })
    .IntersectionObserver = MockObserver as unknown as typeof IntersectionObserver;
});
afterEach(() => { cleanup(); mock.restore(); });

describe('InfiniteStatus', () => {
  test('renders nothing when feed is empty and there is no next page', () => {
    const fetchNextPage = mock(noop);
    const { container } = render(
      <InfiniteStatus hasNextPage={false} isFetchingNextPage={false} fetchNextPage={fetchNextPage} itemCount={0} endLabel="END · 0 BATCHES" />,
    );
    expect(container.firstChild).toBeNull();
  });

  test('renders the loading row while fetching the next page', () => {
    const fetchNextPage = mock(noop);
    render(
      <InfiniteStatus hasNextPage isFetchingNextPage fetchNextPage={fetchNextPage} itemCount={20} endLabel="END · 20 BATCHES" />,
    );
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('LOADING MORE');
    expect(status.getAttribute('aria-live')).toBe('polite');
  });

  test('renders the end pill when there are no more pages but the feed is non-empty', () => {
    const fetchNextPage = mock(noop);
    render(
      <InfiniteStatus hasNextPage={false} isFetchingNextPage={false} fetchNextPage={fetchNextPage} itemCount={47} endLabel="END · 47 BATCHES" />,
    );
    expect(screen.getByText('END · 47 BATCHES')).toBeTruthy();
  });

  test('mounts an invisible sentinel and a keyboard-fallback button when idle with more pages available', () => {
    const fetchNextPage = mock(noop);
    render(
      <InfiniteStatus hasNextPage isFetchingNextPage={false} fetchNextPage={fetchNextPage} itemCount={20} endLabel="END · 20 BATCHES" />,
    );
    // observer attaches
    expect(lastObserver).not.toBeNull();
    expect(expectObserver().observed.length).toBe(1);
    // sr-only fallback button is reachable
    const button = screen.getByRole('button', { name: /load more/i });
    expect(button).toBeTruthy();
    expect(button.hasAttribute('disabled')).toBe(false);
  });

  test('fires fetchNextPage when the sentinel intersects', () => {
    const fetchNextPage = mock(noop);
    render(
      <InfiniteStatus hasNextPage isFetchingNextPage={false} fetchNextPage={fetchNextPage} itemCount={20} endLabel="END · 20 BATCHES" />,
    );
    expectObserver().trigger(true);
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });

  test('fires fetchNextPage when the keyboard-fallback button is clicked', () => {
    const fetchNextPage = mock(noop);
    render(
      <InfiniteStatus hasNextPage isFetchingNextPage={false} fetchNextPage={fetchNextPage} itemCount={20} endLabel="END · 20 BATCHES" />,
    );
    screen.getByRole('button', { name: /load more/i }).click();
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });

  test('keeps sentinel and fallback button mounted across the idle→loading transition (button disabled while loading)', () => {
    // Regression: previously the sentinel + button only rendered when state==='idle',
    // so an in-flight fetch unmounted them. The observer kept a reference to a
    // detached node and the next fresh sentinel was unobserved — auto-load
    // became dead until itemCount changed. Now both are stable when hasNextPage.
    const fetchNextPage = mock(noop);
    const { rerender } = render(
      <InfiniteStatus hasNextPage isFetchingNextPage={false} fetchNextPage={fetchNextPage} itemCount={20} endLabel="END · 20 BATCHES" />,
    );
    const observerBefore = expectObserver();
    expect(observerBefore.observed.length).toBe(1);
    const sentinelBefore = observerBefore.observed[0];

    rerender(<InfiniteStatus hasNextPage isFetchingNextPage fetchNextPage={fetchNextPage} itemCount={20} endLabel="END · 20 BATCHES" />);
    // Same observer, same sentinel node — no churn.
    expect(expectObserver()).toBe(observerBefore);
    expect(observerBefore.observed[0]).toBe(sentinelBefore);
    // Button is still in the DOM but disabled.
    const button = screen.getByRole('button', { name: /load more/i });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
  });

  test('does not observe when enabled is false', () => {
    const fetchNextPage = mock(noop);
    render(
      <InfiniteStatus hasNextPage isFetchingNextPage={false} fetchNextPage={fetchNextPage} itemCount={20} endLabel="END · 20 BATCHES" enabled={false} />,
    );
    expect(lastObserver).toBeNull();
  });

  test('aria-live region wraps only the text label, not the focusable button', () => {
    // Regression: previously `role="status" aria-live="polite"` wrapped the
    // whole row including the fallback button — activating the button while
    // it sat in the live region caused screen readers to announce the
    // disappearing/changing content unpredictably.
    const fetchNextPage = mock(noop);
    render(
      <InfiniteStatus hasNextPage isFetchingNextPage={false} fetchNextPage={fetchNextPage} itemCount={20} endLabel="END · 20 BATCHES" />,
    );
    const status = screen.getByRole('status');
    const button = screen.getByRole('button', { name: /load more/i });
    expect(status.contains(button)).toBe(false);
  });
});

import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render } from '@testing-library/react';
import { useInfiniteScroll } from './useInfiniteScroll';

type ObserverCallback = IntersectionObserverCallback;

const originalIntersectionObserver = globalThis.IntersectionObserver;

class MockIntersectionObserver {
  static callbacks: ObserverCallback[] = [];

  readonly root: Element | Document | null = null;
  readonly rootMargin: string;
  readonly thresholds: readonly number[] = [0];

  constructor(callback: ObserverCallback, options?: IntersectionObserverInit) {
    MockIntersectionObserver.callbacks.push(callback);
    this.rootMargin = options?.rootMargin ?? '0px';
  }

  observe = mock((_target: Element) => undefined);
  unobserve = mock((_target: Element) => undefined);
  disconnect = mock(() => undefined);
  takeRecords = mock((): IntersectionObserverEntry[] => []);
}

function Harness({
  hasNextPage,
  isFetchingNextPage,
  isFetchNextPageError = false,
  itemCount,
  fetchNextPage,
  enabled = true,
}: {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError?: boolean;
  itemCount: number;
  fetchNextPage: () => void;
  enabled?: boolean;
}) {
  const { sentinelRef } = useInfiniteScroll({
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    itemCount,
    fetchNextPage,
    rootMargin: '0px',
    enabled,
  });
  return <div ref={sentinelRef} data-testid="sentinel" />;
}

function intersectingEntry(): IntersectionObserverEntry {
  return {
    isIntersecting: true,
    target: document.createElement('div'),
  } as unknown as IntersectionObserverEntry;
}

afterEach(() => {
  cleanup();
  mock.restore();
  MockIntersectionObserver.callbacks = [];
  globalThis.IntersectionObserver = originalIntersectionObserver;
});

describe('useInfiniteScroll', () => {
  test('clearing only a background page error does not restart the visible failing cursor', () => {
    globalThis.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver;
    const fetchNextPage = mock();
    const { rerender } = render(
      <Harness hasNextPage isFetchingNextPage={false} isFetchNextPageError itemCount={30} fetchNextPage={fetchNextPage} />,
    );
    const callback = MockIntersectionObserver.callbacks.at(-1);
    if (!callback) throw new Error('missing observer callback');
    callback([intersectingEntry()], {} as IntersectionObserver);
    rerender(<Harness hasNextPage isFetchingNextPage={false} itemCount={30} fetchNextPage={fetchNextPage} />);
    expect(fetchNextPage).not.toHaveBeenCalled();

    // Explicit Retry still starts work; its successful completion may fill
    // more of the viewport using the ordinary fetch/item-count transitions.
    fetchNextPage();
    rerender(<Harness hasNextPage isFetchingNextPage itemCount={30} fetchNextPage={fetchNextPage} />);
    rerender(<Harness hasNextPage isFetchingNextPage={false} itemCount={60} fetchNextPage={fetchNextPage} />);
    expect(fetchNextPage).toHaveBeenCalledTimes(2);
  });

  test('does not restart an exhausted page request while its sentinel remains visible', () => {
    globalThis.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver;
    const fetchNextPage = mock();
    const { rerender } = render(
      <Harness hasNextPage isFetchingNextPage={false} itemCount={30} fetchNextPage={fetchNextPage} />,
    );
    const callback = MockIntersectionObserver.callbacks.at(-1);
    if (!callback) throw new Error('missing observer callback');
    callback([intersectingEntry()], {} as IntersectionObserver);
    rerender(<Harness hasNextPage isFetchingNextPage itemCount={30} fetchNextPage={fetchNextPage} />);
    rerender(<Harness hasNextPage isFetchingNextPage={false} isFetchNextPageError itemCount={30} fetchNextPage={fetchNextPage} />);
    callback([intersectingEntry()], {} as IntersectionObserver);
    expect(fetchNextPage).toHaveBeenCalledTimes(1);

    // A manual retry may run while the error is still recorded. Successful
    // completion clears the native error and restores viewport filling.
    rerender(<Harness hasNextPage isFetchingNextPage isFetchNextPageError itemCount={30} fetchNextPage={fetchNextPage} />);
    rerender(<Harness hasNextPage isFetchingNextPage={false} itemCount={60} fetchNextPage={fetchNextPage} />);
    expect(fetchNextPage).toHaveBeenCalledTimes(2);
  });

  test('continues fetching when an underfilled page leaves the sentinel visible', () => {
    globalThis.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver;
    const fetchNextPage = mock();

    const { rerender } = render(
      <Harness hasNextPage isFetchingNextPage={false} itemCount={30} fetchNextPage={fetchNextPage} />,
    );
    const callback = MockIntersectionObserver.callbacks.at(-1);
    if (!callback) throw new Error('missing observer callback');

    callback([intersectingEntry()], {} as IntersectionObserver);
    expect(fetchNextPage).toHaveBeenCalledTimes(1);

    rerender(
      <Harness hasNextPage isFetchingNextPage={false} itemCount={60} fetchNextPage={fetchNextPage} />,
    );

    expect(fetchNextPage).toHaveBeenCalledTimes(2);
  });

  test('does not reuse stale sentinel visibility after an enabled false-to-true transition', () => {
    globalThis.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver;
    const fetchNextPage = mock();

    const { rerender } = render(
      <Harness hasNextPage isFetchingNextPage={false} itemCount={30} fetchNextPage={fetchNextPage} />,
    );
    const callback = MockIntersectionObserver.callbacks.at(-1);
    if (!callback) throw new Error('missing observer callback');

    callback([intersectingEntry()], {} as IntersectionObserver);
    expect(fetchNextPage).toHaveBeenCalledTimes(1);

    rerender(
      <Harness
        enabled={false}
        hasNextPage
        isFetchingNextPage={false}
        itemCount={30}
        fetchNextPage={fetchNextPage}
      />,
    );
    rerender(
      <Harness hasNextPage isFetchingNextPage={false} itemCount={30} fetchNextPage={fetchNextPage} />,
    );

    expect(fetchNextPage).toHaveBeenCalledTimes(1);

    const nextCallback = MockIntersectionObserver.callbacks.at(-1);
    if (!nextCallback) throw new Error('missing replacement observer callback');
    nextCallback([intersectingEntry()], {} as IntersectionObserver);

    expect(fetchNextPage).toHaveBeenCalledTimes(2);
  });
});

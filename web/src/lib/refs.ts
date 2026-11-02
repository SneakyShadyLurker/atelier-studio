import type { RefCallback, RefObject } from 'react';

/** Compose an object ref with a React 19 callback ref and its detach cleanup. */
export function composeRef<T>(targetRef: RefObject<T | null> | undefined, callback: RefCallback<T>): RefCallback<T> {
  return (element) => {
    if (targetRef) targetRef.current = element;
    const cleanup = callback(element);
    return () => {
      if (typeof cleanup === 'function') cleanup();
      if (targetRef?.current === element) targetRef.current = null;
    };
  };
}

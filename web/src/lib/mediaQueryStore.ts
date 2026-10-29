import { useSyncExternalStore } from 'react';

export interface MediaQueryStore {
  /** Current match; false without a window or `matchMedia`. */
  readonly matches: () => boolean;
  readonly subscribe: (callback: () => void) => () => void;
  /** React binding: re-renders when the query flips. Server snapshot is false. */
  readonly useMatches: () => boolean;
}

/**
 * One external store per media query. The MediaQueryList is cached and
 * re-created only when `window.matchMedia` changes identity (tests swap it).
 */
export function createMediaQueryStore(query: string): MediaQueryStore {
  let mql: MediaQueryList | null | undefined;
  let cachedMatchMedia: unknown;

  const getMediaQueryList = (): MediaQueryList | null => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
    if (mql === undefined || cachedMatchMedia !== window.matchMedia) {
      // Retain an opaque identity for cache invalidation, never an unbound callable.
      cachedMatchMedia = Reflect.get(window, 'matchMedia');
      mql = window.matchMedia(query);
    }
    return mql;
  };

  const matches = (): boolean => getMediaQueryList()?.matches ?? false;

  const subscribe = (callback: () => void): (() => void) => {
    const media = getMediaQueryList();
    if (!media) return () => undefined;
    media.addEventListener('change', callback);
    return () => { media.removeEventListener('change', callback); };
  };

  const useMatches = (): boolean => useSyncExternalStore(subscribe, matches, () => false);

  return { matches, subscribe, useMatches };
}

/** Shared by the `useReducedMotion` hook and non-React readers (overlay timing). */
export const reducedMotionStore = createMediaQueryStore('(prefers-reduced-motion: reduce)');

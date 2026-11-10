import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  getMediaSnapshot,
  isMediaCacheable,
  retainMedia,
  retryMedia,
  subscribeMedia,
  type MediaStatus,
} from '../lib/mediaCache';

export interface CachedMedia {
  /** An object URL from the session media cache (or a `data:`/`blob:` URL as given). */
  src: string | undefined;
  /** `ready` means the bytes are in memory; decoding stays with the consumer. */
  status: MediaStatus;
  /** The bytes were already in memory on this URL's first render here: a repaint, not an arrival. */
  cached: boolean;
  /** Starts a fresh download after `error`. */
  retry: () => void;
}

export interface CachedMediaOptions {
  priority?: RequestPriority | undefined;
}

function noSubscription(): () => void {
  return () => undefined;
}

/**
 * Reads `url` through the session media cache (lib/mediaCache.ts) while the
 * component is mounted. A cache hit is `ready` on the first render, so a
 * virtualized remount paints from memory without a request. No URL is
 * `error`: there is nothing to load.
 */
export function useCachedMedia(url: string | undefined, { priority }: CachedMediaOptions = {}): CachedMedia {
  const cacheable = url !== undefined && isMediaCacheable(url);
  const snapshot = useSyncExternalStore(
    cacheable ? (listener: () => void) => subscribeMedia(url, listener) : noSubscription,
    () => (cacheable ? getMediaSnapshot(url) : undefined),
    () => undefined,
  );
  const hitNow = snapshot?.status === 'ready';
  const [firstSeen, setFirstSeen] = useState(() => ({ url, cached: hitNow }));
  if (firstSeen.url !== url) setFirstSeen({ url, cached: hitNow });
  const cached = firstSeen.url === url ? firstSeen.cached : hitNow;

  useEffect(() => {
    if (!cacheable) return;
    return retainMedia(url, { priority });
  }, [cacheable, url, priority]);

  const retry = () => { if (cacheable) retryMedia(url); };
  if (url === undefined) return { src: undefined, status: 'error', cached: false, retry };
  if (!cacheable) return { src: url, status: 'ready', cached: false, retry };
  return { src: snapshot?.src, status: snapshot?.status ?? 'loading', cached, retry };
}

/**
 * The `src` for a small thumbnail image: the cached thumbnail, or the original
 * when the tile has no thumbnail or it could not be loaded. `undefined` while
 * the thumbnail is still downloading (the image has nothing to show yet).
 */
export function useCachedThumb(thumbUrl: string | undefined, originalUrl: string | undefined): string | undefined {
  const thumb = useCachedMedia(thumbUrl);
  return thumbUrl === undefined || thumb.status === 'error' ? originalUrl : thumb.src;
}

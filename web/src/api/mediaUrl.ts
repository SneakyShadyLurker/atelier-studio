// Move authenticated media off URL keys issued with the former immutable
// policy. Keep this fixed across renders; current responses use no-store.
const MEDIA_CACHE_REVISION = '2';

export function mediaUrl(url: string): string {
  if (url.startsWith('data:') || url.startsWith('blob:')) return url;
  const hashIndex = url.indexOf('#');
  const hash = hashIndex < 0 ? '' : url.slice(hashIndex);
  const beforeHash = hashIndex < 0 ? url : url.slice(0, hashIndex);
  const queryIndex = beforeHash.indexOf('?');
  const path = queryIndex < 0 ? beforeHash : beforeHash.slice(0, queryIndex);
  const query = new URLSearchParams(queryIndex < 0 ? '' : beforeHash.slice(queryIndex + 1));
  query.set('media', MEDIA_CACHE_REVISION);
  return `${path}?${query}${hash}`;
}

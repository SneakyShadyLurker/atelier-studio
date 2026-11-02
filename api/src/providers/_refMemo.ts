// The orchestrator builds the refImages array once per batch (loadRefImages)
// and forwards the SAME reference to every tile's generate() call. Memoizing
// the expensive per-ref encode/downscale work on array identity collapses a
// count=N batch from N× to 1× without any cross-request cache. WeakMap is
// correct here: the memo lives in a request-scoped provider closure, so the
// refs array never outlives the entry it keys.
export function createRefMemo<K extends object, T>(): {
  get(key: K, compute: (key: K) => Promise<T>): Promise<T>;
} {
  const cache = new WeakMap<K, Promise<T>>();
  return {
    get(key, compute) {
      const hit = cache.get(key);
      if (hit) return hit;
      const computed = compute(key);
      cache.set(key, computed);
      // Defense-in-depth: evict on rejection so a *later* caller (e.g. a
      // sequential retry, or a future refactor that stops fanning siblings
      // out concurrently) gets a fresh compute() attempt instead of the
      // cached failure. Concurrent siblings in the SAME batch all hold the
      // same `computed` reference already — they share the rejection; this
      // does not help them. The .catch handler is a no-op observer; the
      // original awaiter still sees the rejection through its own await.
      computed.catch(() => {
        if (cache.get(key) === computed) cache.delete(key);
      });
      return computed;
    },
  };
}

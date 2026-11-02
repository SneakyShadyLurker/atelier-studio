import { useEffect, useState } from 'react';

// Trailing-edge debounce. NOT interchangeable with useDeferredValue: per
// React's docs the deferred value still produces a distinct value (and thus
// a distinct query key → a distinct fetch) per settled input, so it does
// NOT bound network requests. This hook does — it feeds the history query
// key so search-typing issues ONE /history request after input settles, not
// one per keystroke. The SSE-scope desync is handled structurally by the
// pinned write key (useGenerate) + the broad invalidate-on-settle, not here.
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => { setDebounced(value); }, delayMs);
    return () => { clearTimeout(id); };
  }, [value, delayMs]);
  return debounced;
}

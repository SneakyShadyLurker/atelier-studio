import { useEffect, useMemo, useRef } from 'react';

export interface AbortableMutation {
  /** Abort any in-flight request, install a fresh controller, and return its signal. */
  supersede: () => AbortSignal;
  /** Abort the current request with a named AbortError reason (e.g. 'reset'). */
  abort: (reason: string) => void;
  /** The current request's signal, if one is in flight. */
  readonly signal: AbortSignal | null;
}

// Owns an AbortController across a hook's lifetime for the streaming/LLM hooks
// (enhance, infer). Aborts on unmount, and supersede() aborts any prior
// in-flight request BEFORE installing the fresh controller so a superseding run
// can never strand an un-abortable controller. The returned object is stable
// across renders, so it is safe in useCallback dependency arrays.
export function useAbortableMutation(): AbortableMutation {
  const controllerRef = useRef<AbortController | null>(null);
  useEffect(() => () => {
    controllerRef.current?.abort(new DOMException('hook unmount', 'AbortError'));
  }, []);
  return useMemo<AbortableMutation>(() => ({
    supersede() {
      controllerRef.current?.abort(new DOMException('superseded', 'AbortError'));
      const controller = new AbortController();
      controllerRef.current = controller;
      return controller.signal;
    },
    abort(reason: string) {
      controllerRef.current?.abort(new DOMException(reason, 'AbortError'));
    },
    get signal() {
      return controllerRef.current?.signal ?? null;
    },
  }), []);
}

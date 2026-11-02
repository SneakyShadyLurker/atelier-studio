// Canonical abort helpers for the api (detection mirrors web/src/lib/abort.ts).
// An aborted fetch / AbortController rejects with a DOMException named
// 'AbortError'; some paths surface a plain Error with the same name. The
// `instanceof` gate is load-bearing — a bare `.name` check would also swallow
// unrelated errors that happen to be named 'AbortError'.
export function isAbortError(error: unknown): boolean {
  return (error instanceof DOMException || error instanceof Error) && error.name === 'AbortError';
}

// The error an aborted operation rejects with: the signal's own reason when it
// is an Error (identity preserved, so callers can match the exact reason),
// otherwise an AbortError DOMException carrying a string reason as its
// message, so `isAbortError` classifies every abort the same way.
export function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException(typeof reason === 'string' ? reason : 'aborted', 'AbortError');
}

// Resolves after `ms`, or rejects with `abortReason(signal)` as soon as the
// signal aborts (immediately when it already has). Detaches its listener on
// the timer path.
export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// Canonical abort-detection. An aborted fetch / AbortController rejects with a
// DOMException named 'AbortError'; some paths surface a plain Error with the
// same name. The `instanceof` gate is load-bearing — a bare `.name` check would
// also swallow unrelated errors that happen to be named 'AbortError'.
export function isAbortError(error: unknown): boolean {
  return (error instanceof DOMException || error instanceof Error) && error.name === 'AbortError';
}

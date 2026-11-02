export class TileTimeout extends Error {
  constructor() {
    super('timed out');
    this.name = 'TileTimeout';
  }
}

// Composes the per-tile timeout with the parent (batch / shutdown) signal via
// AbortSignal.any — no hand-rolled listener bookkeeping. The timeout branch
// aborts with a TileTimeout so the orchestrator can tell a timeout from a
// parent abort via `reason instanceof TileTimeout`; dispose() clears the
// pending timer when the tile settles first (the common case).
export function timeoutSignal(ms: number, parent: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  if (parent.aborted) {
    return { signal: parent, dispose: () => undefined };
  }
  const timeout = new AbortController();
  const timer = setTimeout(() => { timeout.abort(new TileTimeout()); }, ms);
  return {
    signal: AbortSignal.any([parent, timeout.signal]),
    dispose: () => {
      clearTimeout(timer);
    },
  };
}

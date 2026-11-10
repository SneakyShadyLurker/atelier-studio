/**
 * The feed asks the desktop Composer to yield the viewport (minimize) when the
 * reader scrolls it. The Composer owns every reason not to (pointer over it,
 * an owned popover, an upload, IME, a forced-open error), so the feed only
 * asks; the mounted Composer registers the handler that decides.
 */
type YieldHandler = () => void;

let handler: YieldHandler | null = null;

export function registerComposerYield(next: YieldHandler): () => void {
  handler = next;
  return () => {
    if (handler === next) handler = null;
  };
}

export function requestComposerYield(): void {
  handler?.();
}

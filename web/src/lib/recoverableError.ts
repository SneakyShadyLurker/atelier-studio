import type { ErrorInfo } from 'react';

/**
 * The root's onRecoverableError. A browser rejects a view transition it skips
 * (a hidden tab, a viewport resize) with an InvalidStateError; React finishes
 * the commit regardless but treats the rejection as benign only for the exact
 * messages it knows, and Chromium now words it "Transition was aborted because
 * of invalid state. Document hidden", so each skipped transition would surface
 * as an uncaught error. Everything else is reported as React does by default.
 */
export function reportRecoverableError(error: unknown, _info: ErrorInfo): void {
  if (isSkippedViewTransition(error)) return;
  reportError(error);
}

function isSkippedViewTransition(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'InvalidStateError' && /transition/i.test(error.message);
}

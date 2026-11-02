import type { AppView } from '../store/atelier';

/** Which way a view swap reads, for the stage's enter transition. */
export type ViewNavDirection = 'deeper' | 'back' | 'lateral';

/**
 * The Canvas family (the feed scopes) is the studio floor; Archive, the
 * Prompt library and Text models sit one level in. Exhaustive switch so a new
 * AppView kind forces an intentional decision.
 */
function isCanvasView(kind: AppView['kind']): boolean {
  switch (kind) {
    case 'unsorted':
    case 'pinned':
    case 'collection':
      return true;
    case 'archive':
    case 'prompts':
    case 'text-models':
      return false;
    default: {
      // Compile-time exhaustiveness: a new AppView kind fails to assign to never here.
      const _exhaustive: never = kind;
      return Boolean(_exhaustive);
    }
  }
}

/**
 * Canvas into a managed view goes deeper, a managed view back to Canvas goes
 * back, and everything else (a Canvas scope change, managed to managed) is
 * lateral.
 */
export function viewNavDirection(prev: AppView['kind'], next: AppView['kind']): ViewNavDirection {
  const fromCanvas = isCanvasView(prev);
  const toCanvas = isCanvasView(next);
  if (fromCanvas && !toCanvas) return 'deeper';
  if (!fromCanvas && toCanvas) return 'back';
  return 'lateral';
}

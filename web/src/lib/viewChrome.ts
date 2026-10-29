import type { AppView } from '../store/atelier';

/**
 * Management views (Archive, Prompt Library) do not generate images, so the
 * Composer is not rendered there — which also lets those views drop the
 * composer-dock padding reserve entirely. Exhaustive switch so a new AppView
 * kind forces an intentional decision instead of silently showing the Composer.
 */
export function shouldShowComposer(view: AppView): boolean {
  switch (view.kind) {
    case 'archive':
    case 'prompts':
      return false;
    case 'unsorted':
    case 'pinned':
    case 'collection':
      return true;
    default: {
      // Compile-time exhaustiveness: a new AppView kind fails to assign to never here.
      const _exhaustive: never = view;
      return Boolean(_exhaustive); // unreachable; predicate must return a value (no throw)
    }
  }
}

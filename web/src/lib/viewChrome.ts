import type { Collection } from '@atelier/shared';
import type { AppView } from '../store/atelier';

/**
 * Management views (Archive, Prompt Library, Text models) do not generate images, so the
 * Composer is not rendered there — which also lets those views drop the
 * composer-dock padding reserve entirely. Exhaustive switch so a new AppView
 * kind forces an intentional decision instead of silently showing the Composer.
 */
export function shouldShowComposer(view: AppView): boolean {
  switch (view.kind) {
    case 'archive':
    case 'prompts':
    case 'text-models':
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

function collectionName(collections: readonly Collection[], id: string): string | null {
  return collections.find((collection) => collection.id === id)?.name ?? null;
}

/**
 * The one scope title: the rail row's name for the view the content column
 * shows. Sidebar, Canvas and App's "Back to <scope>" labels all read it, so
 * the header, the rail and every Back button name the scope the same way.
 */
export function scopeTitle(view: AppView, collections: readonly Collection[]): string {
  switch (view.kind) {
    case 'unsorted':
      return 'Unsorted';
    case 'pinned':
      return 'Pinned';
    case 'collection':
      return collectionName(collections, view.id) ?? 'Collection';
    case 'archive': {
      const { scope } = view;
      if (scope.kind === 'all') return 'Archive';
      if (scope.kind === 'pinned') return 'Archive, pinned';
      if (scope.kind === 'unsorted') return 'Archive, unsorted';
      const name = collectionName(collections, scope.id);
      return name ? `Archive, ${name}` : 'Archive';
    }
    case 'prompts':
      return 'Prompt Library';
    case 'text-models':
      return 'Text models';
    default: {
      const _exhaustive: never = view;
      return String(_exhaustive);
    }
  }
}

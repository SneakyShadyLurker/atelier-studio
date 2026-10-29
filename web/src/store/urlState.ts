import { useEffect, useLayoutEffect } from 'react';
import {
  APP_VIEW_ARCHIVE,
  APP_VIEW_PINNED,
  APP_VIEW_PROMPTS,
  APP_VIEW_UNSORTED,
  appViewEquals,
  archiveCollectionView,
  archivePinnedView,
  archiveUnsortedView,
  collectionView,
  type AppView,
  useAtelierStore,
} from './atelier';
import { useCollections } from '../hooks/useCollections';
import { MAX_HISTORY_Q_LEN } from '@atelier/shared';

function normalizeQ(value: string | null): string {
  if (!value) return '';
  return value.slice(0, MAX_HISTORY_Q_LEN);
}

export function parseUrlState(params: URLSearchParams): { view: AppView; q: string } {
  const q = normalizeQ(params.get('q'));
  const view = params.get('view');
  const collectionId = params.get('c');
  if (view === 'archive') {
    if (collectionId) return { view: archiveCollectionView(collectionId), q };
    const archive = params.get('archive');
    if (archive === 'unsorted') return { view: archiveUnsortedView, q };
    if (archive === 'pinned') return { view: archivePinnedView, q };
    return { view: APP_VIEW_ARCHIVE, q };
  }
  if (collectionId) return { view: collectionView(collectionId), q };
  if (view === 'pinned') return { view: APP_VIEW_PINNED, q };
  if (view === 'prompts') return { view: APP_VIEW_PROMPTS, q };
  // ?view=history is a removed vestigial global feed — fall through to the
  // default Unsorted view rather than reviving an unscoped, no-UI variant.
  return { view: APP_VIEW_UNSORTED, q };
}

export function serializeUrlState(view: AppView, q: string): string {
  const params = new URLSearchParams();
  if (view.kind === 'archive') {
    params.set('view', 'archive');
    if (view.scope.kind === 'collection') params.set('c', view.scope.id);
    else if (view.scope.kind === 'unsorted') params.set('archive', 'unsorted');
    else if (view.scope.kind === 'pinned') params.set('archive', 'pinned');
  }
  if (view.kind === 'pinned') params.set('view', 'pinned');
  if (view.kind === 'prompts') params.set('view', 'prompts');
  if (view.kind === 'collection') params.set('c', view.id);
  const normalizedQ = normalizeQ(q).trim();
  if (normalizedQ) params.set('q', normalizedQ);
  const serialized = params.toString();
  return serialized ? `?${serialized}` : '';
}

function urlForState(view: AppView, q: string): string {
  const search = serializeUrlState(view, q);
  return `${window.location.pathname}${search}${window.location.hash}`;
}

function currentUrl(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

export function replaceUrlState(view: AppView, q: string): void {
  window.history.replaceState({}, '', urlForState(view, q));
  useAtelierStore.getState().navigate(view, normalizeQ(q));
}

function applyUrlToStore(): void {
  const next = parseUrlState(new URLSearchParams(window.location.search));
  replaceUrlState(next.view, next.q);
}

function viewCollectionId(view: AppView): string | null {
  if (view.kind === 'collection') return view.id;
  if (view.kind === 'archive' && view.scope.kind === 'collection') return view.scope.id;
  return null;
}

export function useUrlState(promptsGated = false): void {
  const view = useAtelierStore((state) => state.view);
  const referencedCollectionId = viewCollectionId(view);
  const collectionsQuery = useCollections({ enabled: referencedCollectionId !== null });
  const {
    data: collectionsData,
    isFetchedAfterMount,
    isSuccess: collectionsLoaded,
    refetch: refetchCollections,
  } = collectionsQuery;

  useLayoutEffect(() => {
    applyUrlToStore();

    const unsubscribe = useAtelierStore.subscribe((state, prevState) => {
      const viewChanged = !appViewEquals(state.view, prevState.view);
      if (!viewChanged && state.q === prevState.q) return;
      const url = urlForState(state.view, state.q);
      if (url === currentUrl()) return;
      // A view change is a navigation (back-able). A q-only change is
      // live-search filtering bound to the store per keystroke — collapse
      // it into the current history entry so Back isn't flooded one entry
      // per typed character (mirrors the orphan-recovery replaceState path).
      if (viewChanged) window.history.pushState({}, '', url);
      else window.history.replaceState({}, '', url);
    });

    const onPopState = () => {
      applyUrlToStore();
    };
    window.addEventListener('popstate', onPopState);
    return () => {
      unsubscribe();
      window.removeEventListener('popstate', onPopState);
    };
  }, []);

  useEffect(() => {
    if (view.kind === 'prompts' && promptsGated) replaceUrlState(APP_VIEW_UNSORTED, '');
  }, [promptsGated, view.kind]);

  useEffect(() => {
    if (referencedCollectionId === null || !collectionsLoaded) return;
    const exists = collectionsData.items.some((collection) => collection.id === referencedCollectionId);
    if (exists) return;
    if (!isFetchedAfterMount) {
      void refetchCollections();
      return;
    }
    // Orphan recovery: when the referenced collection no longer exists,
    // archive-collection routes fall back to archive-all (FK SET NULL has
    // already moved the batches to archive-unsorted, but archive-all is the
    // safer "home" landing). Non-archive collection routes fall back to
    // Unsorted, the global home view.
    const fallback: AppView = view.kind === 'archive' ? APP_VIEW_ARCHIVE : APP_VIEW_UNSORTED;
    replaceUrlState(fallback, '');
  }, [
    collectionsData,
    collectionsLoaded,
    isFetchedAfterMount,
    referencedCollectionId,
    refetchCollections,
    view,
  ]);
}

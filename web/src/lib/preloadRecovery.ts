import { useAtelierStore } from '../store/atelier';
import { sessionStorageOrUndefined, storageGet, storageSet } from './safeStorage';

// Vite emits `vite:preloadError` when a dynamic import() fails: usually version
// skew (a tab open across a redeploy holds an index.html whose content-hashed
// chunks the server has replaced), but also a dropped network or a blocking
// extension. A reload (fresh HTML, fresh chunk names) recovers the skew case.
// It also discards every in-memory draft, so it only happens on its own when
// there is nothing to lose; otherwise the failed lazy surface's scoped
// ErrorBoundary shows its fallback and a toast offers the reload instead.

const RELOAD_AT_KEY = 'atelier.preloadReloadAt';
// Timestamp guard so a failure that a reload cannot fix (offline, blocked)
// surfaces instead of looping.
const RELOAD_LOOP_GUARD_MS = 10_000;
const RELOAD_TOAST_MS = 15_000;

const unsavedWorkChecks = new Set<() => boolean>();
let reloadToastVisible = false;

/** Register an in-memory work owner (e.g. retained prompt-library drafts). */
export function registerUnsavedWork(check: () => boolean): () => void {
  unsavedWorkChecks.add(check);
  return () => { unsavedWorkChecks.delete(check); };
}

function composerHasUnsavedWork(): boolean {
  const { draft } = useAtelierStore.getState();
  return draft.prompt.trim().length > 0
    || draft.refImages.length > 0
    || draft.i2vSourceUploadId !== undefined
    || (draft.motionPrompt ?? '').trim().length > 0
    || (draft.storyOutline ?? '').trim().length > 0
    || (draft.brainstormBrief ?? '').trim().length > 0;
}

export function hasUnsavedWork(): boolean {
  if (composerHasUnsavedWork()) return true;
  for (const check of unsavedWorkChecks) {
    if (check()) return true;
  }
  return false;
}

/** The `vite:preloadError` listener; `reloadPage` is injectable for tests. */
export function createPreloadErrorHandler(reloadPage: () => void = () => { window.location.reload(); }): () => void {
  const reload = () => {
    storageSet(sessionStorageOrUndefined(), RELOAD_AT_KEY, String(Date.now()));
    reloadPage();
  };
  return () => {
    // No preventDefault: the import still rejects into its scoped ErrorBoundary.
    if (hasUnsavedWork()) {
      if (reloadToastVisible) return;
      reloadToastVisible = true;
      useAtelierStore.getState().addToast(
        'Part of Atelier couldn’t load. Reload to retry; unsaved drafts will be lost.',
        'error',
        RELOAD_TOAST_MS,
        { label: 'Reload', onClick: reload },
        () => { reloadToastVisible = false; },
      );
      return;
    }
    const last = Number(storageGet(sessionStorageOrUndefined(), RELOAD_AT_KEY) ?? 0);
    if (Date.now() - last < RELOAD_LOOP_GUARD_MS) return;
    reload();
  };
}

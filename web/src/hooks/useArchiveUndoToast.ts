import { useAtelierStore } from '../store/atelier';
import { useRestore } from './useRestore';

// Long enough to reach the action, like the composer Clear toast.
export const ARCHIVE_UNDO_TOAST_MS = 5000;

// The "Archived" toast for single-tile and batch archive. When the operation
// archived tiles (the server archives `done` tiles; failed ones are
// hard-deleted), the toast offers Undo, which hands exactly those IDs back to
// the existing restore path (HISTORY_WRITE_MUTATION_KEY, library refetch).
// Undo fires once: the toast closes and a repeat click is ignored.
export function useArchiveUndoToast() {
  const addToast = useAtelierStore((state) => state.addToast);
  const removeToast = useAtelierStore((state) => state.removeToast);
  const restore = useRestore();
  const restoreMutate = restore.mutate;

  return (text: string, archivedTileIds: readonly string[]): void => {
    if (archivedTileIds.length === 0) {
      addToast(text);
      return;
    }
    const tileIds = [...archivedTileIds];
    let undone = false;
    const toastId = addToast(text, 'success', ARCHIVE_UNDO_TOAST_MS, {
      label: 'Undo',
      onClick: () => {
        if (undone) return;
        undone = true;
        removeToast(toastId);
        restoreMutate(tileIds);
      },
    });
  };
}

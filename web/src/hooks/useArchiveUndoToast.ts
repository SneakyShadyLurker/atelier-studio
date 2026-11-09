import { focusWhenPresent } from '../lib/focusSuccessor';
import { useAtelierStore } from '../store/atelier';
import { useRestore } from './useRestore';

// Long enough to reach the action, like the composer Clear toast.
export const ARCHIVE_UNDO_TOAST_MS = 5000;

// The "Archived" toast for single-tile and batch archive. When the operation
// archived tiles (the server archives `done` tiles; failed ones are
// hard-deleted), the toast offers Undo, which hands exactly those IDs back to
// the existing restore path (HISTORY_WRITE_MUTATION_KEY, library refetch).
// Undo fires once: the toast fades out (dismissToast) and a repeat click is
// ignored.
export function useArchiveUndoToast() {
  const addToast = useAtelierStore((state) => state.addToast);
  const dismissToast = useAtelierStore((state) => state.dismissToast);
  const restore = useRestore();
  const restoreMutateAsync = restore.mutateAsync;

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
        dismissToast(toastId);
        // The toast takes the keyboard with it; once the restore's re-read
        // lands, the restored tile is where the user was working.
        const [first] = tileIds;
        void restoreMutateAsync(tileIds).then(
          () => { if (first) focusWhenPresent(`[data-feed-tile="${first}"]`); },
          () => undefined,
        );
      },
    });
  };
}

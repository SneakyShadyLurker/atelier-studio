import { useEffect } from 'react';
import { isImeComposing } from '../lib/ime';

export function useNestedDialogEscape(open: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      // Escape during IME composition dismisses the candidate window, not us.
      if (event.key !== 'Escape' || isImeComposing(event)) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', handler, true);
    return () => { document.removeEventListener('keydown', handler, true); };
  }, [open, onClose]);
}

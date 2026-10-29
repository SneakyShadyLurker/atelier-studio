import { useEffect, useRef, useState } from 'react';
import { overlayExitDurationMs } from '../lib/overlayDuration';

/* Exit choreography for overlays that unmount via parent state (dialogs,
   popovers, the Lightbox). Enter animations live in CSS and play on mount;
   exits need a beat between "user closed" and "React unmounted" for the
   reverse animation to play. `requestClose()` flips `closing` (the component
   stamps it as data-closing for CSS), then fires the real close after the
   exit duration. Idempotent — repeat calls (Esc mashing, backdrop double
   click) don't stack timers or re-fire the close. `cancelClose()` aborts a
   pending exit (e.g. re-toggling a chip menu mid-fade). */

/* `open` matters for consumers that stay mounted and toggle the dialog via a
   prop (ConfirmDialog, CoverageCard): a reopen must start from closing=false
   or the fresh dialog would mount mid-exit. Always-mounted-while-open
   consumers (Lightbox et al.) omit it. */
export function useExitTransition(onClose: () => void, open = true): {
  closing: boolean;
  requestClose: () => void;
  cancelClose: () => void;
} {
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  // Latest-callback ref so requestClose stays referentially stable while the
  // eventual close still sees fresh parent state.
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; });

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  // Reopen reset, split to satisfy react-hooks v7: state adjusts during
  // render (adjust-state-during-render pattern — refs are off-limits here),
  // while the pending timer/ref cleanup runs in the paired effect below.
  const [prevOpen, setPrevOpen] = useState(open);
  if (prevOpen !== open) {
    setPrevOpen(open);
    if (open && closing) setClosing(false);
  }

  // Any open-prop transition cancels a pending exit: a reopen must not close
  // the fresh dialog, and an external close (e.g. instant Confirm while an
  // Escape-armed exit is pending) must not double-fire onClose ~160ms later.
  // The normal exit path is unaffected — requestClose never changes `open`.
  useEffect(() => {
    closingRef.current = false;
    clearTimer();
  }, [open]);

  useEffect(() => () => { clearTimer(); }, []);

  const cancelClose = () => {
    if (!closingRef.current) return;
    closingRef.current = false;
    setClosing(false);
    clearTimer();
  };

  const requestClose = () => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      closingRef.current = false;
      // Reset state too — consumers that stay mounted after the close (chip
      // menus, prop-toggled dialogs) must not be stuck in closing=true.
      setClosing(false);
      closeRef.current();
    }, overlayExitDurationMs());
  };

  return { closing, requestClose, cancelClose };
}

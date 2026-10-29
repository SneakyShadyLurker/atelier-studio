import { useLayoutEffect, useRef } from 'react';
import type { RefObject, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useModalChrome } from '../../hooks/useModalChrome';
import { runWhenReachable } from '../../lib/focus';
import styles from '../../styles/dialog.module.css';

interface DialogShellProps {
  open: boolean;
  onCancel: () => void;
  closeOnBackdrop?: boolean;
  busy?: boolean;
  labelledBy?: string;
  describedBy?: string;
  label?: string;
  /**
   * REPLACES the shared backdrop class — it does not merge with it. A caller
   * that passes a local class purely to tweak layout silently loses
   * `position: fixed`, the z-index, the scrim and the mobile-sheet behaviour,
   * and the dialog renders in normal flow at the bottom of <body>, invisible
   * behind the page. Pass this ONLY to supply a complete replacement backdrop
   * (Lightbox does); for layout tweaks, override the `.dialog` card instead.
   */
  backdropClassName?: string | undefined;
  portalRef?: RefObject<HTMLDialogElement | null>;
  roleOnBackdrop?: boolean;
  // Exit choreography (useExitTransition): stamps data-closing on the
  // backdrop so the shared exit animations play, and freezes backdrop
  // dismissal during the leave.
  closing?: boolean;
  children: ReactNode;
}

export function DialogShell({
  open,
  onCancel,
  closeOnBackdrop = true,
  busy = false,
  labelledBy,
  describedBy,
  label,
  backdropClassName = styles.backdrop,
  portalRef: externalPortalRef,
  roleOnBackdrop = true,
  closing = false,
  children,
}: DialogShellProps) {
  const internalPortalRef = useRef<HTMLDialogElement | null>(null);
  const portalRef = externalPortalRef ?? internalPortalRef;
  // Require the pointer to both press AND release on the backdrop. Otherwise a
  // drag-selection started inside an input that releases over the backdrop (or
  // a press on the backdrop edge that drags inward) would dismiss the dialog
  // and discard an unsaved draft.
  const downOnBackdrop = useRef(false);
  // `nativeModal`: showModal() below puts the dialog in the top layer, which
  // inerts everything outside it — so useModalChrome must not run its own
  // inert/aria-hidden sweep over the body's children as well.
  useModalChrome({ open, onCancel, portalRef, nativeModal: true });

  // Promote to a REAL modal. This is where Tab containment, background
  // inerting and top-layer stacking come from — the platform's, not ours, so
  // no dialog can ship without them. React owns `open`, so the element is only
  // ever opened here and closed by unmounting.
  useLayoutEffect(() => {
    if (!open) return undefined;
    const element = portalRef.current;
    // Capture the opener HERE, immediately before showModal moves focus into
    // the dialog — this is the only point at which it is provably still
    // focused. useModalChrome cannot do it (hence `nativeModal`): it runs as a
    // passive effect, i.e. after this layout effect, by which time the dialog
    // already holds focus and it would capture a control inside the dialog.
    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null;
    if (element && !element.open) element.showModal();
    return () => {
      // close() rather than a bare unmount so the element leaves the top layer
      // through the platform's own path; the restore is ours because the
      // platform's does not survive React removing the node in the same commit.
      if (element?.open) element.close();
      if (opener) runWhenReachable(() => { opener.focus(); }, opener);
    };
  }, [open, portalRef]);

  if (!open) return null;
  return createPortal(
    <dialog
      ref={portalRef}
      className={backdropClassName}
      data-closing={closing ? 'true' : undefined}
      // Escape routing stays ours: the app deliberately runs three Escape
      // mechanisms keyed by nesting depth (useModalChrome / useNestedDialogEscape
      // / useKeyboardScoped), and letting the platform close the top-most dialog
      // unilaterally would shut an outer dialog when the user meant to dismiss a
      // popover inside it. Cancel the native close-request; useModalChrome's
      // listener decides.
      onCancel={(event) => { event.preventDefault(); }}
      onMouseDown={(event) => {
        // Capture eligibility at gesture START — a press while busy must not
        // dismiss even if the async op finishes (busy → false) before mouseup.
        downOnBackdrop.current = closeOnBackdrop && !busy && !closing && event.target === event.currentTarget;
      }}
      onMouseUp={(event) => {
        const eligible = downOnBackdrop.current;
        downOnBackdrop.current = false;
        if (eligible && event.target === event.currentTarget) onCancel();
      }}
      role={roleOnBackdrop ? 'dialog' : undefined}
      aria-modal={roleOnBackdrop ? 'true' : undefined}
      aria-labelledby={roleOnBackdrop ? labelledBy : undefined}
      aria-describedby={roleOnBackdrop ? describedBy : undefined}
      aria-label={roleOnBackdrop ? label : undefined}
    >
      {children}
    </dialog>,
    document.body,
  );
}

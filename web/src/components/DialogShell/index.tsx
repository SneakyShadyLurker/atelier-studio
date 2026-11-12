import { useLayoutEffect, useRef } from 'react';
import type { RefObject, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useModalChrome } from '../../hooks/useModalChrome';
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
  /**
   * Where focus goes when the dialog closes. Called once per open with the
   * opener, while the page still holds it, so the owner can record what it
   * needs from the DOM; the resolver it returns runs after a real close (never
   * after a re-run of the open effect) and names the target, or null for none.
   * Default: the opener, when it is still connected and not inert.
   */
  restoreFocus?: ((opener: HTMLElement) => () => HTMLElement | null) | undefined;
  children: ReactNode;
}

/** Connected and outside every inert subtree: focus() would land. */
export function focusReachable(target: HTMLElement | null | undefined): target is HTMLElement {
  return target !== null && target !== undefined && target.isConnected && target.closest('[inert]') === null;
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
  restoreFocus,
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
  const bindToastHost = useModalChrome({ open, onCancel, portalRef, nativeModal: true });

  // Promote to a REAL modal. This is where Tab containment, background
  // inerting and top-layer stacking come from — the platform's, not ours, so
  // no dialog can ship without them. React owns `open`, so the element is only
  // ever opened here and closed by unmounting.
  const openerRef = useRef<HTMLElement | null>(null);
  const resolveRef = useRef<(() => HTMLElement | null) | null>(null);
  const restoreFocusRef = useRef(restoreFocus);
  useLayoutEffect(() => { restoreFocusRef.current = restoreFocus; });
  useLayoutEffect(() => {
    if (!open) return undefined;
    const element = portalRef.current;
    // Capture the opener HERE, immediately before showModal moves focus into
    // the dialog — this is the only point at which it is provably still
    // focused. useModalChrome cannot do it (hence `nativeModal`): it runs as a
    // passive effect, i.e. after this layout effect, by which time the dialog
    // already holds focus and it would capture a control inside the dialog.
    // React may run this effect again while the dialog stays open (StrictMode's
    // simulated remount, an Activity reveal): focus is then already inside the
    // dialog, so the opener captured by the first run stands.
    const active = document.activeElement;
    if (!(element && active instanceof Node && element.contains(active))) {
      const opener = active instanceof HTMLElement && active !== document.body ? active : null;
      openerRef.current = opener;
      resolveRef.current = opener
        ? restoreFocusRef.current?.(opener) ?? (() => (focusReachable(opener) ? opener : null))
        : null;
    }
    if (element && !element.open) {
      // The snapshot tree paints above the top layer. Excluding background
      // names in motion.css prevents future captures; end the existing one
      // before the modal paints as well. Wait for ready: skipping preparation
      // rejects ready with AbortError, which React reports as recoverable.
      // Typed optional: the DOM lib declares the property, older engines and
      // the unit-test DOM lack it (and the latter getAnimations as well).
      const active: { readonly activeViewTransition?: ViewTransition | null } = document;
      if ('activeViewTransition' in active) {
        const transition = active.activeViewTransition;
        if (transition) void transition.ready.then(() => { transition.skipTransition(); }, () => undefined);
      } else if (typeof document.getAnimations === 'function') {
        // Older engines expose the running pseudo animations, but not the
        // active transition. Finishing those ends its paint without rejecting
        // React's ready promise or touching ordinary element animations.
        for (const animation of document.getAnimations()) {
          const effect = animation.effect as KeyframeEffect | null;
          if (effect?.pseudoElement?.startsWith('::view-transition')) animation.finish();
        }
      }
      element.showModal();
    }
    return () => {
      // close() rather than a bare unmount so the element leaves the top layer
      // through the platform's own path; the restore is ours because the
      // platform's does not survive React removing the node in the same commit.
      if (element?.open) element.close();
      const opener = openerRef.current;
      const resolve = resolveRef.current;
      // A microtask: the close commit lifts the background's inert first.
      queueMicrotask(() => {
        // Re-shown by a re-run of this effect: the dialog keeps focus.
        if (element?.isConnected && element.open) return;
        // The owner already handed focus on (a removal's successor).
        const current = document.activeElement;
        if (current instanceof HTMLElement && current !== document.body && !element?.contains(current)) return;
        const target = resolve?.() ?? null;
        if (!focusReachable(target)) return;
        target.focus(target === opener ? undefined : { preventScroll: true });
      });
    };
  }, [open, portalRef]);

  if (!open) return null;
  return createPortal(
    <dialog
      ref={bindToastHost}
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

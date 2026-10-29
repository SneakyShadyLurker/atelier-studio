import type { RefObject } from 'react';
import { useEffect, useEffectEvent, useRef } from 'react';
import { runWhenReachable } from '../lib/focus';
import { isImeComposing } from '../lib/ime';
import { registerToastHost, type ToastHost, type ToastHostRegistration } from '../lib/toastHost';

interface ModalChromeOptions {
  open: boolean;
  onCancel: () => void;
  portalRef?: RefObject<HTMLElement | null>;
  /**
   * The panel global toasts render INTO while this overlay is open. Pass it
   * when a custom focus trap owns a panel inside `portalRef`: a toast in the
   * outer portal root would be visible but outside the trap, so its Undo could
   * never be reached by keyboard. Defaults to `portalRef`, which for a native
   * modal is the showModal() element itself.
   */
  toastHostRef?: RefObject<HTMLElement | null>;
  /**
   * Identity of the element behind `toastHostRef`. Pass the responsive mode
   * when the owner's JSX replaces the panel node while open (popover ⇄ sheet):
   * a change rebinds the toast host to the current node without re-running
   * the inert sweep or focus capture.
   */
  containerKey?: unknown;
  deferRestore?: boolean;
  /**
   * The overlay is a real `<dialog>` opened with `showModal()`. Two jobs then
   * belong to the platform, not here:
   *   - background inerting (the top layer does it), so skip the manual sweep
   *     over the body's children;
   *   - focus restore, which `close()` performs against the element that was
   *     focused when `showModal()` ran. Ours cannot compete: showModal fires in
   *     a LAYOUT effect, so by the time this passive effect reads
   *     `document.activeElement` the dialog has already taken focus and we
   *     would capture a control inside it instead of the opener.
   * Popovers and drawers are ordinary portalled elements, not in the top layer,
   * and still need both.
   */
  nativeModal?: boolean;
}

function inertAncestor(el: HTMLElement): HTMLElement | null {
  let current: HTMLElement | null = el;
  while (current) {
    if (current.hasAttribute('inert')) return current;
    current = current.parentElement;
  }
  return null;
}

function restoreFocus(target: HTMLElement, defer: boolean): void {
  const focus = () => {
    if (!target.isConnected) return;
    if (inertAncestor(target)) return;
    target.focus();
  };
  if (defer) {
    runWhenReachable(focus, target);
  } else {
    focus();
  }
}

function protectedBodyChild(portalRoot: HTMLElement | null): HTMLElement | null {
  if (!portalRoot) return null;
  const parent = portalRoot.parentElement;
  const protectedRoot = parent && parent !== document.body ? parent : portalRoot;
  return Array.from(document.body.children).find((child): child is HTMLElement =>
    child instanceof HTMLElement && (child === protectedRoot || child.contains(protectedRoot))
  ) ?? null;
}

function isBodyPortalRoot(portalRoot: HTMLElement | null): boolean {
  if (!portalRoot) return false;
  return portalRoot.parentElement === document.body || portalRoot.parentElement?.parentElement === document.body;
}

function resolveToastHost(
  toastHostRef: RefObject<HTMLElement | null> | undefined,
  portalRef: RefObject<HTMLElement | null> | undefined,
): ToastHost | null {
  const panel = toastHostRef?.current ?? null;
  if (panel) return { element: panel, placement: 'contained' };
  const portal = portalRef?.current ?? null;
  return portal ? { element: portal, placement: 'viewport' } : null;
}

interface ModalToastHostOptions {
  active: boolean;
  toastHostRef?: RefObject<HTMLElement | null> | undefined;
  portalRef?: RefObject<HTMLElement | null> | undefined;
  containerKey?: unknown;
}

/**
 * Feedback raised while an overlay is open must stay inside it: the app root
 * (the toast's default home) is then inert/aria-hidden or behind the top
 * layer. Registered once per open, so its place in the host stack is fixed;
 * a `containerKey` change re-points that same entry at the current node.
 * Released on close, restoring whichever host was below. Exported for nested
 * custom-trap panels that do not run the full modal chrome (AxisDropdown).
 */
export function useModalToastHost({ active, toastHostRef, portalRef, containerKey }: ModalToastHostOptions): void {
  const registrationRef = useRef<ToastHostRegistration | null>(null);

  useEffect(() => {
    if (!active) return;
    const host = resolveToastHost(toastHostRef, portalRef);
    if (!host) return;
    const registration = registerToastHost(host);
    registrationRef.current = registration;
    return () => {
      registration.release();
      if (registrationRef.current === registration) registrationRef.current = null;
    };
  }, [active, portalRef, toastHostRef]);

  useEffect(() => {
    if (!active) return;
    const host = resolveToastHost(toastHostRef, portalRef);
    if (host) registrationRef.current?.update(host);
  }, [active, containerKey, portalRef, toastHostRef]);
}

export function useModalChrome({
  open,
  onCancel,
  portalRef,
  toastHostRef,
  containerKey,
  deferRestore = true,
  nativeModal = false,
}: ModalChromeOptions): void {
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  useModalToastHost({ active: open, toastHostRef, portalRef, containerKey });
  // Effect Event: the Escape listener must see the CURRENT onCancel without
  // making the chrome effect reactive to it — a consumer passing an inline
  // arrow would otherwise re-run the whole inert/aria-hidden sweep on every
  // one of its renders.
  const cancel = useEffectEvent(() => { onCancel(); });

  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    restoreFocusRef.current = !nativeModal && active instanceof HTMLElement && active !== document.body ? active : null;

    const portalRoot = portalRef?.current ?? null;
    const protectedChild = !nativeModal && isBodyPortalRoot(portalRoot) ? protectedBodyChild(portalRoot) : null;
    const touched: { element: HTMLElement; hadAriaHidden: boolean; ariaHiddenValue: string | null; hadInert: boolean }[] = [];

    if (protectedChild) {
      for (const child of Array.from(document.body.children)) {
        if (!(child instanceof HTMLElement)) continue;
        if (child === protectedChild) continue;
        const hadInert = child.hasAttribute('inert');
        const hadAriaHidden = child.hasAttribute('aria-hidden');
        const ariaHiddenValue = child.getAttribute('aria-hidden');
        child.setAttribute('inert', '');
        child.setAttribute('aria-hidden', 'true');
        touched.push({ element: child, hadAriaHidden, ariaHiddenValue, hadInert });
      }
    }

    const onKeyDown = (event: KeyboardEvent) => {
      // Escape during IME composition dismisses the candidate window, not us.
      if (event.defaultPrevented || event.key !== 'Escape' || isImeComposing(event)) return;
      const root = portalRef?.current ?? null;
      const target = event.target;
      const active = document.activeElement;
      const targetInside = root && (
        (target instanceof Node && root.contains(target))
        || (target === document && active instanceof Node && root.contains(active))
      );
      const focusOnBody = document.activeElement === document.body;
      if (!targetInside && !focusOnBody) return;
      event.preventDefault();
      cancel();
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      for (const { element, hadAriaHidden, ariaHiddenValue, hadInert } of touched) {
        if (!hadInert) element.removeAttribute('inert');
        if (hadAriaHidden) {
          if (ariaHiddenValue === null) element.removeAttribute('aria-hidden');
          else element.setAttribute('aria-hidden', ariaHiddenValue);
        } else {
          element.removeAttribute('aria-hidden');
        }
      }
      const target = restoreFocusRef.current;
      if (target) restoreFocus(target, deferRestore);
    };
  }, [deferRestore, nativeModal, open, portalRef]);
}

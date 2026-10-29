// Where the single global <Toast /> renders. By default it sits in the app
// root — which an open modal makes unreachable: native showModal() puts
// everything outside the top layer behind it, and useModalChrome inerts and
// aria-hides the root for portalled panels. While a modal is open its chrome
// registers the element that keeps feedback inside the modal, so an actionable
// toast (queue-clear Undo) stays visible, announced and keyboard-reachable.
//
// A stack, not a slot: nested modals push on open and pop on close, so closing
// the inner one hands the toast back to the outer one; an empty stack means the
// default app-root placement.

export type ToastHostPlacement =
  // The host spans the viewport (a native <dialog> backdrop, a portal root):
  // keep the default fixed, composer-anchored position.
  | 'viewport'
  // The host is the panel itself (custom focus trap): position inside it.
  | 'contained';

export interface ToastHost {
  readonly element: HTMLElement;
  readonly placement: ToastHostPlacement;
}

interface ToastHostEntry {
  readonly token: symbol;
  readonly host: ToastHost;
}

const stack: ToastHostEntry[] = [];
const listeners = new Set<() => void>();
let current: ToastHost | null = null;

function publish(): void {
  const next = stack.at(-1)?.host ?? null;
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

export interface ToastHostRegistration {
  /**
   * Re-points this entry at a new element IN PLACE. An owner whose responsive
   * JSX swaps its panel node while open rebinds here; releasing and pushing
   * again would jump it above a nested modal opened after it.
   */
  readonly update: (host: ToastHost) => void;
  /** Idempotent. */
  readonly release: () => void;
}

/** Registers `host` as the topmost toast host. */
export function registerToastHost(host: ToastHost): ToastHostRegistration {
  const token = Symbol('toast-host');
  stack.push({ token, host });
  publish();
  return {
    update: (next) => {
      const index = stack.findIndex((entry) => entry.token === token);
      const entry = stack[index];
      if (!entry || (entry.host.element === next.element && entry.host.placement === next.placement)) return;
      stack[index] = { token, host: next };
      publish();
    },
    release: () => {
      const index = stack.findIndex((entry) => entry.token === token);
      if (index < 0) return;
      stack.splice(index, 1);
      publish();
    },
  };
}

export function subscribeToastHost(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getToastHost(): ToastHost | null {
  return current;
}

export function getServerToastHost(): ToastHost | null {
  return null;
}

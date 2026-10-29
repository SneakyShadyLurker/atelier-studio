import { type ToastMessage, useAtelierStore } from '../../store/atelier';
import { getServerToastHost, getToastHost, subscribeToastHost } from '../../lib/toastHost';
import { I } from '../icons/I';
import { memo, useEffect, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import styles from './index.module.css';

function renderToast(
  message: ToastMessage,
  pause: (id: string) => void,
  resume: (id: string) => void,
) {
  const tone = message.tone ?? 'success';
  const isError = tone === 'error';
  const toneClass =
    tone === 'error'
      ? styles.toastError
      : tone === 'soft'
        ? styles.toastSoft
        : '';
  const className = [styles.toast, toneClass, message.leaving ? styles.leaving : '']
    .concat(message.action ? styles.toastActionable : '')
    .filter(Boolean)
    .join(' ');
  // WCAG 2.2.1: actionable toasts pause their auto-dismiss while hovered or
  // focused so the action (e.g. Undo) can't expire under the pointer.
  const pauseHandlers = message.action
    ? {
        onPointerEnter: () => { pause(message.id); },
        onPointerLeave: () => { resume(message.id); },
        onFocus: () => { pause(message.id); },
        onBlur: () => { resume(message.id); },
      }
    : {};
  return (
    // Actionable toasts are excluded from the shared live regions (they'd
    // double-announce), so the visible toast IS their announcement path — give
    // it its own status role. Non-actionable toasts stay aria-hidden here and
    // announce via the shared polite/assertive live regions.
    <div
      key={message.id}
      className={className}
      role={message.action ? 'status' : undefined}
      aria-hidden={message.action ? undefined : 'true'}
      {...pauseHandlers}
    >
      {isError ? <I.alert /> : <I.check />}
      <span>{message.text}</span>
      {message.action ? (
        <button type="button" tabIndex={0} className={styles.action} onClick={message.action.onClick}>
          {message.action.label}
        </button>
      ) : null}
    </div>
  );
}

interface ToastLiveRegionProps {
  messages: readonly ToastMessage[];
  role: 'alert' | 'status';
  live: 'assertive' | 'polite';
}

function sameLiveMessages(prev: ToastLiveRegionProps, next: ToastLiveRegionProps): boolean {
  if (prev.role !== next.role || prev.live !== next.live || prev.messages.length !== next.messages.length) return false;
  return prev.messages.every((message, index) => {
    const nextMessage = next.messages[index];
    return nextMessage?.id === message.id
      && nextMessage.text === message.text
      && (nextMessage.tone ?? 'success') === (message.tone ?? 'success');
  });
}

const ToastLiveRegion = memo(function ToastLiveRegion({ messages, role, live }: ToastLiveRegionProps) {
  return (
    <div className="srOnly" role={role} aria-live={live} aria-atomic="false">
      {messages.map((message) => <span key={message.id}>{message.text}</span>)}
    </div>
  );
}, sameLiveMessages);

export default function Toast() {
  // Subscribe to the store HERE, not in App. The two-phase auto-dismiss
  // timer fires `set` twice per toast; if App selected `toasts` every one of
  // those re-rendered the whole shell. As a leaf, Toast's own re-render is
  // cheap and cascades nowhere.
  const messages = useAtelierStore((state) => state.toasts);
  const pauseToast = useAtelierStore((state) => state.pauseToast);
  const resumeToast = useAtelierStore((state) => state.resumeToast);
  // Two stacked live regions so error and non-error toasts can coexist
  // without screen readers announcing success/soft as `assertive`. NVDA in
  // particular re-announces aria-atomic regions on any child change — a
  // single escalated region would speak the whole mixed list each time a
  // message dismissed. Splitting by tone keeps each region's announcement
  // discipline correct.
  // Actionable toasts are NOT aria-hidden in the visible stack (they carry a
  // reachable action button), so the live region would double-announce them.
  // Exclude them here — the visible toast IS their announcement path.
  const errorMessages = messages.filter((m) => !m.action && (m.tone ?? 'success') === 'error');
  const statusMessages = messages.filter((m) => !m.action && (m.tone ?? 'success') !== 'error');
  // One stack, one set of live regions, wherever it lives: while a modal is
  // open the stack portals into that modal's registered host (see
  // lib/toastHost) instead of the app root it has made unreachable.
  const host = useSyncExternalStore(subscribeToastHost, getToastHost, getServerToastHost);
  const activeHost = host?.element.isConnected ? host : null;
  // Moving hosts remounts the stack, and a removed node never receives the
  // pointerleave/blur that would resume a paused toast — resume on the move so
  // a hovered or focused Undo cannot pin its toast forever.
  useEffect(() => () => {
    for (const message of useAtelierStore.getState().toasts) {
      if (message.action) resumeToast(message.id);
    }
  }, [host, resumeToast]);
  const stack = (
    <div className={styles.stack} data-toast-host={activeHost?.placement}>
      <ToastLiveRegion messages={errorMessages} role="alert" live="assertive" />
      <ToastLiveRegion messages={statusMessages} role="status" live="polite" />
      {messages.map((message) => renderToast(message, pauseToast, resumeToast))}
    </div>
  );
  return activeHost ? createPortal(stack, activeHost.element) : stack;
}

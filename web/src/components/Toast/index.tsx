import { type ToastMessage, useAtelierStore } from '../../store/atelier';
import { getToastHost, subscribeToastHost } from '../../lib/toastHost';
import { I } from '../icons/I';
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
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
      data-closing={message.leaving ? 'true' : undefined}
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

function moveStack(stack: HTMLElement, destination: HTMLElement): void {
  if (stack.parentElement === destination) return;
  const focused = stack.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
  // moveBefore preserves native animation and focus state. Older engines need
  // appendChild; retain their CSS animation timelines across that DOM move.
  if (typeof destination.moveBefore === 'function' && stack.isConnected && destination.isConnected) {
    destination.moveBefore(stack, null);
  } else {
    const animations = (typeof stack.getAnimations === 'function' ? stack.getAnimations({ subtree: true }) : []).flatMap((animation) => {
      const target = (animation.effect as KeyframeEffect | null)?.target;
      return target instanceof Element && 'animationName' in animation
        ? [{ target, name: (animation as CSSAnimation).animationName, time: animation.currentTime, rate: animation.playbackRate, paused: animation.playState === 'paused' }]
        : [];
    });
    destination.appendChild(stack);
    for (const saved of animations) {
      const current = saved.target.getAnimations().find((animation) => 'animationName' in animation && (animation as CSSAnimation).animationName === saved.name);
      if (!current) continue;
      current.playbackRate = saved.rate;
      current.currentTime = saved.time;
      if (saved.paused) current.pause();
    }
  }
  if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
}

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
  const homeRef = useRef<HTMLDivElement | null>(null);
  const [mount] = useState(() => {
    const element = document.createElement('div');
    if (styles.stack) element.className = styles.stack;
    return element;
  });
  useLayoutEffect(() => {
    const relocate = () => {
      const host = getToastHost();
      const activeHost = host?.element.isConnected ? host : null;
      const destination = activeHost?.element ?? homeRef.current;
      if (!destination) return;
      if (activeHost) mount.setAttribute('data-toast-host', activeHost.placement);
      else mount.removeAttribute('data-toast-host');
      moveStack(mount, destination);
      // A removed host may never dispatch pointerleave or blur. Resume only
      // actions no longer held by hover/focus; moving a focused Undo keeps pause.
      for (const message of useAtelierStore.getState().toasts) {
        if (message.action && !mount.matches(':hover') && !mount.contains(document.activeElement)) resumeToast(message.id);
      }
    };
    // Registry cleanup publishes synchronously before a modal's DOM leaves.
    // Relocating here preserves the native timeline instead of waiting for a
    // React host-dependent portal render after the old host is disconnected.
    const unsubscribe = subscribeToastHost(relocate);
    relocate();
    return unsubscribe;
  }, [mount, resumeToast]);
  useEffect(() => () => {
    mount.remove();
    for (const message of useAtelierStore.getState().toasts) {
      if (message.action) resumeToast(message.id);
    }
  }, [mount, resumeToast]);
  const stack = (
    <>
      <ToastLiveRegion messages={errorMessages} role="alert" live="assertive" />
      <ToastLiveRegion messages={statusMessages} role="status" live="polite" />
      {messages.map((message) => renderToast(message, pauseToast, resumeToast))}
    </>
  );
  return <><div ref={homeRef} style={{ display: 'contents' }} />{createPortal(stack, mount)}</>;
}

import { useIsPhone } from '../../hooks/useIsPhone';
import { type ToastMessage, type ToastPauseReason, useAtelierStore } from '../../store/atelier';
import { getToastHost, subscribeToastHost } from '../../lib/toastHost';
import { I } from '../icons/I';
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import styles from './index.module.css';

function renderToast(
  message: ToastMessage,
  pause: (id: string, reason: ToastPauseReason) => void,
  resume: (id: string, reason: ToastPauseReason) => void,
  covered: boolean,
  mirrored: boolean,
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
        onPointerEnter: () => { pause(message.id, 'hover'); },
        onPointerLeave: () => { resume(message.id, 'hover'); },
        onFocus: () => { pause(message.id, 'focus'); },
        onBlur: () => { resume(message.id, 'focus'); },
      }
    : {};
  return (
    // Actionable toasts are excluded from the shared live regions (they'd
    // double-announce), so the visible toast IS their announcement path — give
    // it its own status role. Non-actionable toasts stay aria-hidden here and
    // announce via the shared polite/assertive live regions. An actionable
    // toast raised under the phone drawer is announced through the polite region
    // instead (mirrored), so its visible copy carries no second status role.
    <div
      key={message.id}
      className={className}
      data-closing={message.leaving ? 'true' : undefined}
      role={message.action && !mirrored ? 'status' : undefined}
      // Covered by the phone drawer: the visible toast leaves the tab order
      // and the tree; the stack's live regions (siblings) stay exposed.
      aria-hidden={covered || !message.action ? 'true' : undefined}
      inert={covered || undefined}
      {...pauseHandlers}
    >
      {isError ? <I.alert /> : tone === 'soft' ? null : <I.check />}
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
  // Exclude them here — the visible toast IS their announcement path (except
  // those mirrored while the phone drawer covers the stack, below).
  const errorMessages = messages.filter((m) => !m.action && (m.tone ?? 'success') === 'error');
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
      // A removed host may never dispatch pointerleave or blur. Release the
      // hover and focus holds that no longer apply; moving a focused Undo
      // keeps its pause, and a drawer cover is released only on close.
      for (const message of useAtelierStore.getState().toasts) {
        if (!message.action) continue;
        if (!mount.matches(':hover')) resumeToast(message.id, 'hover');
        if (!mount.contains(document.activeElement)) resumeToast(message.id, 'focus');
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
      if (!message.action) continue;
      resumeToast(message.id, 'hover');
      resumeToast(message.id, 'focus');
    }
  }, [mount, resumeToast]);
  // The phone drawer covers the stack (its z-index sits under the toast's, so
  // an Undo would block the drawer's rows). While it is open the stack hides,
  // leaves the pointer and the accessibility tree, and every actionable toast
  // on it, present or added, holds its timer; closing the drawer restores the
  // stack with the time each toast had left. Focus is not moved here: the
  // drawer's own choreography (useSidebarFocusChoreography) takes it.
  const sidebarOpen = useAtelierStore((state) => state.sidebarOpen);
  const isPhone = useIsPhone();
  const covered = sidebarOpen && isPhone;
  // An actionable toast raised while covered is aria-hidden like the rest of
  // the covered stack, so its own status role would never speak. Mirror it
  // into the polite live region instead, and keep it there (not the visible
  // toast's role) after the drawer closes so it is announced once. Toasts on
  // screen when the cover began were already announced and are not mirrored.
  // Adjust-state-during-render: the region must carry the text in the same
  // commit that adds the toast.
  const [cover, setCover] = useState<{ covered: boolean; baseline: ReadonlySet<string>; mirrored: ReadonlySet<string> }>(
    () => ({ covered: false, baseline: new Set(), mirrored: new Set() }),
  );
  let nextCover = cover;
  if (cover.covered !== covered) {
    nextCover = { covered, baseline: new Set(covered ? messages.map((m) => m.id) : []), mirrored: cover.mirrored };
  }
  const liveIds = new Set(messages.map((m) => m.id));
  const fresh = covered
    ? messages.filter((m) => m.action && !nextCover.baseline.has(m.id) && !nextCover.mirrored.has(m.id)).map((m) => m.id)
    : [];
  const stale = [...nextCover.mirrored].some((id) => !liveIds.has(id));
  if (fresh.length > 0 || stale) {
    nextCover = { ...nextCover, mirrored: new Set([...nextCover.mirrored, ...fresh].filter((id) => liveIds.has(id))) };
  }
  if (nextCover !== cover) setCover(nextCover);
  const mirrored = nextCover.mirrored;
  const statusMessages = messages.filter((m) => (m.action ? mirrored.has(m.id) : (m.tone ?? 'success') !== 'error'));
  // The stack only fades (data-covered); each visible toast goes inert and
  // aria-hidden itself (renderToast), so the shared live regions keep
  // announcing errors raised while the drawer is open.
  useLayoutEffect(() => {
    if (covered) mount.setAttribute('data-covered', 'true');
    else mount.removeAttribute('data-covered');
  }, [covered, mount]);
  const coveredIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const held = coveredIdsRef.current;
    if (covered) {
      // Every toast waits while covered, not only actionable ones: a plain
      // error must still be seen once the drawer closes.
      for (const message of messages) {
        if (held.has(message.id)) continue;
        held.add(message.id);
        pauseToast(message.id, 'covered');
      }
      return;
    }
    for (const id of held) resumeToast(id, 'covered');
    held.clear();
  }, [covered, messages, pauseToast, resumeToast]);
  const stack = (
    <>
      <ToastLiveRegion messages={errorMessages} role="alert" live="assertive" />
      <ToastLiveRegion messages={statusMessages} role="status" live="polite" />
      {messages.map((message) => renderToast(message, pauseToast, resumeToast, covered, mirrored.has(message.id)))}
    </>
  );
  return <><div ref={homeRef} style={{ display: 'contents' }} />{createPortal(stack, mount)}</>;
}

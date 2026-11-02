import { useEffect } from 'react';
import { hidePopoverIfOpen, isPopoverOpen, popoverSourceSupported, popoverSupported, showAnchoredPopover } from './useNativeAnchor';

// Lifecycle for the `[data-tip]` tooltip primitive (styles/global.css). Hosts
// keep authoring `data-tip` (and `data-tip-place`); one real label node
// serves the whole document, and this one delegated set of window listeners,
// mounted once by App, decides what it shows. Never one listener, one piece
// of React state or one anchor name per host.
//
// The label is a manual popover shown with its host as the implicit anchor
// (useNativeAnchor), so CSS owns every coordinate: side, flips and clamping.
// Nothing here reads the label's or the host's geometry. What CSS cannot
// express on its own (WCAG 1.4.13) stays here:
//   - which host the label describes: the hovered one, else the one with
//     keyboard focus (`:focus-visible`), and none while either sits in an open
//     disclosure (`aria-expanded="true"`), is inert or is behind a modal;
//   - a host wholly clipped out of view (a focused row scrolled out of its
//     list) has its label hidden by CSS, so it gives the label up until it
//     intersects again: an invisible label never takes Escape or a press;
//   - its DOM owner: the host's open <dialog> or popover, else the host's
//     own top-level subtree, so neither a native modal nor useModalChrome's
//     inert sweep ever leaves the label unreachable;
//   - a short leave grace, so the pointer can cross the 6px gap onto the
//     label and keep it open;
//   - Escape dismisses the visible label BEFORE any surrounding overlay sees
//     the key, and a dismissed label stays hidden until hover and focus have
//     both left its host;
//   - a press or click on the label is a reading gesture: swallowed before
//     anything else sees it, so it neither activates a control beneath nor
//     counts as an outside pointer for the overlay around the host.

export const TIP_DISMISSED_ATTRIBUTE = 'data-tip-dismissed';
export const TIP_LABEL_ATTRIBUTE = 'data-tip-label';
const TIP_HOST_SELECTOR = '[data-tip]:not([data-tip=""])';
const OPEN_ATTRIBUTE = 'data-open';
// Long enough to cross the 6px gap between host and label, short enough that
// leaving reads as immediate.
const LEAVE_GRACE_MS = 120;
const SWALLOWED_EVENTS = ['pointerdown', 'mousedown', 'click', 'dblclick', 'auxclick'] as const;
// What can make the described host stop qualifying, or change what it says.
const OBSERVED: MutationObserverInit = {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: ['aria-expanded', 'data-tip', 'data-tip-place', 'inert', 'open'],
};

function tipHostOf(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>(TIP_HOST_SELECTOR) : null;
}

function isTipHost(target: EventTarget | null): target is HTMLElement {
  return target instanceof HTMLElement && target.matches(TIP_HOST_SELECTOR);
}

function matchesSafely(element: Element, selector: string): boolean {
  try {
    return element.matches(selector);
  } catch {
    return false;
  }
}

function blockedByModal(host: HTMLElement): boolean {
  let modals: HTMLDialogElement[];
  try {
    modals = Array.from(document.querySelectorAll<HTMLDialogElement>('dialog:modal'));
  } catch {
    return false;
  }
  if (modals.length === 0) return false;
  // Only the topmost modal is interactive, and it holds focus: the innermost
  // one around the focused element (a nested dialog follows its ancestors in
  // document order). Without focus in any, any open modal may be the host's.
  const active = document.activeElement;
  const owner = active ? modals.filter((dialog) => dialog.contains(active)).pop() : undefined;
  if (owner) return !owner.contains(host);
  return !modals.some((dialog) => dialog.contains(host));
}

/**
 * Swept inert by a custom modal, or outside the native modal dialog that owns
 * the keyboard: a surface described by `element` no longer owns it
 * (BatchPrompt's card uses the same rule for Escape).
 */
export function behindModal(element: HTMLElement): boolean {
  return element.closest('[inert]') !== null || blockedByModal(element);
}

function describable(host: HTMLElement): boolean {
  return host.isConnected
    && host.matches(TIP_HOST_SELECTOR)
    && !host.hasAttribute(TIP_DISMISSED_ATTRIBUTE)
    && host.closest('[aria-expanded="true"]') === null
    && !behindModal(host);
}

/**
 * Where the label lives while it describes `host`. Inside the host's open
 * dialog or popover, because everything outside a modal dialog is inert. Else
 * inside the host's own top-level subtree: a body-level label could carry the
 * inert sweep of a custom modal opened since, and the host's subtree is the
 * one that sweep spared.
 */
function ownerOf(host: HTMLElement): HTMLElement {
  const layer = host.closest<HTMLElement>('dialog[open], [popover]');
  if (layer) return layer;
  let node = host;
  while (node.parentElement && node.parentElement !== document.body) node = node.parentElement;
  return node !== host && node.parentElement === document.body ? node : document.body;
}

/** Past its reveal delay: `visibility` stays hidden until CSS shows it. */
function revealed(label: HTMLElement): boolean {
  return label.hasAttribute(OPEN_ATTRIBUTE) && window.getComputedStyle(label).visibility !== 'hidden';
}

export function useTooltipDismiss(): void {
  useEffect(() => {
    let active = true;
    const canHover = window.matchMedia('(hover: hover)');
    let label: HTMLDivElement | null = null;
    // The host under the pointer, kept while the pointer is on its label.
    let hovered: HTMLElement | null = null;
    // The host holding keyboard focus.
    let focused: HTMLElement | null = null;
    // The host the label describes now.
    let shown: HTMLElement | null = null;
    let overLabel = false;
    let leaveTimer = 0;

    const ensureLabel = (): HTMLDivElement => {
      if (label) return label;
      const node = document.createElement('div');
      node.setAttribute(TIP_LABEL_ATTRIBUTE, '');
      node.setAttribute('aria-hidden', 'true');
      // A long label scrolls; it is never a Tab stop.
      node.tabIndex = -1;
      if (popoverSupported(node)) node.popover = 'manual';
      label = node;
      return node;
    };

    const show = (host: HTMLElement) => {
      const node = ensureLabel();
      const reveal = host !== shown || !node.hasAttribute(OPEN_ATTRIBUTE);
      const text = host.getAttribute('data-tip') ?? '';
      if (node.textContent !== text) node.textContent = text;
      const place = host.getAttribute('data-tip-place');
      if (place === null) node.removeAttribute('data-tip-place');
      else if (node.getAttribute('data-tip-place') !== place) node.setAttribute('data-tip-place', place);
      const owner = ownerOf(host);
      const moved = node.parentElement !== owner;
      if (moved) owner.append(node);
      if (moved || host !== shown || (popoverSupported(node) && !isPopoverOpen(node))) {
        node.toggleAttribute('data-anchored', popoverSourceSupported());
        showAnchoredPopover(node, host);
      }
      if (!node.hasAttribute(OPEN_ATTRIBUTE)) node.setAttribute(OPEN_ATTRIBUTE, '');
      // One node can switch directly between hosts without a hidden frame.
      // Restart its CSS reveal through Web Animations, not a layout read or
      // another timer. Backwards fill keeps it hidden throughout the delay.
      if (reveal && typeof node.getAnimations === 'function') {
        for (const animation of node.getAnimations()) {
          if ('animationName' in animation && animation.animationName === 'tip-reveal') {
            animation.currentTime = 0;
            animation.play();
          }
        }
      }
      shown = host;
    };

    // The label stays open but fades out (CSS), and the next show re-raises
    // it, so leaving never cuts the fade short. A removed host leaves no
    // source to fade against, and a clipped one's label is already hidden by
    // CSS: either way the label leaves the top layer at once.
    const hide = (clippedOut = false) => {
      const host = shown;
      shown = null;
      if (!label) return;
      label.removeAttribute(OPEN_ATTRIBUTE);
      if (clippedOut || (host && !host.isConnected)) hidePopoverIfOpen(label);
    };

    let observing = false;
    const observer = new MutationObserver(() => { sync(); });

    // Interaction liveness, not placement: only whether the intended host
    // intersects at all is read, by one observer for that host alone.
    // Computed visibility and checkVisibility() still report a label CSS
    // strongly hides as visible (Chrome 156), so neither can tell.
    let watched: HTMLElement | null = null;
    let intersection: IntersectionObserver | null = null;
    let clipped = false;

    const watch = (host: HTMLElement | null) => {
      if (host === watched) return;
      intersection?.disconnect();
      intersection = null;
      watched = host;
      clipped = false;
      if (!host || typeof IntersectionObserver === 'undefined') return;
      const next = new IntersectionObserver((entries, current) => {
        // A report queued for a host no longer intended.
        if (current !== intersection) return;
        const latest = entries.filter((entry) => entry.target === watched).pop();
        if (!latest || clipped === !latest.isIntersecting) return;
        clipped = !latest.isIntersecting;
        sync();
      });
      intersection = next;
      next.observe(host);
    };

    const sync = (): void => {
      if (!active) return;
      const candidate = hovered && describable(hovered)
        ? hovered
        : focused && describable(focused) ? focused : null;
      const intended = candidate && canHover.matches ? candidate : null;
      watch(intended);
      if (intended && !clipped) show(intended);
      else hide(intended !== null);
      // Kept for a clipped host too: its removal, inerting or new text must
      // not leave it watched.
      if (intended && !observing) {
        observer.observe(document.documentElement, OBSERVED);
        observing = true;
      } else if (!intended && observing) {
        observer.disconnect();
        observing = false;
      }
    };

    const rearm = (host: HTMLElement | null) => {
      if (!host?.hasAttribute(TIP_DISMISSED_ATTRIBUTE)) return;
      if (host === hovered || host === document.activeElement) return;
      host.removeAttribute(TIP_DISMISSED_ATTRIBUTE);
    };

    const clearLeave = () => {
      if (leaveTimer === 0) return;
      window.clearTimeout(leaveTimer);
      leaveTimer = 0;
    };

    const setHovered = (next: HTMLElement | null) => {
      clearLeave();
      if (next === hovered) return;
      const previous = hovered;
      hovered = next;
      rearm(previous);
      sync();
    };

    const onPointerOver = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      const target = event.target;
      if (label && target instanceof Node && label.contains(target)) {
        overLabel = true;
        clearLeave();
        return;
      }
      overLabel = false;
      const next = tipHostOf(target);
      if (next === hovered) {
        clearLeave();
        return;
      }
      // Off the host but not onto another one: maybe on the way to its label.
      if (next === null && hovered !== null && hovered === shown) {
        if (leaveTimer === 0) {
          leaveTimer = window.setTimeout(() => {
            leaveTimer = 0;
            if (!overLabel) setHovered(null);
          }, LEAVE_GRACE_MS);
        }
        return;
      }
      setHovered(next);
    };

    // Leaving the document, or into a region that dispatches no pointerover.
    const onPointerOut = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || event.relatedTarget !== null) return;
      overLabel = false;
      setHovered(null);
    };

    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      focused = isTipHost(target) && matchesSafely(target, ':focus-visible') ? target : null;
      sync();
    };

    const onFocusOut = (event: FocusEvent) => {
      const host = event.target;
      if (host === focused) focused = null;
      // activeElement is still the host during focusout; re-check once focus
      // has settled on its next target.
      queueMicrotask(() => {
        if (!active) return;
        if (isTipHost(host)) rearm(host);
        sync();
      });
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      // Escape before the label appears belongs to whatever owns it next.
      const host = shown;
      if (!host || !label || !revealed(label)) return;
      host.setAttribute(TIP_DISMISSED_ATTRIBUTE, '');
      sync();
      // Consumed: the overlay (or composer, or lightbox) keeps its state.
      event.preventDefault();
      event.stopPropagation();
    };

    // The label is a reading surface, never a second hit area: nothing below
    // it, and no outside-pointer owner around its host, sees the gesture.
    const onLabelPress = (event: Event) => {
      if (!label || !(event.target instanceof Node) || !label.contains(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    window.addEventListener('pointerover', onPointerOver, true);
    window.addEventListener('pointerout', onPointerOut, true);
    window.addEventListener('focusin', onFocusIn, true);
    window.addEventListener('focusout', onFocusOut, true);
    // Capture on window runs before every document-level and element-level
    // Escape and pointer owner (useModalChrome, useOutsidePointer,
    // useKeyboard, React handlers).
    window.addEventListener('keydown', onKeyDown, true);
    for (const type of SWALLOWED_EVENTS) window.addEventListener(type, onLabelPress, true);
    canHover.addEventListener('change', sync);
    return () => {
      active = false;
      window.removeEventListener('pointerover', onPointerOver, true);
      window.removeEventListener('pointerout', onPointerOut, true);
      window.removeEventListener('focusin', onFocusIn, true);
      window.removeEventListener('focusout', onFocusOut, true);
      window.removeEventListener('keydown', onKeyDown, true);
      for (const type of SWALLOWED_EVENTS) window.removeEventListener(type, onLabelPress, true);
      canHover.removeEventListener('change', sync);
      clearLeave();
      observer.disconnect();
      intersection?.disconnect();
      intersection = null;
      watched = null;
      if (label) {
        hidePopoverIfOpen(label);
        label.remove();
      }
    };
  }, []);
}

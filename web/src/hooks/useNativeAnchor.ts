import { useEffectEvent, useLayoutEffect, type RefObject } from 'react';

// Relationship and lifecycle for native CSS anchor positioning
// (docs/native-anchors.md). Nothing here measures or places anything: the
// browser resolves every coordinate from the stylesheets
// (styles/anchors.module.css and each owner's module).
//
// A panel that may sit in the top layer is a manual popover shown with
// `showPopover({ source })`. The source becomes the popover's implicit anchor,
// so there is no anchor name to invent, bind or release, and repeated or
// nested triggers cannot cross-bind. Manual, not auto: the owners keep their
// own Escape order, outside-pointer rule, focus trap and exit animation.
// Page-layer surfaces (ChipSelect, the BatchPrompt card) declare a name
// instead and do not use this module's lifecycle.

let probedShowPopover: unknown = null;
let probedSource = false;

/**
 * True when `showPopover()` honours its `source` member. Detected by whether
 * the WebIDL conversion of the options dictionary reads the member: argument
 * conversion runs before the method's own checks, so a detached element with
 * no `popover` attribute answers without being shown or measured. An engine
 * that has the Popover API (or CSS anchoring) but not `source` reads nothing.
 */
export function popoverSourceSupported(): boolean {
  const showPopover: unknown = Reflect.get(HTMLElement.prototype, 'showPopover');
  if (typeof showPopover !== 'function') return false;
  if (probedShowPopover === showPopover) return probedSource;
  let read = false;
  const probe: ShowPopoverOptions = Object.defineProperty({}, 'source', {
    get() {
      read = true;
      return undefined;
    },
  });
  try {
    document.createElement('div').showPopover(probe);
  } catch {
    // NotSupportedError: the probe has no popover attribute. Expected.
  }
  probedShowPopover = showPopover;
  probedSource = read;
  return read;
}

/** The Popover API (top layer) exists, with or without `source`. */
export function popoverSupported(element: HTMLElement): boolean {
  return 'showPopover' in element;
}

export function isPopoverOpen(element: HTMLElement): boolean {
  try {
    return element.matches(':popover-open');
  } catch {
    return false;
  }
}

/**
 * Shows `panel` in the top layer, anchored to `source` where supported. Re-
 * showing an open panel hides it first: that is how a new source is taken,
 * and it raises the panel above anything shown since.
 */
export function showAnchoredPopover(panel: HTMLElement, source: HTMLElement | null): void {
  if (!popoverSupported(panel) || !panel.isConnected || !panel.hasAttribute('popover')) return;
  if (isPopoverOpen(panel)) panel.hidePopover();
  panel.showPopover(source && popoverSourceSupported() ? { source } : undefined);
}

export function hidePopoverIfOpen(panel: HTMLElement): void {
  if (popoverSupported(panel) && isPopoverOpen(panel)) panel.hidePopover();
}

export interface AnchoredPopoverProps {
  popover?: 'manual';
}

// Present while CSS may anchor the panel (styles/anchors.module.css keys on
// it). Written by the hook, not rendered: it follows the source's lifecycle.
const ANCHORED_ATTRIBUTE = 'data-anchored';
const CONNECTION: MutationObserverInit = { childList: true, subtree: true };

interface AnchoredPopoverOptions {
  /** The panel is mounted in its popover form (desktop, not the phone sheet). */
  active: boolean;
  /**
   * Identity of the node behind `panelRef`, as for useFocusTrap: an owner that
   * replaces the panel node while open re-shows the current one.
   */
  containerKey?: unknown;
  /**
   * The platform hid the popover on its own (entering fullscreen hides every
   * popover), or its source left the document. Owners close so their state
   * matches what is on screen.
   */
  onNativeClose?: () => void;
}

/**
 * Shows the mounted panel as a manual popover whose implicit anchor is
 * `anchorRef`'s element, in a layout effect so the first painted frame is
 * already in place, and returns the attributes the panel renders. Inactive,
 * it returns nothing and the panel is an ordinary element (the phone sheet).
 *
 * The panel is anchored only while its source is in the document: one shown
 * without a connected source, or whose source is removed while it is open or
 * playing its exit, drops `data-anchored` and takes the centred, scrolling
 * fallback instead of resolving against nothing. A removal is reported like a
 * platform close, so the owner closes (with its exit and focus fallback).
 * Connection is watched only while a source is bound, and nothing is read
 * but `isConnected`.
 *
 * Our own hide (unmount, a responsive switch, a new anchor) removes the toggle
 * listener first, so a stale `toggle` event from it is never mistaken for the
 * platform closing the current panel.
 */
export function useAnchoredPopover(
  panelRef: RefObject<HTMLElement | null>,
  anchorRef: RefObject<HTMLElement | null>,
  { active, containerKey, onNativeClose }: AnchoredPopoverOptions,
): AnchoredPopoverProps {
  const nativeClose = useEffectEvent(() => { onNativeClose?.(); });

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!active || !panel) return;
    const candidate = anchorRef.current;
    const source = candidate?.isConnected ? candidate : null;
    const onToggle = (event: ToggleEvent) => {
      if (event.newState === 'closed') nativeClose();
    };
    panel.addEventListener('toggle', onToggle);
    showAnchoredPopover(panel, source);
    let connection: MutationObserver | null = null;
    if (source && popoverSupported(panel) && popoverSourceSupported()) {
      panel.setAttribute(ANCHORED_ATTRIBUTE, 'source');
      connection = new MutationObserver(() => {
        if (source.isConnected) return;
        connection?.disconnect();
        connection = null;
        panel.removeAttribute(ANCHORED_ATTRIBUTE);
        nativeClose();
      });
      connection.observe(source.ownerDocument.documentElement, CONNECTION);
    } else {
      panel.removeAttribute(ANCHORED_ATTRIBUTE);
    }
    return () => {
      connection?.disconnect();
      panel.removeEventListener('toggle', onToggle);
      hidePopoverIfOpen(panel);
      panel.removeAttribute(ANCHORED_ATTRIBUTE);
    };
  }, [active, anchorRef, containerKey, panelRef]);

  return active ? { popover: 'manual' } : {};
}

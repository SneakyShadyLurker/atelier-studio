import type { RefObject } from 'react';
import { useEffect, useRef } from 'react';
import { runWhenReachable } from '../lib/focus';

// Programmatically focusable: initial-focus candidates. A native control with
// tabindex="-1" still qualifies here (a roving row the owner focuses itself).
const FOCUSABLE_SELECTOR =
  'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex="-1"])';

// Sequentially tabbable: what Tab can actually land on, so the only valid trap
// boundaries. Candidates with a negative tabindex are dropped below — a roving
// list's tabindex="-1" rows are focusable but NOT tab stops, and treating the
// last one as the boundary let Tab walk straight out of the container.
const TABBABLE_SELECTOR = [
  'button:not(:disabled)',
  'input:not(:disabled):not([type="hidden"])',
  'textarea:not(:disabled)',
  'select:not(:disabled)',
  'a[href]',
  'area[href]',
  '[tabindex]:not(:disabled)',
].join(', ');

// The parsed value, not the attribute text: " -1" is negative, "-0" is not.
// Only an explicit attribute counts, so natively focusable controls never
// depend on the environment's default tabIndex.
function negativeTabIndex(element: HTMLElement): boolean {
  return element.hasAttribute('tabindex') && element.tabIndex < 0;
}

type DisplayCache = Map<Element, boolean>;

function displayed(element: Element, cache: DisplayCache): boolean {
  const known = cache.get(element);
  if (known !== undefined) return known;
  const parent = element.parentElement;
  const result = window.getComputedStyle(element).display !== 'none' && (parent === null || displayed(parent, cache));
  cache.set(element, result);
  return result;
}

// Reachability without layout: a `hidden`, `inert` or aria-hidden subtree, a
// display:none ancestor or a visibility:hidden (inherited) control is never a
// focus target. Deliberately not getClientRects, which happy-dom cannot
// answer and which would drop every control under test.
function isReachable(element: HTMLElement, cache: DisplayCache): boolean {
  if (element.closest('[hidden], [inert], [aria-hidden="true"]') !== null) return false;
  const { visibility } = window.getComputedStyle(element);
  if (visibility === 'hidden' || visibility === 'collapse') return false;
  return displayed(element, cache);
}

function reachableMatches(el: HTMLElement, selector: string): HTMLElement[] {
  const cache: DisplayCache = new Map();
  return Array.from(el.querySelectorAll<HTMLElement>(selector)).filter((element) => isReachable(element, cache));
}

export function focusableInside(el: HTMLElement | null): HTMLElement[] {
  if (!el) return [];
  return reachableMatches(el, FOCUSABLE_SELECTOR);
}

export function tabbableInside(el: HTMLElement | null): HTMLElement[] {
  if (!el) return [];
  return reachableMatches(el, TABBABLE_SELECTOR).filter((element) => !negativeTabIndex(element));
}

interface FocusTrapOptions {
  active: boolean;
  returnFocusTo?: RefObject<HTMLElement | null>;
  // Restore target when the primary returnFocusTo unmounted while the trap
  // was open (e.g. a popover action removed its own trigger) — keeps keyboard
  // focus on a stable control instead of falling to document.body.
  returnFocusFallback?: RefObject<HTMLElement | null>;
  // Default true: focus the first focusable on activation. Set false when the
  // consumer owns initial focus (e.g. a target gated behind an async query) so
  // the trap provides Tab containment without racing that focus.
  autoFocus?: boolean;
  // Identity of the node behind containerRef. Pass the responsive mode when
  // the owner's JSX replaces the container while open (popover ⇄ sheet): a
  // change moves Tab containment onto the current node — and re-seats focus
  // the removed node dropped — without re-running activation or restore.
  containerKey?: unknown;
}

function lostFocus(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || !active.isConnected;
}

export function useFocusTrap(containerRef: RefObject<HTMLElement | null>, { active, returnFocusTo, returnFocusFallback, autoFocus = true, containerKey }: FocusTrapOptions): void {
  const boundRef = useRef<HTMLElement | null>(null);

  // Activation: initial focus and the restore target, once per open.
  useEffect(() => {
    if (!active) return;
    boundRef.current = null;
    const container = containerRef.current;
    if (!container) return;
    const returnTarget = returnFocusTo?.current ?? null;
    const fallbackTarget = returnFocusFallback?.current ?? null;

    if (autoFocus) {
      const focusInitial = () => {
        if (!container.isConnected || container.contains(document.activeElement)) return;
        (focusableInside(container)[0] ?? container).focus();
      };
      focusInitial();
      runWhenReachable(focusInitial, container);
    }

    return () => {
      if (returnTarget?.isConnected) {
        returnTarget.focus();
        return;
      }
      if (fallbackTarget?.isConnected) fallbackTarget.focus();
    };
  }, [active, autoFocus, containerRef, returnFocusTo, returnFocusFallback]);

  // Containment: bound to whichever node is current.
  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;
    const replaced = boundRef.current !== null && boundRef.current !== container;
    boundRef.current = container;
    if (replaced && lostFocus()) (focusableInside(container)[0] ?? container).focus();

    // Recovery for a focused descendant the owner removed (a Clear button that
    // clears itself): the browser drops focus to <body>, outside this
    // container's keydown listener. Re-seat only when that exact node went away
    // AND focus truly fell out — a connected control or a nested portalled
    // dialog keeps it. The fast path does no layout or computed-style work.
    let lastFocused: Element | null = container.contains(document.activeElement) ? document.activeElement : null;
    const onFocusIn = (event: FocusEvent) => {
      lastFocused = event.target instanceof Element ? event.target : null;
    };
    const observer = new MutationObserver(() => {
      if (lastFocused === null || lastFocused.isConnected) return;
      if (!container.isConnected || !lostFocus()) return;
      lastFocused = null;
      (tabbableInside(container)[0] ?? focusableInside(container)[0] ?? container).focus();
    });
    observer.observe(container, { childList: true, subtree: true });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const tabbable = tabbableInside(container);
      const first = tabbable[0];
      const last = tabbable.at(-1);
      if (!first || !last) return;
      const current = document.activeElement;
      const index = current instanceof HTMLElement ? tabbable.indexOf(current) : -1;
      let target: HTMLElement | undefined;
      if (index >= 0) {
        // Interior moves stay native; only the boundaries wrap.
        if (event.shiftKey && index === 0) target = last;
        else if (!event.shiftKey && index === tabbable.length - 1) target = first;
      } else {
        // Focus sits on something focusable but not tabbable (a roving row, the
        // container itself, a click-focused <pre>): resolve the next stop by
        // document order so the browser cannot pick one outside the container.
        const following = (node: HTMLElement) => current instanceof Node
          && (current.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
          && !node.contains(current);
        target = event.shiftKey
          ? tabbable.findLast((node) => !following(node) && node !== current) ?? last
          : tabbable.find(following) ?? first;
      }
      if (!target) return;
      event.preventDefault();
      target.focus();
    };

    container.addEventListener('focusin', onFocusIn);
    container.addEventListener('keydown', onKeyDown);
    return () => {
      observer.disconnect();
      container.removeEventListener('focusin', onFocusIn);
      container.removeEventListener('keydown', onKeyDown);
    };
  }, [active, containerKey, containerRef]);
}

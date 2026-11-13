/**
 * Input wins over a view transition.
 *
 * React starts a document view transition for a Transition commit that
 * touches a view-transition boundary. Between `document.startViewTransition`
 * and the browser running its update callback (the preparation window: a
 * frame or two at rest, up to 500 ms while React waits for fonts and images)
 * three things hold, and each one breaks input:
 *
 * - react-dom has switched its event system off (commitBeforeMutationEffects)
 *   and switches it on again only in the mutation phase, so no React handler
 *   runs: a keystroke changes the field's DOM value but never reaches
 *   `onChange`, a submit shortcut does nothing.
 * - React recorded the focused element before the window and puts focus back
 *   on it afterwards whenever focus differs, which reverts a focus move the
 *   reader made meanwhile.
 * - The browser suppresses rendering and hit-tests every pointer press to the
 *   root element (css-view-transitions-1, "rendering suppression").
 *
 * React documents the way out: a synchronous update in the middle of that
 * sequence makes it skip the transition and commit at once. So the first
 * input event of a preparation window forces the pending commit through,
 * before React's own listeners see the event. That one transition loses its
 * animation; no event, focus move or press is lost. A press the browser
 * delivered to the root, or (while a captured element animates) to whatever
 * lies behind it, is re-aimed at the element under the pointer.
 *
 * This module starts no transition and names no element: React alone does
 * both. It only observes `document.startViewTransition` to know when a
 * commit is pending.
 */

interface PendingCommit {
  /** `document.activeElement` when the commit began: what React restores focus to. */
  readonly prior: Element | null;
}

interface RescuedPress {
  readonly intended: Element;
  readonly at: number;
}

type UpdateCallback = () => unknown;
type StartArgument = UpdateCallback | { readonly update?: UpdateCallback | null } | null | undefined;
type StartViewTransition = (argument?: StartArgument) => ViewTransition;

/** Discrete input React may handle, or whose default action moves focus. */
const INPUT_EVENTS = [
  'keydown', 'keyup', 'beforeinput', 'input', 'compositionstart', 'compositionupdate', 'compositionend',
  'pointerup', 'mousedown', 'mouseup', 'auxclick', 'dblclick', 'contextmenu', 'touchstart', 'touchend',
  'focusin', 'focusout', 'change', 'paste', 'cut', 'copy', 'dragstart', 'drop', 'submit',
] as const;

/** A stray click follows its rescued press within one press-and-release. */
const RESCUED_CLICK_WINDOW_MS = 1500;
const CLICKABLE_SELECTOR = 'button, a[href], [role="button"], [role="menuitem"], [role="option"], [role="tab"], label, summary, input, select';
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number']);

let pending: PendingCommit | null = null;
/** Inside the synchronous part of an update callback: React is committing. */
let committing = false;
let running: ViewTransition | null = null;
let flushCommit: (() => void) | null = null;
let rescued: RescuedPress | null = null;
const protectedRegions = new Set<HTMLElement>();

/** A Transition commit is waiting for the browser's update callback. */
export function viewTransitionPreparing(): boolean {
  return pending !== null;
}

/**
 * The mounted guard component registers how to make React flush a pending
 * commit: a synchronous no-op update on the app's root.
 */
export function registerCommitFlush(flush: () => void): () => void {
  flushCommit = flush;
  return () => {
    if (flushCommit === flush) flushCommit = null;
  };
}

/**
 * Presses inside this element's box always reach it. While a view transition
 * animates, a captured element is not hit-testable and a press on it lands on
 * whatever lies behind; for a protected region that press ends the transition
 * and is re-aimed at the element under the pointer.
 */
export function protectPresses(element: HTMLElement): () => void {
  protectedRegions.add(element);
  return () => { protectedRegions.delete(element); };
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';
}

/**
 * Force the pending commit through. When the reader already moved focus, the
 * commit's focus restore would take it back to `prior`; that restore calls
 * `prior.focus()`, so it is made a no-op for the length of the flush. When
 * focus has not moved, the restore stays: a mutation that detaches and
 * re-inserts the focused node relies on it.
 */
function flushPendingCommit(doc: Document): boolean {
  const commit = pending;
  // An event fired from inside the commit itself (a focused node the
  // mutation removes fires focusout) finds React already at work.
  if (commit === null || flushCommit === null || committing) return false;
  pending = null;
  const prior = commit.prior;
  const hold = prior instanceof HTMLElement && prior !== doc.body && doc.activeElement !== prior;
  const own = hold ? Object.getOwnPropertyDescriptor(prior, 'focus') : undefined;
  if (hold) Object.defineProperty(prior, 'focus', { configurable: true, writable: true, value: () => undefined });
  try {
    flushCommit();
  } finally {
    if (hold) {
      if (own) Object.defineProperty(prior, 'focus', own);
      else Reflect.deleteProperty(prior, 'focus');
    }
  }
  return true;
}

function textFieldOf(element: Element | null): HTMLTextAreaElement | HTMLInputElement | null {
  if (element instanceof HTMLTextAreaElement) return element.disabled ? null : element;
  if (element instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(element.type)) return element.disabled ? null : element;
  return null;
}

function containsPoint(element: Element, x: number, y: number): boolean {
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0 && x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
}

/** Focus the field and put the caret where the press landed. */
function pressTextField(doc: Document, field: HTMLTextAreaElement | HTMLInputElement, x: number, y: number): void {
  field.focus({ preventScroll: true });
  const position = typeof doc.caretPositionFromPoint === 'function' ? doc.caretPositionFromPoint(x, y) : null;
  if (position?.offsetNode !== field) return;
  try {
    field.setSelectionRange(position.offset, position.offset);
  } catch {
    // An input type without a selection API keeps the caret it had.
  }
}

/**
 * Re-aim a press the browser delivered to the wrong element. Its default
 * action (the root or the element behind taking focus) is cancelled; a text
 * field takes focus and the caret now, anything else gets its click when the
 * press ends (see onClick).
 */
function rescuePress(doc: Document, event: PointerEvent, within: Element | null): void {
  const intended = doc.elementFromPoint(event.clientX, event.clientY);
  if (!intended || intended === event.target || intended === doc.documentElement || intended === doc.body) return;
  if (within && !within.contains(intended)) return;
  if (intended.closest('[inert]') !== null) return;
  event.preventDefault();
  rescued = { intended, at: event.timeStamp };
  const field = textFieldOf(intended);
  if (field) pressTextField(doc, field, event.clientX, event.clientY);
}

/**
 * Observe `document.startViewTransition` and listen for input. Returns the
 * uninstaller. Engines without view transitions need no guard.
 */
export function installViewTransitionGuard(doc: Document = document): () => void {
  const host = doc as Document & { startViewTransition?: StartViewTransition };
  const view = doc.defaultView;
  if (typeof host.startViewTransition !== 'function' || !view) return () => undefined;
  const native = host.startViewTransition.bind(doc);
  const shadowed = Object.getOwnPropertyDescriptor(host, 'startViewTransition');

  const start: StartViewTransition = (argument) => {
    const commit: PendingCommit = { prior: doc.activeElement };
    const update = typeof argument === 'function' ? argument : argument?.update ?? undefined;
    const settle = () => {
      if (pending === commit) pending = null;
    };
    // The window ends when the update callback has run: at once for a
    // synchronous one, and once its promise settles when the caller waits
    // inside it (React holds it open for fonts and images; rendering stays
    // suppressed for as long).
    const guarded: UpdateCallback = () => {
      let result: unknown;
      committing = true;
      try {
        result = update?.();
      } catch (error) {
        settle();
        throw error;
      } finally {
        committing = false;
      }
      if (isThenable(result)) void Promise.resolve(result).then(settle, settle);
      else settle();
      return result;
    };
    pending = commit;
    let transition: ViewTransition;
    try {
      transition = native(typeof argument === 'function' || argument == null ? guarded : { ...argument, update: guarded });
    } catch (error) {
      settle();
      throw error;
    }
    running = transition;
    const ended = () => {
      if (running === transition) running = null;
    };
    void transition.finished.then(ended, ended);
    return transition;
  };
  host.startViewTransition = start;

  const onInput = () => {
    flushPendingCommit(doc);
  };

  const onPointerDown = (event: PointerEvent) => {
    const prepared = flushPendingCommit(doc);
    rescued = null;
    if (!event.isTrusted || !event.isPrimary || event.button !== 0) return;
    // Preparation suspends hit-testing: the press was delivered to the root.
    if (prepared && event.target === doc.documentElement) {
      rescuePress(doc, event, null);
      return;
    }
    // A captured element is skipped by hit-testing while its transition
    // animates. A protected region ends the transition to take its press.
    const transition = running;
    if (transition === null || !(event.target instanceof Node)) return;
    for (const region of protectedRegions) {
      if (region.contains(event.target) || !containsPoint(region, event.clientX, event.clientY)) continue;
      transition.skipTransition();
      rescuePress(doc, event, region);
      return;
    }
  };

  // The click that ends a rescued press targets the nearest common ancestor
  // of where the press was delivered and where it was released, never the
  // control itself. Stop that stray click and click the control instead.
  const onClick = (event: MouseEvent) => {
    flushPendingCommit(doc);
    const press = rescued;
    if (press === null || !event.isTrusted) return;
    rescued = null;
    if (event.timeStamp - press.at > RESCUED_CLICK_WINDOW_MS || !press.intended.isConnected) return;
    if (event.target instanceof Node && press.intended.contains(event.target)) return;
    if (!containsPoint(press.intended, event.clientX, event.clientY)) return;
    event.stopImmediatePropagation();
    event.preventDefault();
    if (textFieldOf(press.intended)) return;
    const control = press.intended.closest(CLICKABLE_SELECTOR);
    if (control instanceof HTMLElement) control.click();
  };

  const controller = new AbortController();
  const options = { capture: true, signal: controller.signal } as const;
  for (const name of INPUT_EVENTS) view.addEventListener(name, onInput, options);
  view.addEventListener('pointerdown', onPointerDown, options);
  view.addEventListener('click', onClick, options);

  return () => {
    controller.abort();
    if (host.startViewTransition === start) {
      if (shadowed) Object.defineProperty(host, 'startViewTransition', shadowed);
      else Reflect.deleteProperty(host, 'startViewTransition');
    }
    pending = null;
    committing = false;
    running = null;
    rescued = null;
  };
}

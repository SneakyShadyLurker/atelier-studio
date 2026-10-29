import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { TIP_DISMISSED_ATTRIBUTE, TIP_LABEL_ATTRIBUTE, useTooltipDismiss } from './useTooltipDismiss';

// Lifecycle only. Where the label lands (side, flips, clamping, escaping clips
// and transformed hosts) is native anchor positioning, asserted in a real
// browser: web/e2e/native-anchors.spec.ts. happy-dom has no Popover API and
// no stylesheet here, so the label's reveal is `labelVisibility`: hidden
// through the 360ms delay, visible after.
let labelVisibility = 'visible';
const originalMatchMedia = window.matchMedia.bind(window);

function installHover(hover: boolean): void {
  window.matchMedia = mock((query: string) => ({
    matches: query === '(hover: hover)' ? hover : false,
    media: query,
    onchange: null,
    addEventListener: mock(() => undefined),
    removeEventListener: mock(() => undefined),
    addListener: mock(() => undefined),
    removeListener: mock(() => undefined),
    dispatchEvent: mock(() => true),
  }));
}

// happy-dom has no layout to intersect: each observer reports only when a
// test says so.
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly targets: Element[] = [];
  disconnected = false;
  private readonly callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    FakeIntersectionObserver.instances.push(this);
  }
  observe(target: Element): void { this.targets.push(target); }
  unobserve(): void { /* unused */ }
  disconnect(): void { this.disconnected = true; }
  takeRecords(): IntersectionObserverEntry[] { return []; }
  report(isIntersecting: boolean): void {
    const entries = this.targets.map((target) => ({ target, isIntersecting }) as unknown as IntersectionObserverEntry);
    this.callback(entries, this as unknown as IntersectionObserver);
  }
}
const originalIntersectionObserver = Reflect.get(globalThis, 'IntersectionObserver') as unknown;

function liveObservers(): FakeIntersectionObserver[] {
  return FakeIntersectionObserver.instances.filter((observer) => !observer.disconnected);
}

beforeEach(() => {
  labelVisibility = 'visible';
  installHover(true);
  FakeIntersectionObserver.instances = [];
  Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, writable: true, value: FakeIntersectionObserver });
  const real = window.getComputedStyle.bind(window);
  spyOn(window, 'getComputedStyle').mockImplementation(((element: Element, pseudo?: string | null) => (
    element.hasAttribute(TIP_LABEL_ATTRIBUTE)
      ? ({ visibility: labelVisibility } as unknown as CSSStyleDeclaration)
      : real(element, pseudo)
  )));
});

afterEach(() => {
  cleanup();
  window.matchMedia = originalMatchMedia;
  mock.restore();
  if (originalIntersectionObserver === undefined) Reflect.deleteProperty(globalThis, 'IntersectionObserver');
  else Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, writable: true, value: originalIntersectionObserver });
});

// A minimal Popover API: happy-dom has none.
function installPopoverApi(): { open: Set<Element>; hides: Element[]; restore: () => void } {
  const prototype = HTMLElement.prototype as unknown as Record<string, unknown>;
  const ownMatches = Object.getOwnPropertyDescriptor(Element.prototype, 'matches');
  const ownPopover = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'popover');
  const nativeMatches = Reflect.get(Element.prototype, 'matches') as (this: Element, selector: string) => boolean;
  const open = new Set<Element>();
  const hides: Element[] = [];
  Object.defineProperty(prototype, 'popover', {
    configurable: true,
    get(this: HTMLElement) { return this.getAttribute('popover'); },
    set(this: HTMLElement, value: string) { this.setAttribute('popover', value); },
  });
  Object.defineProperty(prototype, 'showPopover', {
    configurable: true,
    writable: true,
    value(this: HTMLElement) { open.add(this); },
  });
  Object.defineProperty(prototype, 'hidePopover', {
    configurable: true,
    writable: true,
    value(this: HTMLElement) {
      open.delete(this);
      hides.push(this);
    },
  });
  Object.defineProperty(Element.prototype, 'matches', {
    configurable: true,
    writable: true,
    value(this: Element, selector: string) {
      return selector === ':popover-open' ? open.has(this) : nativeMatches.call(this, selector);
    },
  });
  const restore = () => {
    Reflect.deleteProperty(prototype, 'showPopover');
    Reflect.deleteProperty(prototype, 'hidePopover');
    if (ownPopover) Object.defineProperty(HTMLElement.prototype, 'popover', ownPopover);
    else Reflect.deleteProperty(prototype, 'popover');
    if (ownMatches) Object.defineProperty(Element.prototype, 'matches', ownMatches);
    else Reflect.deleteProperty(Element.prototype, 'matches');
  };
  return { open, hides, restore };
}

function label(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[${TIP_LABEL_ATTRIBUTE}]`);
}

function shownText(): string | null {
  const node = label();
  return node?.hasAttribute('data-open') ? node.textContent : null;
}

// Lets the MutationObserver the lifecycle keeps while a label shows deliver.
async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

function Lifecycle() {
  useTooltipDismiss();
  return null;
}

// An overlay owning Escape the way useModalChrome does: document capture,
// honouring defaultPrevented.
function useOverlayEscape(onOverlayEscape: () => void): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) onOverlayEscape();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => { document.removeEventListener('keydown', onKeyDown, true); };
  }, [onOverlayEscape]);
}

function Harness({ onOverlayEscape }: { onOverlayEscape: () => void }) {
  useTooltipDismiss();
  useOverlayEscape(onOverlayEscape);
  return (
    <div role="dialog" aria-label="Templates">
      <button type="button" aria-label="Close templates" data-tip="Close templates" data-tip-place="below-end"><svg aria-hidden="true" /></button>
      <button type="button">Other</button>
    </div>
  );
}

function host(): HTMLElement {
  return screen.getByRole('button', { name: 'Close templates' });
}

describe('one label node for every host', () => {
  test('hovering a host shows its text and placement on a visual-only label in the host’s own subtree', () => {
    const view = render(<Harness onOverlayEscape={mock()} />);
    expect(label()).toBeNull();
    fireEvent.pointerOver(host());

    const node = label();
    expect(node?.textContent).toBe('Close templates');
    expect(node?.getAttribute('data-tip-place')).toBe('below-end');
    expect(node?.getAttribute('aria-hidden')).toBe('true');
    expect(node?.hasAttribute('data-open')).toBe(true);
    // Never a Tab stop, never part of the host's accessible name.
    expect(node?.tabIndex).toBe(-1);
    expect(host().contains(node ?? null)).toBe(false);
    expect(node?.parentElement).toBe(view.container);
  });

  test('leaving every host hides the label after the travel grace; the next host reuses the node', async () => {
    render(<Harness onOverlayEscape={mock()} />);
    fireEvent.pointerOver(host());
    const node = label();
    fireEvent.pointerOver(screen.getByRole('button', { name: 'Other' }));
    // Not a host: the label is kept for the gap crossing, then dropped.
    expect(shownText()).toBe('Close templates');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 160)); });
    expect(shownText()).toBeNull();

    fireEvent.pointerOver(host());
    expect(label()).toBe(node);
    expect(document.querySelectorAll(`[${TIP_LABEL_ATTRIBUTE}]`)).toHaveLength(1);
  });

  test('the pointer crossing onto the label keeps it open', async () => {
    render(<Harness onOverlayEscape={mock()} />);
    fireEvent.pointerOver(host());
    fireEvent.pointerOver(screen.getByRole('dialog'));
    const node = label();
    if (!node) throw new Error('missing label');
    fireEvent.pointerOver(node);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 160)); });
    expect(shownText()).toBe('Close templates');
  });

  test('a host inside an open dialog keeps its label inside that dialog', () => {
    render(
      <>
        <Lifecycle />
        <dialog open>
          <button type="button" data-tip="Inside">in</button>
        </dialog>
      </>,
    );
    fireEvent.pointerOver(screen.getByRole('button', { name: 'in' }));
    expect(label()?.closest('dialog')).not.toBeNull();
  });

  test('touch pointers and devices without hover never show a label', () => {
    render(<Harness onOverlayEscape={mock()} />);
    fireEvent.pointerOver(host(), { pointerType: 'touch' });
    expect(shownText()).toBeNull();
    cleanup();

    installHover(false);
    render(<Harness onOverlayEscape={mock()} />);
    fireEvent.pointerOver(host());
    expect(shownText()).toBeNull();
  });

  test('an expanded disclosure keeps its own and its nested hosts quiet, including one that expands while shown', async () => {
    function Disclosure() {
      useTooltipDismiss();
      const [open, setOpen] = useState(false);
      return (
        <button type="button" aria-expanded={open} data-tip="Chip label" onClick={() => { setOpen((value) => !value); }}>
          <span data-tip="Value label">value</span>
        </button>
      );
    }
    render(<Disclosure />);
    const chip = screen.getByRole('button');
    fireEvent.pointerOver(chip);
    expect(shownText()).toBe('Chip label');
    // The innermost host describes itself; one label at a time.
    fireEvent.pointerOver(screen.getByText('value'));
    expect(shownText()).toBe('Value label');

    fireEvent.click(chip);
    await settle();
    expect(shownText()).toBeNull();
    fireEvent.pointerOver(chip);
    expect(shownText()).toBeNull();
  });

  test('a host removed while described takes its label with it', async () => {
    function Removable() {
      useTooltipDismiss();
      const [shown, setShown] = useState(true);
      return (
        <>
          {shown ? <button type="button" data-tip="Going">go</button> : null}
          <button type="button" onClick={() => { setShown(false); }}>remove</button>
        </>
      );
    }
    render(<Removable />);
    fireEvent.pointerOver(screen.getByRole('button', { name: 'go' }));
    expect(shownText()).toBe('Going');
    fireEvent.click(screen.getByRole('button', { name: 'remove' }));
    await settle();
    expect(shownText()).toBeNull();
  });

  test('a removed host takes its label out of the top layer at once; leaving a host only fades it', async () => {
    const { open, hides, restore } = installPopoverApi();
    try {
      function Removable() {
        useTooltipDismiss();
        const [shown, setShown] = useState(true);
        return (
          <>
            {shown ? <button type="button" data-tip="Going">go</button> : null}
            <button type="button" data-tip="Staying">stay</button>
            <button type="button" onClick={() => { setShown(false); }}>remove</button>
          </>
        );
      }
      render(<Removable />);
      fireEvent.pointerOver(screen.getByRole('button', { name: 'stay' }));
      const node = label();
      if (!node) throw new Error('missing label');
      expect(open.has(node)).toBe(true);
      // A normal leave keeps the popover open so CSS can fade it.
      fireEvent.pointerOut(screen.getByRole('button', { name: 'stay' }), { relatedTarget: null });
      expect(shownText()).toBeNull();
      expect(open.has(node)).toBe(true);
      expect(hides).toEqual([]);

      fireEvent.pointerOver(screen.getByRole('button', { name: 'go' }));
      expect(shownText()).toBe('Going');
      // Re-pointing at a new host re-shows (hide, then show) the same node.
      hides.length = 0;
      fireEvent.click(screen.getByRole('button', { name: 'remove' }));
      await settle();
      expect(shownText()).toBeNull();
      expect(open.has(node)).toBe(false);
      expect(hides).toEqual([node]);
    } finally {
      cleanup();
      restore();
    }
  });

  test('a changed data-tip is what the label says', async () => {
    function Changing() {
      useTooltipDismiss();
      const [locked, setLocked] = useState(false);
      return (
        <button type="button" data-tip={locked ? 'Unlock seed' : 'Lock seed'} onClick={() => { setLocked(true); }}>lock</button>
      );
    }
    render(<Changing />);
    const button = screen.getByRole('button');
    fireEvent.pointerOver(button);
    fireEvent.click(button);
    await settle();
    expect(shownText()).toBe('Unlock seed');
  });
});

describe('Escape', () => {
  test('dismisses a visible hovered label before the overlay sees the key', () => {
    const onOverlayEscape = mock();
    render(<Harness onOverlayEscape={onOverlayEscape} />);

    fireEvent.pointerOver(host());
    fireEvent.keyDown(document.body, { key: 'Escape' });

    expect(host().hasAttribute(TIP_DISMISSED_ATTRIBUTE)).toBe(true);
    expect(shownText()).toBeNull();
    expect(onOverlayEscape).not.toHaveBeenCalled();

    // Nothing left to dismiss: the next Escape belongs to the overlay.
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onOverlayEscape).toHaveBeenCalledTimes(1);
  });

  test('a label still inside its reveal delay does not swallow Escape', () => {
    const onOverlayEscape = mock();
    render(<Harness onOverlayEscape={onOverlayEscape} />);
    labelVisibility = 'hidden';

    fireEvent.pointerOver(host());
    fireEvent.keyDown(document.body, { key: 'Escape' });

    expect(host().hasAttribute(TIP_DISMISSED_ATTRIBUTE)).toBe(false);
    expect(onOverlayEscape).toHaveBeenCalledTimes(1);
  });

  test('stays dismissed while hovered, including over its own children, and re-arms once hover leaves', () => {
    render(<Harness onOverlayEscape={mock()} />);
    fireEvent.pointerOver(host());
    fireEvent.keyDown(document.body, { key: 'Escape' });

    const icon = host().querySelector('svg');
    if (!icon) throw new Error('missing icon');
    fireEvent.pointerOver(icon);
    expect(host().hasAttribute(TIP_DISMISSED_ATTRIBUTE)).toBe(true);
    expect(shownText()).toBeNull();

    fireEvent.pointerOut(host(), { relatedTarget: null });
    expect(host().hasAttribute(TIP_DISMISSED_ATTRIBUTE)).toBe(false);
    fireEvent.pointerOver(host());
    expect(shownText()).toBe('Close templates');
  });

  test('a dismissed label that still holds focus re-arms only after focus leaves too', async () => {
    render(<Harness onOverlayEscape={mock()} />);
    fireEvent.pointerOver(host());
    fireEvent.keyDown(document.body, { key: 'Escape' });
    host().focus();

    fireEvent.pointerOut(host(), { relatedTarget: null });
    expect(host().hasAttribute(TIP_DISMISSED_ATTRIBUTE)).toBe(true);

    await act(async () => {
      screen.getByRole('button', { name: 'Other' }).focus();
      await Promise.resolve();
    });
    expect(host().hasAttribute(TIP_DISMISSED_ATTRIBUTE)).toBe(false);
  });

  test('ignores Escape during IME composition and when no label is showing', () => {
    const onOverlayEscape = mock();
    render(<Harness onOverlayEscape={onOverlayEscape} />);

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onOverlayEscape).toHaveBeenCalledTimes(1);

    fireEvent.pointerOver(host());
    fireEvent.keyDown(document.body, { key: 'Escape', isComposing: true });
    expect(host().hasAttribute(TIP_DISMISSED_ATTRIBUTE)).toBe(false);
  });

  test('a nested native modal owns Escape: a label behind it neither shows nor takes the key; its own labels do', () => {
    // happy-dom has no :modal; here every open dialog is a native modal.
    spyOn(document, 'querySelectorAll').mockImplementation((selector: string) => (
      document.documentElement.querySelectorAll(selector === 'dialog:modal' ? 'dialog[open]' : selector)
    ));
    function Nested({ onOverlayEscape }: { onOverlayEscape: () => void }) {
      useTooltipDismiss();
      useOverlayEscape(onOverlayEscape);
      const [inner, setInner] = useState(false);
      return (
        <>
          <dialog open>
            <button type="button" data-tip="Outer label">outer</button>
            <button type="button" onClick={() => { setInner(true); }}>open inner</button>
          </dialog>
          {inner ? (
            <dialog open>
              <button type="button">inner</button>
              <button type="button" data-tip="Inner label">inner tip</button>
            </dialog>
          ) : null}
        </>
      );
    }
    const onOverlayEscape = mock();
    render(<Nested onOverlayEscape={onOverlayEscape} />);
    const outer = screen.getByRole('button', { name: 'outer' });
    fireEvent.pointerOver(outer);
    expect(shownText()).toBe('Outer label');

    // showModal moves focus into the new, topmost modal.
    fireEvent.click(screen.getByRole('button', { name: 'open inner' }));
    const inner = screen.getByRole('button', { name: 'inner' });
    act(() => { inner.focus(); });
    expect(shownText()).toBeNull();
    fireEvent.keyDown(inner, { key: 'Escape' });
    expect(onOverlayEscape).toHaveBeenCalledTimes(1);
    expect(outer.hasAttribute(TIP_DISMISSED_ATTRIBUTE)).toBe(false);

    const innerTip = screen.getByRole('button', { name: 'inner tip' });
    fireEvent.pointerOver(innerTip);
    expect(shownText()).toBe('Inner label');
    expect(label()?.closest('dialog')?.contains(innerTip)).toBe(true);
  });
});

// Two hosts, as in a scrolled list, with an Escape owner around them.
function Rows({ onOverlayEscape }: { onOverlayEscape: () => void }) {
  useTooltipDismiss();
  useOverlayEscape(onOverlayEscape);
  const [present, setPresent] = useState(true);
  return (
    <div>
      {present ? <button type="button" data-tip="First row">first</button> : null}
      <button type="button" data-tip="Second row">second</button>
      <button type="button" onClick={() => { setPresent(false); }}>remove</button>
    </div>
  );
}

describe('a host clipped out of view', () => {
  test('one observer at a time, for the intended host only, released with it and on unmount', () => {
    const view = render(<Rows onOverlayEscape={mock()} />);
    expect(FakeIntersectionObserver.instances).toHaveLength(0);
    const first = screen.getByRole('button', { name: 'first' });
    const second = screen.getByRole('button', { name: 'second' });

    fireEvent.pointerOver(first);
    expect(liveObservers().map((observer) => observer.targets)).toEqual([[first]]);
    fireEvent.pointerOver(second);
    expect(liveObservers().map((observer) => observer.targets)).toEqual([[second]]);
    // No candidate left: nothing observed.
    fireEvent.pointerOut(second, { relatedTarget: null });
    expect(liveObservers()).toHaveLength(0);

    fireEvent.pointerOver(first);
    expect(liveObservers()).toHaveLength(1);
    view.unmount();
    expect(liveObservers()).toHaveLength(0);
  });

  test('a wholly clipped host gives up its label, so Escape passes on; back in view it shows again', () => {
    const onOverlayEscape = mock();
    render(<Rows onOverlayEscape={onOverlayEscape} />);
    const first = screen.getByRole('button', { name: 'first' });
    fireEvent.pointerOver(first);
    expect(shownText()).toBe('First row');
    const [observer] = liveObservers();
    if (!observer) throw new Error('missing observer');

    // Computed visibility still reads visible, as Chrome 156 reports a label
    // CSS strongly hides (position-visibility).
    observer.report(false);
    expect(shownText()).toBeNull();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onOverlayEscape).toHaveBeenCalledTimes(1);
    // Not dismissed: the host was out of view, not declined.
    expect(first.hasAttribute(TIP_DISMISSED_ATTRIBUTE)).toBe(false);
    expect(liveObservers()).toEqual([observer]);

    observer.report(true);
    expect(shownText()).toBe('First row');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(first.hasAttribute(TIP_DISMISSED_ATTRIBUTE)).toBe(true);
    expect(onOverlayEscape).toHaveBeenCalledTimes(1);
  });

  test('a clipped host’s label leaves the top layer; returning re-raises it', () => {
    const { open, restore } = installPopoverApi();
    try {
      render(<Rows onOverlayEscape={mock()} />);
      fireEvent.pointerOver(screen.getByRole('button', { name: 'first' }));
      const node = label();
      if (!node) throw new Error('missing label');
      expect(open.has(node)).toBe(true);
      const [observer] = liveObservers();
      if (!observer) throw new Error('missing observer');
      observer.report(false);
      expect(open.has(node)).toBe(false);
      observer.report(true);
      expect(open.has(node)).toBe(true);
      expect(shownText()).toBe('First row');
    } finally {
      cleanup();
      restore();
    }
  });

  test('a clipped host stays watched: removing it releases its observer', async () => {
    render(<Rows onOverlayEscape={mock()} />);
    fireEvent.pointerOver(screen.getByRole('button', { name: 'first' }));
    const [observer] = liveObservers();
    if (!observer) throw new Error('missing observer');
    observer.report(false);
    fireEvent.click(screen.getByRole('button', { name: 'remove' }));
    await settle();
    expect(observer.disconnected).toBe(true);
    expect(liveObservers()).toHaveLength(0);
    expect(shownText()).toBeNull();
  });

  test('a queued report about a host no longer intended changes nothing', () => {
    render(<Rows onOverlayEscape={mock()} />);
    fireEvent.pointerOver(screen.getByRole('button', { name: 'first' }));
    const [stale] = liveObservers();
    if (!stale) throw new Error('missing observer');
    fireEvent.pointerOver(screen.getByRole('button', { name: 'second' }));
    expect(shownText()).toBe('Second row');
    stale.report(false);
    expect(shownText()).toBe('Second row');
  });

  test('without IntersectionObserver labels keep working', () => {
    Reflect.deleteProperty(globalThis, 'IntersectionObserver');
    const onOverlayEscape = mock();
    render(<Rows onOverlayEscape={onOverlayEscape} />);
    const first = screen.getByRole('button', { name: 'first' });
    fireEvent.pointerOver(first);
    expect(shownText()).toBe('First row');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(first.hasAttribute(TIP_DISMISSED_ATTRIBUTE)).toBe(true);
    expect(onOverlayEscape).not.toHaveBeenCalled();
  });

  test('a queued intersection after cleanup cannot restore a label on a retained host', () => {
    const external = document.createElement('button');
    external.setAttribute('data-tip', 'External label');
    document.body.append(external);
    function Lifecycle() {
      useTooltipDismiss();
      return null;
    }
    const view = render(<Lifecycle />);
    try {
      fireEvent.pointerOver(external);
      const [stale] = liveObservers();
      if (!stale) throw new Error('missing observer');
      stale.report(false);
      view.unmount();
      stale.report(true);
      expect(label()).toBeNull();
      expect(liveObservers()).toHaveLength(0);
    } finally {
      view.unmount();
      external.remove();
    }
  });
});

function ClickHarness({ onLock, onAncestor, onOutside }: { onLock: () => void; onAncestor: () => void; onOutside: () => void }) {
  useTooltipDismiss();
  // An outside-pointer owner the way useOutsidePointer is: document bubble.
  useEffect(() => {
    document.addEventListener('pointerdown', onOutside);
    return () => { document.removeEventListener('pointerdown', onOutside); };
  }, [onOutside]);
  return (
    // The wrapper's onClick probes ancestor activation.
    <div onClick={onAncestor}>
      <button type="button" aria-label="Lock seed" data-tip="Lock the seed" onClick={onLock}>L</button>
    </div>
  );
}

describe('presses on the label', () => {
  test('neither activate anything nor count as an outside pointer', () => {
    const onLock = mock();
    const onAncestor = mock();
    const onOutside = mock();
    render(<ClickHarness onLock={onLock} onAncestor={onAncestor} onOutside={onOutside} />);
    const lock = screen.getByRole('button', { name: 'Lock seed' });
    fireEvent.pointerOver(lock);
    const node = label();
    if (!node) throw new Error('missing label');

    fireEvent.pointerDown(node);
    fireEvent.mouseDown(node);
    fireEvent.click(node);
    fireEvent.doubleClick(node);

    expect(onLock).not.toHaveBeenCalled();
    expect(onAncestor).not.toHaveBeenCalled();
    expect(onOutside).not.toHaveBeenCalled();
    // Still showing: a press is reading, not leaving.
    expect(shownText()).toBe('Lock the seed');
  });

  test('presses on the host itself still go through', () => {
    const onLock = mock();
    render(<ClickHarness onLock={onLock} onAncestor={mock()} onOutside={mock()} />);
    const lock = screen.getByRole('button', { name: 'Lock seed' });
    fireEvent.pointerOver(lock);
    fireEvent.pointerDown(lock);
    fireEvent.click(lock);
    expect(onLock).toHaveBeenCalledTimes(1);
  });

  test('unmounting the lifecycle removes the label', () => {
    const view = render(<ClickHarness onLock={mock()} onAncestor={mock()} onOutside={mock()} />);
    fireEvent.pointerOver(screen.getByRole('button', { name: 'Lock seed' }));
    expect(label()).not.toBeNull();
    view.unmount();
    expect(label()).toBeNull();
  });
});

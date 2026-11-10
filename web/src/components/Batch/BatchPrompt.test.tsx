import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect, useRef, useState } from 'react';
import BatchPrompt from './BatchPrompt';

// Interaction lifecycle only. Where the card lands (flip, edge clearance,
// following the prompt through scroll) is native anchor positioning and is
// asserted in a real browser: web/e2e/native-anchors.spec.ts. The card opens
// only from the batch More menu; here a button stands in for that item.

const PROMPT = 'A long prompt that the batch header truncates to a single line of text';
const originalMatchMedia = window.matchMedia.bind(window);
const descriptors = {
  scrollWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth'),
  clientWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth'),
};

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

// happy-dom has no layout: every element reports a 600px scroll width inside a
// 200px box, i.e. the prompt is truncated.
function installTruncation(): void {
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 200 });
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
  installHover(true);
  installTruncation();
  FakeIntersectionObserver.instances = [];
  Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, writable: true, value: FakeIntersectionObserver });
});

afterEach(() => {
  cleanup();
  window.matchMedia = originalMatchMedia;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, key);
  }
  if (originalIntersectionObserver === undefined) Reflect.deleteProperty(globalThis, 'IntersectionObserver');
  else Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, writable: true, value: originalIntersectionObserver });
});

// The per-instance anchor name an element declares (CSS reads it as
// anchor-name on a source and position-anchor on the card).
function nameOf(element: Element | null): string {
  return element instanceof HTMLElement ? element.style.getPropertyValue('--prompt-anchor') : '';
}

function prompt(): HTMLElement {
  const text = screen.getByText(PROMPT, { selector: 'span' });
  const host = text.parentElement;
  if (!host) throw new Error('missing prompt host');
  return host;
}

async function wait(ms: number): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

// The owner (BatchView): a More button that opens the card, which reports
// truncation up and asks to close.
function Owner({ text = PROMPT, onTruncated }: { text?: string; onTruncated?: (truncated: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button ref={moreRef} type="button" onClick={() => { setOpen(true); }}>More actions</button>
      <BatchPrompt prompt={text} open={open} onClose={() => { setOpen(false); }} onTruncatedChange={(next) => { onTruncated?.(next); }} returnFocusRef={moreRef} />
      <button type="button">elsewhere</button>
    </>
  );
}

function card(): HTMLElement {
  return screen.getByRole('dialog', { name: 'Full prompt' });
}

async function openCard(): Promise<HTMLElement> {
  const more = screen.getByRole('button', { name: 'More actions' });
  act(() => { more.focus(); });
  fireEvent.click(more);
  await flush();
  return card();
}

// An overlay owning Escape the way useModalChrome does: document capture,
// honouring defaultPrevented.
function WithOverlay({ onOverlayEscape }: { onOverlayEscape: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) onOverlayEscape();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => { document.removeEventListener('keydown', onKeyDown, true); };
  }, [onOverlayEscape]);
  return <Owner />;
}

describe('BatchPrompt full-prompt card', () => {
  test('reports whether the prompt is truncated', () => {
    const reports: boolean[] = [];
    render(<Owner onTruncated={(next) => { reports.push(next); }} />);
    expect(reports.at(-1)).toBe(true);
    cleanup();
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get: () => 100 });
    const short: boolean[] = [];
    render(<Owner text="Short" onTruncated={(next) => { short.push(next); }} />);
    expect(short.at(-1)).toBe(false);
  });

  test('a card whose prompt fits again closes for good: it does not come back when the prompt truncates again', async () => {
    // A ResizeObserver the test drives (a rotation or a window resize).
    const observers: (() => void)[] = [];
    const originalResizeObserver = Reflect.get(globalThis, 'ResizeObserver') as unknown;
    class ManualResizeObserver {
      private readonly callback: () => void;
      constructor(callback: () => void) { this.callback = callback; observers.push(() => { this.callback(); }); }
      observe(): void { /* driven by the test */ }
      unobserve(): void { /* unused */ }
      disconnect(): void { /* unused */ }
    }
    Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, writable: true, value: ManualResizeObserver });
    try {
      render(<Owner />);
      await openCard();
      // The prompt now fits.
      Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get: () => 100 });
      act(() => { for (const notify of observers) notify(); });
      await wait(400);
      expect(screen.queryByRole('dialog', { name: 'Full prompt' }) === null).toBe(true);
      // It truncates again: nobody chose Show full prompt, so no card.
      Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get: () => 600 });
      act(() => { for (const notify of observers) notify(); });
      await wait(400);
      expect(screen.queryByRole('dialog', { name: 'Full prompt' }) === null).toBe(true);
    } finally {
      if (originalResizeObserver === undefined) Reflect.deleteProperty(globalThis, 'ResizeObserver');
      else Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, writable: true, value: originalResizeObserver });
    }
  });

  test('no implicit trigger: resting the pointer, focus and a tap open nothing, and the prompt is no tab stop', async () => {
    render(<Owner />);
    fireEvent.mouseEnter(prompt(), { clientX: 40, clientY: 30 });
    fireEvent.mouseMove(prompt(), { clientX: 42, clientY: 31 });
    await wait(1000);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(prompt().hasAttribute('tabindex')).toBe(false);
    act(() => { prompt().focus(); });
    installHover(false);
    fireEvent.pointerDown(prompt(), { pointerType: 'touch' });
    fireEvent.click(prompt());
    await flush();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(nameOf(prompt())).toBe('');
  });

  test('opening shows a non-modal dialog named Full prompt, anchored to the prompt, holding focus', async () => {
    render(<Owner />);
    const opened = await openCard();
    expect(opened.textContent).toBe(PROMPT);
    expect(opened.getAttribute('aria-modal')).toBe('false');
    expect(document.activeElement === opened).toBe(true);
    expect(nameOf(prompt())).not.toBe('');
    expect(nameOf(opened)).toBe(nameOf(prompt()));
  });

  test('Escape closes it and returns focus to the More button', async () => {
    render(<Owner />);
    await openCard();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await flush();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement === screen.getByRole('button', { name: 'More actions' })).toBe(true);
  });

  test('a press outside closes it; a press inside does not', async () => {
    render(<Owner />);
    const opened = await openCard();
    fireEvent.pointerDown(opened);
    await flush();
    expect(screen.getByRole('dialog', { name: 'Full prompt' })).toBeTruthy();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'elsewhere' }));
    await flush();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('its prompt scrolling out of view closes it', async () => {
    render(<Owner />);
    await openCard();
    expect(liveObservers()).toHaveLength(1);
    act(() => { liveObservers()[0]?.report(false); });
    await flush();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(liveObservers()).toHaveLength(0);
  });

  test('with the More button gone, closing hands focus along the successor chain', async () => {
    // No More button to return to: the row's successor takes focus.
    function Direct() {
      const [open, setOpen] = useState(true);
      const gone = useRef<HTMLElement | null>(null);
      return <BatchPrompt prompt={PROMPT} open={open} onClose={() => { setOpen(false); }} returnFocusRef={gone} />;
    }
    render(
      <div data-testid="canvas-scroller" tabIndex={0}>
        <div data-batch-id="a"><section data-batch-id="a"><Direct /></section></div>
        <div data-batch-id="b"><section data-batch-id="b"><button type="button" id="next-row">next row</button></section></div>
      </div>,
    );
    await flush();
    expect(document.activeElement === card()).toBe(true);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await flush();
    expect(document.activeElement?.id).toBe('next-row');
  });

  test('the row unmounting while open removes the card and hands focus on', async () => {
    function Row({ mounted }: { mounted: boolean }) {
      return (
        <div data-testid="canvas-scroller" tabIndex={0}>
          {mounted && <div data-batch-id="a"><section data-batch-id="a"><Owner /></section></div>}
          <div data-batch-id="b"><section data-batch-id="b"><button type="button" id="next-row">next row</button></section></div>
        </div>
      );
    }
    const view = render(<Row mounted />);
    await openCard();
    view.rerender(<Row mounted={false} />);
    await flush();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement?.id).toBe('next-row');
  });

  test('a card whose prompt a modal has since made inert leaves Escape to that modal', async () => {
    const onOverlayEscape = mock();
    const view = render(<WithOverlay onOverlayEscape={onOverlayEscape} />);
    await openCard();
    view.container.setAttribute('inert', '');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onOverlayEscape).toHaveBeenCalledTimes(1);
  });

  test('Escape that another owner already took, or that ends an IME composition, is left alone', async () => {
    render(<Owner />);
    await openCard();
    const taken = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    taken.preventDefault();
    act(() => { window.dispatchEvent(taken); });
    fireEvent.keyDown(document.body, { key: 'Escape', isComposing: true });
    await flush();
    expect(screen.getByRole('dialog', { name: 'Full prompt' })).toBeTruthy();
  });

  test('closing plays the shared fade: the card is stamped data-closing, then unmounts', async () => {
    render(<Owner />);
    const opened = await openCard();
    expect(opened.hasAttribute('data-closing')).toBe(false);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    // Closed for assistive tech at once; the visual card stays through its exit.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opened.isConnected).toBe(true);
    expect(opened.getAttribute('data-closing')).toBe('true');
    expect(opened.getAttribute('aria-hidden')).toBe('true');
    await wait(250);
    expect(opened.isConnected).toBe(false);
    expect(nameOf(prompt())).toBe('');
  });

  test('repeated prompts declare their own names; only the shown one binds', async () => {
    const other = `${PROMPT} (again)`;
    render(
      <>
        <Owner />
        <BatchPrompt prompt={other} />
      </>,
    );
    const second = screen.getByText(other, { selector: 'span' }).parentElement;
    const opened = await openCard();
    expect(nameOf(prompt())).toBe(nameOf(opened));
    expect(nameOf(second)).toBe('');
  });

  test('an untruncated prompt never shows the card, even when asked', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get: () => 100 });
    render(<BatchPrompt prompt="Short" open />);
    await flush();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import BatchPrompt from './BatchPrompt';

// Interaction lifecycle only. Where the card lands (flip, edge clearance,
// following the prompt through scroll) is native anchor positioning and is
// asserted in a real browser: web/e2e/native-anchors.spec.ts.

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

function cursor(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[aria-hidden="true"]:not([role])');
}

async function wait(ms: number): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

// Past the 400ms dwell.
const dwell = () => wait(450);
// Past the 200ms leave grace.
const grace = () => wait(250);

async function openByDwell(): Promise<HTMLElement> {
  fireEvent.mouseEnter(prompt(), { clientX: 40, clientY: 30 });
  await dwell();
  return screen.getByRole('tooltip');
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
  return <BatchPrompt prompt={PROMPT} />;
}

describe('BatchPrompt full-text card', () => {
  test('a dwell opens a card anchored to a stand-in at the pointer, which follows the pointer', async () => {
    render(<BatchPrompt prompt={PROMPT} />);
    fireEvent.mouseEnter(prompt(), { clientX: 40, clientY: 30 });
    expect(screen.queryByRole('tooltip')).toBeNull();
    await dwell();

    const card = screen.getByRole('tooltip');
    expect(card.textContent).toBe(PROMPT);
    expect(card.getAttribute('data-anchor')).toBe('pointer');
    // Page layer, under the toast stack: a declared name, not a popover.
    expect(card.hasAttribute('popover')).toBe(false);
    expect(card.getAttribute('data-anchored')).toBe('name');
    expect(card.parentElement).toBe(document.body);
    expect(prompt().getAttribute('aria-describedby')).toBe(card.id);
    // The card itself never carries coordinates; only the stand-in does.
    expect(card.style.left).toBe('');
    expect(card.style.top).toBe('');
    const stand = cursor();
    expect(stand?.style.left).toBe('40px');
    expect(stand?.style.top).toBe('30px');
    // The stand-in is the active source: it alone declares the card's name.
    const name = nameOf(card);
    expect(name).toMatch(/^--prompt-[\w-]+$/);
    expect(nameOf(stand)).toBe(name);
    expect(nameOf(prompt())).toBe('');
    // Pointer mode is dismissed by scroll instead: no liveness observer.
    expect(liveObservers()).toHaveLength(0);

    fireEvent.mouseMove(prompt(), { clientX: 90, clientY: 35 });
    expect(stand?.style.left).toBe('90px');
    expect(stand?.style.top).toBe('35px');

    // Leaving closes it once the travel grace has passed.
    fireEvent.mouseLeave(prompt());
    expect(screen.queryByRole('tooltip')).not.toBeNull();
    await grace();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  test('the pointer can travel onto the card and stay there to read; leaving both closes it', async () => {
    render(<BatchPrompt prompt={PROMPT} />);
    const card = await openByDwell();
    fireEvent.mouseLeave(prompt());
    fireEvent.pointerEnter(card);
    const stand = cursor();
    const position = stand?.getAttribute('style');
    fireEvent.mouseMove(card, { clientX: 320, clientY: 240 });
    expect(stand?.getAttribute('style')).toBe(position);
    await grace();
    expect(screen.getByRole('tooltip')).toBe(card);

    // Scrolling a long prompt inside the card is reading, not a dismissal.
    fireEvent.scroll(card);
    expect(screen.queryByRole('tooltip')).not.toBeNull();

    // Back onto the prompt and off again: still one card, then gone.
    fireEvent.pointerLeave(card);
    // React's logical portal ancestry can omit a second parent mouseenter.
    fireEvent.mouseMove(prompt(), { clientX: 60, clientY: 30 });
    await grace();
    expect(screen.getByRole('tooltip')).toBe(card);
    fireEvent.mouseLeave(prompt());
    await grace();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  test('a scroll dismisses the pointer card: the point it was opened at is stale', async () => {
    render(<BatchPrompt prompt={PROMPT} />);
    await openByDwell();
    fireEvent.scroll(window);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  test('Escape closes a pointer card while focus is elsewhere, before any overlay sees the key', async () => {
    const onOverlayEscape = mock();
    render(<WithOverlay onOverlayEscape={onOverlayEscape} />);
    await openByDwell();
    expect(document.activeElement).toBe(document.body);

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(onOverlayEscape).not.toHaveBeenCalled();

    // Nothing left to dismiss: the next Escape belongs to the overlay.
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onOverlayEscape).toHaveBeenCalledTimes(1);
  });

  test('a dismissed card stays closed while the pointer rests on the prompt, and re-arms once it leaves', async () => {
    render(<BatchPrompt prompt={PROMPT} />);
    await openByDwell();
    fireEvent.keyDown(document.body, { key: 'Escape' });

    // Still over the prompt: neither a move nor a fresh enter reopens it.
    fireEvent.mouseMove(prompt(), { clientX: 50, clientY: 30 });
    fireEvent.mouseEnter(prompt(), { clientX: 50, clientY: 30 });
    await dwell();
    expect(screen.queryByRole('tooltip')).toBeNull();

    fireEvent.mouseLeave(prompt());
    await openByDwell();
    expect(screen.getByRole('tooltip')).toBeTruthy();
  });

  test('Escape that another owner already took, or that ends an IME composition, is left alone', async () => {
    render(<BatchPrompt prompt={PROMPT} />);
    await openByDwell();
    fireEvent.keyDown(document.body, { key: 'Escape', isComposing: true });
    expect(screen.queryByRole('tooltip')).not.toBeNull();

    const taken = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    taken.preventDefault();
    document.body.dispatchEvent(taken);
    expect(screen.queryByRole('tooltip')).not.toBeNull();
  });

  test('focus opens the card against the prompt itself, which survives scroll and closes on Escape', () => {
    const onOverlayEscape = mock();
    render(<WithOverlay onOverlayEscape={onOverlayEscape} />);
    act(() => { prompt().focus(); });

    const card = screen.getByRole('tooltip');
    expect(card.getAttribute('data-anchor')).toBe('element');
    expect(cursor()).toBeNull();
    // The prompt is the active source and declares the card's name.
    expect(nameOf(card)).not.toBe('');
    expect(nameOf(prompt())).toBe(nameOf(card));

    // Anchored to an element, the card follows it; scrolling is not a dismissal.
    fireEvent.scroll(window);
    expect(screen.getByRole('tooltip')).toBeTruthy();

    fireEvent.keyDown(prompt(), { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(onOverlayEscape).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(prompt());
  });

  test('a focused prompt clipped wholly out of view closes its hidden card and stops owning Escape', () => {
    const onOverlayEscape = mock();
    render(<WithOverlay onOverlayEscape={onOverlayEscape} />);
    act(() => { prompt().focus(); });
    expect(screen.getByRole('tooltip')).toBeTruthy();
    // One observer, on the prompt, only while the element card is open.
    const [observer] = liveObservers();
    expect(liveObservers()).toHaveLength(1);
    expect(observer?.targets).toEqual([prompt()]);

    // Still intersecting: nothing changes.
    act(() => { observer?.report(true); });
    expect(screen.getByRole('tooltip')).toBeTruthy();

    act(() => { observer?.report(false); });
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(document.activeElement).toBe(prompt());
    expect(liveObservers()).toHaveLength(0);
    // Nothing visible is left to dismiss: Escape belongs to the overlay.
    fireEvent.keyDown(prompt(), { key: 'Escape' });
    expect(onOverlayEscape).toHaveBeenCalledTimes(1);

    // A fresh focus opens it again, observed again.
    act(() => { prompt().blur(); });
    act(() => { prompt().focus(); });
    expect(screen.getByRole('tooltip').getAttribute('data-anchor')).toBe('element');
    expect(liveObservers()).toHaveLength(1);
    // A queued report from the released observer cannot close the new card.
    act(() => { observer?.report(false); });
    expect(screen.getByRole('tooltip').getAttribute('data-anchor')).toBe('element');
  });

  test('closing an element card by blur or unmount releases its observer', () => {
    const view = render(
      <>
        <BatchPrompt prompt={PROMPT} />
        <button type="button">elsewhere</button>
      </>,
    );
    act(() => { prompt().focus(); });
    expect(liveObservers()).toHaveLength(1);
    act(() => { screen.getByRole('button', { name: 'elsewhere' }).focus(); });
    expect(liveObservers()).toHaveLength(0);
    act(() => { prompt().focus(); });
    expect(liveObservers()).toHaveLength(1);
    view.unmount();
    expect(liveObservers()).toHaveLength(0);
  });

  test('a card whose prompt a modal has since made inert leaves Escape to that modal', async () => {
    const onOverlayEscape = mock();
    const view = render(<WithOverlay onOverlayEscape={onOverlayEscape} />);
    await openByDwell();
    // The custom-modal sweep: the prompt's top-level subtree goes inert.
    view.container.setAttribute('inert', '');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onOverlayEscape).toHaveBeenCalledTimes(1);
  });

  test('repeated prompts declare their own names; only the active one binds', () => {
    const other = `${PROMPT} (again)`;
    render(
      <>
        <BatchPrompt prompt={PROMPT} />
        <BatchPrompt prompt={other} />
      </>,
    );
    const second = screen.getByText(other, { selector: 'span' }).parentElement;
    if (!second) throw new Error('missing second prompt host');
    act(() => { prompt().focus(); });
    const first = nameOf(screen.getByRole('tooltip'));
    expect(nameOf(prompt())).toBe(first);
    expect(nameOf(second)).toBe('');

    act(() => { second.focus(); });
    const next = nameOf(screen.getByRole('tooltip'));
    expect(next).not.toBe(first);
    expect(nameOf(second)).toBe(next);
    expect(nameOf(prompt())).toBe('');
  });

  test('a focused prompt card takes Escape before an older hovered card', async () => {
    const other = `${PROMPT} (focused)`;
    render(<><BatchPrompt prompt={PROMPT} /><BatchPrompt prompt={other} /></>);
    await openByDwell();
    const second = screen.getByText(other, { selector: 'span' }).parentElement;
    if (!second) throw new Error('missing second prompt');
    act(() => { second.focus(); });
    expect(screen.getAllByRole('tooltip')).toHaveLength(2);
    fireEvent.keyDown(second, { key: 'Escape' });
    expect(screen.getAllByRole('tooltip').map((card) => card.textContent)).toEqual([PROMPT]);
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  test('blur closes a focus-opened card; a new focus reopens it', () => {
    render(
      <>
        <BatchPrompt prompt={PROMPT} />
        <button type="button">elsewhere</button>
      </>,
    );
    act(() => { prompt().focus(); });
    expect(screen.getByRole('tooltip')).toBeTruthy();
    act(() => { screen.getByRole('button', { name: 'elsewhere' }).focus(); });
    expect(screen.queryByRole('tooltip')).toBeNull();
    act(() => { prompt().focus(); });
    expect(screen.getByRole('tooltip').getAttribute('data-anchor')).toBe('element');
  });

  test('the pointer takes over a focus-opened card at once, and leaving closes it', async () => {
    render(<BatchPrompt prompt={PROMPT} />);
    act(() => { prompt().focus(); });
    fireEvent.mouseEnter(prompt(), { clientX: 12, clientY: 18 });
    const card = screen.getByRole('tooltip');
    expect(card.getAttribute('data-anchor')).toBe('pointer');
    expect(cursor()?.style.left).toBe('12px');
    // The name moves to the new source; the prompt no longer declares it.
    expect(nameOf(cursor())).toBe(nameOf(card));
    expect(nameOf(prompt())).toBe('');
    fireEvent.mouseLeave(prompt());
    await grace();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  test('touch: a tap toggles the element card and never starts a dwell', async () => {
    installHover(false);
    render(<BatchPrompt prompt={PROMPT} />);
    fireEvent.mouseEnter(prompt(), { clientX: 40, clientY: 30 });
    await dwell();
    expect(screen.queryByRole('tooltip')).toBeNull();

    fireEvent.click(prompt());
    expect(screen.getByRole('tooltip').getAttribute('data-anchor')).toBe('element');
    fireEvent.click(prompt());
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  test('unmounting mid-dwell or while open leaves no card behind', async () => {
    const view = render(<BatchPrompt prompt={PROMPT} />);
    fireEvent.mouseEnter(prompt(), { clientX: 40, clientY: 30 });
    view.unmount();
    await dwell();
    expect(screen.queryByRole('tooltip')).toBeNull();

    const again = render(<BatchPrompt prompt={PROMPT} />);
    await openByDwell();
    again.unmount();
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(cursor()).toBeNull();
  });

  test('an untruncated prompt never opens a card', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get: () => 100 });
    render(<BatchPrompt prompt="Short" />);
    const host = screen.getByText('Short', { selector: 'span' }).parentElement;
    if (!host) throw new Error('missing prompt host');
    fireEvent.mouseEnter(host, { clientX: 40, clientY: 30 });
    await dwell();
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(host.hasAttribute('tabindex')).toBe(false);
  });
});

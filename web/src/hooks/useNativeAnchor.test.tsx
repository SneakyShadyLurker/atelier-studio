import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, render } from '@testing-library/react';
import { useRef } from 'react';
import { popoverSourceSupported, useAnchoredPopover } from './useNativeAnchor';

// Geometry is the browser's (web/e2e/native-anchors.spec.ts). These cover the
// relationship and lifecycle only: when a panel is shown, with which implicit
// anchor, and how the platform closing it is told apart from our own hide.
// happy-dom has no Popover API, so a minimal one is installed per test.

const prototype = HTMLElement.prototype as unknown as Record<string, unknown>;
const nativeMatches = Reflect.get(Element.prototype, 'matches') as (this: Element, selector: string) => boolean;
const ownMatches = Object.getOwnPropertyDescriptor(Element.prototype, 'matches');

interface FakePopover {
  shows: { element: HTMLElement; source: HTMLElement | undefined }[];
  hides: HTMLElement[];
}

function installPopover({ readsSource }: { readsSource: boolean }): FakePopover {
  const open = new Set<Element>();
  const fake: FakePopover = { shows: [], hides: [] };
  Object.defineProperty(prototype, 'showPopover', {
    configurable: true,
    writable: true,
    value(this: HTMLElement, options?: ShowPopoverOptions) {
      // A real engine converts the dictionary first: reading `source` is what
      // an engine that supports it does, before any of its own checks.
      const source = readsSource ? options?.source : undefined;
      if (!this.hasAttribute('popover')) throw new DOMException('not a popover', 'NotSupportedError');
      open.add(this);
      fake.shows.push({ element: this, source });
    },
  });
  Object.defineProperty(prototype, 'hidePopover', {
    configurable: true,
    writable: true,
    value(this: HTMLElement) {
      open.delete(this);
      fake.hides.push(this);
      // A real toggle event is queued; dispatching it at once is the harsher
      // test of the stale-event guard.
      this.dispatchEvent(Object.assign(new Event('toggle'), { newState: 'closed', oldState: 'open' }));
    },
  });
  Object.defineProperty(Element.prototype, 'matches', {
    configurable: true,
    writable: true,
    value(this: Element, selector: string) {
      return selector === ':popover-open' ? open.has(this) : nativeMatches.call(this, selector);
    },
  });
  return fake;
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(prototype, 'showPopover');
  Reflect.deleteProperty(prototype, 'hidePopover');
  if (ownMatches) Object.defineProperty(Element.prototype, 'matches', ownMatches);
  else Reflect.deleteProperty(Element.prototype, 'matches');
});

describe('popoverSourceSupported', () => {
  test('false without the Popover API', () => {
    expect(popoverSourceSupported()).toBe(false);
  });

  test('true only when showPopover reads the source member', () => {
    installPopover({ readsSource: false });
    expect(popoverSourceSupported()).toBe(false);
    installPopover({ readsSource: true });
    expect(popoverSourceSupported()).toBe(true);
  });
});

function Panel({ active, onNativeClose, source = true }: { active: boolean; onNativeClose: () => void; source?: boolean }) {
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const props = useAnchoredPopover(panelRef, anchorRef, { active, onNativeClose });
  return (
    <>
      {source ? <button ref={anchorRef} type="button">trigger</button> : null}
      <div ref={panelRef} data-testid="panel" {...props} />
    </>
  );
}

// Lets the connection observer deliver its records.
async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe('useAnchoredPopover', () => {
  test('shows the panel as a manual popover anchored to its trigger, and hides it when inactive', () => {
    const fake = installPopover({ readsSource: true });
    const onNativeClose = mock();
    const view = render(<Panel active onNativeClose={onNativeClose} />);
    const panel = view.getByTestId('panel');
    expect(panel.getAttribute('popover')).toBe('manual');
    expect(panel.getAttribute('data-anchored')).toBe('source');
    expect(fake.shows).toEqual([{ element: panel, source: view.getByRole('button') }]);

    view.rerender(<Panel active={false} onNativeClose={onNativeClose} />);
    expect(fake.hides).toEqual([panel]);
    expect(panel.hasAttribute('popover')).toBe(false);
    // Our own hide is never reported as the platform closing the panel.
    expect(onNativeClose).not.toHaveBeenCalled();
  });

  test('the platform closing the open panel is reported to the owner', () => {
    installPopover({ readsSource: true });
    const onNativeClose = mock();
    const view = render(<Panel active onNativeClose={onNativeClose} />);
    view.getByTestId('panel').dispatchEvent(Object.assign(new Event('toggle'), { newState: 'closed', oldState: 'open' }));
    expect(onNativeClose).toHaveBeenCalledTimes(1);
  });

  test('an engine without source still gets a top-layer panel, left unanchored', () => {
    const fake = installPopover({ readsSource: false });
    const view = render(<Panel active onNativeClose={mock()} />);
    const panel = view.getByTestId('panel');
    expect(panel.getAttribute('popover')).toBe('manual');
    expect(panel.hasAttribute('data-anchored')).toBe(false);
    expect(fake.shows).toEqual([{ element: panel, source: undefined }]);
  });

  test('inactive (the phone sheet): an ordinary element, never shown', () => {
    const fake = installPopover({ readsSource: true });
    const view = render(<Panel active={false} onNativeClose={mock()} />);
    expect(view.getByTestId('panel').hasAttribute('popover')).toBe(false);
    expect(fake.shows).toEqual([]);
  });

  test('unmounting an open panel releases it without reporting a native close', () => {
    installPopover({ readsSource: true });
    const onNativeClose = mock();
    const view = render(<Panel active onNativeClose={onNativeClose} />);
    view.unmount();
    expect(onNativeClose).not.toHaveBeenCalled();
  });

  test('shown without a source: still a usable top-layer panel, left unanchored', async () => {
    const fake = installPopover({ readsSource: true });
    const onNativeClose = mock();
    const view = render(<Panel active source={false} onNativeClose={onNativeClose} />);
    const panel = view.getByTestId('panel');
    expect(panel.getAttribute('popover')).toBe('manual');
    expect(panel.hasAttribute('data-anchored')).toBe(false);
    expect(fake.shows).toEqual([{ element: panel, source: undefined }]);
    await settle();
    expect(onNativeClose).not.toHaveBeenCalled();
  });

  test('a source removed while open drops the anchor and is reported once; the panel stays shown for its exit', async () => {
    const fake = installPopover({ readsSource: true });
    const onNativeClose = mock();
    const view = render(<Panel active onNativeClose={onNativeClose} />);
    const panel = view.getByTestId('panel');
    expect(panel.getAttribute('data-anchored')).toBe('source');

    view.rerender(<Panel active source={false} onNativeClose={onNativeClose} />);
    await settle();
    // Unanchored: the centred fallback, never resolved against a removed box.
    expect(panel.hasAttribute('data-anchored')).toBe(false);
    expect(onNativeClose).toHaveBeenCalledTimes(1);
    // The owner's exit decides when it goes; the hook does not cut it short.
    expect(fake.hides).toEqual([]);
    expect(panel.getAttribute('popover')).toBe('manual');

    // Watched only while a source is bound: later churn reports nothing.
    const churn = document.createElement('div');
    act(() => { document.body.append(churn); });
    await settle();
    churn.remove();
    expect(onNativeClose).toHaveBeenCalledTimes(1);
  });

  test('a panel released before its source goes stops watching it', async () => {
    installPopover({ readsSource: true });
    const onNativeClose = mock();
    const view = render(<Panel active onNativeClose={onNativeClose} />);
    view.rerender(<Panel active={false} onNativeClose={onNativeClose} />);
    view.rerender(<Panel active={false} source={false} onNativeClose={onNativeClose} />);
    await settle();
    expect(onNativeClose).not.toHaveBeenCalled();
    expect(view.getByTestId('panel').hasAttribute('data-anchored')).toBe(false);
  });

  test('without source support a bound trigger is never watched or marked anchored', async () => {
    installPopover({ readsSource: false });
    const onNativeClose = mock();
    const view = render(<Panel active onNativeClose={onNativeClose} />);
    view.rerender(<Panel active source={false} onNativeClose={onNativeClose} />);
    await settle();
    expect(view.getByTestId('panel').hasAttribute('data-anchored')).toBe(false);
    expect(onNativeClose).not.toHaveBeenCalled();
  });
});

import { afterEach, describe, expect, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { focusableInside, tabbableInside, useFocusTrap } from './useFocusTrap';

afterEach(() => {
  cleanup();
});

// The AxisDropdown shape: a close button and filter, a roving list whose only
// tab stop is the active row, plus controls the trap must never land on.
function RovingTrapHarness() {
  const ref = useRef<HTMLDivElement | null>(null);
  useFocusTrap(ref, { active: true });
  return (
    <>
      <button type="button">outside before</button>
      <div ref={ref}>
        <button type="button">Close</button>
        <input aria-label="Filter" />
        <button type="button" tabIndex={0}>Random</button>
        <button type="button" tabIndex={-1}>serene</button>
        <button type="button" tabIndex={-1}>playful</button>
        <div hidden><button type="button">hidden action</button></div>
        <div inert><button type="button">inert action</button></div>
        <div aria-hidden="true"><button type="button">aria-hidden action</button></div>
      </div>
      <button type="button">outside after</button>
    </>
  );
}

function labels(nodes: readonly HTMLElement[]): string[] {
  return nodes.map((node) => node.getAttribute('aria-label') ?? node.textContent);
}

describe('tabbable vs focusable', () => {
  test('a native control with negative tabindex is focusable but never a tab stop', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <button>tab stop</button>
      <button tabindex="-1">roving row</button>
      <input tabindex="-1" aria-label="skipped input">
      <a href="/x" tabindex="-1">skipped link</a>
      <select tabindex="-2"><option>x</option></select>
      <div tabindex="0">custom</div>
      <input type="hidden">
    `;
    expect(labels(tabbableInside(root))).toEqual(['tab stop', 'custom']);
    expect(labels(focusableInside(root))).toContain('roving row');
  });

  test('hidden, inert and aria-hidden subtrees are neither focusable nor tabbable', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <button>visible</button>
      <div hidden><button>hidden</button></div>
      <div inert><button>inert</button></div>
      <div aria-hidden="true"><button>aria-hidden</button></div>
      <button hidden>self hidden</button>
    `;
    expect(labels(tabbableInside(root))).toEqual(['visible']);
    expect(labels(focusableInside(root))).toEqual(['visible']);
  });

  test('CSS display:none ancestors and visibility:hidden controls are neither focusable nor tabbable', () => {
    const root = document.body.appendChild(document.createElement('div'));
    root.innerHTML = `
      <button>visible</button>
      <div style="display: none"><span><button>display none</button></span></div>
      <div style="visibility: hidden"><button>visibility hidden</button></div>
      <button style="visibility: hidden">self hidden</button>
      <div style="visibility: hidden"><button style="visibility: visible">revealed</button></div>
    `;
    try {
      expect(labels(tabbableInside(root))).toEqual(['visible', 'revealed']);
      expect(labels(focusableInside(root))).toEqual(['visible', 'revealed']);
    } finally {
      root.remove();
    }
  });

  test('negative-tabindex exclusion uses the parsed value', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <button tabindex=" -1">spaced negative</button>
      <button tabindex="-0">negative zero</button>
    `;
    expect(labels(tabbableInside(root))).toEqual(['negative zero']);
    expect(labels(focusableInside(root))).toContain('spaced negative');
  });
});

// The PromptPicker shape: the popover ⇄ sheet switch replaces the trapped node
// under the same ref while the trap stays active.
function SwappingTrapHarness({ layout }: { layout: 'popover' | 'sheet' }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useFocusTrap(ref, { active: true, containerKey: layout });
  const panel = (
    <div ref={ref} data-layout={layout}>
      <button type="button">{`${layout} first`}</button>
      <button type="button">{`${layout} last`}</button>
    </div>
  );
  return (
    <>
      <button type="button">outside</button>
      {layout === 'sheet' ? <><button type="button">backdrop</button>{panel}</> : panel}
    </>
  );
}

describe('useFocusTrap container identity', () => {
  test('a containerKey change moves containment onto the replacement node and re-seats lost focus', () => {
    const { rerender } = render(<SwappingTrapHarness layout="popover" />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'popover first' }));

    rerender(<SwappingTrapHarness layout="sheet" />);
    const first = screen.getByRole('button', { name: 'sheet first' });
    const last = screen.getByRole('button', { name: 'sheet last' });
    // The focused node went away with the old panel; focus lands in the new one.
    expect(document.activeElement).toBe(first);

    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
  });

  test('a re-render without a key change neither re-binds nor moves focus', () => {
    const { rerender } = render(<SwappingTrapHarness layout="popover" />);
    const last = screen.getByRole('button', { name: 'popover last' });
    last.focus();

    rerender(<SwappingTrapHarness layout="popover" />);

    expect(document.activeElement).toBe(last);
  });
});

// The queue-clear shape: a control that removes itself while it holds focus,
// optionally beside a nested portalled control that lives outside the panel.
function RemovingTrapHarness({ portal = false }: { portal?: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [cleared, setCleared] = useState(false);
  useFocusTrap(ref, { active: true });
  return (
    <>
      <button type="button">outside</button>
      <div ref={ref}>
        <button type="button">Close</button>
        {cleared ? null : <button type="button" onClick={() => { setCleared(true); }}>Clear</button>}
        <button type="button">Done</button>
        {portal ? createPortal(<input aria-label="Nested field" />, document.body) : null}
      </div>
    </>
  );
}

async function flushObserver(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('useFocusTrap focused-control removal', () => {
  test('removing the focused control re-seats focus on the first tab stop inside', async () => {
    render(<RemovingTrapHarness />);
    await flushObserver();
    const clear = screen.getByRole('button', { name: 'Clear' });
    clear.focus();

    fireEvent.click(clear);

    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
    const close = screen.getByRole('button', { name: 'Close' });
    await waitFor(() => { expect(document.activeElement === close).toBe(true); });

    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(document.activeElement === screen.getByRole('button', { name: 'Done' })).toBe(true);
  });

  test('does not steal focus from a connected nested portalled control', async () => {
    render(<RemovingTrapHarness portal />);
    await flushObserver();
    const clear = screen.getByRole('button', { name: 'Clear' });
    clear.focus();
    const nested = screen.getByRole('textbox', { name: 'Nested field' });
    nested.focus();

    fireEvent.click(clear);
    await flushObserver();

    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
    expect(document.activeElement === nested).toBe(true);
  });

  test('does not move focus when an unrelated sibling is removed', async () => {
    render(<RemovingTrapHarness />);
    await flushObserver();
    const clear = screen.getByRole('button', { name: 'Clear' });
    clear.focus();
    const done = screen.getByRole('button', { name: 'Done' });
    done.focus();

    fireEvent.click(clear);
    await flushObserver();

    expect(document.activeElement === done).toBe(true);
  });
});

describe('useFocusTrap boundaries', () => {
  test('Tab from the last real tab stop wraps instead of walking past roving rows', () => {
    render(<RovingTrapHarness />);
    const random = screen.getByRole('button', { name: 'Random' });
    random.focus();

    fireEvent.keyDown(random, { key: 'Tab' });

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
  });

  test('Shift+Tab from the first tab stop wraps to the last real tab stop', () => {
    render(<RovingTrapHarness />);
    const close = screen.getByRole('button', { name: 'Close' });
    close.focus();

    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Random' }));
  });

  test('Tab from a programmatically focused roving row stays inside', () => {
    render(<RovingTrapHarness />);
    const playful = screen.getByRole('button', { name: 'playful' });
    playful.focus();

    fireEvent.keyDown(playful, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));

    const serene = screen.getByRole('button', { name: 'serene' });
    serene.focus();
    fireEvent.keyDown(serene, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Random' }));
  });
});

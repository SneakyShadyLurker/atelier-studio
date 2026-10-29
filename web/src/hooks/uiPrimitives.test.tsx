import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap, focusableInside } from './useFocusTrap';
import { useModalChrome } from './useModalChrome';
import { useOutsidePointer } from './useOutsidePointer';
import { runWhenReachable } from '../lib/focus';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function ModalHarness({ open, onCancel = mock() }: { open: boolean; onCancel?: () => void }) {
  const portalRef = useRef<HTMLDivElement | null>(null);
  useModalChrome({ open, onCancel, portalRef });
  if (!open) return null;
  return createPortal(
    <div>
      <div ref={portalRef} data-testid="modal-root">
        <button type="button">Modal action</button>
      </div>
      <button type="button">Outside modal in portal</button>
    </div>,
    document.body,
  );
}

function StatefulModalHarness({ open, onCancel = mock() }: { open: boolean; onCancel?: () => void }) {
  const portalRef = useRef<HTMLDivElement | null>(null);
  const [value, setValue] = useState('');
  useModalChrome({ open, onCancel: () => { if (value.length >= 0) onCancel(); }, portalRef });
  return (
    <>
      <button type="button">Open</button>
      {open ? (
        <div ref={portalRef} data-testid="stateful-modal-root">
          <label>
            Name
            <input value={value} onChange={(event) => { setValue(event.target.value); }} />
          </label>
        </div>
      ) : null}
    </>
  );
}

function FocusTrapHarness({ active = true, autoFocus }: { active?: boolean; autoFocus?: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useFocusTrap(ref, { active, ...(autoFocus === undefined ? {} : { autoFocus }) });
  return (
    <div ref={ref} role="dialog" tabIndex={-1}>
      <button type="button">First</button>
      <button type="button">Last</button>
    </div>
  );
}

function OutsidePointerHarness({ enabled = true, onOutside = mock() }: { enabled?: boolean; onOutside?: () => void }) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  useOutsidePointer([panelRef, triggerRef], onOutside, { enabled });
  return (
    <>
      <button ref={triggerRef} type="button">Trigger</button>
      <div ref={panelRef}>
        <button type="button">Inside</button>
      </div>
      <button type="button">Outside</button>
    </>
  );
}

describe('useModalChrome', () => {
  test('inerts and aria-hides every body sibling outside the portal root, then restores focus', async () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Open';
    document.body.appendChild(trigger);
    trigger.focus();

    const background = document.createElement('main');
    document.body.appendChild(background);

    const { rerender } = render(<ModalHarness open />);
    const root = screen.getByTestId('modal-root');
    const portalHost = Array.from(document.body.children).find((child) => child.contains(root));
    if (!portalHost) throw new Error('missing portal host');

    expect(trigger.hasAttribute('inert')).toBe(true);
    expect(trigger.getAttribute('aria-hidden')).toBe('true');
    expect(background.hasAttribute('inert')).toBe(true);
    expect(background.getAttribute('aria-hidden')).toBe('true');
    expect(portalHost.hasAttribute('inert')).toBe(false);

    rerender(<ModalHarness open={false} />);
    expect(trigger.hasAttribute('inert')).toBe(false);
    expect(trigger.hasAttribute('aria-hidden')).toBe(false);
    expect(background.hasAttribute('inert')).toBe(false);
    expect(background.hasAttribute('aria-hidden')).toBe(false);
    await waitFor(() => { expect(document.activeElement).toBe(trigger); });
  });

  test('Escape only cancels from inside the portal or after focus falls to body', () => {
    const onCancel = mock();
    render(<ModalHarness open onCancel={onCancel} />);

    const outside = screen.getByRole('button', { name: 'Outside modal in portal' });
    outside.focus();
    fireEvent.keyDown(outside, { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();

    const inside = screen.getByRole('button', { name: 'Modal action' });
    inside.focus();
    fireEvent.keyDown(inside, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);

    inside.blur();
    document.body.focus();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  test('keeps the original focus restore target across stateful rerenders', async () => {
    const { rerender } = render(<StatefulModalHarness open={false} />);
    const trigger = screen.getByRole('button', { name: 'Open' });
    trigger.focus();

    rerender(<StatefulModalHarness open />);
    const input = screen.getByLabelText('Name');
    input.focus();
    fireEvent.change(input, { target: { value: 'edited' } });
    await waitFor(() => { expect(document.activeElement).toBe(input); });

    rerender(<StatefulModalHarness open={false} />);

    await waitFor(() => { expect(document.activeElement).toBe(trigger); });
  });
});

describe('useFocusTrap', () => {
  test('focuses the first control on mount and wraps Tab at the edges', () => {
    render(<FocusTrapHarness />);
    const first = screen.getByRole('button', { name: 'First' });
    const last = screen.getByRole('button', { name: 'Last' });

    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  test('autoFocus=false keeps Tab containment but does not move initial focus', () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();

    render(<FocusTrapHarness autoFocus={false} />);
    const first = screen.getByRole('button', { name: 'First' });
    const last = screen.getByRole('button', { name: 'Last' });

    // Initial focus stays where the consumer left it — the trap did not grab it.
    expect(document.activeElement).toBe(outside);

    // Tab containment is still active once focus is inside.
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    outside.remove();
  });

  test('focusableInside excludes disabled controls and negative tabindex', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <button>ok</button>
      <button disabled>disabled</button>
      <a href="/x">link</a>
      <div tabindex="-1">skip</div>
      <div tabindex="0">custom</div>
    `;
    expect(focusableInside(root).map((node) => node.textContent)).toEqual(['ok', 'link', 'custom']);
  });
});

describe('useOutsidePointer', () => {
  test('ignores configured inside refs and closes on outside pointerdown', () => {
    const onOutside = mock();
    render(<OutsidePointerHarness onOutside={onOutside} />);

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Trigger' }));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Inside' }));
    expect(onOutside).not.toHaveBeenCalled();

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }));
    expect(onOutside).toHaveBeenCalledTimes(1);
  });

  test('does not subscribe when disabled', () => {
    const onOutside = mock();
    render(<OutsidePointerHarness enabled={false} onOutside={onOutside} />);

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }));
    expect(onOutside).not.toHaveBeenCalled();
  });
});

describe('runWhenReachable', () => {
  test('runs a reachable task in a microtask', async () => {
    const target = document.createElement('button');
    document.body.appendChild(target);
    const task = mock();

    runWhenReachable(task, target);
    expect(task).not.toHaveBeenCalled();

    await Promise.resolve();
    expect(task).toHaveBeenCalledTimes(1);
  });

  test('drops the task when the target is disconnected before it runs', async () => {
    const target = document.createElement('button');
    document.body.appendChild(target);
    const task = mock();

    runWhenReachable(task, target);
    target.remove();

    await Promise.resolve();
    expect(task).not.toHaveBeenCalled();
  });
});

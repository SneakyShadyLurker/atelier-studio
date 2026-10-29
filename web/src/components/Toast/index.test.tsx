import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { tabbableInside } from '../../hooks/useFocusTrap';
import { useModalChrome } from '../../hooks/useModalChrome';
import { initialAtelierState, useAtelierStore } from '../../store/atelier';
import { DialogShell } from '../DialogShell';
import Toast from './index';

afterEach(() => {
  cleanup();
  mock.restore();
  useAtelierStore.setState(initialAtelierState, true);
});

type Layout = 'popover' | 'sheet';

// The PromptPicker shape: a body-level portal root (swept as the protected
// child) wrapping the panel that owns a custom focus trap. The sheet branch
// replaces the panel node, as the real popover ⇄ sheet switch does.
function PanelModal({ open, layout = 'popover', children }: { open: boolean; layout?: Layout; children?: ReactNode }) {
  const portalRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  useModalChrome({ open, onCancel: () => undefined, portalRef, toastHostRef: panelRef, containerKey: layout });
  if (!open) return null;
  const panel = (
    <div ref={panelRef} role="dialog" aria-modal="true" aria-label="Templates" data-layout={layout}>
      <button type="button">Panel action</button>
      {children}
    </div>
  );
  return createPortal(
    <div ref={portalRef}>
      {layout === 'sheet' ? <><button type="button">Close templates</button>{panel}</> : panel}
    </div>,
    document.body,
  );
}

function Shell({ panelOpen = false, confirmOpen = false, mounted = true, layout = 'popover' }: { panelOpen?: boolean; confirmOpen?: boolean; mounted?: boolean; layout?: Layout }) {
  return (
    <>
      <main data-testid="app-root"><Toast /></main>
      {mounted ? (
        <PanelModal open={panelOpen} layout={layout}>
          <DialogShell open={confirmOpen} onCancel={() => undefined} label="Clear queued rolls?">
            <button type="button">Keep queue</button>
          </DialogShell>
        </PanelModal>
      ) : null}
    </>
  );
}

function addUndoToast(onClick = mock()) {
  act(() => {
    useAtelierStore.getState().addToast('Queue cleared', 'soft', 5000, { label: 'Undo', onClick });
  });
  return onClick;
}

function undoButtons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll('button')).filter((button) => button.textContent === 'Undo');
}

function onlyUndo(): HTMLButtonElement {
  const buttons = undoButtons();
  // Exactly one stack, one copy — never a duplicate per host.
  expect(buttons).toHaveLength(1);
  const [button] = buttons;
  if (!button) throw new Error('missing Undo');
  return button;
}

function panel(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Templates"]');
  if (!element) throw new Error('missing panel');
  return element;
}

describe('Toast host placement', () => {
  test('renders in the app root at the default placement when no modal is open', () => {
    const { getByTestId } = render(<Shell />);
    addUndoToast();

    const undo = onlyUndo();
    expect(getByTestId('app-root').contains(undo)).toBe(true);
    expect(undo.closest('[data-toast-host]')).toBeNull();
  });

  test('a custom-trap modal hosts the stack inside its panel, within the focus trap', () => {
    const { getByTestId } = render(<Shell panelOpen />);
    // The app root is exactly what the modal chrome made unreachable.
    expect(getByTestId('app-root').closest('[inert]')).not.toBeNull();
    const onUndo = addUndoToast();

    const undo = onlyUndo();
    expect(panel().contains(undo)).toBe(true);
    expect(undo.closest('[data-toast-host="contained"]')).not.toBeNull();
    expect(undo.closest('[inert], [aria-hidden="true"]')).toBeNull();
    expect(tabbableInside(panel())).toContain(undo);
    // The live regions travel with the stack, out of the aria-hidden root.
    expect(panel().querySelectorAll('[aria-live]')).toHaveLength(2);

    fireEvent.click(undo);
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  test('a nested native dialog takes the stack inside its showModal element and hands it back', () => {
    const { getByTestId, rerender } = render(<Shell panelOpen />);
    addUndoToast();
    expect(panel().contains(onlyUndo())).toBe(true);

    rerender(<Shell panelOpen confirmOpen />);
    const dialog = document.querySelector('dialog');
    if (!dialog) throw new Error('missing native dialog');
    const inDialog = onlyUndo();
    expect(dialog.contains(inDialog)).toBe(true);
    expect(inDialog.closest('[data-toast-host="viewport"]')).not.toBeNull();

    rerender(<Shell panelOpen />);
    expect(panel().contains(onlyUndo())).toBe(true);

    rerender(<Shell />);
    const restored = onlyUndo();
    expect(getByTestId('app-root').contains(restored)).toBe(true);
    expect(restored.closest('[data-toast-host]')).toBeNull();
  });

  test('a modal unmounted while open releases its host', () => {
    const { getByTestId, rerender } = render(<Shell panelOpen />);
    addUndoToast();
    expect(panel().contains(onlyUndo())).toBe(true);

    rerender(<Shell panelOpen mounted={false} />);

    expect(getByTestId('app-root').contains(onlyUndo())).toBe(true);
  });

  test('a layout switch that replaces the panel node follows it to the current panel', () => {
    const { getByTestId, rerender } = render(<Shell panelOpen />);
    const onUndo = addUndoToast();
    const popover = panel();
    expect(popover.contains(onlyUndo())).toBe(true);

    rerender(<Shell panelOpen layout="sheet" />);
    const sheet = panel();
    expect(sheet).not.toBe(popover);
    expect(sheet.dataset.layout).toBe('sheet');
    const undo = onlyUndo();
    expect(sheet.contains(undo)).toBe(true);
    expect(tabbableInside(sheet)).toContain(undo);
    // The inert sweep was not redone around the new node.
    expect(getByTestId('app-root').closest('[inert]')).not.toBeNull();

    rerender(<Shell panelOpen />);
    expect(panel().dataset.layout).toBe('popover');
    const restored = onlyUndo();
    expect(panel().contains(restored)).toBe(true);
    fireEvent.click(restored);
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  test('a layout switch underneath a nested dialog keeps the dialog as the host', () => {
    const { rerender } = render(<Shell panelOpen />);
    addUndoToast();
    // The confirmation is opened from the already-open picker, as in the app.
    rerender(<Shell panelOpen confirmOpen />);
    const dialog = document.querySelector('dialog');
    if (!dialog) throw new Error('missing native dialog');
    expect(dialog.contains(onlyUndo())).toBe(true);

    rerender(<Shell panelOpen confirmOpen layout="sheet" />);
    const current = document.querySelector('dialog');
    if (!current) throw new Error('missing native dialog');
    expect(current.contains(onlyUndo())).toBe(true);

    rerender(<Shell panelOpen layout="sheet" />);
    expect(panel().contains(onlyUndo())).toBe(true);
  });
});

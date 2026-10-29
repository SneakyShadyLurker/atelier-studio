import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useKeyboard } from '../../hooks/useKeyboard';
import { initialAtelierState, useAtelierStore } from '../../store/atelier';
import Toast from '../Toast';
import ConfirmDialog from './index';

afterEach(() => {
  cleanup();
  mock.restore();
  useAtelierStore.setState(initialAtelierState, true);
});

describe('ConfirmDialog', () => {
  test('the production keyboard dispatcher leaves Enter on hosted Undo to native activation', async () => {
    const onConfirm = mock();
    const onCancel = mock();
    const onUndo = mock();
    function Shell() {
      useKeyboard(() => undefined);
      return <><ConfirmDialog open title="Clear queue?" body="Discard these rolls?" confirmLabel="Clear" cancelLabel="Keep queue" onConfirm={onConfirm} onCancel={onCancel} /><Toast /></>;
    }
    render(<Shell />);
    await act(async () => { await Promise.resolve(); });
    act(() => { useAtelierStore.getState().addToast('Queue cleared', 'soft', 5000, { label: 'Undo', onClick: onUndo }); });
    const undo = screen.getByRole('button', { name: 'Undo' });
    expect(screen.getByRole('dialog').contains(undo)).toBe(true);
    undo.focus();
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    fireEvent(undo, enter);
    expect(enter.defaultPrevented).toBe(false);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    // Happy DOM does not synthesize native button activation from keydown.
    // The real-browser lane asserts the Enter-to-click path end to end.
    fireEvent.click(undo);
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  test('initially focuses Cancel and wires confirmation inside the native dialog', () => {
    const onConfirm = mock();
    render(
      <>
        <button type="button">Before</button>
        <ConfirmDialog
          open
          title="Delete permanently?"
          body="This cannot be undone."
          confirmLabel="Delete"
          cancelLabel="Cancel"
          onConfirm={onConfirm}
          onCancel={mock()}
        />
        <button type="button">After</button>
      </>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Delete permanently?' });
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const confirm = screen.getByRole('button', { name: 'Delete' });

    expect(document.activeElement).toBe(cancel);

    // Native showModal() contains Tab focus, including hosted toast actions.
    // Happy DOM cannot exercise that platform behavior; web/e2e/overlays.spec.ts
    // covers DialogShell's containment in a real browser.
    expect(dialog.tagName).toBe('DIALOG');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

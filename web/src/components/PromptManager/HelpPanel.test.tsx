import { afterEach, describe, expect, test, mock } from 'bun:test';
import { act, render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import HelpPanel from './HelpPanel';

afterEach(cleanup);

describe('HelpPanel', () => {
  test('not in the DOM when closed', () => {
    render(<HelpPanel open={false} panelId="help-x" onClose={mock(() => undefined)} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('open: dialog has the supplied id and the help copy', () => {
    render(<HelpPanel open panelId="help-x" onClose={mock(() => undefined)} />);
    const dialog = screen.getByRole('dialog', { name: 'How the prompt library works' });
    expect(dialog.getAttribute('id')).toBe('help-x');
    expect(dialog.textContent).toMatch(/Templates/);
    expect(dialog.textContent).toMatch(/Dimensions/);
  });

  test('moves focus into the panel on open', async () => {
    render(<HelpPanel open panelId="help-x" onClose={mock(() => undefined)} />);
    await waitFor(() => {
      const dialog = screen.getByRole('dialog');
      expect(dialog.contains(document.activeElement)).toBe(true);
    });
  });

  const settleExit = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });

  test('Escape and the close button each play the exit, then call onClose; desktop renders no backdrop', async () => {
    const onClose = mock(() => undefined);
    const { rerender } = render(<HelpPanel open panelId="help-x" onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    // The exit plays first: the panel stays mounted with data-closing.
    expect(screen.getByRole('dialog').getAttribute('data-closing')).toBe('true');
    expect(onClose).not.toHaveBeenCalled();
    await settleExit();
    expect(onClose).toHaveBeenCalledTimes(1);

    // The parent closes and reopens it.
    rerender(<HelpPanel open={false} panelId="help-x" onClose={onClose} />);
    rerender(<HelpPanel open panelId="help-x" onClose={onClose} />);
    expect(screen.getByRole('dialog').getAttribute('data-closing')).toBeNull();
    // Desktop popovers are scrim-free (sibling-overlay parity); the labeled
    // backdrop tap-catcher only mounts on phone.
    const closeButtons = screen.getAllByRole('button', { name: 'Close help' });
    expect(closeButtons).toHaveLength(1);
    const closeBtn = closeButtons[0];
    if (!closeBtn) throw new Error('expected close button');
    fireEvent.click(closeBtn);
    expect(screen.getByRole('dialog').getAttribute('data-closing')).toBe('true');
    // Repeated dismissals during the exit do not stack.
    fireEvent.click(closeBtn);
    await settleExit();
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

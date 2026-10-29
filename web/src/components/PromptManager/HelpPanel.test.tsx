import { afterEach, describe, expect, test, mock } from 'bun:test';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
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

  test('Escape and close button each call onClose; desktop renders no backdrop', () => {
    const onClose = mock(() => undefined);
    render(<HelpPanel open panelId="help-x" onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    // Desktop popovers are scrim-free (sibling-overlay parity); the labeled
    // backdrop tap-catcher only mounts on phone.
    const closeButtons = screen.getAllByRole('button', { name: 'Close help' });
    expect(closeButtons).toHaveLength(1);
    const closeBtn = closeButtons[0];
    if (!closeBtn) throw new Error('expected close button');
    fireEvent.click(closeBtn);
    expect(onClose.mock.calls.length).toBe(2);
  });
});

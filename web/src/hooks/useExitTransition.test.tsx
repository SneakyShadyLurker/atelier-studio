import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { useExitTransition } from './useExitTransition';

function Host({ onClosed }: { onClosed?: () => void }) {
  const [open, setOpen] = useState(true);
  const { closing, requestClose } = useExitTransition(() => {
    setOpen(false);
    onClosed?.();
  }, open);
  if (!open) return <div>gone</div>;
  return (
    <div data-closing={closing ? 'true' : undefined} data-testid="panel">
      <button type="button" onClick={requestClose}>close</button>
    </div>
  );
}

describe('useExitTransition', () => {
  afterEach(cleanup);

  test('requestClose stamps closing, then fires the close after the exit beat', async () => {
    const onClosed = mock();
    render(<Host onClosed={onClosed} />);
    const panel = screen.getByTestId('panel');
    expect(panel.dataset.closing).toBeUndefined();

    fireEvent.click(screen.getByRole('button', { name: 'close' }));
    expect(screen.getByTestId('panel').dataset.closing).toBe('true');
    expect(onClosed).not.toHaveBeenCalled();

    await waitFor(() => { expect(screen.queryByTestId('panel')).toBeNull(); });
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(screen.getByText('gone')).toBeTruthy();
  });

  test('an external close cancels a pending exit — no double-fire, reopen is clean', async () => {
    const onCancel = mock();
    function StayMounted() {
      const [open, setOpen] = useState(true);
      const { closing, requestClose } = useExitTransition(() => {
        setOpen(false);
        onCancel();
      }, open);
      if (!open) return <button type="button" onClick={() => { setOpen(true); }}>reopen</button>;
      return (
        <div data-testid="panel" data-closing={closing ? 'true' : undefined}>
          <button type="button" onClick={requestClose}>dismiss</button>
          <button type="button" onClick={() => { setOpen(false); }}>confirm</button>
        </div>
      );
    }
    render(<StayMounted />);
    // Arm the exit (Escape-like dismissal), then close instantly (Confirm-like)
    // before the exit timer fires — the leaked timer must NOT fire onCancel.
    fireEvent.click(screen.getByRole('button', { name: 'dismiss' }));
    fireEvent.click(screen.getByRole('button', { name: 'confirm' }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'reopen' }));
    expect(screen.getByTestId('panel').dataset.closing).toBeUndefined();
  });

  test('requestClose is idempotent — one close for repeated calls', async () => {
    const onClosed = mock();
    render(<Host onClosed={onClosed} />);
    const button = screen.getByRole('button', { name: 'close' });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => { expect(screen.queryByTestId('panel')).toBeNull(); });
    expect(onClosed).toHaveBeenCalledTimes(1);
  });
});

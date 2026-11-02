import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render } from '@testing-library/react';
import { useRef } from 'react';
import { useModalChrome } from './useModalChrome';
import { useNestedDialogEscape } from './useNestedDialogEscape';

afterEach(() => {
  cleanup();
  mock.restore();
});

function escapeKeydown(composing: { isComposing?: boolean; keyCode?: number }): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
    isComposing: composing.isComposing ?? false,
  });
  Object.defineProperty(event, 'keyCode', { value: composing.keyCode ?? 27 });
  return event;
}

function ModalHarness({ onCancel }: { onCancel: () => void }) {
  const portalRef = useRef<HTMLDivElement | null>(null);
  useModalChrome({ open: true, onCancel, portalRef, nativeModal: true });
  return (
    <div ref={portalRef}>
      <input aria-label="Name" />
    </div>
  );
}

function NestedHarness({ onClose }: { onClose: () => void }) {
  useNestedDialogEscape(true, onClose);
  return <input aria-label="Filter" />;
}

describe('IME-safe Escape owners', () => {
  test('useModalChrome ignores Escape that dismisses an IME candidate, then cancels on a real Escape', () => {
    const onCancel = mock();
    const { getByLabelText } = render(<ModalHarness onCancel={onCancel} />);
    const input = getByLabelText('Name');
    input.focus();

    input.dispatchEvent(escapeKeydown({ isComposing: true }));
    input.dispatchEvent(escapeKeydown({ keyCode: 229 }));
    expect(onCancel).not.toHaveBeenCalled();

    input.dispatchEvent(escapeKeydown({}));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test('useNestedDialogEscape ignores Escape during IME composition', () => {
    const onClose = mock();
    const { getByLabelText } = render(<NestedHarness onClose={onClose} />);
    const input = getByLabelText('Filter');

    input.dispatchEvent(escapeKeydown({ isComposing: true }));
    input.dispatchEvent(escapeKeydown({ keyCode: 229 }));
    expect(onClose).not.toHaveBeenCalled();

    input.dispatchEvent(escapeKeydown({}));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

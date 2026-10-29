import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import DescribeListDialog from './index';

afterEach(() => { cleanup(); });

const noop = () => undefined;

describe('DescribeListDialog', () => {
  test('renders the model question and is a modal dialog', () => {
    render(<DescribeListDialog question="What kind of list?" busy={false} error={null}
      onSubmit={noop} onCancel={noop} />);
    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('true');
    expect(screen.getByText('What kind of list?')).toBeDefined();
  });

  test('renders the seed prompt body when no question is provided', () => {
    render(<DescribeListDialog busy={false} error={null} onSubmit={noop} onCancel={noop} />);
    expect(screen.getByText(
      'Describe what this list should contain. The AI will generate up to 10 starter entries you can edit, reorder, or delete.',
    )).toBeDefined();
  });

  test('submit passes the textarea value; empty is blocked', () => {
    const onSubmit = mock((_: string) => undefined);
    render(<DescribeListDialog question="q" busy={false} error={null}
      onSubmit={onSubmit} onCancel={noop} />);
    const btn = screen.getByRole('button', { name: /generate list/i });
    fireEvent.click(btn);
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'cat breeds' } });
    fireEvent.click(btn);
    expect(onSubmit).toHaveBeenCalledWith('cat breeds');
  });

  test('Escape and Cancel call onCancel', async () => {
    const onCancel = mock(() => undefined);
    render(<DescribeListDialog question="q" busy={false} error={null}
      onSubmit={noop} onCancel={onCancel} />);
    // Dismissals ride the shared exit transition (useExitTransition); each
    // gesture's close lands ~160ms later, and repeat gestures inside that
    // window collapse into one close.
    fireEvent.keyDown(document, { key: 'Escape' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(onCancel.mock.calls.length).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(onCancel.mock.calls.length).toBe(2);
  });

  test('shows an inline error', () => {
    render(<DescribeListDialog question="q" busy={false} error="server hiccup"
      onSubmit={noop} onCancel={noop} />);
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('server hiccup');
    expect(status.getAttribute('aria-live')).toBe('polite');
  });
});

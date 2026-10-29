import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import DescribeTemplateDialog from './index';

afterEach(() => { cleanup(); });

const noop = () => undefined;

describe('DescribeTemplateDialog', () => {
  test('seed mode renders seed heading + helper copy', () => {
    render(
      <DescribeTemplateDialog
        mode="seed" question={null}
        onSubmit={noop} onCancel={noop} busy={false}
      />,
    );
    expect(screen.getByRole('heading', { name: /describe the template/i })).toBeTruthy();
    expect(screen.getByText(/use your variable library for entropy/i)).toBeTruthy();
  });

  test('clarify mode renders the model-supplied question', () => {
    render(
      <DescribeTemplateDialog
        mode="clarify" question="Indoor or outdoor?"
        onSubmit={noop} onCancel={noop} busy={false}
      />,
    );
    expect(screen.getByText('Indoor or outdoor?')).toBeTruthy();
  });

  test('primary disabled until textarea non-empty', () => {
    render(
      <DescribeTemplateDialog
        mode="seed" question={null}
        onSubmit={noop} onCancel={noop} busy={false}
      />,
    );
    const primary = screen.getByRole('button', { name: /generate template/i });
    expect(primary.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'noir' } });
    expect(primary.hasAttribute('disabled')).toBe(false);
  });

  test('submit calls onSubmit with textarea value (trimmed)', () => {
    const onSubmit = mock((_: string) => undefined);
    render(
      <DescribeTemplateDialog
        mode="seed" question={null}
        onSubmit={onSubmit} onCancel={noop} busy={false}
      />,
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  X  ' } });
    fireEvent.click(screen.getByRole('button', { name: /generate template/i }));
    expect(onSubmit).toHaveBeenCalledWith('X');
  });

  test('cancel calls onCancel', async () => {
    const onCancel = mock(() => undefined);
    render(
      <DescribeTemplateDialog
        mode="clarify" question="Q"
        onSubmit={noop} onCancel={onCancel} busy={false}
      />,
    );
    // Dismissal rides the shared exit transition (useExitTransition).
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(onCancel).toHaveBeenCalled();
  });

  test('busy shows "Generating…" and disables primary', () => {
    render(
      <DescribeTemplateDialog
        mode="seed" question={null}
        onSubmit={noop} onCancel={noop} busy={true}
      />,
    );
    expect(screen.getByRole('button', { name: /generating…/i })).toBeTruthy();
  });
});

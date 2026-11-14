import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

// CSS Modules resolve to an empty object under bun test; name the button
// classes so the AI-action treatment is observable in the DOM.
await mock.module('../../styles/buttons.module.css', () => ({
  default: { ai: 'ai', primary: 'primary', secondary: 'secondary' },
}));
const { DescribeDialog } = await import('./index');

afterEach(() => {
  cleanup();
  mock.restore();
});

function renderDialog(props: { error?: string | null; notice?: string | null } = {}) {
  const onSubmit = mock((_description: string) => undefined);
  const onCancel = mock(() => undefined);
  render(
    <DescribeDialog
      title="Describe the list"
      body="What should the list contain?"
      fieldLabel="Description"
      placeholder="Describe it…"
      maxLength={500}
      submitLabel="Draft list"
      busy={false}
      {...props}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />,
  );
  return { onSubmit, onCancel };
}

describe('DescribeDialog', () => {
  test('Cmd/Ctrl+Enter submits the trimmed description', () => {
    const { onSubmit } = renderDialog();
    const field = screen.getByLabelText('Description');
    fireEvent.change(field, { target: { value: '  moody harbours  ' } });
    fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledWith('moody harbours');
  });

  test('a dismissed dialog does not submit during its exit fade', async () => {
    const { onSubmit, onCancel } = renderDialog();
    const field = screen.getByLabelText('Description');
    fireEvent.change(field, { target: { value: 'moody harbours' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(field, { key: 'Enter', metaKey: true });
    fireEvent.click(screen.getByRole('button', { name: 'Draft list' }));

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test('the submit is the AI action: btn.ai with an aria-hidden sparkle', () => {
    renderDialog();
    const submit = screen.getByRole('button', { name: 'Draft list' });
    expect(submit.classList.contains('ai')).toBe(true);
    expect(submit.classList.contains('primary')).toBe(false);
    const icon = submit.querySelector('svg');
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
  });

  test('a notice is a polite status that describes the field', () => {
    renderDialog({ notice: 'The model found nothing to change.' });
    const notice = screen.getByText('The model found nothing to change.');
    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.getAttribute('aria-live')).toBe('polite');
    const field = screen.getByLabelText('Description');
    expect((field.getAttribute('aria-describedby') ?? '').split(' ')).toContain(notice.id);
    expect(field.getAttribute('aria-invalid')).toBeNull();
  });

  test('an error wins over a notice', () => {
    renderDialog({ error: 'Upstream failed.', notice: 'The model found nothing to change.' });
    expect(screen.queryByText('The model found nothing to change.')).toBeNull();
    const error = screen.getByText('Upstream failed.');
    const field = screen.getByLabelText('Description');
    expect((field.getAttribute('aria-describedby') ?? '').split(' ')).toContain(error.id);
    expect(field.getAttribute('aria-invalid')).toBe('true');
  });

  test('no notice and no error leaves only the hint in aria-describedby', () => {
    renderDialog();
    const field = screen.getByLabelText('Description');
    expect((field.getAttribute('aria-describedby') ?? '').split(' ')).toHaveLength(1);
    expect(screen.queryByRole('status')).toBeNull();
  });
});

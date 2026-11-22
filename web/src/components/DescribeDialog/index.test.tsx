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

interface DialogProps {
  error?: string | null;
  notice?: string | null;
  body?: string;
  resetKey?: string;
}

function renderDialog(props: DialogProps = {}) {
  const onSubmit = mock((_description: string) => undefined);
  const onCancel = mock(() => undefined);
  const element = (next: DialogProps) => (
    <DescribeDialog
      title="Describe the list"
      body="What should the list contain?"
      fieldLabel="Description"
      placeholder="Describe it…"
      maxLength={500}
      submitLabel="Draft list"
      busy={false}
      {...next}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />
  );
  const { rerender } = render(element(props));
  return { onSubmit, onCancel, rerender: (next: DialogProps) => { rerender(element(next)); } };
}

describe('DescribeDialog', () => {
  test('Cmd/Ctrl+Enter submits the trimmed description', () => {
    const { onSubmit } = renderDialog();
    const field = screen.getByLabelText('Description');
    fireEvent.change(field, { target: { value: '  moody harbours  ' } });
    fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledWith('moody harbours');
  });

  test('Cmd/Ctrl+Enter during IME composition does not submit', () => {
    const { onSubmit } = renderDialog();
    const field = screen.getByLabelText('Description');
    fireEvent.change(field, { target: { value: 'moody harbours' } });
    fireEvent.keyDown(field, { key: 'Enter', metaKey: true, isComposing: true });
    fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true, keyCode: 229 });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test('a new body clears the typed text', () => {
    const { rerender } = renderDialog();
    const field = screen.getByLabelText<HTMLTextAreaElement>('Description');
    fireEvent.change(field, { target: { value: 'moody harbours' } });
    rerender({ body: 'Which harbours?' });
    expect(field.value).toBe('');
  });

  test('a body change under a stable reset key keeps the typed text', () => {
    const { rerender } = renderDialog({ resetKey: 'seed' });
    const field = screen.getByLabelText<HTMLTextAreaElement>('Description');
    fireEvent.change(field, { target: { value: 'moody harbours' } });
    rerender({ resetKey: 'seed', body: 'Describe the list, or leave it blank.' });
    expect(field.value).toBe('moody harbours');
    expect(screen.getByText('Describe the list, or leave it blank.')).not.toBeNull();
  });

  test('a new reset key clears the typed text', () => {
    const { rerender } = renderDialog({ resetKey: 'seed' });
    const field = screen.getByLabelText<HTMLTextAreaElement>('Description');
    fireEvent.change(field, { target: { value: 'moody harbours' } });
    rerender({ resetKey: 'clarify' });
    expect(field.value).toBe('');
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

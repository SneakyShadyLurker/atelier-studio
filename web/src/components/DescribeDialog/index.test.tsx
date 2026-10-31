import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DescribeDialog } from './index';

afterEach(() => {
  cleanup();
  mock.restore();
});

function renderDialog() {
  const onSubmit = mock((_description: string) => undefined);
  const onCancel = mock(() => undefined);
  render(
    <DescribeDialog
      sectionLabel="AI DRAFT"
      title="Describe the list"
      body="What should the list contain?"
      fieldLabel="Description"
      placeholder="Describe it…"
      maxLength={500}
      submitLabel="Draft list"
      busy={false}
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
});

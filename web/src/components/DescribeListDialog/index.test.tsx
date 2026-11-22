import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { LIST_DESCRIPTION_MAX_CHARS } from '@atelier/shared/prompt-limits';
import type { TaskModelChoice } from '../../hooks/useTaskModelChoice';
import type { ListReviewMode } from '../PromptManager/listReview';
import DescribeListDialog, { type DescribeListDialogMode } from './index';

afterEach(() => { cleanup(); });

const noop = () => undefined;

function choice(): TaskModelChoice {
  return {
    state: { kind: 'ready' },
    modelId: '',
    effort: 'default',
    groups: [{
      providerName: 'Provider',
      models: [{ id: 'writer-a', displayName: 'Writer A', providerName: 'Provider', vision: false, reasoningLevels: [], status: 'available' }],
    }],
    defaultName: 'Writer A',
    effortLevels: null,
    setModelId: noop,
    setEffort: noop,
    commit: () => Promise.resolve(),
    reset: noop,
  };
}

/** The populated dialog with its chip state owned here, as the editor owns it. */
function Populated({ full = false, onSubmit = noop, busy = false }: { full?: boolean; onSubmit?: (text: string) => void; busy?: boolean }) {
  const [mode, setMode] = useState<ListReviewMode>(full ? 'rework' : 'extend');
  return (
    <DescribeListDialog mode="populated" choice={mode} onChoice={setMode} full={full} busy={busy}
      modelChoice={choice()} onSubmit={onSubmit} onCancel={noop} />
  );
}

describe('DescribeListDialog', () => {
  test('seed: its copy, a required description and the model fields', () => {
    const onSubmit = mock((_: string) => undefined);
    render(<DescribeListDialog mode="seed" busy={false} modelChoice={choice()} onSubmit={onSubmit} onCancel={noop} />);
    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('true');
    expect(screen.getByRole('heading', { name: 'Describe the list' })).toBeTruthy();
    expect(screen.getByText('Say what this list should hold. The options fill the list for you to edit, reorder or delete, and nothing is saved until you press Save list.')).toBeTruthy();
    const field = screen.getByLabelText('List description');
    expect(field.getAttribute('placeholder')).toBe('e.g. cat breeds for a portrait template');
    expect(field.getAttribute('maxlength')).toBe(String(LIST_DESCRIPTION_MAX_CHARS));
    expect(screen.getByLabelText('Model')).toBeTruthy();
    expect(screen.getByLabelText('Reasoning')).toBeTruthy();
    const submit = screen.getByRole<HTMLButtonElement>('button', { name: 'Draft list' });
    expect(submit.disabled).toBe(true);
    fireEvent.change(field, { target: { value: '  scarves ' } });
    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledWith('scarves');
  });

  test('create: its copy and the model fields', () => {
    render(<DescribeListDialog mode="create" busy={false} modelChoice={choice()} onSubmit={noop} onCancel={noop} />);
    expect(screen.getByRole('heading', { name: 'Describe the new list' })).toBeTruthy();
    expect(screen.getByText('Say what the list should vary and how many options you want. The AI names the list and writes its options, which stay unsaved until you press Save list.')).toBeTruthy();
    expect(screen.getByLabelText('List description').getAttribute('placeholder')).toBe('e.g. twenty weather conditions, from clear to stormy');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Draft list' }).disabled).toBe(true);
    expect(screen.getByLabelText('Model')).toBeTruthy();
  });

  test('clarify: the question as body, no model fields, a required answer', () => {
    render(<DescribeListDialog mode="clarify" question="Which scarves?" busy={false} modelChoice={choice()} onSubmit={noop} onCancel={noop} />);
    expect(screen.getByRole('heading', { name: 'One more thing' })).toBeTruthy();
    expect(screen.getByText('Which scarves?')).toBeTruthy();
    expect(screen.getByLabelText('List description')).toBeTruthy();
    expect(screen.queryByLabelText('Model')).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Add options' }).disabled).toBe(true);
  });

  // R4.1, R4.2
  test('populated: Add options is chosen and may go blank; Rework needs text; switching keeps the text', () => {
    const onSubmit = mock((_: string) => undefined);
    render(<Populated onSubmit={onSubmit} />);
    const add = screen.getByRole<HTMLInputElement>('radio', { name: 'Add options' });
    const rework = screen.getByRole<HTMLInputElement>('radio', { name: 'Rework' });
    expect(add.checked).toBe(true);
    expect(screen.getByRole('heading', { name: 'Add to the list' })).toBeTruthy();
    expect(screen.getByText('The AI adds options in the vein of the ones you have. Say what to add, or leave this blank for more of the same. You review each one before it is applied.')).toBeTruthy();
    expect(screen.getByLabelText('What to add').getAttribute('placeholder')).toBe('e.g. 15 more, leaning toward winter');
    expect(screen.getByLabelText('Model')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add options' }));
    expect(onSubmit).toHaveBeenLastCalledWith('');

    fireEvent.change(screen.getByLabelText('What to add'), { target: { value: 'warmer ones' } });
    fireEvent.click(rework);
    expect(rework.checked).toBe(true);
    expect(screen.getByRole('heading', { name: 'Rework the list' })).toBeTruthy();
    expect(screen.getByText("Say what should change: rewrite, remove, reweight or add options. You review each change before it is applied, and options you don't mention stay as they are.")).toBeTruthy();
    const area = screen.getByLabelText<HTMLTextAreaElement>('Change instructions');
    expect(area.value).toBe('warmer ones');
    expect(area.getAttribute('placeholder')).toBe('e.g. shorten every option and drop the near-duplicates');
    fireEvent.change(area, { target: { value: ' ' } });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Rework list' }).disabled).toBe(true);
    fireEvent.change(area, { target: { value: 'shorter' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rework list' }));
    expect(onSubmit).toHaveBeenLastCalledWith('shorter');
  });

  test('populated at the option limit: Add options is off, Rework chosen, with the note', () => {
    render(<Populated full />);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Add options' }).disabled).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Rework' }).checked).toBe(true);
    expect(screen.getByText('This list is at its option limit, so there is no room to add.')).toBeTruthy();
  });

  test('populated without the limit shows no limit note', () => {
    render(<Populated />);
    expect(screen.queryByText('This list is at its option limit, so there is no room to add.')).toBeNull();
  });

  test('Rework busy reads "Reworking…" and locks the chips', () => {
    render(<DescribeListDialog mode="populated" choice="rework" busy onSubmit={noop} onCancel={noop} />);
    expect(screen.getByRole('button', { name: 'Reworking…' })).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Add options' }).closest('fieldset')?.disabled).toBe(true);
  });

  test('Rework again opens on the last instructions', () => {
    render(<DescribeListDialog mode="populated" choice="rework" initialText="shorter" busy={false} onSubmit={noop} onCancel={noop} />);
    expect(screen.getByLabelText<HTMLTextAreaElement>('Change instructions').value).toBe('shorter');
  });

  test('a note and an error show inline', () => {
    const { rerender } = render(<DescribeListDialog mode="populated" choice="extend" notice="No new options to add." busy={false} onSubmit={noop} onCancel={noop} />);
    expect(screen.getByRole('status').textContent).toBe('No new options to add.');
    rerender(<DescribeListDialog mode="populated" choice="extend" error="Couldn't draft the list." busy={false} onSubmit={noop} onCancel={noop} />);
    expect(screen.getByRole('status').textContent).toBe("Couldn't draft the list.");
  });

  for (const mode of ['seed', 'create', 'populated', 'clarify'] as DescribeListDialogMode[]) {
    test(`${mode}: Cancel calls onCancel`, async () => {
      const onCancel = mock(() => undefined);
      render(<DescribeListDialog mode={mode} question="Which?" busy={false} onSubmit={noop} onCancel={onCancel} />);
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
      expect(onCancel).toHaveBeenCalledTimes(1);
    });
  }
});

import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TEMPLATE_DESCRIPTION_MAX_CHARS } from '@atelier/shared/prompt-limits';
import type { TaskModelChoice } from '../../hooks/useTaskModelChoice';
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
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
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

function choice(over: Partial<TaskModelChoice> = {}): TaskModelChoice {
  return {
    state: { kind: 'ready' },
    modelId: '',
    effort: 'default',
    groups: [
      {
        providerName: 'CLIProxyAPI',
        models: [
          { id: 'kimi', displayName: 'Kimi K3', providerName: 'CLIProxyAPI', vision: true, reasoningLevels: ['low', 'high'], status: 'available' },
          { id: 'gone', displayName: 'Gone', providerName: 'CLIProxyAPI', vision: false, reasoningLevels: [], status: 'offline' },
        ],
      },
      {
        providerName: 'Ollama',
        models: [{ id: 'scout', displayName: 'Llama 4 Scout', providerName: 'Ollama', vision: true, reasoningLevels: [], status: 'available' }],
      },
    ],
    defaultName: 'Kimi K3',
    effortLevels: null,
    setModelId: noop,
    setEffort: noop,
    commit: () => Promise.resolve(),
    reset: noop,
    ...over,
  };
}

function selects() {
  const model = screen.getByLabelText('Model');
  const effort = screen.getByLabelText('Reasoning');
  if (!(model instanceof HTMLSelectElement) || !(effort instanceof HTMLSelectElement)) throw new Error('expected native selects');
  return { model, effort };
}

describe('DescribeTemplateDialog rework mode and model fields', () => {
  test('rework mode renders its own copy and submit label', () => {
    const onSubmit = mock((_: string) => undefined);
    render(<DescribeTemplateDialog mode="rework" question={null} onSubmit={onSubmit} onCancel={noop} busy={false} />);
    expect(screen.getByRole('heading', { name: 'Rework the template' })).toBeTruthy();
    expect(screen.getByText("Say what should change. The AI rewrites the body and keeps everything you don't mention, your tokens included.")).toBeTruthy();
    const area = screen.getByLabelText('Change instructions');
    expect(area.getAttribute('placeholder')).toBe('e.g. make the lighting moodier and move the outfit into a variable');
    const primary = screen.getByRole('button', { name: 'Rework template' });
    expect(primary.hasAttribute('disabled')).toBe(true);
    fireEvent.change(area, { target: { value: ' moodier ' } });
    fireEvent.click(primary);
    expect(onSubmit).toHaveBeenCalledWith('moodier');
  });

  test('rework busy label is "Reworking…"', () => {
    render(<DescribeTemplateDialog mode="rework" question={null} onSubmit={noop} onCancel={noop} busy={true} />);
    expect(screen.getByRole('button', { name: 'Reworking…' })).toBeTruthy();
  });

  test('the description field allows TEMPLATE_DESCRIPTION_MAX_CHARS', () => {
    render(<DescribeTemplateDialog mode="rework" question={null} onSubmit={noop} onCancel={noop} busy={false} />);
    expect(screen.getByLabelText('Change instructions').getAttribute('maxlength')).toBe(String(TEMPLATE_DESCRIPTION_MAX_CHARS));
  });

  test('seed and rework show the model fields; clarify does not', () => {
    const { rerender } = render(<DescribeTemplateDialog mode="seed" question={null} modelChoice={choice()} onSubmit={noop} onCancel={noop} busy={false} />);
    expect(selects().model).toBeTruthy();
    rerender(<DescribeTemplateDialog mode="rework" question={null} modelChoice={choice()} onSubmit={noop} onCancel={noop} busy={false} />);
    expect(selects().model).toBeTruthy();
    rerender(<DescribeTemplateDialog mode="clarify" question="Q?" modelChoice={choice()} onSubmit={noop} onCancel={noop} busy={false} />);
    expect(screen.queryByLabelText('Model')).toBeNull();
    expect(screen.queryByLabelText('Reasoning')).toBeNull();
  });

  test('model options: named default first, provider groups, offline models disabled', () => {
    render(<DescribeTemplateDialog mode="rework" question={null} modelChoice={choice()} onSubmit={noop} onCancel={noop} busy={false} />);
    const { model, effort } = selects();
    expect(model.options[0]?.textContent).toBe('Use default (Kimi K3)');
    expect([...model.querySelectorAll('optgroup')].map((g) => g.label)).toEqual(['CLIProxyAPI', 'Ollama']);
    const offline = [...model.options].find((o) => o.value === 'gone');
    expect(offline?.disabled).toBe(true);
    expect(offline?.textContent).toBe('Gone (offline)');
    // "Use default": the reasoning select is disabled at Default.
    expect(effort.disabled).toBe(true);
    expect(effort.selectedOptions[0]?.textContent).toBe('Default');
  });

  test('a chosen model offers its levels; picking calls the choice setters', () => {
    const setModelId = mock((_: string) => undefined);
    const setEffort = mock((_: string) => undefined);
    render(<DescribeTemplateDialog mode="rework" question={null} modelChoice={choice({ modelId: 'kimi', effortLevels: ['low', 'high'], setModelId, setEffort })} onSubmit={noop} onCancel={noop} busy={false} />);
    const { model, effort } = selects();
    expect(effort.disabled).toBe(false);
    expect([...effort.options].map((o) => o.textContent)).toEqual(['Default', 'Low', 'High']);
    fireEvent.change(model, { target: { value: 'scout' } });
    expect(setModelId).toHaveBeenCalledWith('scout');
    fireEvent.change(effort, { target: { value: 'high' } });
    expect(setEffort).toHaveBeenCalledWith('high');
  });

  test('a model without levels shows "Fixed by the model", disabled', () => {
    render(<DescribeTemplateDialog mode="seed" question={null} modelChoice={choice({ modelId: 'scout', effortLevels: [] })} onSubmit={noop} onCancel={noop} busy={false} />);
    const { effort } = selects();
    expect(effort.disabled).toBe(true);
    expect(effort.selectedOptions[0]?.textContent).toBe('Fixed by the model');
  });

  test('busy disables both selects', () => {
    render(<DescribeTemplateDialog mode="rework" question={null} modelChoice={choice({ modelId: 'kimi', effortLevels: ['low'] })} onSubmit={noop} onCancel={noop} busy={true} />);
    const { model, effort } = selects();
    expect(model.disabled).toBe(true);
    expect(effort.disabled).toBe(true);
  });

  test('unavailable: both selects disabled at "Use default", submit still works', () => {
    const onSubmit = mock((_: string) => undefined);
    render(<DescribeTemplateDialog mode="rework" question={null} modelChoice={choice({ state: { kind: 'unavailable' }, groups: [], defaultName: undefined })} onSubmit={onSubmit} onCancel={noop} busy={false} />);
    const { model, effort } = selects();
    expect(model.disabled).toBe(true);
    expect(effort.disabled).toBe(true);
    expect(model.selectedOptions[0]?.textContent).toBe('Use default');
    fireEvent.change(screen.getByLabelText('Change instructions'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rework template' }));
    expect(onSubmit).toHaveBeenCalledWith('x');
  });

  test("an offline saved pick shows as the selected option, so 'Use default' is a change", () => {
    const setModelId = mock((_: string) => undefined);
    render(<DescribeTemplateDialog mode="rework" question={null} modelChoice={choice({ modelId: 'gone', effortLevels: null, setModelId })} onSubmit={noop} onCancel={noop} busy={false} />);
    const { model, effort } = selects();
    expect(model.value).toBe('gone');
    expect(model.selectedOptions[0]?.textContent).toBe('Gone (offline)');
    expect(effort.disabled).toBe(true);
    // Choosing the default directly, with no other model picked in between.
    fireEvent.change(model, { target: { value: '' } });
    expect(setModelId).toHaveBeenCalledWith('');
  });

  test('a locked writer replaces the selects with a fixed note', () => {
    render(<DescribeTemplateDialog mode="rework" question={null} modelChoice={choice({ state: { kind: 'locked', writerName: 'GPT 6' } })} onSubmit={noop} onCancel={noop} busy={false} />);
    expect(screen.getByText('Prompts for this image model are always written by GPT 6.')).toBeTruthy();
    expect(screen.queryByLabelText('Model')).toBeNull();
    expect(screen.queryByLabelText('Reasoning')).toBeNull();
  });
});

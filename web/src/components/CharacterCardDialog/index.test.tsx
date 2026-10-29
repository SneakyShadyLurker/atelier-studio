import type { CharacterCardKind } from '@atelier/shared';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import CharacterCardDialog from './index';

afterEach(() => { cleanup(); });

const noop = () => undefined;
const blank = { direction: '', kind: 'subject' } as const;

describe('CharacterCardDialog', () => {
  test('a blank field still creates the card, with no direction', () => {
    const onSubmit = mock((_direction: string, _kind: CharacterCardKind) => undefined);
    render(<CharacterCardDialog initial={blank} onSubmit={onSubmit} onCancel={noop} />);
    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Create card' }));
    expect(onSubmit).toHaveBeenCalledWith('', 'subject');
  });

  test('typed steering is submitted trimmed, also with Cmd/Ctrl+Enter', () => {
    const onSubmit = mock((_direction: string, _kind: CharacterCardKind) => undefined);
    render(<CharacterCardDialog initial={blank} onSubmit={onSubmit} onCancel={noop} />);
    const field = screen.getByRole('textbox', { name: 'Direction for the character card' });
    fireEvent.change(field, { target: { value: '  a retired sea captain  ' } });
    fireEvent.keyDown(field, { key: 'Enter', metaKey: true });
    expect(onSubmit).toHaveBeenCalledWith('a retired sea captain', 'subject');
  });

  test('starts from the pending attempt\'s direction so a retry keeps it', () => {
    const onSubmit = mock((_direction: string, _kind: CharacterCardKind) => undefined);
    render(<CharacterCardDialog initial={{ direction: 'a lighthouse keeper', kind: 'subject' }} onSubmit={onSubmit} onCancel={noop} />);
    expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe('a lighthouse keeper');
    fireEvent.click(screen.getByRole('button', { name: 'Create card' }));
    expect(onSubmit).toHaveBeenCalledWith('a lighthouse keeper', 'subject');
  });

  test('a chosen kind is submitted with the direction, which survives the switch', () => {
    const onSubmit = mock((_direction: string, _kind: CharacterCardKind) => undefined);
    render(<CharacterCardDialog initial={blank} onSubmit={onSubmit} onCancel={noop} />);
    expect(screen.getByRole('group', { name: 'Card type' })).toBeTruthy();
    const field = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Direction for the character card' });
    fireEvent.change(field, { target: { value: 'two sisters' } });
    fireEvent.click(screen.getByRole('radio', { name: /Multiple subjects/ }));
    expect(field.value).toBe('two sisters');
    expect(field.placeholder).toStartWith('e.g. two sisters who run a failing vineyard');
    fireEvent.click(screen.getByRole('button', { name: 'Create card' }));
    expect(onSubmit).toHaveBeenCalledWith('two sisters', 'group');
  });

  test('opens on the pending attempt\'s kind', () => {
    const onSubmit = mock((_direction: string, _kind: CharacterCardKind) => undefined);
    render(<CharacterCardDialog initial={{ direction: '', kind: 'scenario' }} onSubmit={onSubmit} onCancel={noop} />);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: /Scenario/ }).checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: /Single subject/ }).checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Create card' }));
    expect(onSubmit).toHaveBeenCalledWith('', 'scenario');
  });
});

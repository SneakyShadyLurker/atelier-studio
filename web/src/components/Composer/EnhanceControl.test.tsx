import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import EnhanceControl from './EnhanceControl';

afterEach(cleanup);

function setup(over: Partial<Parameters<typeof EnhanceControl>[0]> = {}) {
  const onEnhance = mock();
  const onUndo = mock();
  render(
    <EnhanceControl
      enhancing={false}
      canUndo={false}
      disabled={false}
      onEnhance={onEnhance}
      onUndo={onUndo}
      {...over}
    />,
  );
  return { onEnhance, onUndo };
}

describe('EnhanceControl', () => {
  test('renders both segments; revert always present, disabled until canUndo', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Enhance' })).toBeDefined();
    const undo = screen.getByRole('button', { name: 'Undo enhance' });
    expect(undo.hasAttribute('disabled')).toBe(true);
  });

  test('canUndo enables the revert segment', () => {
    setup({ canUndo: true });
    expect(screen.getByRole('button', { name: 'Undo enhance' }).hasAttribute('disabled')).toBe(false);
  });

  test('enhancing swaps the label and disables the enhance segment', () => {
    setup({ enhancing: true });
    const enhance = screen.getByRole('button', { name: 'Enhance' });
    expect(enhance.hasAttribute('disabled')).toBe(true);
    expect(enhance.textContent).toContain('Enhancing…');
  });

  test('disabled prop disables the enhance segment but not a valid revert', () => {
    setup({ disabled: true, canUndo: true });
    expect(screen.getByRole('button', { name: 'Enhance' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Undo enhance' }).hasAttribute('disabled')).toBe(false);
  });

  test('clicks fire the right callbacks', () => {
    const { onEnhance, onUndo } = setup({ canUndo: true });
    fireEvent.click(screen.getByRole('button', { name: 'Enhance' }));
    fireEvent.click(screen.getByRole('button', { name: 'Undo enhance' }));
    expect(onEnhance).toHaveBeenCalledTimes(1);
    expect(onUndo).toHaveBeenCalledTimes(1);
  });
});

import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import EnhanceControl from './EnhanceControl';

afterEach(cleanup);

function setup(over: Partial<Parameters<typeof EnhanceControl>[0]> = {}) {
  const onEnhance = mock();
  const result = render(
    <EnhanceControl
      working={false}
      disabled={false}
      onEnhance={onEnhance}
      {...over}
    />,
  );
  return { onEnhance, ...result };
}

const ENHANCE = 'Enhance and generate';

describe('EnhanceControl', () => {
  test('one button named for what it does, labelled Enhance, with no Undo', () => {
    const { onEnhance } = setup();
    const enhance = screen.getByRole('button', { name: ENHANCE });
    expect(enhance.textContent).toBe('Enhance');
    expect(enhance.getAttribute('data-tip')).toBe('Rewrite and generate');
    expect(screen.getAllByRole('button')).toHaveLength(1);
    fireEvent.click(enhance);
    expect(onEnhance).toHaveBeenCalledTimes(1);
  });

  test('without a text model the tip says so and the press still reaches the owner (the note)', () => {
    const { onEnhance } = setup({ needsTextModel: true });
    const enhance = screen.getByRole('button', { name: ENHANCE });
    expect(enhance.getAttribute('data-tip')).toBe('Needs a text model');
    fireEvent.click(enhance);
    expect(onEnhance).toHaveBeenCalledTimes(1);
  });

  test('a closed gate is aria-disabled with a click guard, never natively disabled', () => {
    const { onEnhance } = setup({ disabled: true });
    const enhance = screen.getByRole('button', { name: ENHANCE });
    expect(enhance.hasAttribute('disabled')).toBe(false);
    expect(enhance.getAttribute('aria-disabled')).toBe('true');
    enhance.focus();
    fireEvent.click(enhance);
    expect(onEnhance).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(enhance);
  });

  test('working: busy and announced, the label unchanged, and still pressable', () => {
    const { onEnhance } = setup({ working: true });
    const enhance = screen.getByRole('button', { name: ENHANCE });
    expect(enhance.getAttribute('aria-busy')).toBe('true');
    expect(enhance.getAttribute('aria-disabled')).toBeNull();
    expect(enhance.textContent).toBe('Enhance');
    expect(screen.getByRole('status').textContent).toBe('Enhancing prompt…');
    fireEvent.click(enhance);
    fireEvent.click(enhance);
    expect(onEnhance).toHaveBeenCalledTimes(2);
  });

  test('idle: no busy state and a silent status line', () => {
    setup();
    expect(screen.getByRole('button', { name: ENHANCE }).hasAttribute('aria-busy')).toBe(false);
    expect(screen.getByRole('status').textContent).toBe('');
  });

  test('icon-only keeps the accessible name and drops the visible label', () => {
    setup({ iconOnly: true });
    const enhance = screen.getByRole('button', { name: ENHANCE });
    expect(enhance.textContent).toBe('');
  });
});

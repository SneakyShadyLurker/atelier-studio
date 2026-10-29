import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef, useState } from 'react';
import { TIP_LABEL_ATTRIBUTE, useTooltipDismiss } from '../../hooks/useTooltipDismiss';
import InlineFieldChrome from './InlineFieldChrome';

afterEach(cleanup);

describe('InlineFieldChrome', () => {
  test('renders shared inline-title chrome without the native title or a tooltip', () => {
    const ref = createRef<HTMLInputElement>();

    render(
      <InlineFieldChrome
        ref={ref}
        kicker="TEMPLATE"
        ariaLabel="Template name"
        value="Hero"
        onChange={() => undefined}
      />,
    );

    expect(screen.getByText('TEMPLATE')).toBeTruthy();
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Template name' });
    expect(input.value).toBe('Hero');
    expect(input.getAttribute('title')).toBeNull();
    expect(input.getAttribute('data-cancel-inline')).toBe('true');
    // The field shows its own value: a label would echo the typing and take
    // Escape from the field's blur.
    expect(input.hasAttribute('data-tip')).toBe(false);
    expect(input.hasAttribute('data-tip-place')).toBe(false);
    expect(ref.current).toBe(input);
  });

  test('typing shows no label, and the first Escape reaches the field', () => {
    const onEscape = mock();
    function Editor() {
      useTooltipDismiss();
      const [name, setName] = useState('Hero');
      return (
        <InlineFieldChrome
          kicker="TEMPLATE"
          ariaLabel="Template name"
          value={name}
          onChange={(event) => { setName(event.target.value); }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              onEscape();
              event.currentTarget.blur();
            }
          }}
        />
      );
    }
    render(<Editor />);
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Template name' });
    fireEvent.pointerOver(input);
    act(() => { input.focus(); });
    fireEvent.change(input, { target: { value: 'Hero shot' } });
    expect(document.querySelector(`[${TIP_LABEL_ATTRIBUTE}][data-open]`)).toBeNull();

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(input);
  });
});

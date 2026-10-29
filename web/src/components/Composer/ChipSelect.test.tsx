import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useKeyboard } from '../../hooks/useKeyboard';
import ChipSelect, { type ChipSelectOption } from './ChipSelect';

const originalMatchMedia = window.matchMedia.bind(window);
const originalAddEventListener = document.addEventListener.bind(document);
const originalRemoveEventListener = document.removeEventListener.bind(document);

function installMatchMedia(isPhone: boolean): void {
  window.matchMedia = mock((query: string) => ({
    matches: isPhone && query.includes('width < 768px'),
    media: query,
    onchange: null,
    addEventListener: mock(() => undefined),
    removeEventListener: mock(() => undefined),
    addListener: mock(() => undefined),
    removeListener: mock(() => undefined),
    dispatchEvent: mock(() => true),
  }));
}

function installDesktop(): void {
  installMatchMedia(false);
}

function installPhone(): void {
  installMatchMedia(true);
}

function TestChipSelect({ onChange }: { onChange: (value: string) => void }) {
  useKeyboard([]);
  const options: readonly ChipSelectOption<string>[] = [
    { value: 'one', label: 'One' },
    { value: 'two', label: 'Two' },
  ];

  return (
    <ChipSelect
      ariaLabel="Choice"
      valueDisplay="One"
      options={options}
      value="one"
      onChange={onChange}
    />
  );
}

function ActionableChipSelect({ onChange }: { onChange: (value: string) => void }) {
  useKeyboard([]);
  const options: readonly ChipSelectOption<string>[] = [
    {
      value: 'offline',
      label: 'Offline model',
      hint: 'Offline · Check again',
      actionable: true,
      keepOpenOnSelect: true,
    },
  ];
  return (
    <ChipSelect
      ariaLabel="Choice"
      valueDisplay="Other"
      options={options}
      value="other"
      onChange={onChange}
    />
  );
}

afterEach(() => {
  cleanup();
  window.matchMedia = originalMatchMedia;
  document.addEventListener = originalAddEventListener;
  document.removeEventListener = originalRemoveEventListener;
  mock.restore();
});

describe('ChipSelect keyboard listener', () => {
  test('stays bound once while open across parent re-renders', () => {
    installDesktop();
    const addKeydown = mock();
    const removeKeydown = mock();
    document.addEventListener = mock((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
      if (type === 'keydown') addKeydown();
      originalAddEventListener.call(document, type, listener, options);
    }) as typeof document.addEventListener;
    document.removeEventListener = mock((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
      if (type === 'keydown') removeKeydown();
      originalRemoveEventListener.call(document, type, listener, options);
    }) as typeof document.removeEventListener;

    const { rerender, unmount } = render(<TestChipSelect onChange={mock()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Choice' }));

    rerender(<TestChipSelect onChange={mock()} />);
    rerender(<TestChipSelect onChange={mock()} />);

    expect(addKeydown).toHaveBeenCalledTimes(1);
    expect(removeKeydown).toHaveBeenCalledTimes(0);

    unmount();
    expect(removeKeydown).toHaveBeenCalledTimes(1);
  });

  test('phone: open menu renders a tap-catching backdrop that closes only the menu', async () => {
    installPhone();
    const onChange = mock();
    render(<TestChipSelect onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Choice' }));

    // The bottom-sheet must own a backdrop so an outside tap is consumed here
    // instead of falling through to the composer scrim (which would collapse
    // the whole composer). See ChipSelect bottom-sheet dismissal.
    const backdrop = screen.getByTestId('chipselect-backdrop');
    expect(screen.queryByRole('listbox', { name: 'Choice' })).not.toBeNull();

    // Critical ordering: a real tap fires pointerdown BEFORE click. The menu's
    // document-level outside-pointer dismissal must be OFF on phone, otherwise
    // pointerdown closes the menu (unmounting the backdrop) and the click falls
    // through to the composer scrim → collapse. So pointerdown must NOT close.
    fireEvent.pointerDown(backdrop);
    expect(screen.queryByRole('listbox', { name: 'Choice' })).not.toBeNull();

    // The click on the still-mounted backdrop is what closes the sheet —
    // after the shared exit transition (useExitTransition) has played.
    fireEvent.click(backdrop);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(screen.queryByRole('listbox', { name: 'Choice' })).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  test('desktop: open menu does NOT render a backdrop (non-modal popover)', () => {
    installDesktop();
    render(<TestChipSelect onChange={mock()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Choice' }));

    expect(screen.queryByRole('listbox', { name: 'Choice' })).not.toBeNull();
    expect(screen.queryByTestId('chipselect-backdrop')).toBeNull();
  });

  test('desktop: the listbox names its own chip as the anchor from its first frame, never measured', () => {
    installDesktop();
    render(<TestChipSelect onChange={mock()} />);
    const chip = screen.getByRole('button', { name: 'Choice' });
    fireEvent.click(chip);

    const listbox = screen.getByRole('listbox', { name: 'Choice' });
    expect(listbox.getAttribute('data-anchor-place')).toBe('above-start');
    expect(listbox.getAttribute('data-anchor-width')).toBe('trigger');
    expect(listbox.getAttribute('data-anchored')).toBe('name');
    // Declared on both ends; the stylesheet turns it into anchor-name and
    // position-anchor.
    const name = listbox.style.getPropertyValue('--named-anchor');
    expect(name).toMatch(/^--chip-[\w-]+$/);
    expect(chip.style.getPropertyValue('--named-anchor')).toBe(name);
    // Ordinary layer under the toast stack, not the top layer.
    expect(listbox.hasAttribute('popover')).toBe(false);
    // No hidden measuring pass and no script coordinates.
    expect(listbox.style.visibility).toBe('');
    expect(listbox.style.top).toBe('');
    expect(listbox.style.left).toBe('');
    expect(listbox.style.minWidth).toBe('');
    expect(listbox.style.maxHeight).toBe('');
  });

  test('repeated chips each anchor their own menu', async () => {
    installDesktop();
    function Pair() {
      useKeyboard([]);
      const options: readonly ChipSelectOption<string>[] = [{ value: 'one', label: 'One' }];
      return (
        <>
          <ChipSelect ariaLabel="First" valueDisplay="One" options={options} value="one" onChange={() => undefined} />
          <ChipSelect ariaLabel="Second" valueDisplay="One" options={options} value="one" onChange={() => undefined} />
        </>
      );
    }
    render(<Pair />);
    fireEvent.click(screen.getByRole('button', { name: 'First' }));
    const first = screen.getByRole('listbox', { name: 'First' }).style.getPropertyValue('--named-anchor');
    fireEvent.keyDown(document, { key: 'Escape' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    fireEvent.click(screen.getByRole('button', { name: 'Second' }));
    const second = screen.getByRole('listbox', { name: 'Second' }).style.getPropertyValue('--named-anchor');
    expect(first).not.toBe('');
    expect(second).not.toBe('');
    expect(second).not.toBe(first);
  });

  test('phone: the bottom sheet carries no anchoring', () => {
    installPhone();
    render(<TestChipSelect onChange={mock()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Choice' }));
    const listbox = screen.getByRole('listbox', { name: 'Choice' });
    expect(listbox.hasAttribute('data-anchor-place')).toBe(false);
    expect(listbox.hasAttribute('data-anchored')).toBe(false);
    expect(listbox.style.getPropertyValue('--named-anchor')).toBe('');
  });

  test('actionable dimmed row is enabled, discloses its action, and keeps the menu open', () => {
    installDesktop();
    const onChange = mock();
    render(<ActionableChipSelect onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Choice' }));

    const option = screen.getByRole('option', { name: /Offline model.*Offline.*Check again/i });
    expect(option.getAttribute('aria-disabled')).toBeNull();
    expect(option.getAttribute('data-dimmed')).toBe('true');
    fireEvent.click(option);

    expect(onChange).toHaveBeenCalledWith('offline');
    expect(screen.queryByRole('listbox', { name: 'Choice' })).not.toBeNull();
  });

  test('global scoped keys move and close the open listbox', async () => {
    installDesktop();
    const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
    const scrollIntoView = mock(() => undefined);
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
    try {
      const onChange = mock();
      render(<TestChipSelect onChange={onChange} />);
      const trigger = screen.getByRole('button', { name: 'Choice' });
      fireEvent.click(trigger);

      fireEvent.keyDown(document, { key: 'ArrowDown' });
      expect(scrollIntoView).toHaveBeenCalled();

      // Tab closes the listbox and restores focus to the trigger WITHOUT selecting.
      fireEvent.keyDown(document, { key: 'Tab' });
      expect(onChange).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(trigger);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(screen.queryByRole('listbox', { name: 'Choice' })).toBeNull();

      // Space activates the focused option (ARIA single-select listbox APG):
      // reopen, move to 'two', then Space commits and closes.
      fireEvent.click(trigger);
      fireEvent.keyDown(document, { key: 'ArrowDown' });
      fireEvent.keyDown(document, { key: ' ' });
      expect(onChange).toHaveBeenCalledWith('two');
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(screen.queryByRole('listbox', { name: 'Choice' })).toBeNull();
    } finally {
      if (originalScrollIntoView) {
        Object.defineProperty(Element.prototype, 'scrollIntoView', originalScrollIntoView);
      } else {
        Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
      }
    }
  });
});

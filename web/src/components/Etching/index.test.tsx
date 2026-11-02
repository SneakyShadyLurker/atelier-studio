import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, render } from '@testing-library/react';
import { Etching } from './index';

afterEach(() => { cleanup(); });

function etching(container: HTMLElement): HTMLElement {
  const element = container.querySelector('[data-etching]');
  if (!(element instanceof HTMLElement)) throw new Error('No etching rendered');
  return element;
}

describe('Etching', () => {
  test('renders a decorative element carrying its asset mask and ratio', () => {
    const { container } = render(<Etching id="empty-canvas" />);
    const element = etching(container);

    expect(element.getAttribute('aria-hidden')).toBe('true');
    expect(element.getAttribute('data-etching')).toBe('empty-canvas');
    expect(element.style.getPropertyValue('--etch-url')).toMatch(/^url\(".*empty-canvas.*\.webp"\)$/);
    expect(element.style.getPropertyValue('--etch-ratio')).toBe('3 / 2');
    // Design 4.2 display widths: desktop, then phone.
    expect(element.style.getPropertyValue('--etch-width-desktop')).toBe('360px');
    expect(element.style.getPropertyValue('--etch-width-phone')).toBe('240px');
    expect(element.style.getPropertyValue('--etch-width')).toBe('');
  });

  test('square assets get a square ratio, and a width prop overrides the default', () => {
    const { container } = render(<Etching id="state-error" width={96} />);
    const element = etching(container);

    expect(element.style.getPropertyValue('--etch-url')).toContain('state-error');
    expect(element.style.getPropertyValue('--etch-ratio')).toBe('1 / 1');
    expect(element.style.getPropertyValue('--etch-width')).toBe('96px');
  });
});

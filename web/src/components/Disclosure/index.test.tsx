import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import { Disclosure } from './index';

afterEach(() => { cleanup(); });

describe('Disclosure', () => {
  test('a closed panel stays mounted, inert and hidden from assistive technology', () => {
    render(<Disclosure open={false} id="panel"><button type="button">inside</button></Disclosure>);
    const panel = document.getElementById('panel');
    expect(panel?.hasAttribute('inert')).toBe(true);
    expect(panel?.getAttribute('aria-hidden')).toBe('true');
    expect(panel?.hasAttribute('data-open')).toBe(false);
    expect(panel?.textContent).toBe('inside');
    expect(screen.queryByRole('button', { name: 'inside' })).toBeNull();
  });

  test('opening flips data-open on the same node and keeps the content mounted', () => {
    const { rerender } = render(<Disclosure open={false} id="panel"><p>inside</p></Disclosure>);
    const panel = document.getElementById('panel');
    const content = screen.getByText('inside');
    rerender(<Disclosure open id="panel"><p>inside</p></Disclosure>);
    expect(document.getElementById('panel')).toBe(panel);
    expect(panel?.getAttribute('data-open')).toBe('true');
    expect(panel?.hasAttribute('inert')).toBe(false);
    expect(panel?.getAttribute('aria-hidden')).toBe('false');
    expect(screen.getByText('inside')).toBe(content);
  });

  test('lazy content mounts on first open and stays mounted after closing', () => {
    const { rerender } = render(<Disclosure open={false} lazy id="panel"><p>inside</p></Disclosure>);
    expect(screen.queryByText('inside')).toBeNull();
    rerender(<Disclosure open lazy id="panel"><p>inside</p></Disclosure>);
    const content = screen.getByText('inside');
    rerender(<Disclosure open={false} lazy id="panel"><p>inside</p></Disclosure>);
    expect(screen.getByText('inside')).toBe(content);
    expect(document.getElementById('panel')?.hasAttribute('inert')).toBe(true);
  });
});

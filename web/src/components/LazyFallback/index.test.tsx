import { describe, expect, test } from 'bun:test';
import { render, screen } from '@testing-library/react';
import { LazyFallback } from './index';

describe('LazyFallback', () => {
  test('announces delayed lazy content without leaving the surface blank', () => {
    render(<LazyFallback label="Loading archive" />);
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Loading archive');
    // The plate at rest: one empty decorative element beside the label, no
    // art. The browser spec (motion.spec.ts) pins its pulse.
    const decorative = status.querySelectorAll('[aria-hidden="true"]');
    expect(decorative).toHaveLength(1);
    expect(decorative[0]?.childNodes).toHaveLength(0);
    expect(status.querySelector('[data-etching]')).toBeNull();
  });
});

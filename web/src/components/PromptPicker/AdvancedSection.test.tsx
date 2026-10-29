import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import AdvancedSection from './AdvancedSection';

afterEach(() => { cleanup(); });

describe('AdvancedSection', () => {
  test('collapsed by default: toggle present with count label, children hidden', () => {
    render(
      <AdvancedSection count={3}>
        <p>axis controls</p>
      </AdvancedSection>,
    );
    const toggle = screen.getByRole('button', { name: /^Advanced · 3 variables/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('axis controls')).toBeNull();
  });

  test('singular count label for a single variable', () => {
    render(<AdvancedSection count={1}><p>x</p></AdvancedSection>);
    expect(screen.getByRole('button', { name: /^Advanced · 1 variable$/ })).toBeTruthy();
  });

  test('clicking expands: children visible inside a labelled group, aria-expanded flips', () => {
    render(
      <AdvancedSection count={2}>
        <p>axis controls</p>
      </AdvancedSection>,
    );
    const toggle = screen.getByRole('button', { name: /^Advanced/ });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const group = screen.getByRole('group', { name: 'Advanced variables' });
    expect(group.textContent).toContain('axis controls');
  });

  test('clicking again collapses', () => {
    render(<AdvancedSection count={2}><p>axis controls</p></AdvancedSection>);
    const toggle = screen.getByRole('button', { name: /^Advanced/ });
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('axis controls')).toBeNull();
  });
});

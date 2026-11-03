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
    const toggle = screen.getByRole('button', { name: /^Advanced, 3 variables/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const panel = screen.getByText('axis controls').closest('[role="group"]');
    expect(panel?.id).toBe(toggle.getAttribute('aria-controls') ?? '');
    expect(panel?.hasAttribute('inert')).toBe(true);
    expect(panel?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByRole('group', { name: 'Advanced variables' })).toBeNull();
  });

  test('singular count label for a single variable', () => {
    render(<AdvancedSection count={1}><p>x</p></AdvancedSection>);
    expect(screen.getByRole('button', { name: /^Advanced, 1 variable$/ })).toBeTruthy();
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
    expect(group.hasAttribute('inert')).toBe(false);
    expect(group.getAttribute('data-open')).toBe('true');
  });

  test('clicking again collapses', () => {
    render(<AdvancedSection count={2}><p>axis controls</p></AdvancedSection>);
    const toggle = screen.getByRole('button', { name: /^Advanced/ });
    fireEvent.click(toggle);
    const panel = screen.getByRole('group', { name: 'Advanced variables' });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('group', { name: 'Advanced variables' })).toBeNull();
    expect(screen.getByText('axis controls').closest('[role="group"]')).toBe(panel);
    expect(panel.hasAttribute('inert')).toBe(true);
    expect(panel.getAttribute('aria-hidden')).toBe('true');
    expect(panel.hasAttribute('data-open')).toBe(false);
  });
});

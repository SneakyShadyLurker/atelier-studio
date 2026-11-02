import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ManagedViewHeader } from './index';

afterEach(() => { cleanup(); });

describe('ManagedViewHeader', () => {
  test('renders default back label, scope label, and a heading wired by id', () => {
    render(
      <ManagedViewHeader heading="Archive" headingId="x-heading" label="3 items" onBack={() => undefined} />,
    );
    expect(screen.getByRole('button', { name: 'Back to feed' })).toBeTruthy();
    expect(screen.getByText('3 items')).toBeTruthy();
    const heading = screen.getByRole('heading', { level: 2, name: 'Archive' });
    expect(heading.getAttribute('id')).toBe('x-heading');
  });

  test('the title is visible and the scope renders as a separate label', () => {
    render(
      <ManagedViewHeader heading="Archive" headingId="x-heading" label="3 items" onBack={() => undefined} />,
    );
    const heading = screen.getByRole('heading', { level: 2, name: 'Archive' });
    // The title is no longer the visually hidden anchor; it is the view's title.
    expect(heading.classList.contains('srOnly')).toBe(false);
    const scope = screen.getByText('3 items');
    expect(scope.tagName).not.toBe('H2');
    expect(heading.contains(scope)).toBe(false);
    expect(heading.parentElement?.contains(scope)).toBe(true);
  });

  test('omits the scope label when none is given', () => {
    const { container } = render(
      <ManagedViewHeader heading="Text models" headingId="tm" onBack={() => undefined} />,
    );
    const heading = screen.getByRole('heading', { level: 2, name: 'Text models' });
    expect(heading.parentElement?.children).toHaveLength(1);
    expect(container.querySelector('header')?.textContent).toBe('Back to feedText models');
  });

  test('back button invokes onBack; custom backLabel and right-action children render', () => {
    const onBack = mock(() => undefined);
    render(
      <ManagedViewHeader
        heading="Prompt Library"
        headingId="pm"
        backLabel="Back to feed"
        onBack={onBack}
      >
        <button type="button">Empty Archive</button>
      </ManagedViewHeader>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Back to feed' }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Empty Archive' })).toBeTruthy();
  });

  test('renders no tablist or help control when used without children (Archive)', () => {
    render(
      <ManagedViewHeader heading="Archive" headingId="h" label="0 items" onBack={() => undefined} />,
    );
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('button', { name: 'How the prompt library works' })).toBeNull();
  });
});

import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ManagedViewHeader } from './index';

afterEach(() => { cleanup(); });

describe('ManagedViewHeader', () => {
  test('renders default back label, scope label, and an sr-only heading wired by id', () => {
    render(
      <ManagedViewHeader heading="Archive" headingId="x-heading" label="ARCHIVE · 3 ITEMS" onBack={() => undefined} />,
    );
    expect(screen.getByRole('button', { name: 'Back to feed' })).toBeTruthy();
    expect(screen.getByText('ARCHIVE · 3 ITEMS')).toBeTruthy();
    const heading = screen.getByRole('heading', { level: 2, name: 'Archive' });
    expect(heading.getAttribute('id')).toBe('x-heading');
  });

  test('back button invokes onBack; custom backLabel and right-action children render', () => {
    const onBack = mock(() => undefined);
    render(
      <ManagedViewHeader
        heading="Prompt Library"
        headingId="pm"
        label="PROMPT LIBRARY"
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
      <ManagedViewHeader heading="Archive" headingId="h" label="ARCHIVE · 0 ITEMS" onBack={() => undefined} />,
    );
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('button', { name: 'How the prompt library works' })).toBeNull();
  });
});

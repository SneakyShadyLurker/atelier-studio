import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ManagedViewHeader } from './index';

afterEach(() => { cleanup(); });

describe('ManagedViewHeader', () => {
  test('renders the back label it is given and a heading wired by id', () => {
    render(
      <ManagedViewHeader heading="Archive" headingId="x-heading" backLabel="Back to Unsorted" onBack={() => undefined} />,
    );
    expect(screen.getByRole('button', { name: 'Back to Unsorted' })).toBeTruthy();
    const heading = screen.getByRole('heading', { level: 2, name: 'Archive' });
    expect(heading.getAttribute('id')).toBe('x-heading');
    // The title is the view's visible title, not a visually hidden anchor.
    expect(heading.classList.contains('srOnly')).toBe(false);
  });

  test('the back button keeps its label as its name; only a phone, which shows the arrow alone, adds a tip', () => {
    const { unmount } = render(
      <ManagedViewHeader heading="Archive" headingId="a" backLabel="Back to Campaign studies" onBack={() => undefined} />,
    );
    const desktopBack = screen.getByRole('button', { name: 'Back to Campaign studies' });
    // Desktop shows the label, so a tip would only repeat it.
    expect(desktopBack.getAttribute('data-tip')).toBeNull();
    expect(desktopBack.querySelector('[aria-hidden="true"] svg')).not.toBeNull();
    unmount();

    const matchMedia = window.matchMedia.bind(window);
    window.matchMedia = ((query: string) => ({
      matches: query === '(width < 768px)', media: query, onchange: null,
      addEventListener: () => undefined, removeEventListener: () => undefined,
      addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => true,
    }));
    try {
      render(
        <ManagedViewHeader heading="Archive" headingId="b" backLabel="Back to Campaign studies" onBack={() => undefined} />,
      );
      expect(screen.getByRole('button', { name: 'Back to Campaign studies' }).getAttribute('data-tip')).toBe('Back to Campaign studies');
    } finally {
      window.matchMedia = matchMedia;
    }
  });

  test('the title stands alone: nothing renders beside it', () => {
    const { container } = render(
      <ManagedViewHeader heading="Text models" headingId="tm" backLabel="Back to Unsorted" onBack={() => undefined} />,
    );
    const heading = screen.getByRole('heading', { level: 2, name: 'Text models' });
    expect(heading.parentElement?.children).toHaveLength(1);
    expect(container.querySelector('header')?.textContent).toBe('Back to UnsortedText models');
  });

  test('without onBack there is no back button, only the title', () => {
    const { container } = render(<ManagedViewHeader heading="Unsorted" headingId="feed" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(container.querySelector('header')?.textContent).toBe('Unsorted');
  });

  test('back button invokes onBack; right-action children render', () => {
    const onBack = mock(() => undefined);
    render(
      <ManagedViewHeader
        heading="Prompt Library"
        headingId="pm"
        backLabel="Back to Unsorted"
        onBack={onBack}
      >
        <button type="button">Empty archive</button>
      </ManagedViewHeader>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Back to Unsorted' }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Empty archive' })).toBeTruthy();
  });

  test('renders no tablist or help control when used without children (Archive)', () => {
    render(
      <ManagedViewHeader heading="Archive" headingId="h" backLabel="Back to Unsorted" onBack={() => undefined} />,
    );
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('button', { name: 'How the Prompt Library works' })).toBeNull();
  });
});

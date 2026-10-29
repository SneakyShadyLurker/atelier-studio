import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import QueuedTile from './index';

afterEach(() => {
  cleanup();
});

describe('QueuedTile', () => {
  test('renders static queue status as a single role="img" without generation affordances', () => {
    const { container } = render(<QueuedTile queueLengthAhead={3} />);

    expect(screen.getByText('Queued · #4')).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
    // Single labelled image; the model is announced by the batch header, not here.
    const region = screen.getByRole('img');
    expect(region.getAttribute('aria-label')).toBe('Queued · #4');
  });

  test('omits the ahead suffix at the head of the queue', () => {
    render(<QueuedTile queueLengthAhead={0} />);

    expect(screen.getByText('Queued · head')).toBeTruthy();
  });
});

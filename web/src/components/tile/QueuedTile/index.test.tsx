import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import QueuedTile from './index';

afterEach(() => {
  cleanup();
});

describe('QueuedTile', () => {
  test('renders static queue status as a single role="img" without generation affordances', () => {
    const { container } = render(<QueuedTile queueLengthAhead={3} />);

    expect(screen.getByText('Queued, 3 ahead')).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
    // The plate at rest: the status line is the only layer, no sheen.
    expect(screen.getByRole('img').children).toHaveLength(1);
    // Single labelled image; the model is announced by the batch header, not here.
    const region = screen.getByRole('img');
    expect(region.getAttribute('aria-label')).toBe('Queued, 3 ahead');
  });

  test('omits the ahead suffix at the head of the queue', () => {
    render(<QueuedTile queueLengthAhead={0} />);

    expect(screen.getByText('Queued, next')).toBeTruthy();
  });
  test('shows an unknown position without claiming the head of the queue', () => {
    render(<QueuedTile queueLengthAhead={undefined} />);
    expect(screen.getByText('Queued')).toBeTruthy();
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('Queued');
    expect(screen.queryByText('Queued, next')).toBeNull();
  });
});

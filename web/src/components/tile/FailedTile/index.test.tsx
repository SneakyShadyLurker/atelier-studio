import { describe, expect, test } from 'bun:test';
import { render, screen } from '@testing-library/react';
import FailedTile from './index';
import type { Tile } from '@atelier/shared';

function failedTile(error: string): Extract<Tile, { status: 'failed' }> {
  return { id: 't1', seed: 1, status: 'failed', error: error as never, completedAt: 1 };
}

describe('FailedTile service unavailable', () => {
  test('renders temporary-unavailable copy and keeps Retry', () => {
    const noop = () => { /* noop */ };
    render(
      <FailedTile tile={failedTile('service unavailable')} aspectRatio="1 / 1" onRetry={noop} onDismiss={noop} />,
    );
    expect(screen.getByText(/temporarily unavailable/i)).toBeDefined();
    expect(screen.getByLabelText('Retry failed tile')).toBeDefined();
  });
});

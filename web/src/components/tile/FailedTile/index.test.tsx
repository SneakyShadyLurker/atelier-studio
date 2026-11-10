import { afterEach, describe, expect, test } from 'bun:test';
import { act, cleanup, render, screen } from '@testing-library/react';
import FailedTile from './index';
import type { Tile } from '@atelier/shared';

afterEach(cleanup);

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

describe('FailedTile replacing a loading plate', () => {
  test('an entered tile marks its body for the in-place fade, the shell stays still', () => {
    const noop = () => { /* noop */ };
    const { container } = render(
      <FailedTile tile={failedTile('timed out')} aspectRatio="16 / 9" entered onRetry={noop} onDismiss={noop} />,
    );
    const tile = container.querySelector('[data-feed-tile]');
    expect(tile?.getAttribute('data-seen')).toBe('true');
    expect(tile?.getAttribute('data-entered')).toBe('true');
  });

  test('a tile that mounted failed carries no in-place mark', () => {
    const noop = () => { /* noop */ };
    const { container } = render(
      <FailedTile tile={failedTile('timed out')} aspectRatio="16 / 9" seen onRetry={noop} onDismiss={noop} />,
    );
    expect(container.querySelector('[data-feed-tile]')?.hasAttribute('data-entered')).toBe(false);
  });
});

describe('FailedTile dismiss focus', () => {
  test('dismissing the only tile of a batch hands focus to a neighbouring row, not the leaving header', async () => {
    const { container } = render(
      <div data-testid="canvas-scroller" tabIndex={0}>
        <div data-batch-id="older"><section data-batch-id="older"><div><div data-feed-tile="done"><button type="button" id="older-open">open</button></div></div></section></div>
        <div data-batch-id="b">
          <section data-batch-id="b">
            <header><button type="button">Archive batch</button></header>
            <div><FailedTile tile={failedTile('timed out')} aspectRatio="1 / 1" onRetry={() => undefined} onDismiss={() => undefined} /></div>
          </section>
        </div>
      </div>,
    );
    const dismiss = container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss failed tile"]');
    dismiss?.focus();
    await act(async () => { dismiss?.click(); await Promise.resolve(); });
    expect(document.activeElement?.id).toBe('older-open');
  });
});

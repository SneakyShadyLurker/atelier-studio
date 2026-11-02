import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ErrorState, LoadingState, StateView } from './index';

afterEach(() => { cleanup(); });

describe('StateView', () => {
  test('an art surface shows its etching in the plate above heading, body and action', () => {
    const onClick = mock(() => undefined);
    const { container } = render(
      <StateView art="empty-archive" title="Nothing archived" body="Deleted images live here." action={{ label: 'Go back', onClick }} />,
    );

    const etching = container.querySelector('[data-etching="empty-archive"]');
    expect(etching).not.toBeNull();
    expect(etching?.getAttribute('aria-hidden')).toBe('true');
    // The plate is the etching's frame and the state's first child.
    const state = container.firstElementChild;
    expect(state?.firstElementChild).toBe(etching?.parentElement ?? null);
    expect(screen.getByRole('heading', { name: 'Nothing archived' })).toBeTruthy();
    expect(screen.getByText('Deleted images live here.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Go back' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test('error states use the state-error etching and keep their retry', () => {
    const onRetry = mock(() => undefined);
    const { container } = render(<ErrorState message="Couldn’t load history." onRetry={onRetry} />);

    expect(container.querySelector('[data-etching="state-error"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test('the loading state shows the empty plate at rest: no glyph, no etching', () => {
    const { container } = render(<LoadingState label="Loading history…" />);

    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Loading history…');
    expect(container.querySelector('svg')).toBeNull();
    expect(container.querySelector('[data-etching]')).toBeNull();
    // One empty decorative plate ahead of the heading, like LazyFallback's.
    const decorative = status.querySelectorAll('[aria-hidden="true"]');
    expect(decorative).toHaveLength(1);
    expect(decorative[0]?.childNodes).toHaveLength(0);
    expect(status.firstElementChild).toBe(decorative[0] ?? null);
  });

  test('icon-only states keep their glyph and render no etching', () => {
    const { container } = render(<StateView glyph={<svg aria-hidden="true" />} title="This view hit an error" />);

    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.querySelector('[data-etching]')).toBeNull();
  });
});

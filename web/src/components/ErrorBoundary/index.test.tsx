import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import { ErrorBoundary, renderErrorMetricPayload } from './index';

function ThrowingChild(): never {
  throw new Error('boom');
}

function StableChild() {
  return <div>Recovered child</div>;
}

afterEach(() => { cleanup(); });

describe('ErrorBoundary', () => {
  test('renders its static page fallback as status, not alert', () => {
    const originalError = console.error;
    console.error = mock(() => undefined);
    try {
      render(
        <ErrorBoundary>
          <ThrowingChild />
        </ErrorBoundary>,
      );

      expect(screen.getByRole('status').textContent).toContain('Something went wrong');
      expect(screen.queryByRole('alert')).toBeNull();
    } finally {
      console.error = originalError;
    }
  });

  test('resets a scoped fallback when a reset key changes', () => {
    const originalError = console.error;
    console.error = mock(() => undefined);
    try {
      const { rerender } = render(
        <ErrorBoundary resetKeys={[0]} fallback={<button type="button">Reload section</button>}>
          <ThrowingChild />
        </ErrorBoundary>,
      );

      expect(screen.getByRole('button', { name: 'Reload section' })).toBeTruthy();

      rerender(
        <ErrorBoundary resetKeys={[1]} fallback={<button type="button">Reload section</button>}>
          <StableChild />
        </ErrorBoundary>,
      );

      expect(screen.getByText('Recovered child')).toBeTruthy();
    } finally {
      console.error = originalError;
    }
  });

  test('truncates render-error fields to the metrics schema caps', () => {
    const error = new Error('m'.repeat(3000));
    error.stack = 's'.repeat(1200);

    const payload = renderErrorMetricPayload(error, { componentStack: 'c'.repeat(1200) });

    expect(payload.message.length).toBe(2048);
    expect(payload.stack?.length).toBe(1024);
    expect(payload.componentStack?.length).toBe(1024);
  });
});

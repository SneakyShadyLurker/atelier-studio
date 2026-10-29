import { describe, expect, test } from 'bun:test';
import { render, screen } from '@testing-library/react';
import { LazyFallback } from './index';

describe('LazyFallback', () => {
  test('announces delayed lazy content without leaving the surface blank', () => {
    render(<LazyFallback label="Loading archive" />);
    expect(screen.getByRole('status').textContent).toContain('Loading archive');
  });
});

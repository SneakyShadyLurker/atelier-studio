import { describe, expect, test } from 'bun:test';
import { render } from '@testing-library/react';
import { I } from './I';

describe('I icon registry', () => {
  test('info renders an svg', () => {
    const { container } = render(<>{I.info()}</>);
    expect(container.querySelector('svg')).toBeTruthy();
  });
  test('pencil renders an svg', () => {
    const { container } = render(<>{I.pencil()}</>);
    expect(container.querySelector('svg')).toBeTruthy();
  });
});

import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import { Meta } from './index';

afterEach(() => { cleanup(); });

describe('Meta', () => {
  test('renders one list item per field, in order', () => {
    render(<Meta items={['Krea 2', '3:4', 4]} />);
    const items = screen.getAllByRole('listitem').map((item) => item.textContent);
    expect(items).toEqual(['Krea 2', '3:4', '4']);
    expect(screen.getByRole('list').tagName).toBe('UL');
  });

  test('drops empty fields but keeps zero', () => {
    render(<Meta items={['Krea 2', null, undefined, false, '', 0, 'done']} />);
    const items = screen.getAllByRole('listitem').map((item) => item.textContent);
    expect(items).toEqual(['Krea 2', '0', 'done']);
  });

  test('renders nothing when every field is empty', () => {
    const { container } = render(<Meta items={[null, '', false]} />);
    expect(container.firstChild).toBeNull();
  });

  test('passes the caller className through to the list', () => {
    render(<Meta items={['a']} className="caption" />);
    const list = screen.getByRole('list');
    expect(list.classList.contains('caption')).toBe(true);
  });
});

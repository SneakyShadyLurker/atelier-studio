import { describe, expect, test } from 'bun:test';
import { isAbortError } from './abort';

describe('isAbortError', () => {
  test('true for a DOMException named AbortError', () => {
    expect(isAbortError(new DOMException('aborted', 'AbortError'))).toBe(true);
  });

  test('true for a plain Error named AbortError', () => {
    const e = new Error('aborted');
    e.name = 'AbortError';
    expect(isAbortError(e)).toBe(true);
  });

  test('false for other errors and non-errors', () => {
    expect(isAbortError(new Error('boom'))).toBe(false);
    expect(isAbortError(new DOMException('x', 'DataError'))).toBe(false);
    expect(isAbortError({ name: 'AbortError' })).toBe(false); // bare object: instanceof gate
    expect(isAbortError(undefined)).toBe(false);
  });
});

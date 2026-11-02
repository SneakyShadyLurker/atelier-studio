import { describe, expect, test } from 'bun:test';
import { ApiError } from '../api/client';
import { describeError, describeQueueFull } from './errorCopy';

describe('describeError', () => {
  test('renders the first Zod issue path and message', () => {
    const error = new ApiError(400, 'validation failed', {
      error: 'validation failed',
      issues: [{ path: ['tagIds', 3], message: 'expected uuid' }],
    });

    expect(describeError(error, 'fallback')).toBe('path: tagIds[3], expected uuid');
  });

  test('renders queue-full retry guidance', () => {
    const error = new ApiError(429, 'queue full', {
      code: 'QUEUE_FULL',
      retry_after_seconds: 5,
    });

    expect(describeQueueFull(error)).toBe('At capacity — try again in 5s');
    expect(describeError(error, 'fallback')).toBe('At capacity — try again in 5s');
  });

  test('appends request ids only to server-error copy', () => {
    const body = { error: 'server failed' };
    expect(describeError(new ApiError(503, 'server failed', body, 'req-abcdefghi'), 'fallback'))
      .toBe('Something went wrong on our end. Please try again. (req: req_req-abcd)');
    expect(describeError(new ApiError(400, 'bad request', body, 'req-abcdefghi'), 'fallback'))
      .toBe('bad request');
  });
});

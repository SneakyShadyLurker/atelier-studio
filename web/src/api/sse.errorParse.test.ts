import { describe, expect, test } from 'bun:test';
import { parseTerminalSseError, parseTerminalSseErrorFromData, QuotaExhaustedError } from './sse';

describe('parseTerminalSseErrorFromData', () => {
  test('preserves the message for a custom code (over-length, count-mismatch)', () => {
    const err = parseTerminalSseErrorFromData({
      message: 'Filled prompt is too long — 5000 / 4096 chars.',
      code: 'over-length',
    });
    expect(err).not.toBeInstanceOf(QuotaExhaustedError);
    expect(err.message).toBe('Filled prompt is too long — 5000 / 4096 chars.');
  });

  test('still maps quota-exhausted to QuotaExhaustedError with retryAfter', () => {
    const err = parseTerminalSseErrorFromData({
      message: 'quota',
      code: 'quota-exhausted',
      retryAfterSeconds: 30,
    });
    expect(err).toBeInstanceOf(QuotaExhaustedError);
    expect((err as QuotaExhaustedError).retryAfterSeconds).toBe(30);
  });

  test('raw-string variant preserves a custom-code message', () => {
    const err = parseTerminalSseError(JSON.stringify({ message: 'nope', code: 'count-mismatch' }));
    expect(err.message).toBe('nope');
  });
});

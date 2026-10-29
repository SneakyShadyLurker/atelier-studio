import { describe, expect, test } from 'bun:test';
import { parseTerminalSseError, QuotaExhaustedError } from '../src/api/sse';

describe('parseTerminalSseError', () => {
  test('quota-exhausted frame → typed QuotaExhaustedError with seconds', () => {
    const e = parseTerminalSseError('{"message":"Codex quota exhausted","code":"quota-exhausted","retryAfterSeconds":900}');
    expect(e).toBeInstanceOf(QuotaExhaustedError);
    expect((e as QuotaExhaustedError).retryAfterSeconds).toBe(900);
  });
  test('provider-error frame → generic Error', () => {
    const e = parseTerminalSseError('{"message":"provider error","code":"provider-error"}');
    expect(e).not.toBeInstanceOf(QuotaExhaustedError);
  });
  test('malformed → generic Error', () => {
    expect(parseTerminalSseError('not json')).toBeInstanceOf(Error);
  });
});

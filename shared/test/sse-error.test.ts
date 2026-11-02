import { describe, expect, test } from 'bun:test';
import { SseTerminalErrorSchema } from '../src/sse-error';

describe('SseTerminalErrorSchema', () => {
  test('round-trips a full object', () => {
    const result = SseTerminalErrorSchema.safeParse({
      message: 'x',
      code: 'quota-exhausted',
      retryAfterSeconds: 900,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ message: 'x', code: 'quota-exhausted', retryAfterSeconds: 900 });
    }
  });

  test('round-trips message-only object', () => {
    const result = SseTerminalErrorSchema.safeParse({ message: 'x' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ message: 'x' });
    }
  });

  test('accepts an unknown code so the message survives (open code field)', () => {
    // A closed enum here would FAIL the parse on a server code the client does
    // not special-case (e.g. ai-fill's count-mismatch / over-length), collapsing
    // the server's helpful message into a generic "request failed".
    const result = SseTerminalErrorSchema.safeParse({ message: 'too long — 5000 / 4096 chars.', code: 'over-length' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.code).toBe('over-length');
      expect(result.data.message).toBe('too long — 5000 / 4096 chars.');
    }
  });

  test('rejects a non-string code', () => {
    expect(SseTerminalErrorSchema.safeParse({ message: 'x', code: 42 }).success).toBe(false);
  });
});

import { describe, expect, test } from 'bun:test';
import { redactSecrets } from './redact';

describe('redactSecrets', () => {
  test('removes every byte of standalone OpenAI-style tokens', () => {
    const token = `sk-${'a'.repeat(32)}`;

    const redacted = redactSecrets(`provider echoed ${token}`);

    expect(redacted).toBe('provider echoed [redacted]');
    expect(redacted).not.toContain(token.slice(0, 8));
  });

  test('removes every byte of standalone Google API keys', () => {
    const token = `AIza${'b'.repeat(35)}`;

    const redacted = redactSecrets(`provider echoed ${token}`);

    expect(redacted).toBe('provider echoed [redacted]');
    expect(redacted).not.toContain(token.slice(0, 8));
  });

  test('keeps keyword prefixes while removing bearer and authorization values', () => {
    expect(redactSecrets(`bearer ${'c'.repeat(20)}`)).toBe('bearer …[redacted]');
    expect(redactSecrets(`authorization=${'d'.repeat(20)}`)).toBe('authoriz…[redacted]');
  });

  test('redacts a DeepSeek bearer token', () => {
    const token = `sk-${'d'.repeat(40)}`;
    const out = redactSecrets(`Authorization: Bearer ${token}`);
    expect(out).not.toContain(token);
  });
});

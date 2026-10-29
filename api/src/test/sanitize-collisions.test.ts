import { describe, expect, test } from 'bun:test';
import pino from 'pino';
import { sanitizeProviderError } from '../orchestrator/sanitize';

const logger = pino({ level: 'silent' });

describe('provider error sanitization collision resistance', () => {
  test.each([
    ['content-policy violation', 'the image contains detailed content metadata only'],
    ['content-policy violation', 'policy engine warmed successfully before provider crash'],
    ['upstream rejected', 'the request id 0xDEADBEEF returned 0x422 while routing crashed'],
    ['upstream rejected', 'unknown provider for model gpt-5.4-mini reject-map lookup failed'],
    ['timed out', 'timeoutBudgetMs was attached to the request log before a crash'],
    ['interrupted', 'interruptible stream capability probe failed during startup'],
    ['connection lost', 'sse data stream protocol enabled'],
    ['connection lost', 'stream disconnect counter incremented'],
  ] as const)('does not map incidental text to %s', (_category, raw) => {
    expect(sanitizeProviderError(raw, logger)).toBe('internal error');
  });

  test('maps CLIProxyAPI connection-failure wrappers to connection lost', () => {
    expect(sanitizeProviderError({ status: 502, message: 'stream disconnected before completion' }, logger))
      .toBe('connection lost');
    expect(sanitizeProviderError({ status: 502, message: 'upstream did not return image output' }, logger))
      .toBe('connection lost');
    expect(sanitizeProviderError({ status: 502, message: 'invalid SSE data JSON' }, logger))
      .toBe('connection lost');
    expect(sanitizeProviderError('CLIProxyAPI stream ended without a completed event', logger))
      .toBe('connection lost');
  });

  test('maps explicit upstream categories without leaking raw text', () => {
    expect(sanitizeProviderError({ status: 400, type: 'moderation_blocked' }, logger))
      .toBe('content-policy violation');
    expect(sanitizeProviderError({ status: 400, type: 'invalid_request_error' }, logger))
      .toBe('upstream rejected');
    expect(sanitizeProviderError({ status: 429, message: 'rate limit exceeded' }, logger))
      .toBe('upstream rejected');
    expect(sanitizeProviderError({ status: 504, message: 'upstream timed out' }, logger))
      .toBe('timed out');
  });
});

import { describe, expect, test } from 'bun:test';
import { BrokenCircuitError } from 'cockatiel';
import pino from 'pino';
import { sanitizeProviderError } from './sanitize';

const logger = pino({ level: 'silent' });

describe('sanitizeProviderError provider reasons', () => {
  test.each([
    [{ kind: 'policy', raw: 'SAFETY' }, 'content-policy violation'],
    [{ kind: 'no-image', raw: 'NO_IMAGE' }, 'upstream rejected'],
    // Behaviour-preserving: legacy `cause:'unsupported format'` flattened to
    // 'internal error' pre-refactor; the typed path keeps that mapping (a
    // promotion to 'unsupported format' is a deliberate future change).
    [{ kind: 'unsupported', raw: 'unsupported format' }, 'internal error'],
    [{ kind: 'too-large', status: 200, raw: 'response too large' }, 'internal error'],
    [{ kind: 'http', status: 400, raw: 'invalid_request_error' }, 'upstream rejected'],
    [{ kind: 'http', status: 400, raw: 'moderation_blocked' }, 'content-policy violation'],
  ] as const)('maps typed reason %p to %s', (reason, category) => {
    expect(sanitizeProviderError({ reason, cause: 'legacy text should not decide' }, logger)).toBe(category);
  });
});

test("scoped 'service-unavailable' reason maps to 'service unavailable'", () => {
  const cat = sanitizeProviderError(
    { status: 503, error: 'x', reason: { kind: 'service-unavailable', status: 503, raw: 'auth_unavailable' } },
    logger,
  );
  expect(cat).toBe('service unavailable');
});

test('BrokenCircuitError maps to service unavailable', () => {
  expect(sanitizeProviderError(new BrokenCircuitError('open'), logger)).toBe('service unavailable');
});

test('bare 503 WITHOUT scoped reason still maps to internal error (scope lock)', () => {
  expect(sanitizeProviderError({ status: 503, error: 'gateway' }, logger)).toBe('internal error');
});

test('statusless safety timeout maps to timeout instead of content policy', () => {
  expect(sanitizeProviderError('safety checker timed out', logger)).toBe('timed out');
});

test('bare 502 stream disconnected falls through to the 5xx branch', () => {
  expect(sanitizeProviderError({ status: 502, message: 'stream disconnected' }, logger)).toBe('internal error');
});

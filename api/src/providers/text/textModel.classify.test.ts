import { expect, test } from 'bun:test';
import { BrokenCircuitError, TaskCancelledError } from 'cockatiel';
import { PermanentUpstreamError, QuotaExhaustedError } from '../../lifecycle/resilient-call';
import { textFailureFromError } from './featureHelpers';

// HTTP and in-stream classification is covered against `classifyApiError` /
// `classifyStreamError` in classify.test.ts. This is the feature provider's
// one error-to-result mapping.

test('quota error maps to failed result with retryAfterSeconds + quota kind', () => {
  const r = textFailureFromError(new QuotaExhaustedError(900, { status: 429 }));
  expect(r).toMatchObject({ type: 'failed', kind: 'quota', status: 429, retryAfterSeconds: 900 });
});

test('typed upstream error details are redacted and capped before logging paths receive them', () => {
  const secret = 'sk-' + 'x'.repeat(80);
  const raw = `${'a'.repeat(3000)} ${secret}`;
  const r = textFailureFromError(
    new PermanentUpstreamError('4xx', { status: 400, body: { error: { message: raw } } }, 'upstream 400'),
  );

  expect(r).toMatchObject({ type: 'failed', kind: 'permanent', status: 400 });
  expect(r.detail.length).toBeLessThanOrEqual(2064);
  expect(r.detail).not.toContain(secret);
});

test('an open breaker and a per-attempt timeout map to transient', () => {
  expect(textFailureFromError(new BrokenCircuitError())).toMatchObject({ type: 'failed', kind: 'transient', status: null });
  expect(textFailureFromError(new TaskCancelledError())).toMatchObject({ type: 'failed', kind: 'transient', status: null });
});

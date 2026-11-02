import { expect, test } from 'bun:test';
import { PermanentUpstreamError, QuotaExhaustedError } from '../../lifecycle/resilient-call';
import { inferResultFromError } from './featureHelpers';

// HTTP and in-stream classification is covered against `classifyApiError` /
// `classifyStreamError` in classify.test.ts. These are the feature provider's
// error-to-result mappers.

test('quota error maps to failed result with retryAfterSeconds + quota kind', () => {
  const r = inferResultFromError(new QuotaExhaustedError(900, { status: 429 }));
  expect(r).toMatchObject({ type: 'failed', kind: 'quota', status: 429, retryAfterSeconds: 900 });
});

test('typed upstream error details are redacted and capped before logging paths receive them', () => {
  const secret = 'sk-' + 'x'.repeat(80);
  const raw = `${'a'.repeat(3000)} ${secret}`;
  const r = inferResultFromError(
    new PermanentUpstreamError('4xx', { status: 400, body: { error: { message: raw } } }, 'upstream 400'),
  );

  expect(r).toMatchObject({ type: 'failed', kind: 'permanent', status: 400 });
  if (r.type !== 'failed') throw new Error('expected failure');
  expect(r.detail.length).toBeLessThanOrEqual(2064);
  expect(r.detail).not.toContain(secret);
});

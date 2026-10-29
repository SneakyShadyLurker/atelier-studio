import { describe, expect, test } from 'bun:test';
import { buildResilientPolicy, PermanentUpstreamError, QuotaExhaustedError, TransientUpstreamError, isRetriable } from '../lifecycle/resilient-call';
import { classifyUpstreamFailureForTests as classify, inferResultFromErrorForTests } from './cliproxyText';

const QUOTA_MS = 300_000;
describe('classifyHttpFailure quota detection', () => {
  test('429 + long Retry-After → QuotaExhaustedError with raw seconds', () => {
    const h = new Headers({ 'retry-after': '900' });
    const e = classify(429, { error: { message: 'slow down' } }, h, QUOTA_MS);
    expect(e).toBeInstanceOf(QuotaExhaustedError);
    expect((e as QuotaExhaustedError).retryAfterSeconds).toBe(900);
  });
  test('429 + token-budget body wording → quota even without header', () => {
    const body = { error: { message: 'You have hit your usage limit for this 5 hour window' } };
    expect(classify(429, body, new Headers(), QUOTA_MS)).toBeInstanceOf(QuotaExhaustedError);
  });
  test('429 + short Retry-After (30s) → transient, NOT quota', () => {
    const h = new Headers({ 'retry-after': '30' });
    const e = classify(429, {}, h, QUOTA_MS);
    expect(e).toBeInstanceOf(TransientUpstreamError);
    expect((e as TransientUpstreamError).category).toBe('429');
    expect(e.cause).toEqual({ status: 429, body: {}, retryAfterMs: 30_000 });
  });
  test('429 + no signal → transient', () => {
    expect(classify(429, {}, new Headers(), QUOTA_MS)).toBeInstanceOf(TransientUpstreamError);
  });
  test('quota error is non-retriable', () => {
    expect(isRetriable(classify(429, {}, new Headers({ 'retry-after': '900' }), QUOTA_MS))).toBe(false);
  });
});

test('5xx preserves Retry-After metadata without applying quota classification', () => {
  for (const status of [500, 502, 503, 504]) {
    const body = { error: { message: 'try later' } };
    const error = classify(status, body, new Headers({ 'retry-after': '900' }), QUOTA_MS);
    expect(error).toBeInstanceOf(TransientUpstreamError);
    expect(error.cause).toEqual({ status, body, retryAfterMs: 900_000 });
  }
});

test('invalid Retry-After stays absent; past HTTP dates preserve zero', () => {
  expect(classify(503, {}, new Headers({ 'retry-after': 'invalid' }), QUOTA_MS).cause)
    .toMatchObject({ retryAfterMs: null });
  expect(classify(429, {}, new Headers({ 'retry-after': 'Thu, 01 Jan 1970 00:00:00 GMT' }), QUOTA_MS).cause)
    .toMatchObject({ retryAfterMs: 0 });
});

async function retryGap(status: number, retryAfter: string | undefined): Promise<number> {
  const policy = buildResilientPolicy({
    timeoutPerAttemptMs: 1_000, maxAttempts: 2, initialBackoffMs: 1, maxBackoffMs: 80,
    rateLimitBackoffFloorMs: 30, breakerThreshold: 8, halfOpenAfterMs: 1_000,
  });
  let first = 0;
  let gap = 0;
  let attempts = 0;
  await policy.execute(() => {
    attempts += 1;
    if (attempts === 1) {
      first = performance.now();
      throw classify(status, {}, new Headers(retryAfter === undefined ? {} : { 'retry-after': retryAfter }), QUOTA_MS);
    }
    gap = performance.now() - first;
    return Promise.resolve();
  });
  expect(attempts).toBe(2);
  return gap;
}

test('text-classified Retry-After reaches retry scheduling and retains floor/cap semantics', async () => {
  // Parsed headers are seconds; the injected policy caps them to milliseconds.
  // Without classifier metadata these take the 1ms exponential delay (or 30ms floor).
  for (const status of [429, 503]) {
    const capped = await retryGap(status, '1');
    expect(capped).toBeGreaterThanOrEqual(70);
    expect(capped).toBeLessThan(1_000);
  }
  for (const header of ['0', undefined]) {
    expect(await retryGap(429, header)).toBeGreaterThanOrEqual(25);
  }
});

test('quota error maps to failed result with retryAfterSeconds + quota kind', () => {
  const r = inferResultFromErrorForTests(new QuotaExhaustedError(900, { status: 429 }));
  expect(r).toMatchObject({ type: 'failed', kind: 'quota', status: 429, retryAfterSeconds: 900 });
});

test('typed upstream error details are redacted and capped before logging paths receive them', () => {
  const secret = 'sk-' + 'x'.repeat(80);
  const raw = `${'a'.repeat(3000)} ${secret}`;
  const r = inferResultFromErrorForTests(
    new PermanentUpstreamError('4xx', { status: 400, body: { error: { message: raw } } }, 'upstream 400'),
  );

  expect(r).toMatchObject({ type: 'failed', kind: 'permanent', status: 400 });
  if (r.type !== 'failed') throw new Error('expected failure');
  expect(r.detail.length).toBeLessThanOrEqual(2064);
  expect(r.detail).not.toContain(secret);
});
